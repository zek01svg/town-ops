"""HTTP client for the Proof atomic service."""

from __future__ import annotations

import httpx
import structlog

from config import settings
from schemas import ProofItem

log = structlog.get_logger(__name__)


async def store_proof(
  case_id: int,
  uploader_id: int,
  proof_items: list[ProofItem],
) -> dict:  # type: ignore[type-arg]
  """
  Submit proof items to the Proof service via POST /proof.

  Returns the JSON response from the Proof service.
  Raises httpx.HTTPStatusError on non-2xx responses.
  """
  url = f"{settings.proof_service_url}/proof"
  payload = {
    "case_id": case_id,
    "uploader_id": uploader_id,
    "items": [
      {
        "media_url": str(item.media_url),
        "type": item.type,
        "remarks": item.remarks,
      }
      for item in proof_items
    ],
  }

  async with httpx.AsyncClient(timeout=settings.http_timeout) as client:
    resp = await client.post(url, json=payload)
    resp.raise_for_status()
    log.info(
      "Proof stored",
      case_id=case_id,
      uploader_id=uploader_id,
      count=len(proof_items),
    )
    return resp.json()
