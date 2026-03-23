import asyncio
import os
from unittest.mock import ANY, AsyncMock, Mock, patch

import httpx
import pytest
from src.services import (
  _create_assignment,
  _search_contractors,
  assign_contractor,
  get_metrics,
  select_best,
)


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


# --- Existing Tests ---


def test_select_best_picks_lowest_jobs():
  contractors = [
    {"contractor_id": "uuid-1", "total_jobs": 10, "total_score": 50},
    {"contractor_id": "uuid-2", "total_jobs": 3, "total_score": 40},
    {"contractor_id": "uuid-3", "total_jobs": 7, "total_score": 60},
  ]
  result = select_best(contractors)
  assert result["contractor_id"] == "uuid-2"


def test_select_best_uses_score_as_tiebreaker():
  contractors = [
    {"contractor_id": "uuid-1", "total_jobs": 5, "total_score": 30},
    {"contractor_id": "uuid-2", "total_jobs": 5, "total_score": 80},
  ]
  result = select_best(contractors)
  assert result["contractor_id"] == "uuid-2"


def test_sector_code_extraction():
  postal_code = "560123"
  sector_code = postal_code[:2]
  assert sector_code == "56"


# --- New Unit Tests ---


def test_get_metrics_success():
  async def run() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    mock_resp = Mock()
    mock_resp.json.return_value = {
      "metrics": [{"score_delta": 10}, {"score_delta": -2}, {"score_delta": 5}]
    }
    client.get.return_value = mock_resp

    result = await get_metrics(client, "contractor-1")

    assert result["contractor_id"] == "contractor-1"
    assert result["total_jobs"] == 3
    assert result["total_score"] == 13
    client.get.assert_called_once_with("http://metrics/api/metrics/contractor-1")

  asyncio.run(run())


def test_search_contractors_success():
  async def run() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    mock_resp = Mock()
    mock_resp.json.return_value = [{"ContractorUuid": "1"}, {"ContractorUuid": "2"}]
    client.get.return_value = mock_resp

    result = await _search_contractors(client, "56", "ELEC")

    assert len(result) == 2
    client.get.assert_called_once_with(
      "http://contractor/contractors/search",
      params={"SectorCode": "56", "CategoryCode": "ELEC"},
    )

  asyncio.run(run())


def test_create_assignment_success():
  async def run() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    mock_resp = Mock()
    mock_resp.json.return_value = {"id": "assign-1", "status": "PENDING"}
    client.post.return_value = mock_resp

    result = await _create_assignment(client, "case-123", "contractor-456")

    assert result["id"] == "assign-1"
    client.post.assert_called_once_with(
      "http://assignment/assignments",
      json={
        "case_id": "case-123",
        "contractor_id": "contractor-456",
        "source": "AUTO_ASSIGN",
      },
    )

  asyncio.run(run())


def test_assign_contractor_success():
  async def run() -> None:
    with (
      patch("src.services._search_contractors") as mock_search,
      patch("src.services._fetch_metrics_for_contractors") as mock_fetch_metrics,
      patch("src.services._create_assignment") as mock_assign,
      patch("src.services.publish_job_assigned") as mock_publish,
    ):
      mock_search.return_value = [{"ContractorUuid": "1"}]
      mock_fetch_metrics.return_value = [
        {"contractor_id": "1", "total_jobs": 2, "total_score": 100}
      ]
      mock_assign.return_value = {"id": "assign-1"}

      result = await assign_contractor("case-123", "560123", "ELEC")

      assert result["id"] == "assign-1"
      mock_search.assert_called_once()
      mock_fetch_metrics.assert_called_once()
      mock_assign.assert_called_once_with(ANY, "case-123", "1")
      mock_publish.assert_called_once_with(
        assignment_id="assign-1", case_id="case-123", contractor_id="1"
      )

  asyncio.run(run())


def test_assign_contractor_no_eligible_contractors():
  async def run() -> None:
    with patch("src.services._search_contractors") as mock_search:
      mock_search.return_value = []

      with pytest.raises(ValueError, match="No eligible contractors found"):
        await assign_contractor("case-123", "560123", "ELEC")

  asyncio.run(run())
