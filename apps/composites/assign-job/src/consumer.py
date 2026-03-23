import json
import logging

import aio_pika
from townops_shared.utils.rabbitmq import RabbitMQClient

from .services import assign_contractor

logger = logging.getLogger(__name__)

client = RabbitMQClient()


async def process_case_opened_message(body: dict) -> None:
  try:
    await assign_contractor(
      case_id=body["case_id"],
      postal_code=body["postal_code"],
      category_code=body["category_code"],
    )
    logger.info("Assignment created for case %s", body["case_id"])
  except Exception:
    logger.exception("Failed to process Case_Opened")
    raise


async def _on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
  body = json.loads(message.body)
  await process_case_opened_message(body)


async def start_consumer() -> None:
  await client.connect()
  await client.consume(queue_name="case.opened", callback=_on_message)
