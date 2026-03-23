from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient
from src.main import app


@pytest.fixture
def client() -> TestClient:
  """Create a test client."""
  with TestClient(app) as c:
    yield c


@pytest.fixture
def reschedule_request():
  """Create a sample reschedule request."""
  now = datetime.utcnow()
  new_time = now + timedelta(days=3)
  return {
    "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
    "resident_id": "550e8400-e29b-41d4-a716-446655440001",
    "case_id": "550e8400-e29b-41d4-a716-446655440002",
    "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
    "new_start_time": new_time.isoformat(),
    "new_end_time": (new_time + timedelta(hours=2)).isoformat(),
  }


class TestRescheduleEndpointIntegration:
  """Integration tests for the reschedule endpoint."""

  def test_reschedule_endpoint_422_validation_error_invalid_uuid(self, client):
    """Test reschedule returns 422 for invalid UUID."""
    invalid_request = {
      "appointment_id": "not-a-uuid",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=invalid_request)

    assert response.status_code == 422

  def test_reschedule_endpoint_422_validation_error_invalid_datetime(self, client):
    """Test reschedule returns 422 for invalid datetime."""
    invalid_request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "not-a-datetime",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=invalid_request)

    assert response.status_code == 422

  @patch("src.service.HttpClient.get", new_callable=AsyncMock)
  def test_reschedule_endpoint_503_service_unavailable(
    self, mock_get, client, reschedule_request
  ):
    """Test reschedule returns 503 when downstream service unavailable."""
    mock_get.side_effect = httpx.ConnectError("Connection failed")

    response = client.post("/api/cases/reschedule-job", json=reschedule_request)

    assert response.status_code == 503
    data = response.json()
    assert "detail" in data

  @patch("src.service.HttpClient.get", new_callable=AsyncMock)
  def test_reschedule_endpoint_timeout(self, mock_get, client, reschedule_request):
    """Test reschedule returns 503 on timeout."""
    mock_get.side_effect = httpx.TimeoutException("Request timeout")

    response = client.post("/api/cases/reschedule-job", json=reschedule_request)

    assert response.status_code == 503
    data = response.json()
    assert "detail" in data

  @patch("src.service.HttpClient.put", new_callable=AsyncMock)
  @patch("src.service.HttpClient.post", new_callable=AsyncMock)
  @patch("src.service.HttpClient.get", new_callable=AsyncMock)
  def test_reschedule_endpoint_success_workflow(
    self, mock_get, mock_post, mock_put, client, reschedule_request
  ):
    """Test success route flow with downstream mocks."""
    # 1. Mock GET for Resident
    mock_get.return_value = httpx.Response(
      200,
      json={
        "id": reschedule_request["resident_id"],
        "isActive": True,
        "fullName": "John Doe",
        "email": "john.doe@example.com",
      },
      request=httpx.Request("GET", "http://resident:5002/residents"),
    )

    # 2. Mock POST for Appointment
    mock_post.return_value = httpx.Response(
      201,
      json={
        "id": "550e8400-e29b-41d4-a716-446655440099",
        "caseId": reschedule_request["case_id"],
        "assignmentId": reschedule_request["assignment_id"],
        "startTime": reschedule_request["new_start_time"],
        "endTime": reschedule_request["new_end_time"],
        "status": "rescheduled",
      },
      request=httpx.Request("POST", "http://appointment:5004/appointments"),
    )

    # 3. Mock PUT for Case Status
    mock_put.return_value = httpx.Response(
      200,
      json={
        "id": reschedule_request["case_id"],
        "residentId": reschedule_request["resident_id"],
        "category": "medical",
        "priority": "medium",
        "status": "dispatched",
      },
      request=httpx.Request("PUT", "http://case:5001/cases"),
    )

    response = client.post("/api/cases/reschedule-job", json=reschedule_request)

    assert response.status_code == 200
    data = response.json()
    assert data["appointmentId"] == "550e8400-e29b-41d4-a716-446655440099"
    assert data["status"] == "rescheduled"


class TestHealthEndpointIntegration:
  """Integration tests for health endpoint."""

  def test_health_endpoint_always_available(self, client):
    """Test health endpoint is available."""
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"


class TestRequestValidation:
  """Tests for request validation."""

  def test_missing_appointment_id(self, client):
    """Test validation fails without appointment_id."""
    request = {
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_missing_resident_id(self, client):
    """Test validation fails without resident_id."""
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_missing_case_id(self, client):
    """Test validation fails without case_id."""
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_missing_new_start_time(self, client):
    """Test validation fails without new_start_time."""
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_missing_new_end_time(self, client):
    """Test validation fails without new_end_time."""
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "2026-03-25T14:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_invalid_uuid_format(self, client):
    """Test validation fails with invalid UUID format."""
    request = {
      "appointment_id": "invalid-uuid",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_invalid_datetime_format(self, client):
    """Test validation fails with invalid datetime format."""
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "not-a-datetime",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422


class TestErrorHandling:
  """Tests for error handling."""

  def test_error_response_format(self, client):
    """Test error responses have proper format."""
    invalid_request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "not-a-datetime",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=invalid_request)

    assert response.status_code == 422
    data = response.json()
    assert "detail" in data
