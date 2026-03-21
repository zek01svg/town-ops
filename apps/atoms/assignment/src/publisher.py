import json
import os

import aio_pika


async def publish_job_assigned(assignment_id: int, case_id: int, contractor_id: int):
  payload = {
    "assignment_id": assignment_id,
    "case_id": case_id,
    "contractor_id": contractor_id,
    "status": "PENDING_ACCEPTANCE",
  }
  # helps connect to RabbitMQ
  connection = await aio_pika.connect_robust(os.getenv("RABBITMQ_URL"))
  async with connection:
    channel = await connection.channel()
    # Opens a channel for publishing
    await channel.default_exchange.publish(
      aio_pika.Message(body=json.dumps(payload).encode()),
      routing_key="job.assigned",
    )
