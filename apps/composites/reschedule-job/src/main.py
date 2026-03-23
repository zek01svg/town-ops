"""Main FastAPI application for reschedule-job composite service."""

import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from scalar_fastapi import get_scalar_api_reference
from townops_shared.utils.observability import setup_logging, setup_tracing

from .schemas import ErrorResponse, RescheduleRequest, RescheduleResponse
from .service import RescheduleService

# Configure logging and tracing
setup_tracing("reschedule-job-composite")
setup_logging()
logger = logging.getLogger(__name__)

# Global service instance
service: RescheduleService | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
  """Manage application lifecycle."""
  global service

  # Startup
  logger.info("Starting reschedule-job service...")
  service = RescheduleService()
  logger.info("Service initialized successfully")

  yield

  # Shutdown
  logger.info("Shutting down reschedule-job service...")
  if service:
    await service.close()
  logger.info("Service shut down successfully")


# Create FastAPI app
app = FastAPI(
  title="Reschedule Job Service",
  description="Composite service for rescheduling appointments in TownOps",
  version="0.1.0",
  lifespan=lifespan,
  docs_url=None,  # Disable standard Swagger
  redoc_url=None,
)


@app.get("/scalar", include_in_schema=False)
async def scalar_html() -> None:
  """Scalar API documentation."""
  return get_scalar_api_reference(
    openapi_url=app.openapi_url,
    title=app.title,
  )


@app.get(
  "/health",
  tags=["Health"],
  response_model=dict,
  summary="Health check endpoint",
)
async def health() -> dict:
  """Health check endpoint.
  Returns:
      dict: Status information
  """
  return {"status": "healthy"}


@app.post(
  "/api/cases/reschedule-job",
  tags=["Reschedule"],
  response_model=RescheduleResponse,
  status_code=status.HTTP_200_OK,
  summary="Reschedule an appointment",
  responses={
    404: {"model": ErrorResponse, "description": "Resource not found"},
    422: {"model": ErrorResponse, "description": "Validation error"},
    503: {"model": ErrorResponse, "description": "Service unavailable"},
  },
)
async def reschedule(request: RescheduleRequest) -> RescheduleResponse:
  """Reschedule an appointment by creating a new time slot.
  This endpoint orchestrates the following workflow:
  1. Verify the resident exists and is active
  2. Create a new appointment slot with new times
  3. Restore the case status to "dispatched"
  Args:
      request: RescheduleRequest with appointment ID, resident ID,
               case ID, and new times
  Returns:
      RescheduleResponse with operation result
  Raises:
      HTTPException: 404 if resident or appointment not found
      HTTPException: 422 if validation fails
      HTTPException: 503 if downstream services are unavailable
  """
  if not service:
    logger.error("Service not initialized")
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail="Service not ready",
    )

  try:
    logger.info(
      {
        "message": "Reschedule request received",
        "appointment_id": request.appointment_id,
      }
    )
    response = await service.reschedule(request)
    logger.info(
      {
        "message": "Reschedule completed successfully",
        "appointment_id": response.appointment_id,
      }
    )
    return response  # noqa: TRY300

  except ValueError as e:
    logger.warning(
      {
        "message": "Validation error",
        "error": str(e),
      }
    )
    raise HTTPException(
      status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
      detail=str(e),
    ) from e

  except httpx.HTTPStatusError as e:
    logger.exception(
      {
        "message": "HTTP error from downstream service",
        "status_code": e.response.status_code,
      }
    )
    if e.response.status_code == 404:
      raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Resource not found (resident or appointment)",
      ) from e
    if e.response.status_code >= 500:
      raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Downstream service unavailable",
      ) from e
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail="Error communicating with downstream service",
    ) from e

  except httpx.ConnectError as e:
    logger.exception(
      {
        "message": "Connection error to downstream service",
      }
    )
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail="Cannot reach downstream services",
    ) from e

  except httpx.TimeoutException as e:
    logger.exception(
      {
        "message": "Timeout calling downstream service",
      }
    )
    raise HTTPException(
      status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
      detail="Downstream service timeout",
    ) from e

  except Exception as e:
    logger.exception(
      {
        "message": "Unexpected error during reschedule",
      }
    )
    raise HTTPException(
      status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
      detail="Internal server error",
    ) from e


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
  """Custom HTTP exception handler."""
  return JSONResponse(
    status_code=exc.status_code,
    content={
      "detail": exc.detail,
      "error_code": f"HTTP_{exc.status_code}",
    },
  )


if __name__ == "__main__":
  import uvicorn

  port = int(os.environ.get("RESCHEDULE_JOB_PORT", 6006))
  debug = os.environ.get("DEBUG", "false").lower() == "true"

  uvicorn.run(
    "main:app",
    host="127.0.0.1",
    port=port,
    reload=debug,
    log_level="info",
  )
