import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from src.consumer import process_case_opened_message


def test_process_case_opened_message_success():
  async def run() -> None:
    with patch("src.consumer.assign_contractor", new_callable=AsyncMock) as mock_assign:
      # Arrange
      body = {
        "case_id": "case-123",
        "postal_code": "560123",
        "category_code": "ELEC",
      }

      # Act
      await process_case_opened_message(body)

      # Assert
      mock_assign.assert_called_once_with(
        case_id="case-123",
        postal_code="560123",
        category_code="ELEC",
      )

  asyncio.run(run())


def test_process_case_opened_message_failure():
  async def run() -> None:
    with patch("src.consumer.assign_contractor", new_callable=AsyncMock) as mock_assign:
      # Arrange
      mock_assign.side_effect = ValueError("Test failure")
      body = {
        "case_id": "case-123",
        "postal_code": "560123",
        "category_code": "ELEC",
      }

      # Act & Assert
      with pytest.raises(ValueError, match="Test failure"):
        await process_case_opened_message(body)

      mock_assign.assert_called_once()

  asyncio.run(run())
