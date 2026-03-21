import json
import logging
import os

import aio_pika

from .services import assign_contractor

logger = logging.getLogger(__name__)


async def start_consumer() -> None:
  connection = await aio_pika.connect_robust(os.getenv("RABBITMQ_URL"))
  async with connection:
    channel = await connection.channel()
    queue = await channel.declare_queue("case.opened", durable=True)

    async with queue.iterator() as messages:
      async for message in messages:
        async with message.process():
          try:
            body = json.loads(message.body)
            await assign_contractor(
              case_id=body["case_id"],
              postal_code=body["postal_code"],
              category_code=body["category_code"],
            )
            logger.info("Assignment created for case %s", body["case_id"])
          except Exception:
            logger.exception("Failed to process Case_Opened")
            raise
