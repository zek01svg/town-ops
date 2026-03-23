import asyncio
import logging
import os

import httpx

from .publisher import publish_job_assigned

logger = logging.getLogger(__name__)


async def get_metrics(client: httpx.AsyncClient, contractor_id: str) -> dict:
  url = f"{os.getenv('METRICS_URL')}/api/metrics/{contractor_id}"
  resp = await client.get(url)
  resp.raise_for_status()

  rows = resp.json()["metrics"]
  return {
    "contractor_id": contractor_id,
    "total_jobs": len(rows),
    "total_score": sum(m["score_delta"] for m in rows),
  }


def select_best(contractor_data: list[dict]) -> dict:
  return sorted(contractor_data, key=lambda c: (c["total_jobs"], -c["total_score"]))[0]


async def _search_contractors(
  client: httpx.AsyncClient, sector_code: str, category_code: str
) -> list[dict]:
  url = f"{os.getenv('CONTRACTOR_API_URL')}/contractors/search"
  resp = await client.get(
    url, params={"SectorCode": sector_code, "CategoryCode": category_code}
  )
  resp.raise_for_status()
  return resp.json()


async def _fetch_metrics_for_contractors(
  client: httpx.AsyncClient, contractors: list[dict]
) -> list[dict]:
  return await asyncio.gather(
    *(get_metrics(client, c["ContractorUuid"]) for c in contractors)
  )


async def _create_assignment(
  client: httpx.AsyncClient, case_id: str, contractor_id: str
) -> dict:
  url = f"{os.getenv('ASSIGNMENT_URL')}/assignments"
  resp = await client.post(
    url,
    json={"case_id": case_id, "contractor_id": contractor_id, "source": "AUTO_ASSIGN"},
  )
  resp.raise_for_status()
  return resp.json()


async def assign_contractor(case_id: str, postal_code: str, category_code: str) -> dict:
  sector_code = postal_code[:2]

  async with httpx.AsyncClient() as client:
    contractors = await _search_contractors(client, sector_code, category_code)
    if not contractors:
      raise ValueError("No eligible contractors found")  # noqa: TRY003

    contractor_data = await _fetch_metrics_for_contractors(client, contractors)
    best = select_best(contractor_data)

    assignment = await _create_assignment(client, case_id, best["contractor_id"])

    try:
      await publish_job_assigned(
        assignment_id=assignment["id"],
        case_id=case_id,
        contractor_id=best["contractor_id"],
      )
    except Exception:
      logger.exception("Failed to publish Job_Assigned for case %s", case_id)
      raise

    return assignment
