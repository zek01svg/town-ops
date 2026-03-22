"""Request and response schemas for reschedule-job service."""

from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, Field, ConfigDict


class RescheduleRequest(BaseModel):
    """Request to reschedule an appointment."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
                "resident_id": "550e8400-e29b-41d4-a716-446655440001",
                "case_id": "550e8400-e29b-41d4-a716-446655440002",
                "new_start_time": "2026-03-25T14:00:00",
                "new_end_time": "2026-03-25T16:00:00",
            }
        }
    )

    appointment_id: UUID = Field(description="ID of the appointment to reschedule")
    resident_id: UUID = Field(description="ID of the resident")
    case_id: UUID = Field(description="ID of the case")
    new_start_time: datetime = Field(description="New appointment start time (ISO 8601)")
    new_end_time: datetime = Field(description="New appointment end time (ISO 8601)")


class RescheduleResponse(BaseModel):
    """Response after successful reschedule."""

    appointment_id: UUID = Field(description="ID of the rescheduled appointment")
    case_id: UUID = Field(description="ID of the case")
    status: str = Field(description="Status of the operation")
    message: str = Field(description="Human-readable message")
    old_start_time: datetime = Field(description="Previous appointment start time")
    new_start_time: datetime = Field(description="New appointment start time")


class ErrorResponse(BaseModel):
    """Error response schema."""

    detail: str = Field(description="Error message")
    error_code: str = Field(description="Error code")


class ResidentResponse(BaseModel):
    """Response from resident-atom service (matches TownOps profiles table)."""

    id: UUID
    full_name: str
    email: str
    role: str  # 'resident', 'officer', 'contractor'
    contact_number: str | None = None
    postal_code: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class AppointmentResponse(BaseModel):
    """Response from appointment-atom service (matches TownOps appointments table)."""

    id: UUID
    case_id: UUID
    assignment_id: UUID
    start_time: datetime
    end_time: datetime
    status: str  # 'scheduled', 'rescheduled', 'cancelled', 'missed', 'completed'
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CaseResponse(BaseModel):
    """Response from case-atom service (matches TownOps cases table)."""

    id: UUID
    resident_id: UUID
    category: str
    priority: str  # 'low', 'medium', 'high', 'emergency'
    status: str  # 'pending', 'assigned', 'dispatched', 'in_progress', 'completed', 'cancelled', 'escalated'
    description: str | None = None
    address_details: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class RescheduleEventPayload(BaseModel):
    """Payload for Appointment_Rescheduled AMQP event."""

    appointment_id: UUID
    case_id: UUID
    resident_id: UUID
    old_start_time: datetime
    old_end_time: datetime
    new_start_time: datetime
    new_end_time: datetime
    timestamp: datetime
