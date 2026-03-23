from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from .models import AssignmentSource, AssignmentStatus


# Post
class AssignmentCreate(BaseModel):
  case_id: str
  contractor_id: str
  source: AssignmentSource
  notes: str | None = Field(default=None)


# Put
class AssignmentStatusUpdate(BaseModel):
  status: AssignmentStatus
  changed_by: str
  reason: str | None = Field(default=None)


# Get
class AssignmentResponse(BaseModel):
  id: str
  case_id: str
  contractor_id: str
  status: AssignmentStatus
  assigned_at: datetime
  response_due_at: datetime
  accepted_at: datetime | None
  source: AssignmentSource
  reassigned_from_assignment_id: str | None
  notes: str | None
  created_at: datetime
  updated_at: datetime

  model_config = ConfigDict(from_attributes=True)
