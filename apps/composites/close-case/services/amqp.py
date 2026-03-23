"""AMQP publisher wrapper for the Close Case service.

Re-uses the shared RabbitMQClient but adds a convenience helper
for emitting the Job_Done event so that app.py stays clean.
"""

from __future__ import annotations

import json

import structlog
from config import settings
from townops_shared.utils.rabbitmq import RabbitMQClient

log = structlog.get_logger(__name__)

# Module-level singleton — shared across the lifespan of the application.
_rabbitmq: RabbitMQClient | None = None


def get_rabbitmq() -> RabbitMQClient:
  """Return the module-level RabbitMQClient, creating it on first call."""
  global _rabbitmq
  if _rabbitmq is None:
    _rabbitmq = RabbitMQClient()
  return _rabbitmq


async def connect() -> None:
  """Open the RabbitMQ connection and declare the exchange."""
  client = get_rabbitmq()
  await client.connect()
  await client.declare_exchange(settings.job_done_exchange, "topic")
  log.info("AMQP ready", exchange=settings.job_done_exchange)


async def disconnect() -> None:
  """Close the RabbitMQ connection on shutdown."""
  client = get_rabbitmq()
  await client.disconnect()


async def publish_job_done(case_id: int, uploader_id: int) -> None:
  """
  Publish a Job_Done event to RabbitMQ.

  Payload example::

      {
        "event": "Job_Done",
        "case_id": 101,
        "uploader_id": 9001
      }
  """
  client = get_rabbitmq()
  body = json.dumps(
    {
      "event": "Job_Done",
      "case_id": case_id,
      "uploader_id": uploader_id,
    }
  ).encode()

  await client.publish(
    exchange_name=settings.job_done_exchange,
    routing_key=settings.job_done_routing_key,
    message_body=body,
  )
  log.info(
    "Job_Done event published",
    case_id=case_id,
    routing_key=settings.job_done_routing_key,
  )
