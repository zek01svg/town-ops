"""Close Case composite microservice.

Orchestration flow
------------------
1. Validate incoming request (Pydantic).
2. Optionally verify the case exists via Case service.
3. Store proof items via Proof service.
4. Update case status to CLOSED via Case service.
5. Publish Job_Done event to RabbitMQ.
6. Return structured JSON response.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

# Standard library
from contextlib import asynccontextmanager
from typing import Any

# Third-party
import httpx
import services.amqp as amqp_service
import structlog

# Local / project
from config import settings
from fastapi import FastAPI, HTTPException, status
from schemas import CloseCaseRequest, CloseCaseResponse
from services.case_client import get_case, update_case_status
from services.proof_client import store_proof
from townops_shared.utils.observability import setup_logging, setup_tracing

setup_logging()
setup_tracing("close-case")
log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
  """Connect to RabbitMQ on startup; disconnect on shutdown."""
  await amqp_service.connect()
  log.info("Close Case service started", port=settings.port)
  yield
  await amqp_service.disconnect()
  log.info("Close Case service stopped")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
  title="Close Case Service",
  description=(
    "Composite microservice that stores completion proof, "
    "closes the case, and emits a Job_Done event."
  ),
  version="0.1.0",
  lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health", tags=["ops"])
async def health() -> dict[str, str]:
  """Liveness probe — returns service status."""
  return {"status": "ok", "service": "close-case"}


@app.post(
  "/close-case",
  response_model=CloseCaseResponse,
  status_code=status.HTTP_200_OK,
  tags=["close-case"],
)
async def close_case(payload: CloseCaseRequest) -> Any:  # noqa: ANN401
  """
  Close an open case by storing proof and updating its status.

  Steps:
    1. Verify the case exists.
    2. Store all submitted proof items.
    3. Update the case status to CLOSED.
    4. Publish a Job_Done event to RabbitMQ.
  """
  log.info(
    "Close case request received",
    case_id=payload.case_id,
    uploader_id=payload.uploader_id,
    proof_count=len(payload.proof_items),
  )

  # ------------------------------------------------------------------
  # Step 1 – verify case exists
  # ------------------------------------------------------------------
  try:
    await get_case(payload.case_id)
  except httpx.HTTPStatusError as exc:
    if exc.response.status_code == status.HTTP_404_NOT_FOUND:
      raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Case {payload.case_id} not found.",
      ) from exc
    raise HTTPException(
      status_code=status.HTTP_502_BAD_GATEWAY,
      detail="Case service returned an error while verifying case.",
    ) from exc
  except httpx.RequestError as exc:
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail="Case service is unreachable.",
    ) from exc

  # ------------------------------------------------------------------
  # Step 2 – store proof items
  # ------------------------------------------------------------------
  try:
    await store_proof(payload.case_id, payload.uploader_id, payload.proof_items)
  except httpx.HTTPStatusError as exc:
    raise HTTPException(
      status_code=status.HTTP_502_BAD_GATEWAY,
      detail="Proof service failed to store evidence.",
    ) from exc
  except httpx.RequestError as exc:
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail="Proof service is unreachable.",
    ) from exc

  # ------------------------------------------------------------------
  # Step 3 – update case status to CLOSED
  # ------------------------------------------------------------------
  try:
    await update_case_status(payload.case_id, payload.final_status)
  except httpx.HTTPStatusError as exc:
    raise HTTPException(
      status_code=status.HTTP_502_BAD_GATEWAY,
      detail="Case service failed to update status.",
    ) from exc
  except httpx.RequestError as exc:
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail="Case service is unreachable during status update.",
    ) from exc

  # ------------------------------------------------------------------
  # Step 4 – publish Job_Done event
  # ------------------------------------------------------------------
  try:
    await amqp_service.publish_job_done(payload.case_id, payload.uploader_id)
  except Exception as exc:  # noqa: BLE001
    # Event publishing failure is non-fatal for the caller — log and continue.
    log.error(
      "Failed to publish Job_Done event",
      case_id=payload.case_id,
      error=str(exc),
    )

  log.info("Case closed successfully", case_id=payload.case_id)

  return CloseCaseResponse(
    success=True,
    case_id=payload.case_id,
    message=f"Case {payload.case_id} has been closed successfully.",
    proof_stored=len(payload.proof_items),
  )
