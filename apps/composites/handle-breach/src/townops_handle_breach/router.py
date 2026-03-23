import logging

from fastapi import APIRouter, HTTPException

from . import clients
from .schemas import BreachRequest, BreachResponse

router = APIRouter()
logger = logging.getLogger(__name__)


@router.put("/assignments/open-case", response_model=BreachResponse)
async def handle_breach(request: BreachRequest) -> BreachResponse:
  """
  Composite process:
  1. Update escalated status
  2. Re-assign job
  3. Record penalty
  """
  try:
    # 1. Update escalated status (HTTP PUT Assignment)
    assignment_result = await clients.update_escalated_status(
      request.assignment_id, {"status": "ESCALATED", "details": request.breach_details}
    )

    # 2. Re-assign job (HTTP PUT Case)
    case_result = await clients.reassign_job(
      request.case_id, {"new_assignee_id": request.new_assignee_id}
    )

    # 3. Record penalty (HTTP POST Metrics)
    metrics_result = await clients.record_penalty(
      {"entity_id": request.assignment_id, "penalty_score": request.penalty}
    )

    return BreachResponse(
      success=True,
      assignment=assignment_result,
      case=case_result,
      metrics=metrics_result,
    )

  except Exception as e:
    logger.exception("Failed to process breach")
    # In a real environment, you'd trigger sagas or compensating transactions here
    # to rollback previous successful calls if a later one fails.
    raise HTTPException(status_code=500, detail=str(e)) from e
