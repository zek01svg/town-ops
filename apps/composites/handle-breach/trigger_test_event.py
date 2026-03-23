import asyncio
import json
import logging

from dotenv import load_dotenv
from townops_shared.utils.rabbitmq import RabbitMQClient

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main() -> None:
  logger.info("Connecting to RabbitMQ to trigger a mock SLA_Breached event...")
  # Initialize the shared RabbitMQ Client
  # It pulls the RABBITMQ_URL from the environment automatically
  rmq_client = RabbitMQClient()
  await rmq_client.connect()

  # The payload the Handle Breach worker expects
  mock_payload = {
    "assignment_id": "assign_001_mock",
    "case_id": "case_999_mock",
    "contractor_id": "contractor_alpha_1",
  }

  # Ensure the DLX exchange exists just in case it hasn't been created yet
  await rmq_client.declare_exchange("assignment.events.dlx", "topic")

  logger.info("Publishing mock event...")
  await rmq_client.publish(
    exchange_name="assignment.events.dlx",
    routing_key="assignment.sla_breached",
    message_body=json.dumps(mock_payload).encode("utf-8"),
  )

  logger.info("Event successfully published! Watch the terminal to see logs.")
  await rmq_client.disconnect()


if __name__ == "__main__":
  asyncio.run(main())
