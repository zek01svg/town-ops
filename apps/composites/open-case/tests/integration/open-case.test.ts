import { AMQPClient } from "@cloudamqp/amqp-client";
/* eslint-disable import/first */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// 1. Set up environment variables via vi.hoisted to satisfy orchestrator load validation correctly.
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5001";
  process.env.RESIDENT_ATOM_URL = "http://resident-atom";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.JWT_SECRET = "supersecret";

  // shared-observability OpenTelemetry variables (Needed by underlying packages)
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
});

// Bypass JWK in orchestrator validation so we focus strictly on the logical workflow routing.
vi.mock("hono/jwk", () => ({
  jwk: () => (_c: any, next: () => Promise<void>) => next(),
  __esModule: true,
}));

// Now import app AFTER env is setup (Standard Node loading trigger)
import { app } from "../../src/index";

describe("Open Case Composite - RabbitMQ Integration", () => {
  let amqpClient: AMQPClient | null = null;

  beforeAll(async () => {
    // global-setup.ts guarantees process.env.RABBITMQ_URL is populated with Testcontainers address
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      throw new Error(
        "RABBITMQ_URL environment variable is missing in Integration Test run!"
      );
    }
    amqpClient = new AMQPClient(url);
    await amqpClient.connect();
  });

  afterAll(async () => {
    if (amqpClient) {
      await amqpClient.close();
    }
  });

  it("should successfully open case and submit actual AMQP event to RabbitMQ container", async () => {
    if (!amqpClient) throw new Error("AMQP Client failed to initialize!");
    const ch = await amqpClient.channel();

    const EXCHANGE_NAME = "townops.events";
    const ROUTING_KEY = "case.opened";

    // 1. Arrange state - Declare queue and bind to verify receipt of message
    await ch.exchangeDeclare(EXCHANGE_NAME, "topic", { durable: true });
    const q = await ch.queueDeclare("", { autoDelete: true, exclusive: true });
    const queueName = q.name;
    await ch.queueBind(queueName, EXCHANGE_NAME, ROUTING_KEY);

    // 2. Mock downstream service fetches
    const MOCK_BODY = {
      resident_id: "234e5678-e89b-12d3-a456-426614174002",
      category: "Maintenance",
      priority: "high",
      description: "Broken window left building",
    };

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/residents/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: MOCK_BODY.resident_id, name: "Alice Doe" }),
        };
      }
      if (url.includes("/api/cases/new-case")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            cases: { id: "876e5432-e89b-12d3-a456-426614174003" },
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    // 3. Setup RabbitMQ Message Listener before triggering flow
    let receivedPayload: any = null;
    await ch.basicConsume(queueName, { noAck: true }, (msg) => {
      receivedPayload = JSON.parse(msg.bodyString() || "{}");
    });

    // 4. Act - Execute orchestrator trigger hitting local Hono handler
    const res = await app.request("/api/cases/open-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(MOCK_BODY),
    });

    expect(res.status).toBe(201);

    // Wait for the consumer to read execution frame asynchronously
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 5. Assert - Message ACTUALLY travelled through AMQP channel to verify orchestrator bridge
    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload).toHaveProperty("residentId", MOCK_BODY.resident_id);
    expect(receivedPayload).toHaveProperty("category", MOCK_BODY.category);

    await ch.queueDelete(queueName);
  });
});
