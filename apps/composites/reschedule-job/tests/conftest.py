"""Pytest configuration and fixtures."""

import pytest
from fastapi.testclient import TestClient
from src.main import app, service as global_service
from src.service import RescheduleService
from src.config import get_settings


@pytest.fixture
def client():
    """Create a test client with initialized service."""
    # Initialize the service for tests
    with TestClient(app) as test_client:
        yield test_client
