import os
from collections.abc import Awaitable, Callable

import aio_pika
import structlog

log = structlog.get_logger(__name__)


class RabbitMQClient:
  def __init__(self) -> None:
    self.connection: aio_pika.abc.AbstractConnection | None = None
    self.channel: aio_pika.abc.AbstractChannel | None = None

  async def connect(self) -> None:
    """
    Establishes a robust connection to RabbitMQ to survive network drops.
    """
    if self.connection and not self.connection.is_closed:
      return

    url = os.getenv("RABBITMQ_URL")
    if not url:
      raise ValueError("RABBITMQ_URL is not set")  # noqa: TRY003

    self.connection = await aio_pika.connect_robust(
      url, client_properties={"connection_name": "townops-composite"}
    )
    self.channel = await self.connection.channel()
    log.info("RabbitMQ connection established")

  async def disconnect(self) -> None:
    """
    Closes the RabbitMQ connection.
    """
    if self.connection:
      await self.connection.close()
      log.info("RabbitMQ connection closed")

  async def declare_exchange(
    self, name: str, exchange_type: str = "topic"
  ) -> aio_pika.abc.AbstractExchange:
    """
    Declares an exchange for publishing messages.
    """
    if not self.channel:
      await self.connect()
    if self.channel is None:
      raise RuntimeError("RabbitMQ channel not connected")  # noqa: TRY003
    return await self.channel.declare_exchange(name, exchange_type, durable=True)

  async def publish(
    self,
    exchange_name: str,
    routing_key: str,
    message_body: bytes,
    content_type: str = "application/json",
  ) -> None:
    """
    Publishes a message to an exchange.
    """
    if not self.channel:
      await self.connect()
    if self.channel is None:
      raise RuntimeError("RabbitMQ channel not connected")  # noqa: TRY003

    exchange = await self.channel.get_exchange(exchange_name)
    await exchange.publish(
      aio_pika.Message(
        body=message_body,
        content_type=content_type,
      ),
      routing_key=routing_key,
    )
    log.debug("Message published", exchange=exchange_name, routing_key=routing_key)

  async def consume(
    self,
    queue_name: str,
    callback: Callable[[aio_pika.abc.AbstractIncomingMessage], Awaitable[None]],
    exchange_name: str | None = None,
    routing_key: str | None = None,
    arguments: dict[str, any] | None = None,
  ) -> None:
    """
    Continuously consumes from a queue and executes an async callback for each message.
    Optional binding to an exchange with optional arguments for queue declaration.
    """
    if not self.channel:
      await self.connect()
    if self.channel is None:
      raise RuntimeError("RabbitMQ channel not connected")  # noqa: TRY003

    await self.channel.set_qos(prefetch_count=1)
    queue = await self.channel.declare_queue(
      queue_name, durable=True, arguments=arguments
    )

    if exchange_name and routing_key:
      exchange = await self.channel.declare_exchange(
        exchange_name, "topic", durable=True
      )
      await queue.bind(exchange, routing_key=routing_key)
      log.info(
        "Queue bound to exchange",
        queue=queue_name,
        exchange=exchange_name,
        routing_key=routing_key,
      )

    log.info("Starting consumer", queue=queue_name)
    async with queue.iterator() as queue_iter:
      async for message in queue_iter:
        # message.process() automatically ACKs on exit if no exception was raised,
        # or NACKs with requeue if an exception is raised inside the context block.
        async with message.process():
          try:
            await callback(message)
          except Exception as e:
            log.exception(
              "Error processing message",
              error=str(e),
              queue=queue_name,
              message_id=message.message_id,
            )
            # Re-raise to trigger NACK and potential requeue
            raise
