import asyncio
import os
from unittest.mock import AsyncMock, Mock, patch

import pytest
from src.consumer import process_case_opened_message


@pytest.fixture(autouse=True)
def mock_env():
  with patch.dict(
    os.environ,
    {
      "METRICS_URL": "http://metrics",
      "CONTRACTOR_API_URL": "http://contractor",
      "ASSIGNMENT_URL": "http://assignment",
    },
  ):
    yield


def test_full_pipeline_success():
  async def run() -> None:
    # Mock HTTPAyncClient completely to simulate real endpoints
    mock_search_resp = Mock()
    mock_search_resp.json.return_value = [{"ContractorUuid": "contractor-123"}]

    # metrics Response
    mock_metrics_resp = Mock()
    mock_metrics_resp.json.return_value = {
      "metrics": [{"score_delta": 10}, {"score_delta": 5}]
    }

    # assignment Response
    mock_assign_resp = Mock()
    mock_assign_resp.json.return_value = {"id": "assign-999", "status": "PENDING"}

    # Setup the client mock to return these responses in sequence or based on URL
    # To keep it simple, we can patch the AsyncClient itself

    class MockAsyncClient:
      async def __aenter__(self) -> MockAsyncClient:
        return self

      async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        pass

      async def get(self, url: str, **kwargs) -> Mock:  # noqa: ARG002, ANN003
        if "contractors/search" in url:
          return mock_search_resp
        if "metrics" in url:
          return mock_metrics_resp
        raise ValueError("Unmapped URL")  # noqa: TRY003

      async def post(self, url: str, **kwargs) -> Mock:  # noqa: ARG002, ANN003
        if "assignments" in url:
          return mock_assign_resp
        raise ValueError("Unmapped URL")  # noqa: TRY003

    with (
      patch("src.services.httpx.AsyncClient", return_value=MockAsyncClient()),
      patch(
        "src.services.publish_job_assigned", new_callable=AsyncMock
      ) as mock_publish,
    ):
      # Message body from RabbitMQ
      body = {
        "case_id": "case-456",
        "postal_code": "560123",
        "category_code": "ELEC",
      }

      # Act
      await process_case_opened_message(body)

      # Assert
      # 1. Verify correct publisher call
      mock_publish.assert_called_once_with(
        assignment_id="assign-999",
        case_id="case-456",
        contractor_id="contractor-123",
      )

  asyncio.run(run())
