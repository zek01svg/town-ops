import httpx
import pytest
import respx
from fastapi import status
from src.config import settings


@pytest.mark.anyio
@respx.mock
async def test_handle_breach_endpoint_success(client, respx_mock):
  # Setup downstream mocks
  assignment_id = "202"
  case_id = "101"
  new_assignee_id = "backup_01"

  respx_mock.put(f"{settings.CASE_ATOM_URL}/cases/{case_id}/status").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"success": True})
  )
  respx_mock.put(f"{settings.ASSIGNMENT_ATOM_URL}/assignments/{assignment_id}").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"success": True})
  )
  respx_mock.post(f"{settings.METRICS_ATOM_URL}/metrics/penalty").mock(
    return_value=httpx.Response(status.HTTP_201_CREATED, json={"success": True})
  )

  payload = {
    "assignment_id": assignment_id,
    "case_id": case_id,
    "new_assignee_id": new_assignee_id,
    "penalty": 10.0,
    "breach_details": "SLA Breach detected",
  }

  # Use client fixture (TestClient)
  response = client.put("/assignments/open-case", json=payload)

  assert response.status_code == status.HTTP_200_OK
  data = response.json()
  assert data["success"] is True
