"""HTTP client for the Case atomic service."""

from __future__ import annotations

import httpx
import structlog
from config import settings

log = structlog.get_logger(__name__)


async def get_case(case_id: int) -> dict:  # type: ignore[type-arg]
  """
  Fetch a case by ID from the Case service.

  Raises httpx.HTTPStatusError if the case is not found or service errors.
  """
  url = f"{settings.case_service_url}/cases/{case_id}"
  async with httpx.AsyncClient(timeout=settings.http_timeout) as client:
    resp = await client.get(url)
    resp.raise_for_status()
    log.debug("Case fetched", case_id=case_id, status=resp.status_code)
    return resp.json()


async def update_case_status(case_id: int, new_status: str) -> dict:  # type: ignore[type-arg]
  """
  Update the status of a case via the Case service.

  Raises httpx.HTTPStatusError on non-2xx responses.
  """
  url = f"{settings.case_service_url}/cases/{case_id}/status"
  payload = {"status": new_status}
  async with httpx.AsyncClient(timeout=settings.http_timeout) as client:
    resp = await client.put(url, json=payload)
    resp.raise_for_status()
    log.info("Case status updated", case_id=case_id, new_status=new_status)
    return resp.json()
