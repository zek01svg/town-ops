from datetime import UTC, datetime
from enum import StrEnum

from sqlmodel import Field, SQLModel


# Select source from this predefined list of options
class AssignmentSource(StrEnum):
  AUTO_ASSIGN = "AUTO_ASSIGN"
  MANUAL_ASSIGN = "MANUAL_ASSIGN"
  BREACH_REASSIGN = "BREACH_REASSIGN"


class AssignmentStatus(StrEnum):
  PENDING_ACCEPTANCE = "PENDING_ACCEPTANCE"
  ACCEPTED = "ACCEPTED"
  BREACHED = "BREACHED"
  REASSIGNED = "REASSIGNED"
  CANCELLED = "CANCELLED"
  COMPLETED = "COMPLETED"


class Assignment(SQLModel, table=True):
  id: int | None = Field(default=None, primary_key=True)
  case_id: int
  contractor_id: int
  status: AssignmentStatus
  assigned_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
  response_due_at: datetime
  accepted_at: datetime | None = Field(default=None)
  source: AssignmentSource
  reassigned_from_assignment_id: int | None = Field(default=None)
  notes: str | None = Field(default=None)
  created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
  updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AssignmentStatusHistory(SQLModel, table=True):
  id: int | None = Field(default=None, primary_key=True)
  assignment_id: int
  from_status: AssignmentStatus | None = Field(default=None)
  to_status: AssignmentStatus
  changed_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
  changed_by: str
  reason: str | None = Field(default=None)
