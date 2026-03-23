from collections.abc import Generator

import pytest
from starlette.testclient import TestClient
from testcontainers.rabbitmq import RabbitMqContainer


@pytest.fixture(scope="session")
def rabbitmq_container() -> Generator[str]:
  """Start RabbitMQ testcontainer once per session for integration tests."""
  with RabbitMqContainer("rabbitmq:4-management") as container:
    import time

    time.sleep(5)  # Give RabbitMQ time to be fully ready
    host = container.get_container_host_ip()
    port = container.get_exposed_port(5672)
    url = f"amqp://{container.username}:{container.password}@{host}:{port}/"

    # Set environment variable for shared utils
    import os

    os.environ["RABBITMQ_URL"] = url

    from src.config import settings

    settings.RABBITMQ_URL = url
    yield url


@pytest.fixture
def client(_rabbitmq_container) -> Generator[TestClient]:
  """FastAPI TestClient with real RabbitMQ connection."""
  from src.main import app

  with TestClient(app) as c:
    yield c
