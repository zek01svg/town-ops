from typing import Any
from unittest.mock import ANY, MagicMock

from fastapi import status
from fastapi.testclient import TestClient


def test_full_close_case_pathway(
  client: TestClient,
  valid_close_payload: dict[str, Any],
  mock_case_service: dict[str, Any],
  mock_proof_service: MagicMock,
  mock_amqp: MagicMock,
) -> None:
  """
  Integration-style orchestration test for the full Close Case workflow.
  Checks that all services are called in the correct order with correct params.
  """
  mock_case_service["get"].return_value = {"id": 101, "status": "ASSIGNED"}
  mock_proof_service.return_value = {"id": 505}
  mock_case_service["update"].return_value = {"id": 101, "status": "CLOSED"}

  response = client.post("/close-case", json=valid_close_payload)

  assert response.status_code == status.HTTP_200_OK
  data = response.json()
  assert data["success"] is True
  assert data["proof_stored"] == 1
  assert data["case_id"] == 101

  import json

  mock_case_service["get"].assert_called_once_with(ANY, 101)
  mock_proof_service.assert_called_once_with(ANY, 101, 9001, ANY)
  mock_case_service["update"].assert_called_once_with(ANY, 101, "CLOSED")

  expected_msg = json.dumps({"case_id": "101", "uploader_id": 9001}).encode()
  mock_amqp.assert_called_once_with(
    exchange_name="townops.events", routing_key="job.done", message_body=expected_msg
  )


def test_job_done_failure_is_non_fatal(
  client: TestClient,
  valid_close_payload: dict[str, Any],
  mock_case_service: dict[str, Any],
  mock_proof_service: MagicMock,
  mock_amqp: MagicMock,
) -> None:
  """
  Checks that if RabbitMQ publishing fails, the overall request still succeeds.
  """
  mock_case_service["get"].return_value = {"id": 101}
  mock_proof_service.return_value = {"id": 505}
  mock_case_service["update"].return_value = {"id": 101, "status": "CLOSED"}

  mock_amqp.side_effect = Exception("Connection lost")

  response = client.post("/close-case", json=valid_close_payload)

  assert response.status_code == status.HTTP_200_OK
  assert response.json()["success"] is True
  mock_case_service["update"].assert_called_once()
  mock_amqp.assert_called_once()
