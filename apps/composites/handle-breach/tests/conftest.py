from collections.abc import Generator
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from src.main import app


@pytest.fixture
def client() -> Generator[TestClient]:
  """FastAPI TestClient with lifespan triggers connected."""
  # We mock the RabbitMQ connect in lifespan to avoid real AMQP connection errors
  with (
    patch("src.main.RabbitMQClient.connect", new_callable=AsyncMock),
    patch("src.main.RabbitMQClient.disconnect", new_callable=AsyncMock),
    patch("src.main.start_worker", return_value=AsyncMock()),
    TestClient(app) as c,
  ):
    yield c


@pytest.fixture
def mock_amqp_publish() -> Generator[AsyncMock]:
  """Mock RabbitMQClient.publish for verification."""
  with patch("src.worker.RabbitMQClient.publish", new_callable=AsyncMock) as mock_pub:
    yield mock_pub
