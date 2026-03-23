from typing import Any

import httpx

from .config import settings


async def update_assignment_worker(
  assignment_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
  """Process 2: Update Assignment to the new worker (HTTP PUT Assignment)"""
  async with httpx.AsyncClient(base_url=settings.ASSIGNMENT_ATOM_URL) as client:
    # Assuming the atom has an endpoint like /assignments/{id}
    response = await client.put(f"/assignments/{assignment_id}", json=payload)
    response.raise_for_status()
    return response.json()


async def query_backup_worker(case_id: str) -> dict[str, Any]:
  """Process 1: Query Contractor (OutSystems) for a backup worker"""
  async with httpx.AsyncClient(base_url=settings.OUTSYSTEMS_URL) as client:
    # Assuming OutSystems exposes a backup worker search endpoint
    response = await client.get(f"/contractors/backup?case_id={case_id}")
    response.raise_for_status()
    return response.json()


async def update_case_escalated(case_id: str) -> dict[str, Any]:
  """Process 3: Update Case state to ESCALATED (HTTP PUT Case)"""
  async with httpx.AsyncClient(base_url=settings.CASE_ATOM_URL) as client:
    # Assuming the atom has an endpoint to escalate cases
    response = await client.put(
      f"/cases/{case_id}/status", json={"status": "ESCALATED"}
    )
    response.raise_for_status()
    return response.json()


async def record_penalty(payload: dict[str, Any]) -> dict[str, Any]:
  """Process 3: Record penalty (HTTP POST Metrics)"""
  async with httpx.AsyncClient(base_url=settings.METRICS_ATOM_URL) as client:
    # Assuming the atom has an endpoint like /metrics/penalty
    response = await client.post("/metrics/penalty", json=payload)
    response.raise_for_status()
    return response.json()
