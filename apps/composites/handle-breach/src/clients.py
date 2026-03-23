from typing import Any

import httpx

from .config import settings


async def update_assignment_worker(
  client: httpx.AsyncClient, assignment_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
  """Process 2: Update Assignment to the new worker (HTTP PUT Assignment)"""
  url = f"{settings.ASSIGNMENT_ATOM_URL}/assignments/{assignment_id}"
  response = await client.put(url, json=payload)
  response.raise_for_status()
  return response.json()


async def query_backup_worker(
  client: httpx.AsyncClient, case_id: str
) -> dict[str, Any]:
  """Process 1: Query Contractor (OutSystems) for a backup worker"""
  url = f"{settings.OUTSYSTEMS_URL}/contractors/backup?case_id={case_id}"
  response = await client.get(url)
  response.raise_for_status()
  return response.json()


async def update_case_escalated(
  client: httpx.AsyncClient, case_id: str
) -> dict[str, Any]:
  """Process 3: Update Case state to ESCALATED (HTTP PUT Case)"""
  url = f"{settings.CASE_ATOM_URL}/cases/{case_id}/status"
  response = await client.put(url, json={"status": "ESCALATED"})
  response.raise_for_status()
  return response.json()


async def record_penalty(
  client: httpx.AsyncClient, payload: dict[str, Any]
) -> dict[str, Any]:
  """Process 3: Record penalty (HTTP POST Metrics)"""
  url = f"{settings.METRICS_ATOM_URL}/metrics/penalty"
  response = await client.post(url, json=payload)
  response.raise_for_status()
  return response.json()
