"""
Orchestration router for the accept-job composite service.

POST /jobs/accept-job
  1. PUT Assignment → status: accepted
  2. PUT Case       → status: in_progress
  3. POST Appointment → create schedule block

If any step fails, compensating calls are issued to maintain consistency.
"""
from __future__ import annotations

import logging
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from .clients import (
    create_appointment,
    update_assignment_status,
    update_case_status,
)
from .config import Settings, get_settings
from .schemas import AcceptJobRequest, AcceptJobResponse

logger = logging.getLogger(__name__)

router = APIRouter()


def get_http_client(request: Request) -> httpx.AsyncClient:
    """Retrieve the shared AsyncClient stored on app state."""
    return request.app.state.http_client


# ─── Compensation helpers ─────────────────────────────────────────────────────


async def _revert_assignment(
    client: httpx.AsyncClient,
    settings: Settings,
    req: AcceptJobRequest,
    authorization: str | None,
) -> None:
    try:
        await update_assignment_status(
            client,
            settings.ASSIGNMENT_SERVICE_URL,
            req.assignment_id,
            "pending",
            authorization,
        )
        logger.warning(
            "Compensation: reverted assignment %s to 'pending'",
            req.assignment_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.critical(
            "Compensation FAILED for assignment %s: %s",
            req.assignment_id,
            exc,
        )


async def _revert_case(
    client: httpx.AsyncClient,
    settings: Settings,
    req: AcceptJobRequest,
    authorization: str | None,
) -> None:
    try:
        await update_case_status(
            client,
            settings.CASE_SERVICE_URL,
            req.case_id,
            "dispatched",
            authorization,
        )
        logger.warning(
            "Compensation: reverted case %s to 'dispatched'",
            req.case_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.critical(
            "Compensation FAILED for case %s: %s",
            req.case_id,
            exc,
        )


# ─── Route ────────────────────────────────────────────────────────────────────


@router.post(
    "/accept-job",
    response_model=AcceptJobResponse,
    status_code=status.HTTP_200_OK,
    summary="Accept a job assignment",
    description=(
        "Orchestrates the contractor job-acceptance flow: "
        "updates the Assignment status to 'accepted', "
        "transitions the Case to 'in_progress', "
        "and creates a scheduled Appointment block."
    ),
)
async def accept_job(
    payload: AcceptJobRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
    authorization: Annotated[str | None, Header()] = None,
) -> AcceptJobResponse:
    logger.info(
        "accept_job: case=%s assignment=%s contractor=%s",
        payload.case_id,
        payload.assignment_id,
        payload.contractor_id,
    )

    # ── Step 1: Update Assignment status → accepted ───────────────────────────
    try:
        assignment = await update_assignment_status(
            client,
            settings.ASSIGNMENT_SERVICE_URL,
            payload.assignment_id,
            "accepted",
            authorization,
        )
    except Exception as exc:
        logger.error("Step 1 failed (Assignment update): %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Failed to update assignment: {exc}",
        ) from exc

    # ── Step 2: Update Case status → in_progress ──────────────────────────────
    try:
        case = await update_case_status(
            client,
            settings.CASE_SERVICE_URL,
            payload.case_id,
            "in_progress",
            authorization,
        )
    except Exception as exc:
        logger.error("Step 2 failed (Case update): %s — initiating rollback", exc)
        await _revert_assignment(client, settings, payload, authorization)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Failed to update case status: {exc}",
        ) from exc

    # ── Step 3: Create Appointment schedule block ─────────────────────────────
    try:
        appointment = await create_appointment(
            client,
            settings.APPOINTMENT_SERVICE_URL,
            payload.case_id,
            payload.assignment_id,
            payload.start_time,
            payload.end_time,
            authorization,
        )
    except Exception as exc:
        logger.critical(
            "Step 3 failed (Appointment creation): %s — initiating full rollback", exc
        )
        await _revert_case(client, settings, payload, authorization)
        await _revert_assignment(client, settings, payload, authorization)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Failed to create appointment: {exc}",
        ) from exc

    logger.info(
        "accept_job: success — case=%s appointment created", payload.case_id
    )
    return AcceptJobResponse(
        message="Job accepted successfully",
        assignment=assignment,
        case=case,
        appointment=appointment,
    )
