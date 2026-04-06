import type { AMQPMessage } from "@cloudamqp/amqp-client";
import type { StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import { RabbitMQContainer } from "@testcontainers/rabbitmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// We need to set dummy atom URLs for the composite to call
vi.hoisted(() => {
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.RESIDENT_ATOM_URL = "http://resident-atom";
  process.env.JWT_SECRET = "test-secret";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "test=true";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.PORT = "6007";
});

// Mocking the atoms at the HTTP layer
const { mockHc } = vi.hoisted(() => ({
  mockHc: vi.fn(),
}));

vi.mock("hono/client", () => ({
  hc: mockHc,
}));

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

// We will import the app after setting up RabbitMQ URL
let app: any;
let rabbitmqContainer: StartedRabbitMQContainer;

describe("Handle No Access Composite - Integration Tests", () => {
  beforeAll(async () => {
    // Increase timeout for container startup
    vi.setConfig({ testTimeout: 60000 });

    rabbitmqContainer = await new RabbitMQContainer(
      "rabbitmq:3.12-management"
    ).start();
    process.env.RABBITMQ_URL = rabbitmqContainer.getAmqpUrl();

    // Now import the app to ensure it picks up the correct RABBITMQ_URL
    const mod = await import("../../src/index");
    app = mod.app;
  }, 60000);

  afterAll(async () => {
    await rabbitmqContainer.stop();
  });

  it("should successfully report no access and publish to RabbitMQ", async () => {
    const caseId = "123e4567-e89b-12d3-a456-426614174000";
    const assignmentId = "223e4567-e89b-12d3-a456-426614174001";
    const contractorId = "323e4567-e89b-12d3-a456-426614174002";
    const residentId = "423e4567-e89b-12d3-a456-426614174003";

    const validBody = {
      caseId,
      assignmentId,
      contractorId,
      reason: "Gate is locked",
    };

    // Setup mocks for atoms
    const mockCaseClient = {
      api: {
        cases: {
          ":id": {
            $get: vi.fn().mockResolvedValue({
              ok: true,
              json: async () => ({ id: caseId, residentId }),
            }),
          },
          "update-case-status": {
            $put: vi.fn().mockResolvedValue({ ok: true }),
          },
        },
      },
    };

    const mockResidentClient = {
      api: {
        residents: {
          ":id": {
            $get: vi.fn().mockResolvedValue({
              ok: true,
              json: async () => ({
                id: residentId,
                email: "resident@test.dev",
              }),
            }),
          },
        },
      },
    };

    mockHc.mockImplementation((url: string) => {
      if (url === "http://case-atom") return mockCaseClient;
      if (url === "http://resident-atom") return mockResidentClient;
      return {};
    });

    // We need a consumer to verify the message was published
    // We'll use the rabbitmqClient from shared-ts directly
    const { rabbitmqClient } = await import("@townops/shared-ts");

    const receivedMessages: any[] = [];
    await rabbitmqClient.consume(
      "alert-queue", // Using an existing queue name from the type for simplicity
      async (msg: AMQPMessage) => {
        receivedMessages.push(JSON.parse(msg.bodyString() || "{}"));
      },
      {
        exchangeName: "townops.events",
        routingKey: "case.no_access",
      }
    );

    // Call the API
    const res = await app.request("/api/cases/no-access", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(validBody),
    });

    if (res.status !== 200) {
      const errorBody = await res.json();
      console.error("Test failed with status", res.status, errorBody);
    }

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Wait for message to be consumed (polled)
    // Using a more robust wait loop
    let attempts = 0;
    while (receivedMessages.length === 0 && attempts < 10) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }

    expect(receivedMessages.length).toBeGreaterThan(0);
    expect(receivedMessages[0]).toEqual(
      expect.objectContaining({
        caseId,
        residentId,
        email: "resident@test.dev",
        message: validBody.reason,
      })
    );

    const { rabbitmqClient: client } = await import("@townops/shared-ts");
    await client.disconnect();
  }, 30000);
});
