from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class AcceptJobRequest(BaseModel):
  """Incoming payload from the frontend / API gateway."""

  case_id: UUID
  assignment_id: UUID
  contractor_id: UUID
  start_time: datetime  # ISO-8601; used to create the appointment block
  end_time: datetime  # ISO-8601; used to create the appointment block


class AcceptJobResponse(BaseModel):
  """Composite response returned on success."""

  message: str
  assignment: dict
  case: dict
  appointment: dict
