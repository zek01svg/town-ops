from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
  """Base model configured to use camelCase for JSON fields."""

  class Config:
    alias_generator = to_camel
    populate_by_name = True


class RescheduleRequest(CamelModel):
  """Request to reschedule an appointment."""

  appointment_id: UUID = Field(description="ID of the appointment to reschedule")
  resident_id: UUID = Field(description="ID of the resident")
  case_id: UUID = Field(description="ID of the case")
  assignment_id: UUID = Field(description="ID of the assignment")
  new_start_time: datetime = Field(description="New appointment start time (ISO 8601)")
  new_end_time: datetime = Field(description="New appointment end time (ISO 8601)")


class RescheduleResponse(CamelModel):
  """Response after successful reschedule."""

  appointment_id: UUID = Field(description="ID of the new appointment")
  case_id: UUID = Field(description="ID of the case")
  status: str = Field(description="Status of the operation")
  message: str = Field(description="Human-readable message")
  new_start_time: datetime = Field(description="New appointment start time")


class ErrorResponse(CamelModel):
  """Error response schema."""

  detail: str = Field(description="Error message")
  error_code: str = Field(description="Error code")


class ResidentResponse(CamelModel):
  id: UUID
  full_name: str
  email: str
  contact_number: str | None = None
  postal_code: str | None = None
  is_active: bool | None = None
  created_at: str | None = None
  updated_at: str | None = None


class AppointmentResponse(CamelModel):
  id: UUID
  case_id: UUID
  assignment_id: UUID
  start_time: datetime
  end_time: datetime
  status: str  # 'scheduled', 'rescheduled', 'cancelled', 'missed', 'completed'
  created_at: datetime | None = None
  updated_at: datetime | None = None


class CaseResponse(CamelModel):
  """Response from case-atom service (matches TownOps cases table)."""

  id: UUID
  resident_id: UUID
  category: str
  priority: str
  status: str
  description: str | None = None
  address_details: str | None = None
  created_at: datetime | None = None
  updated_at: datetime | None = None
