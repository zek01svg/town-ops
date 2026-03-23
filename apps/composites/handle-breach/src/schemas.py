from typing import Any

from pydantic import BaseModel


class BreachRequest(BaseModel):
  assignment_id: str
  case_id: str
  breach_details: str
  new_assignee_id: str
  penalty: float


class BreachResponse(BaseModel):
  success: bool
  assignment: Any | None = None
  case: Any | None = None
  metrics: Any | None = None
