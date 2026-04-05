import { AMQPClient } from "@cloudamqp/amqp-client";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// 1. Set up environment via vi.hoisted
vi.hoisted(() => {
  process.env.PORT = "6005";
  process.env.CONTRACTOR_API_URL = "http://contractor-api";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.METRICS_ATOM_URL = "http://metrics-atom";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";

  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
});

// Mock jwk middleware for integration test (we focus on AMQP)
vi.mock("hono/jwk", () => ({
  jwk: () => (_c: any, next: () => Promise<void>) => next(),
}));

/* eslint-disable import/first */
import { handleSlaBreach } from "../../src/worker";
/* eslint-enable import/first */

describe("Handle Breach Composite - RabbitMQ Integration", () => {
  let amqpClient: AMQPClient | null = null;

  beforeAll(async () => {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      throw new Error("RABBITMQ_URL is missing — check global-setup.ts");
    }
    amqpClient = new AMQPClient(url);
    await amqpClient.connect();
  }, 60_000);

  afterAll(async () => {
    if (amqpClient) {
      await amqpClient.close();
    }
  }, 60_000);

  it("should publish case.escalated to RabbitMQ after processing sla.breached", async () => {
    if (!amqpClient) throw new Error("AMQP Client failed to initialize!");

    const ch = await amqpClient.channel();
    const EXCHANGE_NAME = "townops.events";
    const ROUTING_KEY = "case.escalated";

    await ch.exchangeDeclare(EXCHANGE_NAME, "topic", { durable: true });
    const q = await ch.queueDeclare("", { autoDelete: true, exclusive: true });
    await ch.queueBind(q.name, EXCHANGE_NAME, ROUTING_KEY);

    const CASE_ID = "case-integration-001";
    const ASSIGNMENT_ID = "assign-integration-001";

    // Mock all downstream HTTP calls
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/contractors/backup")) {
        return {
          ok: true,
          json: async () => ({ worker_id: "backup-worker-int-01" }),
        };
      }
      if (url.includes("/api/assignments/")) {
        return { ok: true, json: async () => ({ assignments: {} }) };
      }
      if (url.includes("/api/cases/update-case-status")) {
        return { ok: true, json: async () => ({ cases: {} }) };
      }
      if (url.includes("/api/metrics")) {
        return { ok: true, json: async () => ({ metric: {} }) };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    // Listen for published event
    let receivedPayload: any = null;
    await ch.basicConsume(q.name, { noAck: true }, (msg) => {
      receivedPayload = JSON.parse(msg.bodyString() || "{}");
    });

    // Trigger the worker
    await handleSlaBreach(
      JSON.stringify({
        assignment_id: ASSIGNMENT_ID,
        case_id: CASE_ID,
        contractor_id: "contractor-old-01",
      })
    );

    // Wait for async AMQP delivery
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Assert message published
    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload).toHaveProperty("caseId", CASE_ID);
    expect(receivedPayload).toHaveProperty("assignmentId", ASSIGNMENT_ID);
    expect(receivedPayload.newWorkerId).toBe("backup-worker-int-01");

    await ch.queueDelete(q.name);
  });
});
