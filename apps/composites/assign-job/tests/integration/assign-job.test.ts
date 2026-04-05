import { AMQPClient } from "@cloudamqp/amqp-client";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// 1. Set up environment via vi.hoisted
vi.hoisted(() => {
  process.env.PORT = "6002";
  process.env.CONTRACTOR_API_URL = "http://contractor-api";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.METRICS_ATOM_URL = "http://metrics-atom";

  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
});

/* eslint-disable import/first */
// 2. Import services after env is set
import { assignContractor } from "../../src/services";

describe("Assign Job Composite - RabbitMQ Integration", () => {
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
  });

  it("should publish job.assigned to RabbitMQ after a successful assignment", async () => {
    if (!amqpClient) throw new Error("AMQP Client failed to initialize!");

    const ch = await amqpClient.channel();
    const EXCHANGE_NAME = "townops.events";
    const ROUTING_KEY = "job.assigned";

    // Declare exchange and ephemeral queue for test verification
    await ch.exchangeDeclare(EXCHANGE_NAME, "topic", { durable: true });
    const q = await ch.queueDeclare("", { autoDelete: true, exclusive: true });
    await ch.queueBind(q.name, EXCHANGE_NAME, ROUTING_KEY);

    const CASE_ID = "234e5678-e89b-12d3-a456-426614174002";

    // Mock downstream HTTP calls
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/contractors/search")) {
        return {
          ok: true,
          json: async () => [{ ContractorUuid: "contractor-integration-01" }],
        };
      }
      if (url.includes("/api/metrics/")) {
        return {
          ok: true,
          json: async () => ({ metrics: [{ score_delta: 20 }] }),
        };
      }
      if (url.includes("/api/assignments")) {
        return {
          ok: true,
          json: async () => ({
            assignments: {
              id: "int-assign-uuid",
              caseId: CASE_ID,
              contractorId: "contractor-integration-01",
            },
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    // Set up listener before triggering
    let receivedPayload: any = null;
    await ch.basicConsume(q.name, { noAck: true }, (msg) => {
      receivedPayload = JSON.parse(msg.bodyString() || "{}");
    });

    // Execute the service
    await assignContractor(CASE_ID, "510000", "PLUMBING");

    // Allow async message to propagate
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Assert message received
    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload).toHaveProperty("caseId", CASE_ID);
    expect(receivedPayload).toHaveProperty(
      "contractorId",
      "contractor-integration-01"
    );
    expect(receivedPayload).toHaveProperty("status", "PENDING_ACCEPTANCE");

    await ch.queueDelete(q.name);
  });
});
