"""Integration tests for reschedule-job service.

These tests validate the end-to-end reschedule workflow with mocked downstream services.
For full integration tests, you would use Docker Compose to spin up actual services.
"""

import pytest
from datetime import datetime, timedelta
from uuid import UUID
from unittest.mock import AsyncMock, MagicMock, patch
import httpx

from fastapi.testclient import TestClient

from src.main import app, service
from src.config import Settings
from src.schemas import RescheduleRequest


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


@pytest.fixture
def reschedule_request():
    """Create a sample reschedule request."""
    now = datetime.utcnow()
    new_time = now + timedelta(days=3)
    return {
        "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
        "resident_id": "550e8400-e29b-41d4-a716-446655440001",
        "case_id": "550e8400-e29b-41d4-a716-446655440002",
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

        response = client.post("/api/reschedule", json=invalid_request)

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

        response = client.post("/api/reschedule", json=invalid_request)

        assert response.status_code == 422

    def test_reschedule_endpoint_503_service_unavailable(self, client, reschedule_request):
        """Test reschedule returns 503 when downstream service unavailable."""
        with patch("src.main.service") as mock_service:
            mock_service.reschedule = AsyncMock(side_effect=httpx.ConnectError("Connection failed"))

            response = client.post("/api/reschedule", json=reschedule_request)

            assert response.status_code == 503
            data = response.json()
            assert "detail" in data

    def test_reschedule_endpoint_timeout(self, client, reschedule_request):
        """Test reschedule returns 503 on timeout."""
        with patch("src.main.service") as mock_service:
            mock_service.reschedule = AsyncMock(side_effect=httpx.TimeoutException("Request timeout"))

            response = client.post("/api/reschedule", json=reschedule_request)

            assert response.status_code == 503
            data = response.json()
            assert "detail" in data


class TestHealthEndpointIntegration:
    """Integration tests for health endpoint."""

    def test_health_endpoint_always_available(self, client):
        """Test health endpoint is available."""
        response = client.get("/health")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["service"] == "reschedule-job"
        assert "version" in data


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

        response = client.post("/api/reschedule", json=request)
        assert response.status_code == 422

    def test_missing_resident_id(self, client):
        """Test validation fails without resident_id."""
        request = {
            "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
            "case_id": "550e8400-e29b-41d4-a716-446655440002",
            "new_start_time": "2026-03-25T14:00:00",
            "new_end_time": "2026-03-25T16:00:00",
        }

        response = client.post("/api/reschedule", json=request)
        assert response.status_code == 422

    def test_missing_case_id(self, client):
        """Test validation fails without case_id."""
        request = {
            "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
            "resident_id": "550e8400-e29b-41d4-a716-446655440001",
            "new_start_time": "2026-03-25T14:00:00",
            "new_end_time": "2026-03-25T16:00:00",
        }

        response = client.post("/api/reschedule", json=request)
        assert response.status_code == 422

    def test_missing_new_start_time(self, client):
        """Test validation fails without new_start_time."""
        request = {
            "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
            "resident_id": "550e8400-e29b-41d4-a716-446655440001",
            "case_id": "550e8400-e29b-41d4-a716-446655440002",
            "new_end_time": "2026-03-25T16:00:00",
        }

        response = client.post("/api/reschedule", json=request)
        assert response.status_code == 422

    def test_missing_new_end_time(self, client):
        """Test validation fails without new_end_time."""
        request = {
            "appointment_id": "550e8400-e29b-41d4-a716-446655440000",
            "resident_id": "550e8400-e29b-41d4-a716-446655440001",
            "case_id": "550e8400-e29b-41d4-a716-446655440002",
            "new_start_time": "2026-03-25T14:00:00",
        }

        response = client.post("/api/reschedule", json=request)
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

        response = client.post("/api/reschedule", json=request)
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

        response = client.post("/api/reschedule", json=request)
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

        response = client.post("/api/reschedule", json=invalid_request)

        assert response.status_code == 422
        data = response.json()
        assert "detail" in data
