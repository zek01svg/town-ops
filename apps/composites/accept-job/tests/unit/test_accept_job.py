from __future__ import annotations

from uuid import uuid4

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response
from src.main import app

# ─── Fixtures ─────────────────────────────────────────────────────────────────

CASE_ID = str(uuid4())
ASSIGNMENT_ID = str(uuid4())
CONTRACTOR_ID = str(uuid4())
START_TIME = "2026-03-24T09:00:00+08:00"
END_TIME = "2026-03-24T11:00:00+08:00"

VALID_PAYLOAD = {
  "case_id": CASE_ID,
  "assignment_id": ASSIGNMENT_ID,
  "contractor_id": CONTRACTOR_ID,
  "start_time": START_TIME,
  "end_time": END_TIME,
}

ASSIGNMENT_RESPONSE = {"assignment": {"id": ASSIGNMENT_ID, "status": "accepted"}}
CASE_RESPONSE = {"cases": {"id": CASE_ID, "status": "in_progress"}}
APPOINTMENT_RESPONSE = {
  "appointment": {
    "id": str(uuid4()),
    "caseId": CASE_ID,
    "assignmentId": ASSIGNMENT_ID,
    "status": "scheduled",
  }
}


@pytest.fixture
def client():
  with TestClient(app) as c:
    yield c


# ─── Happy path ───────────────────────────────────────────────────────────────


@respx.mock
def test_accept_job_success(client: TestClient) -> None:
  """All three atoms return 2xx → 200 OK with assignment, case, appointment."""
  respx.put(f"http://localhost:5003/api/assignments/{ASSIGNMENT_ID}/status").mock(
    return_value=Response(200, json=ASSIGNMENT_RESPONSE)
  )
  respx.put("http://localhost:5001/api/cases/update-case-status/").mock(
    return_value=Response(200, json=CASE_RESPONSE)
  )
  respx.post("http://localhost:5004/api/appointments").mock(
    return_value=Response(201, json=APPOINTMENT_RESPONSE)
  )

  resp = client.post("/jobs/accept-job", json=VALID_PAYLOAD)
  assert resp.status_code == 200
  body = resp.json()
  assert body["message"] == "Job accepted successfully"
  assert "assignment" in body
  assert "case" in body
  assert "appointment" in body


# ─── Step 1 failure (Assignment) ─────────────────────────────────────────────


@respx.mock
def test_assignment_update_failure_returns_503(client: TestClient) -> None:
  """Assignment update fails → 503, no rollback calls needed."""
  respx.put(f"http://localhost:5003/api/assignments/{ASSIGNMENT_ID}/status").mock(
    return_value=Response(500, json={"error": "db error"})
  )

  resp = client.post("/jobs/accept-job", json=VALID_PAYLOAD)
  assert resp.status_code == 503
  assert "assignment" in resp.json()["detail"].lower()


# ─── Step 2 failure (Case) ───────────────────────────────────────────────────


@respx.mock
def test_case_update_failure_triggers_assignment_rollback(client: TestClient) -> None:
  """Case update fails → assignment reverted to 'pending'."""
  respx.put(f"http://localhost:5003/api/assignments/{ASSIGNMENT_ID}/status").mock(
    return_value=Response(200, json=ASSIGNMENT_RESPONSE)
  )
  respx.put("http://localhost:5001/api/cases/update-case-status/").mock(
    return_value=Response(500, json={"error": "case error"})
  )
  # Rollback call — assignment reverted to pending
  rollback_route = respx.put(
    f"http://localhost:5003/api/assignments/{ASSIGNMENT_ID}/status"
  ).mock(return_value=Response(200, json={"assignment": {"status": "pending"}}))

  resp = client.post("/jobs/accept-job", json=VALID_PAYLOAD)
  assert resp.status_code == 503
  assert "case" in resp.json()["detail"].lower()

  # Verify compensating transaction
  assert rollback_route.called
  import json

  rollback_payload = json.loads(rollback_route.calls.last.request.content)
  assert rollback_payload["status"] == "pending"


# ─── Step 3 failure (Appointment) ────────────────────────────────────────────


@respx.mock
def test_appointment_creation_failure_triggers_full_rollback(
  client: TestClient,
) -> None:
  """
  Appointment creation fails -> case reverted to 'dispatched',
  assignment to 'pending'.
  """
  respx.put(f"http://localhost:5003/api/assignments/{ASSIGNMENT_ID}/status").mock(
    return_value=Response(200, json=ASSIGNMENT_RESPONSE)
  )
  respx.put("http://localhost:5001/api/cases/update-case-status/").mock(
    return_value=Response(200, json=CASE_RESPONSE)
  )
  respx.post("http://localhost:5004/api/appointments").mock(
    return_value=Response(500, json={"error": "appointment error"})
  )
  # Rollback: revert case to dispatched
  revert_case_route = respx.put(
    "http://localhost:5001/api/cases/update-case-status/"
  ).mock(return_value=Response(200, json={"cases": {"status": "dispatched"}}))
  # Rollback: revert assignment to pending
  revert_assignment_route = respx.put(
    f"http://localhost:5003/api/assignments/{ASSIGNMENT_ID}/status"
  ).mock(return_value=Response(200, json={"assignment": {"status": "pending"}}))

  resp = client.post("/jobs/accept-job", json=VALID_PAYLOAD)
  assert resp.status_code == 503
  assert "appointment" in resp.json()["detail"].lower()

  # Verify compensating transactions
  assert revert_case_route.called
  assert revert_assignment_route.called

  import json

  case_payload = json.loads(revert_case_route.calls.last.request.content)
  assert case_payload["status"] == "dispatched"

  assignment_payload = json.loads(revert_assignment_route.calls.last.request.content)
  assert assignment_payload["status"] == "pending"


# ─── Validation ───────────────────────────────────────────────────────────────


def test_missing_required_fields_returns_422(client: TestClient) -> None:
  """Missing start_time / end_time → 422 Unprocessable Entity."""
  resp = client.post(
    "/jobs/accept-job",
    json={"case_id": CASE_ID, "assignment_id": ASSIGNMENT_ID},
  )
  assert resp.status_code == 422


def test_health_endpoint(client: TestClient) -> None:
  resp = client.get("/health")
  assert resp.status_code == 200
  assert resp.json() == {"status": "healthy"}
