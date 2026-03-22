"""Main FastAPI application for reschedule-job composite service."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse
import httpx

from .config import get_settings
from .schemas import RescheduleRequest, RescheduleResponse, ErrorResponse
from .service import RescheduleService

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global service instance
service: RescheduleService | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle."""
    global service
    settings = get_settings()

    # Startup
    logger.info("Starting reschedule-job service...")
    service = RescheduleService(settings)
    await service.connect_amqp()
    logger.info("Service initialized successfully")

    yield

    # Shutdown
    logger.info("Shutting down reschedule-job service...")
    if service:
        await service.close()
    logger.info("Service shut down successfully")


# Create FastAPI app
settings = get_settings()
app = FastAPI(
    title="Reschedule Job Service",
    description="Composite service for rescheduling appointments in HDBCare",
    version="0.1.0",
    lifespan=lifespan,
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
    return {
        "status": "healthy",
        "service": "reschedule-job",
        "version": "0.1.0",
    }


@app.post(
    "/api/reschedule",
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
    """Reschedule an appointment to a new time slot.

    This endpoint orchestrates the following workflow:
    1. Verify the resident exists and is active
    2. Fetch the current appointment details
    3. Update the appointment with new times
    4. Restore the case status to "dispatched"
    5. Emit an Appointment_Rescheduled event

    Args:
        request: RescheduleRequest with appointment ID, resident ID, case ID, and new times

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
            f"Reschedule request received for appointment {request.appointment_id}"
        )
        response = await service.reschedule(request)
        logger.info(f"Reschedule completed successfully: {response}")
        return response

    except ValueError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e),
        ) from e

    except httpx.HTTPStatusError as e:
        logger.error(f"HTTP error from downstream service: {e.response.status_code}")
        if e.response.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resource not found (resident or appointment)",
            ) from e
        elif e.response.status_code >= 500:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Downstream service unavailable",
            ) from e
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Error communicating with downstream service",
            ) from e

    except httpx.ConnectError as e:
        logger.error(f"Connection error to downstream service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cannot reach downstream services",
        ) from e

    except httpx.TimeoutException as e:
        logger.error(f"Timeout calling downstream service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Downstream service timeout",
        ) from e

    except Exception as e:
        logger.exception(f"Unexpected error during reschedule: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error",
        ) from e


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc: HTTPException):
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

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.debug,
        log_level="info",
    )
