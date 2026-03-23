import json
import logging
import os

import aio_pika

logger = logging.getLogger(__name__)


async def publish_job_assigned(
  assignment_id: str,
  case_id: str,
  contractor_id: str,
) -> None:
  connection = await aio_pika.connect_robust(os.getenv("RABBITMQ_URL"))
  async with connection:
    channel = await connection.channel()
    await channel.default_exchange.publish(
      aio_pika.Message(
        body=json.dumps(
          {
            "assignment_id": assignment_id,
            "case_id": case_id,
            "contractor_id": contractor_id,
            "status": "PENDING_ACCEPTANCE",
          }
        ).encode(),
      ),
      routing_key="job.assigned",
    )
    logger.info("Published Job_Assigned for case %s", case_id)
