import httpx
import pytest
import respx
from fastapi import status
from src.clients import (
  query_backup_worker,
  record_penalty,
  update_assignment_worker,
  update_case_escalated,
)
from src.config import settings


@pytest.mark.anyio
@respx.mock
async def test_query_backup_worker_success(respx_mock):
  case_id = "101"
  mock_resp = {"worker_id": "backup_01"}
  respx_mock.get(
    f"{settings.OUTSYSTEMS_URL}/contractors/backup?case_id={case_id}"
  ).mock(return_value=httpx.Response(status.HTTP_200_OK, json=mock_resp))

  async with httpx.AsyncClient() as client:
    result = await query_backup_worker(client, case_id)
    assert result == mock_resp


@pytest.mark.anyio
@respx.mock
async def test_update_case_escalated_success(respx_mock):
  case_id = "101"
  respx_mock.put(f"{settings.CASE_ATOM_URL}/cases/{case_id}/status").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"success": True})
  )

  async with httpx.AsyncClient() as client:
    result = await update_case_escalated(client, case_id)
    assert result == {"success": True}


@pytest.mark.anyio
@respx.mock
async def test_update_assignment_worker_success(respx_mock):
  assignment_id = "202"
  payload = {"assigned_to": "worker_01", "status": "REASSIGNED"}
  respx_mock.put(f"{settings.ASSIGNMENT_ATOM_URL}/assignments/{assignment_id}").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"success": True})
  )

  async with httpx.AsyncClient() as client:
    result = await update_assignment_worker(client, assignment_id, payload)
    assert result == {"success": True}


@pytest.mark.anyio
@respx.mock
async def test_record_penalty_success(respx_mock):
  payload = {"entity_id": "1", "penalty_score": 10.0}
  respx_mock.post(f"{settings.METRICS_ATOM_URL}/metrics/penalty").mock(
    return_value=httpx.Response(status.HTTP_201_CREATED, json={"recorded": True})
  )

  async with httpx.AsyncClient() as client:
    result = await record_penalty(client, payload)
    assert result == {"recorded": True}
