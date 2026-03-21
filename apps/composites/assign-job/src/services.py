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


async def assign_contractor(case_id: str, postal_code: str, category_code: str) -> dict:
  sector_code = postal_code[:2]

  async with httpx.AsyncClient() as client:
    search_url = f"{os.getenv('CONTRACTOR_API_URL')}/contractors/search"
    search_resp = await client.get(
      search_url,
      params={"SectorCode": sector_code, "CategoryCode": category_code},
    )
    search_resp.raise_for_status()

    contractors = search_resp.json()
    if not contractors:
      raise ValueError("No eligible contractors found")

    contractor_data = await asyncio.gather(
      *(get_metrics(client, c["ContractorId"]) for c in contractors)
    )

    best = select_best(contractor_data)

    assign_url = f"{os.getenv('ASSIGNMENT_URL')}/assignments"
    final_resp = await client.post(
      assign_url,
      json={
        "case_id": case_id,
        "contractor_id": best["contractor_id"],
        "source": "AUTO_ASSIGN",
      },
    )
    final_resp.raise_for_status()
    assignment = final_resp.json()

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
