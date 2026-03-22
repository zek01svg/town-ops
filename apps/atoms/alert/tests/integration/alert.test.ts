import { AMQPClient } from "@cloudamqp/amqp-client";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("Alert Queue Integration Tests", () => {
  let client: AMQPClient | null = null;

  beforeAll(async () => {
    const url = process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672";
    client = new AMQPClient(url);
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  describe("Routing Bindings", () => {
    const routingKeys = [
      "job.assigned",
      "case.escalated",
      "case.no_access",
      "job.done",
    ];

    it.each(routingKeys)(
      "should successfully route '%s' message through townops.events exchange",
      async (routingKey) => {
        if (!client) throw new Error("client is not initialized");
        const ch = await client.channel();

        // Explicitly declare exchange to guarantee arranged state
        await ch.exchangeDeclare("townops.events", "topic", { durable: true });

        // Create a temporary exclusive queue to avoid concurrent consumer races
        const q = await ch.queueDeclare("", {
          autoDelete: true,
          exclusive: true,
        });
        const queueName = q.name;

        await ch.queueBind(queueName, "townops.events", routingKey);

        const payload = {
          caseId: "123e4567-e89b-12d3-a456-426614174000",
          message: `Integration Test Route Check for ${routingKey}`,
        };

        // Publish to exchange
        await ch.basicPublish(
          "townops.events",
          routingKey,
          JSON.stringify(payload)
        );

        // Setup listener
        let received: any = null;
        await ch.basicConsume(queueName, { noAck: true }, (msg) => {
          received = JSON.parse(msg.bodyString() || "{}");
        });

        // Wait for async consumption
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(received).not.toBeNull();
        expect(received).toHaveProperty("caseId", payload.caseId);
        expect(received.message).toContain(routingKey);

        await ch.queueDelete(queueName);
      }
    );
  });

  describe("Dead Letter Exchange (DLX)", () => {
    it("should route messages landed on townops.dlx to sinks bound with wildcards", async () => {
      if (!client) throw new Error("client is not initialized");
      const ch = await client.channel();

      // Explicitly declare DLX to guarantee arranged state
      await ch.exchangeDeclare("townops.dlx", "topic", { durable: true });

      const q = await ch.queueDeclare("", {
        autoDelete: true,
        exclusive: true,
      });
      const queueName = q.name;

      // Bind to DLX using multi-matching wildcard '#'
      await ch.queueBind(queueName, "townops.dlx", "#");

      const errorPayload = {
        error: "Trigger DLX dead-letter chain test",
        originalMessage: "Malformed input data exception",
      };

      await ch.basicPublish(
        "townops.dlx",
        "alert.reject.malformed",
        JSON.stringify(errorPayload)
      );

      let received: any = null;
      await ch.basicConsume(queueName, { noAck: true }, (msg) => {
        received = JSON.parse(msg.bodyString() || "{}");
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(received).not.toBeNull();
      expect(received.error).toBe("Trigger DLX dead-letter chain test");

      await ch.queueDelete(queueName);
    });
  });
});
