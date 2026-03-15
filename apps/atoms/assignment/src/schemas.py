from datetime import datetime

from pydantic import BaseModel, Field

from .models import AssignmentSource, AssignmentStatus


# Post
class AssignmentCreate(BaseModel):
  case_id: int
  contractor_id: int
  source: AssignmentSource
  notes: str | None = Field(default=None)


# Put
class AssignmentStatusUpdate(BaseModel):
  status: AssignmentStatus
  changed_by: str
  reason: str | None = Field(default=None)


# Get
class AssignmentResponse(BaseModel):
  id: int
  case_id: int
  contractor_id: int
  status: AssignmentStatus
  assigned_at: datetime
  response_due_at: datetime
  accepted_at: datetime | None
  source: AssignmentSource
  reassigned_from_assignment_id: int | None
  notes: str | None
  created_at: datetime
  updated_at: datetime

  class Config:
    from_attributes = True
