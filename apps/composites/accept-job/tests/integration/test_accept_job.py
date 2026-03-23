from __future__ import annotations

from uuid import uuid4

import respx
from fastapi.testclient import TestClient
from httpx import Response
from src.main import app

CASE_ID = str(uuid4())
ASSIGNMENT_ID = str(uuid4())
CONTRACTOR_ID = str(uuid4())

VALID_PAYLOAD = {
  "case_id": CASE_ID,
  "assignment_id": ASSIGNMENT_ID,
  "contractor_id": CONTRACTOR_ID,
  "start_time": "2026-03-24T09:00:00+08:00",
  "end_time": "2026-03-24T11:00:00+08:00",
}


@respx.mock
def test_integration_accept_job_full_flow() -> None:
  """Full integration test: all atoms mocked, checks response shape."""
  appt_id = str(uuid4())

  respx.put(f"http://localhost:5003/api/assignments/{ASSIGNMENT_ID}/status").mock(
    return_value=Response(
      200, json={"assignment": {"id": ASSIGNMENT_ID, "status": "accepted"}}
    )
  )
  respx.put("http://localhost:5001/api/cases/update-case-status/").mock(
    return_value=Response(200, json={"cases": {"id": CASE_ID, "status": "in_progress"}})
  )
  respx.post("http://localhost:5004/api/appointments").mock(
    return_value=Response(
      201, json={"appointment": {"id": appt_id, "status": "scheduled"}}
    )
  )

  with TestClient(app) as client:
    resp = client.put("/jobs/accept-job", json=VALID_PAYLOAD)

  assert resp.status_code == 200
  body = resp.json()
  assert body["message"] == "Job accepted successfully"
  assert body["assignment"]["status"] == "accepted"
  assert body["case"]["status"] == "in_progress"
  assert body["appointment"]["status"] == "scheduled"


@respx.mock
def test_integration_cors_headers_present() -> None:
  """CORS headers are returned for cross-origin requests."""
  respx.put(f"http://localhost:5003/api/assignments/{ASSIGNMENT_ID}/status").mock(
    return_value=Response(
      200, json={"assignment": {"id": ASSIGNMENT_ID, "status": "accepted"}}
    )
  )
  respx.put("http://localhost:5001/api/cases/update-case-status/").mock(
    return_value=Response(200, json={"cases": {"id": CASE_ID, "status": "in_progress"}})
  )
  respx.post("http://localhost:5004/api/appointments").mock(
    return_value=Response(
      201, json={"appointment": {"id": str(uuid4()), "status": "scheduled"}}
    )
  )

  with TestClient(app) as client:
    resp = client.put(
      "/jobs/accept-job",
      json=VALID_PAYLOAD,
      headers={"Origin": "http://localhost:5173"},
    )

  assert resp.status_code == 200
  assert "access-control-allow-origin" in resp.headers
