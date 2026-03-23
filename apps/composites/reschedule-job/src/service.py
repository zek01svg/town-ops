import logging
import os
from uuid import UUID

from townops_shared.utils.http import HttpClient

from .schemas import (
  AppointmentResponse,
  CaseResponse,
  RescheduleRequest,
  RescheduleResponse,
  ResidentResponse,
)

logger = logging.getLogger(__name__)


class RescheduleService:
  """Service for rescheduling appointments."""

  def __init__(self) -> None:
    """Initialize the service and fetch environment variables."""
    self.http_client = HttpClient()
    self.resident_url = os.environ.get("RESIDENT_URL", "http://resident:5002").rstrip(
      "/"
    )
    self.appointment_url = os.environ.get(
      "APPOINTMENT_URL", "http://appointment:5004"
    ).rstrip("/")
    self.case_url = os.environ.get("CASE_URL", "http://case:5001").rstrip("/")

  async def verify_resident(self, resident_id: UUID) -> ResidentResponse:
    """Verify that resident exists and is active.
    Fetches resident profile from the TownOps profiles table via resident-atom.
    """
    url = f"{self.resident_url}/residents/{resident_id}"
    logger.info(
      {
        "message": "Verifying resident",
        "resident_id": resident_id,
        "url": url,
      }
    )

    response = await self.http_client.get(url)
    response.raise_for_status()

    data = response.json()
    resident = ResidentResponse(**data)

    if resident.is_active is False:
      logger.warning(
        {
          "message": "User is inactive",
          "resident_id": resident_id,
        }
      )
      raise ValueError("Resident is not active")  # noqa: TRY003

    logger.info(
      {
        "message": "Resident verified successfully",
        "resident_id": resident_id,
      }
    )
    return resident

  async def create_appointment(self, request: RescheduleRequest) -> AppointmentResponse:
    url = f"{self.appointment_url}/appointments"
    payload = {
      "caseId": str(request.case_id),
      "assignmentId": str(request.assignment_id),
      "startTime": request.new_start_time.isoformat(),
      "endTime": request.new_end_time.isoformat(),
      "status": "rescheduled",
    }

    logger.info(
      {
        "message": "Creating appointment slot",
        "case_id": request.case_id,
        "payload": payload,
      }
    )

    response = await self.http_client.post(url, json=payload)
    response.raise_for_status()

    data = response.json()
    appointment = AppointmentResponse(**data)

    logger.info(
      {
        "message": "Appointment created successfully",
        "appointment_id": appointment.id,
        "status": "rescheduled",
      }
    )
    return appointment

  async def update_case_status(self, case_id: UUID) -> CaseResponse:
    """Update case status to 'dispatched'."""
    url = f"{self.case_url}/cases/{case_id}/status"
    payload = {"status": "dispatched"}

    logger.info(
      {
        "message": "Updating case status",
        "case_id": case_id,
        "payload": payload,
      }
    )

    response = await self.http_client.put(url, json=payload)
    response.raise_for_status()

    data = response.json()
    case = CaseResponse(**data)

    logger.info(
      {
        "message": "Case status updated successfully",
        "case_id": case_id,
        "status": case.status,
      }
    )
    return case

  async def reschedule(self, request: RescheduleRequest) -> RescheduleResponse:
    """Execute the reschedule workflow."""
    logger.info(
      {
        "message": "Starting reschedule workflow",
        "case_id": request.case_id,
      }
    )

    # Step 1: Verify resident (HTTP GET)
    await self.verify_resident(request.resident_id)

    # Step 2: Create appointment (HTTP POST)
    new_appointment = await self.create_appointment(request)

    # Step 3: Restore case status (HTTP PUT)
    await self.update_case_status(request.case_id)

    logger.info(
      {
        "message": "Reschedule workflow completed successfully",
        "case_id": request.case_id,
      }
    )

    return RescheduleResponse(
      appointment_id=new_appointment.id,
      case_id=request.case_id,
      status="rescheduled",
      message="Appointment successfully rescheduled",
      new_start_time=request.new_start_time,
    )

  async def close(self) -> None:
    """Close all connections."""
    await self.http_client.close()
