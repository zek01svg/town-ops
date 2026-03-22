"""Business logic for reschedule-job composite service."""

import json
import logging
from datetime import datetime
from uuid import UUID

import httpx
from aio_pika import connect_robust, Message
from aio_pika.abc import AbstractConnection

from .config import Settings
from .schemas import (
    RescheduleRequest,
    RescheduleResponse,
    ResidentResponse,
    AppointmentResponse,
    CaseResponse,
    RescheduleEventPayload,
)

logger = logging.getLogger(__name__)


class RescheduleService:
    """Service for rescheduling appointments."""

    def __init__(self, settings: Settings):
        """Initialize the service with settings."""
        self.settings = settings
        self.http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                self.settings.http_timeout,
                connect=self.settings.http_connect_timeout,
            )
        )
        self.amqp_connection: AbstractConnection | None = None

    async def verify_resident(self, resident_id: UUID) -> ResidentResponse:
        """Verify that resident exists and is active.

        Fetches resident profile from the TownOps profiles table via resident-atom.

        Args:
            resident_id: UUID of the resident to verify

        Returns:
            ResidentResponse with resident data

        Raises:
            httpx.HTTPStatusError: If resident not found (404) or other HTTP error
        """
        url = f"{self.settings.resident_url}/residents/{resident_id}"
        logger.info(f"Verifying resident {resident_id} at {url}")

        response = await self.http_client.get(url)
        response.raise_for_status()

        data = response.json()
        resident = ResidentResponse(**data)

        # Resident must have 'resident' role (from TownOps user_role ENUM)
        if resident.role != "resident":
            logger.warning(f"User {resident_id} has role '{resident.role}', not 'resident'")
            raise ValueError(f"Invalid user role: expected 'resident', got '{resident.role}'")

        logger.info(f"Resident {resident_id} verified successfully")
        return resident

    async def get_current_appointment(self, appointment_id: UUID) -> AppointmentResponse:
        """Get current appointment details.

        Args:
            appointment_id: UUID of the appointment

        Returns:
            AppointmentResponse with appointment data

        Raises:
            httpx.HTTPStatusError: If appointment not found (404) or other HTTP error
        """
        url = f"{self.settings.appointment_url}/appointments/{appointment_id}"
        logger.info(f"Fetching appointment {appointment_id} from {url}")

        response = await self.http_client.get(url)
        response.raise_for_status()

        data = response.json()
        appointment = AppointmentResponse(**data)

        logger.info(f"Appointment {appointment_id} fetched successfully")
        return appointment

    async def update_appointment(
        self, appointment_id: UUID, request: RescheduleRequest
    ) -> AppointmentResponse:
        """Update appointment with new times in the TownOps appointments table.

        Sets the appointment status to 'rescheduled' (from appointment_status ENUM).

        Args:
            appointment_id: UUID of the appointment
            request: RescheduleRequest with new times

        Returns:
            AppointmentResponse with updated appointment data

        Raises:
            httpx.HTTPStatusError: If update fails
        """
        url = f"{self.settings.appointment_url}/appointments/{appointment_id}/status"
        payload = {
            "start_time": request.new_start_time.isoformat(),
            "end_time": request.new_end_time.isoformat(),
            "status": "rescheduled",
        }

        logger.info(f"Updating appointment {appointment_id} with new times")
        logger.debug(f"Update payload: {payload}")

        response = await self.http_client.put(url, json=payload)
        response.raise_for_status()

        data = response.json()
        appointment = AppointmentResponse(**data)

        logger.info(f"Appointment {appointment_id} updated successfully with status 'rescheduled'")
        return appointment

    async def get_case(self, case_id: UUID) -> CaseResponse:
        """Get case details from the TownOps cases table.

        Args:
            case_id: UUID of the case

        Returns:
            CaseResponse with case data

        Raises:
            httpx.HTTPStatusError: If case not found (404) or other HTTP error
        """
        url = f"{self.settings.case_url}/cases/{case_id}"
        logger.info(f"Fetching case {case_id} from {url}")

        response = await self.http_client.get(url)
        response.raise_for_status()

        data = response.json()
        case = CaseResponse(**data)

        logger.info(f"Case {case_id} fetched successfully with status '{case.status}'")
        return case

    async def restore_case_status(self, case_id: UUID) -> CaseResponse:
        """Restore case status from escalated/no-access back to dispatched.

        Updates the TownOps cases table status field to 'dispatched'.

        Args:
            case_id: UUID of the case

        Returns:
            CaseResponse with updated case data

        Raises:
            httpx.HTTPStatusError: If update fails
        """
        url = f"{self.settings.case_url}/cases/{case_id}/status"
        payload = {"status": "dispatched"}

        logger.info(f"Restoring case {case_id} status to dispatched")

        response = await self.http_client.put(url, json=payload)
        response.raise_for_status()

        data = response.json()
        case = CaseResponse(**data)

        logger.info(f"Case {case_id} status restored successfully")
        return case

    async def emit_reschedule_event(
        self,
        request: RescheduleRequest,
        old_appointment: AppointmentResponse,
    ) -> None:
        """Emit Appointment_Rescheduled event to RabbitMQ.

        Args:
            request: The reschedule request with new times
            old_appointment: The appointment before rescheduling
        """
        if not self.amqp_connection:
            logger.warning("AMQP connection not initialized, skipping event emission")
            return

        try:
            event_payload = RescheduleEventPayload(
                appointment_id=request.appointment_id,
                case_id=request.case_id,
                resident_id=request.resident_id,
                old_start_time=old_appointment.start_time,
                old_end_time=old_appointment.end_time,
                new_start_time=request.new_start_time,
                new_end_time=request.new_end_time,
                timestamp=datetime.utcnow(),
            )

            channel = await self.amqp_connection.channel()
            exchange = await channel.declare_exchange(
                "hdbcare.events", "topic", durable=True
            )

            message = Message(
                body=event_payload.model_dump_json().encode(),
                content_type="application/json",
            )

            routing_key = "hdbcare.appointment.rescheduled"
            await exchange.publish(message, routing_key=routing_key)

            logger.info(
                f"Event emitted: {routing_key} for appointment {request.appointment_id}"
            )

        except Exception as e:
            logger.error(f"Failed to emit event: {e}", exc_info=True)
            # Don't fail the whole operation if event emission fails
            # but log it for monitoring

    async def reschedule(self, request: RescheduleRequest) -> RescheduleResponse:
        """Execute the reschedule workflow.

        Args:
            request: RescheduleRequest with appointment and new times

        Returns:
            RescheduleResponse with operation result

        Raises:
            ValueError: If validation fails
            httpx.HTTPStatusError: If any HTTP call fails
        """
        logger.info(f"Starting reschedule workflow for appointment {request.appointment_id}")

        # Step 1: Verify resident
        resident = await self.verify_resident(request.resident_id)

        # Step 2: Get current appointment
        current_appointment = await self.get_current_appointment(request.appointment_id)

        # Validate appointment belongs to the case
        if current_appointment.case_id != request.case_id:
            logger.error(
                f"Appointment {request.appointment_id} does not belong to case {request.case_id}"
            )
            raise ValueError("Appointment does not belong to the specified case")

        # Step 3: Update appointment with new times
        updated_appointment = await self.update_appointment(
            request.appointment_id, request
        )

        # Step 4: Restore case status
        await self.restore_case_status(request.case_id)

        # Step 5: Emit event
        await self.emit_reschedule_event(request, current_appointment)

        logger.info(f"Reschedule workflow completed for appointment {request.appointment_id}")

        response = RescheduleResponse(
            appointment_id=request.appointment_id,
            case_id=request.case_id,
            status="rescheduled",
            message="Appointment successfully rescheduled",
            old_start_time=current_appointment.start_time,
            new_start_time=request.new_start_time,
        )

        return response

    async def connect_amqp(self) -> None:
        """Connect to RabbitMQ."""
        try:
            logger.info(f"Connecting to RabbitMQ at {self.settings.rabbitmq_url}")
            self.amqp_connection = await connect_robust(self.settings.rabbitmq_url)
            logger.info("Connected to RabbitMQ successfully")
        except Exception as e:
            logger.error(f"Failed to connect to RabbitMQ: {e}", exc_info=True)
            # Don't fail startup if RabbitMQ is unavailable
            # Event emission will be skipped if connection is not available

    async def disconnect_amqp(self) -> None:
        """Disconnect from RabbitMQ."""
        if self.amqp_connection:
            try:
                await self.amqp_connection.close()
                logger.info("Disconnected from RabbitMQ")
            except Exception as e:
                logger.error(f"Error disconnecting from RabbitMQ: {e}", exc_info=True)

    async def close(self) -> None:
        """Close all connections."""
        await self.http_client.aclose()
        await self.disconnect_amqp()
