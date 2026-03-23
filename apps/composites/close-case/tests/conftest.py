from collections.abc import Generator
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from src.app import app


@pytest.fixture
def client() -> Generator[TestClient]:
    """A FastAPI TestClient for the Close Case microservice."""
    with (
        patch("app.amqp_service.connect", new_callable=AsyncMock),
        patch("app.amqp_service.disconnect", new_callable=AsyncMock),
        TestClient(app) as client_instance,
    ):
        yield client_instance


@pytest.fixture
def valid_close_payload() -> dict[str, Any]:
    """A pre-baked, valid request body for POST /close-case."""
    return {
        "case_id": 101,
        "uploader_id": 9001,
        "proof_items": [
            {
                "media_url": "https://cdn.townops.gov/cases/101/finish.jpg",
                "type": "image",
                "remarks": "Repaired the leaking pipe and verified no more drips.",
            }
        ],
        "final_status": "CLOSED",
    }


@pytest.fixture
def mock_case_service() -> Generator[dict[str, AsyncMock]]:
    """Fixture to mock the internal Case Service client."""
    with (
        patch("app.get_case", new_callable=AsyncMock) as mock_get,
        patch("app.update_case_status", new_callable=AsyncMock) as mock_put,
    ):
        yield {"get": mock_get, "update": mock_put}


@pytest.fixture
def mock_proof_service() -> Generator[AsyncMock]:
    """Fixture to mock the internal Proof Service client."""
    with patch("app.store_proof", new_callable=AsyncMock) as mock_store:
        yield mock_store


@pytest.fixture
def mock_amqp() -> Generator[AsyncMock]:
    """Fixture to mock RabbitMQ event publishing."""
    with patch("app.amqp_service.publish_job_done", new_callable=AsyncMock) as mock_pub:
        yield mock_pub
