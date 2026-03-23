import json
from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from fastapi import status
from src.config import settings
from src.worker import process_sla_breached, start_worker


class MockMessage:
  def __init__(self, body: bytes) -> None:
    self.body = body


@pytest.mark.anyio
@respx.mock
async def test_process_sla_breached_success(respx_mock):
  # Setup mocks for client calls
  case_id = "101"
  assignment_id = "202"
  contractor_id = "303"

  respx_mock.get(
    f"{settings.OUTSYSTEMS_URL}/contractors/backup?case_id={case_id}"
  ).mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"worker_id": "backup_01"})
  )
  respx_mock.put(f"{settings.ASSIGNMENT_ATOM_URL}/assignments/{assignment_id}").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"success": True})
  )
  respx_mock.put(f"{settings.CASE_ATOM_URL}/cases/{case_id}/status").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"success": True})
  )
  respx_mock.post(f"{settings.METRICS_ATOM_URL}/metrics/penalty").mock(
    return_value=httpx.Response(status.HTTP_201_CREATED, json={"success": True})
  )

  # Mock RabbitMQClient
  mock_rmq = AsyncMock()

  message_body = json.dumps(
    {"case_id": case_id, "assignment_id": assignment_id, "contractor_id": contractor_id}
  ).encode("utf-8")
  mock_msg = MockMessage(body=message_body)

  async with httpx.AsyncClient() as client:
    # Call the worker handler
    await process_sla_breached(mock_msg, client, mock_rmq)

  # Verify RabbitMQ publish was called for alert
  mock_rmq.publish.assert_called_once()
  _args, kwargs = mock_rmq.publish.call_args
  assert kwargs["exchange_name"] == "alert.events"
  assert kwargs["routing_key"] == "alert.escalated"


@pytest.mark.anyio
async def test_start_worker():
  mock_rmq = AsyncMock()
  mock_http = AsyncMock()

  await start_worker(mock_rmq, mock_http)

  mock_rmq.declare_exchange.assert_called_once_with("alert.events", "topic")
  mock_rmq.consume.assert_called_once()
  _args, kwargs = mock_rmq.consume.call_args
  assert kwargs["queue_name"] == "handle_breach.sla_breached"
  assert kwargs["exchange_name"] == "assignment.events.dlx"
  assert kwargs["routing_key"] == "assignment.sla_breached"
