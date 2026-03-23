"""
Async HTTP client helpers for interacting with the atomic microservices.
Each function accepts an httpx.AsyncClient (injected by the router) and
the caller's raw Authorization header value for forwarding.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any
from uuid import UUID

import httpx

logger = logging.getLogger(__name__)

# ─── helpers ──────────────────────────────────────────────────────────────────


def _auth_headers(authorization: str | None) -> dict[str, str]:
    if authorization:
        return {"Authorization": authorization}
    return {}


def _raise_for_status(response: httpx.Response, label: str) -> None:
    """Raise a descriptive RuntimeError for non-2xx responses."""
    if response.is_error:
        raise RuntimeError(
            f"{label} failed with HTTP {response.status_code}: {response.text}"
        )


# ─── Assignment atom ──────────────────────────────────────────────────────────


async def update_assignment_status(
    client: httpx.AsyncClient,
    base_url: str,
    assignment_id: UUID,
    status: str,
    authorization: str | None = None,
) -> dict[str, Any]:
    """PUT /api/assignments/{id}/status"""
    url = f"{base_url}/api/assignments/{assignment_id}/status"
    logger.info("Calling Assignment atom: PUT %s status=%s", url, status)
    response = await client.put(
        url,
        json={"status": status},
        headers=_auth_headers(authorization),
    )
    _raise_for_status(response, f"Assignment status update ({assignment_id})")
    return response.json().get("assignment", response.json())


# ─── Case atom ────────────────────────────────────────────────────────────────


async def update_case_status(
    client: httpx.AsyncClient,
    base_url: str,
    case_id: UUID,
    status: str,
    authorization: str | None = None,
) -> dict[str, Any]:
    """PUT /api/cases/update-case-status/"""
    url = f"{base_url}/api/cases/update-case-status/"
    logger.info("Calling Case atom: PUT %s case_id=%s status=%s", url, case_id, status)
    response = await client.put(
        url,
        json={"id": str(case_id), "status": status},
        headers=_auth_headers(authorization),
    )
    _raise_for_status(response, f"Case status update ({case_id})")
    return response.json().get("cases", response.json())


# ─── Appointment atom ─────────────────────────────────────────────────────────


async def create_appointment(
    client: httpx.AsyncClient,
    base_url: str,
    case_id: UUID,
    assignment_id: UUID,
    start_time: datetime,
    end_time: datetime,
    authorization: str | None = None,
) -> dict[str, Any]:
    """POST /api/appointments"""
    url = f"{base_url}/api/appointments"
    payload = {
        "caseId": str(case_id),
        "assignmentId": str(assignment_id),
        "startTime": start_time.isoformat(),
        "endTime": end_time.isoformat(),
        "status": "scheduled",
    }
    logger.info("Calling Appointment atom: POST %s", url)
    response = await client.post(
        url,
        json=payload,
        headers=_auth_headers(authorization),
    )
    _raise_for_status(response, f"Appointment creation (case={case_id})")
    return response.json().get("appointment", response.json())
