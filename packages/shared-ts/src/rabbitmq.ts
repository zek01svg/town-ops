import { AMQPClient } from "@cloudamqp/amqp-client";
import type { AMQPChannel, AMQPMessage } from "@cloudamqp/amqp-client";

import { env } from "./env";
import { logger } from "./logger";

type QueueName =
  | "assign-job-queue"
  | "alert-queue"
  | "metrics-queue"
  | "handle-breach-queue"
  | "error-audit-queue"
  | "sla-timers-queue";

const DEFAULT_QUEUE_ARGUMENTS: Record<
  QueueName,
  Record<string, string> | undefined
> = {
  "assign-job-queue": { "x-dead-letter-exchange": "townops.dlx" },
  "alert-queue": { "x-dead-letter-exchange": "townops.dlx" },
  "metrics-queue": { "x-dead-letter-exchange": "townops.dlx" },
  "handle-breach-queue": { "x-dead-letter-exchange": "townops.dlx" },
  "error-audit-queue": undefined,
  "sla-timers-queue": {
    "x-dead-letter-exchange": "townops.events",
    "x-dead-letter-routing-key": "sla.breached",
  },
};

/**
 * @class RabbitMQClient
 * @description A client for interacting with RabbitMQ.
 */
class RabbitMQClient {
  private client: AMQPClient | null = null;
  private connection: Awaited<ReturnType<AMQPClient["connect"]>> | null = null;
  private channel: AMQPChannel | null = null;

  /**
   * @method connect
   * @description Establishes a connection to RabbitMQ.
   */
  async connect(): Promise<void> {
    if (this.channel) return;

    const url = env.RABBITMQ_URL;
    if (!url) {
      throw new Error("RABBITMQ_URL environment variable is not set");
    }

    try {
      this.client = new AMQPClient(url);
      this.connection = await this.client.connect();
      this.channel = await this.connection.channel();
      logger.info("RabbitMQ connection established");
    } catch (e) {
      logger.error({ err: e }, "Failed to connect to RabbitMQ");
      throw e;
    }
  }

  /**
   * @method disconnect
   * @description Closes the RabbitMQ connection.
   */
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.channel = null;
      this.connection = null;
      logger.info("RabbitMQ connection closed");
    }
  }

  /**
   * @method declareExchange
   * @description Declares an exchange if it does not exist.
   */
  async declareExchange(
    name: string,
    type: "direct" | "fanout" | "topic" | "headers" = "topic"
  ): Promise<void> {
    if (!this.channel) await this.connect();
    const channel = this.channel;
    if (!channel) throw new Error("RabbitMQ channel not connected");
    await channel.exchangeDeclare(name, type, { durable: true });
  }

  /**
   * @method publish
   * @param exchangeName - The name of the exchange to publish to.
   * @param routingKey - The routing key to publish to.
   * @param message - The message to publish.
   * @param options - Optional parameters for publishing the message.
   * @description Publishes a message to an exchange.
   */
  async publish(
    exchangeName: "townops.events" | "townops.dlx",
    routingKey:
      | "case.opened"
      | "case.escalated"
      | "case.no_access"
      | "job.assigned"
      | "job.done"
      | "sla.breached"
      | "#",
    message: string | object,
    options?: { contentType?: string }
  ): Promise<void> {
    if (!this.channel) await this.connect();
    const channel = this.channel;
    if (!channel) throw new Error("RabbitMQ channel not connected");

    const data =
      typeof message === "string" ? message : JSON.stringify(message);
    const contentType =
      options?.contentType ||
      (typeof message === "object" ? "application/json" : "text/plain");

    await channel.basicPublish(exchangeName, routingKey, data, {
      contentType,
      deliveryMode: 2, // 2 = persistent - survives broker restarts
    });
    logger.debug({ exchangeName, routingKey }, "Message published to RabbitMQ");
  }

  /**
   * @method consume
   * @param queueName - The name of the queue to consume from.
   * @param callback - The callback function to handle messages.
   * @param options - Optional parameters for consuming messages.
   * @description Consumes messages from a queue with callback handler and automatic/requeue ACK handling.
   */
  async consume(
    queueName: QueueName,
    callback: (message: AMQPMessage) => Promise<void>,
    options?: {
      exchangeName?: "townops.events" | "townops.dlx";
      routingKey?:
        | "case.opened"
        | "case.escalated"
        | "case.no_access"
        | "job.assigned"
        | "job.done"
        | "sla.breached"
        | "#";
      arguments?: Record<string, any>;
    }
  ): Promise<unknown> {
    if (!this.channel) await this.connect();
    const channel = this.channel;
    if (!channel) throw new Error("RabbitMQ channel not connected");

    // Set prefetch to 1 for fair dispatching
    await channel.basicQos(1);

    const queueArguments = DEFAULT_QUEUE_ARGUMENTS[queueName]
      ? { ...DEFAULT_QUEUE_ARGUMENTS[queueName], ...options?.arguments }
      : options?.arguments;

    const q = await channel.queue(queueName, { durable: true }, queueArguments);

    // Optional binding to an exchange
    if (options?.exchangeName && options.routingKey) {
      await channel.exchangeDeclare(options.exchangeName, "topic", {
        durable: true,
      });
      await channel.queueBind(
        queueName,
        options.exchangeName,
        options.routingKey
      );
      logger.info(
        {
          queueName,
          exchangeName: options.exchangeName,
          routingKey: options.routingKey,
        },
        "Bound queue to exchange"
      );
    }

    logger.info({ queueName }, "Starting RabbitMQ consumer");

    const consumer = await q.subscribe(
      { noAck: false },
      async (msg: AMQPMessage) => {
        try {
          await callback(msg);
          await msg.ack();
        } catch (e) {
          logger.error(
            { err: e, queueName },
            "Error processing RabbitMQ message"
          );
          // Requeue set to false, so it gets handled by DLX if configured
          await msg.nack(true, false);
        }
      }
    );

    return consumer;
  }
}

/**
 * @description A singleton instance of RabbitMQClient.
 */
export const rabbitmqClient = new RabbitMQClient();
