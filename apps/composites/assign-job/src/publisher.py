import json
import logging

from townops_shared.utils.rabbitmq import RabbitMQClient

logger = logging.getLogger(__name__)

# Module-level client to reuse connection across requests
client = RabbitMQClient()


async def publish_job_assigned(
  assignment_id: str,
  case_id: str,
  contractor_id: str,
) -> None:
  body = json.dumps(
    {
      "assignment_id": assignment_id,
      "case_id": case_id,
      "contractor_id": contractor_id,
      "status": "PENDING_ACCEPTANCE",
    }
  ).encode()

  # publish("") uses the Default Exchange in aio-pika
  await client.publish(
    exchange_name="",
    routing_key="job.assigned",
    message_body=body,
  )
  logger.info("Published Job_Assigned for case %s", case_id)
