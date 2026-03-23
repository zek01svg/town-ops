import logging

from fastapi import APIRouter, HTTPException, Request

from . import clients
from .schemas import BreachRequest, BreachResponse

router = APIRouter()
logger = logging.getLogger(__name__)


@router.put("/assignments/open-case", response_model=BreachResponse)
async def handle_breach(request: BreachRequest, fastapi_req: Request) -> BreachResponse:
  """
  Composite process:
  1. Update escalated status
  2. Re-assign job
  3. Record penalty
  """
  try:
    client = fastapi_req.app.state.http_client

    # 1. Update Case state to ESCALATED (HTTP PUT Case)
    case_result = await clients.update_case_escalated(client, request.case_id)

    # 2. Update Assignment to new worker (HTTP PUT Assignment)
    assignment_result = await clients.update_assignment_worker(
      client,
      request.assignment_id,
      {"assigned_to": request.new_assignee_id, "status": "REASSIGNED"},
    )

    # 3. Record penalty (HTTP POST Metrics)
    metrics_result = await clients.record_penalty(
      client, {"entity_id": request.assignment_id, "penalty_score": request.penalty}
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
