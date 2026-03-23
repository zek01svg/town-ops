"""Unit tests for reschedule-job service."""

from datetime import datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from src.main import app
from src.schemas import RescheduleRequest


@pytest.fixture
def sample_resident_id():
  """Sample resident UUID."""
  return UUID("550e8400-e29b-41d4-a716-446655440001")


@pytest.fixture
def sample_appointment_id():
  """Sample appointment UUID."""
  return UUID("550e8400-e29b-41d4-a716-446655440000")


@pytest.fixture
def sample_case_id():
  """Sample case UUID."""
  return UUID("550e8400-e29b-41d4-a716-446655440002")


@pytest.fixture
def sample_assignment_id():
  """Sample assignment UUID."""
  return UUID("550e8400-e29b-41d4-a716-446655440003")


@pytest.fixture
def sample_reschedule_request(
  sample_resident_id, sample_appointment_id, sample_case_id, sample_assignment_id
):
  """Create a sample reschedule request."""
  now = datetime.utcnow()
  new_time = now + timedelta(days=3)
  return RescheduleRequest(
    appointment_id=sample_appointment_id,
    resident_id=sample_resident_id,
    case_id=sample_case_id,
    assignment_id=sample_assignment_id,
    new_start_time=new_time,
    new_end_time=new_time + timedelta(hours=2),
  )


class TestHealthEndpoint:
  """Tests for health endpoint."""

  def test_health_check(self):
    """Test health check endpoint."""
    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"


class TestRescheduleEndpoint:
  """Tests for reschedule endpoint."""

  def test_reschedule_request_validation_missing_all_fields(self):
    """Test reschedule endpoint request validation."""
    client = TestClient(app)

    # Missing required fields
    response = client.post("/api/cases/reschedule-job", json={})

    assert response.status_code == 422  # Validation error

  def test_reschedule_request_schema_valid(self):
    """Test reschedule request schema validation."""
    now = datetime.utcnow()

    valid_request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
      "new_start_time": (now + timedelta(days=1)).isoformat(),
      "new_end_time": (now + timedelta(days=1, hours=2)).isoformat(),
    }

    # This should not raise during schema parsing
    request = RescheduleRequest(**valid_request)
    assert request.appointment_id == UUID("550e8400-e29b-41d4-a716-446655440000")

  def test_reschedule_request_missing_appointment_id(self):
    """Test validation fails without appointment_id."""
    client = TestClient(app)
    request = {
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_reschedule_request_invalid_uuid_format(self):
    """Test validation fails with invalid UUID format."""
    client = TestClient(app)
    request = {
      "appointment_id": "invalid-uuid",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_reschedule_request_invalid_datetime_format(self):
    """Test validation fails with invalid datetime format."""
    client = TestClient(app)
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
      "new_start_time": "not-a-datetime",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422


class TestRequestValidation:
  """Tests for request validation."""

  def test_missing_resident_id(self):
    """Test validation fails without resident_id."""
    client = TestClient(app)
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_missing_case_id(self):
    """Test validation fails without case_id."""
    client = TestClient(app)
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_missing_new_start_time(self):
    """Test validation fails without new_start_time."""
    client = TestClient(app)
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_missing_new_end_time(self):
    """Test validation fails without new_end_time."""
    client = TestClient(app)
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "assignment_id": "550e8400-e29b-41d4-a716-446655440003",
      "new_start_time": "2026-03-25T14:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422

  def test_missing_assignment_id(self):
    """Test validation fails without assignment_id."""
    client = TestClient(app)
    request = {
      "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
      "resident_id": "550e8400-e29b-41d4-a716-446655440001",
      "case_id": "550e8400-e29b-41d4-a716-446655440002",
      "new_start_time": "2026-03-25T14:00:00",
      "new_end_time": "2026-03-25T16:00:00",
    }

    response = client.post("/api/cases/reschedule-job", json=request)
    assert response.status_code == 422
