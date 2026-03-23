import json
import logging

import aio_pika
from townops_shared.utils.rabbitmq import RabbitMQClient

from . import clients

logger = logging.getLogger(__name__)


async def process_sla_breached(message: aio_pika.abc.AbstractIncomingMessage) -> None:
  """
  Consumes the SLA_Breached event.
  Process:
  1. Re-query Contractor for backup worker.
  2. Update Assignment to new worker.
  3. Update Case state to ESCALATED.
  4. Record penalty.
  5. Emit AMQP signal to Alert service.
  """
  try:
    payload = json.loads(message.body.decode("utf-8"))
    assignment_id = payload.get("assignment_id")
    case_id = payload.get("case_id")
    contractor_id = payload.get("contractor_id")

    if not assignment_id or not case_id:
      logger.error("Invalid SLA_Breached payload: %s", payload)
      return  # Ignore bad payload

    logger.info(
      "Processing SLA breach for Case: %s, Assignment: %s", case_id, assignment_id
    )

    # 1. Re-query Contractor (OutSystems) for backup worker
    backup_worker_info = await clients.query_backup_worker(case_id)
    new_worker_id = backup_worker_info.get("worker_id", "fallback_worker_01")

    # 2. Update Assignment to new worker
    await clients.update_assignment_worker(
      assignment_id, {"assigned_to": new_worker_id, "status": "REASSIGNED"}
    )

    # 3. Update Case state to ESCALATED
    await clients.update_case_escalated(case_id)

    # 4. Push penalty to Metrics atom
    await clients.record_penalty(
      {
        "entity_id": contractor_id,
        "penalty_score": 10.0,
        "reason": "SLA_BREACH_NO_ACKNOWLEDGEMENT",
        "assignment_id": assignment_id,
      }
    )

    # 5. Emit AMQP signal to Alert service
    rmq_client = RabbitMQClient()
    await rmq_client.connect()
    await rmq_client.declare_exchange("alert.events", "topic")
    await rmq_client.publish(
      exchange_name="alert.events",
      routing_key="alert.escalated",
      message_body=json.dumps(
        {
          "case_id": case_id,
          "assignment_id": assignment_id,
          "message": (
            f"Case {case_id} escalated due to contractor SLA breach. "
            f"Reassigned to {new_worker_id}."
          ),
        }
      ).encode("utf-8"),
    )
    logger.info("SLA breach processed successfully for %s", assignment_id)

  except Exception:
    logger.exception("Error handling SLA_Breached")
    raise  # NACK to requeue/DLX


async def start_worker() -> None:
  rmq_client = RabbitMQClient()
  await rmq_client.connect()

  # Needs to be bound to Assignment atom's DLX emitted events
  await rmq_client.consume(
    queue_name="handle_breach.sla_breached",
    callback=process_sla_breached,
    exchange_name="assignment.events.dlx",
    routing_key="assignment.sla_breached",
  )


if __name__ == "__main__":
  import asyncio

  logging.basicConfig(level=logging.INFO)
  asyncio.run(start_worker())
