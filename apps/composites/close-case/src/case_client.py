from __future__ import annotations

import structlog
from townops_shared.utils.http import HttpClient

from .config import settings

log = structlog.get_logger(__name__)


async def get_case(client: HttpClient, case_id: int) -> dict:  # type: ignore[type-arg]
  """
  Fetch a case by ID from the Case service.

  Raises httpx.HTTPStatusError if the case is not found or service errors.
  """
  url = f"{settings.case_service_url}/cases/{case_id}"
  resp = await client.get(url)
  resp.raise_for_status()
  log.debug("Case fetched", case_id=case_id, status=resp.status_code)
  return resp.json()


async def update_case_status(client: HttpClient, case_id: int, new_status: str) -> dict:  # type: ignore[type-arg]
  """
  Update the status of a case via the Case service.

  Raises httpx.HTTPStatusError on non-2xx responses.
  """
  url = f"{settings.case_service_url}/cases/{case_id}/status"
  payload = {"status": new_status}
  resp = await client.put(url, json=payload)
  resp.raise_for_status()
  log.info("Case status updated", case_id=case_id, new_status=new_status)
  return resp.json()
