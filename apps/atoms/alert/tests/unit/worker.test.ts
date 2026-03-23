import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  getJobAssignedEmail,
  getCaseEscalatedEmail,
  getCaseNoAccessEmail,
  getJobCompletedEmail,
  getGenericAlertEmail,
} from "../../src/email-templates";

const VALID_UUID_1 = "123e4567-e89b-12d3-a456-426614174000";
const VALID_UUID_2 = "123e4567-e89b-12d3-a456-426614174001";

// Mock Query and DB for worker assertions
const { mockQuery, mockDb } = vi.hoisted(() => {
  const q = {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    // eslint-disable-next-line unicorn/no-thenable
    then: vi.fn().mockImplementation((resolve: any) => resolve([])),
  };

  const db = {
    insert: vi.fn().mockReturnValue(q),
    select: vi.fn().mockReturnValue(q),
  };

  return { mockQuery: q, mockDb: db };
});

vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

// Mock RabbitMQ Consuming
let consumeCallback: (msg: any) => Promise<void>;

vi.mock("@townops/shared-ts", () => {
  return {
    rabbitmqClient: {
      connect: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockImplementation((queue: string, callback: any) => {
        consumeCallback = callback;
        return Promise.resolve();
      }),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

// Mock Mailer to spy on sendEmail
const mockSendEmail = vi.fn();
vi.mock("../../src/mailer", () => ({
  sendEmail: mockSendEmail,
}));

// Mock Templates to avoid testing logic inside templates themselves again
vi.mock("../../src/email-templates", () => ({
  getCaseOpenedEmail: vi.fn().mockReturnValue("<p>Case Opened</p>"),
  getJobAssignedEmail: vi.fn().mockReturnValue("<p>Job Assigned</p>"),
  getCaseEscalatedEmail: vi.fn().mockReturnValue("<p>Case Escalated</p>"),
  getCaseNoAccessEmail: vi.fn().mockReturnValue("<p>No Access</p>"),
  getJobCompletedEmail: vi.fn().mockReturnValue("<p>Job Done</p>"),
  getGenericAlertEmail: vi.fn().mockReturnValue("<p>Generic</p>"),
}));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function (this: any) {
    this.emails = { send: vi.fn() };
  }),
}));

vi.mock("../../src/env", () => ({
  env: {
    RESEND_API_KEY: "re_123",
    DATABASE_URL: "postgres://root:password@localhost:5432/testdb",
    RABBITMQ_URL: "amqp://localhost",
    JWKS_URI: "http://localhost",
  },
}));

let startAlertQueueWorker: any;

describe("Alert Worker", () => {
  beforeEach(async () => {
    const workerMod = await import("../../src/worker");
    startAlertQueueWorker = workerMod.startAlertQueueWorker;
    vi.clearAllMocks();
    mockQuery.then.mockImplementation((resolve: any) => resolve([]));
  });

  describe("startAlertQueueWorker", () => {
    it("should connect to RabbitMQ and establish consumer", async () => {
      startAlertQueueWorker();
      // Wait microtasks so void wrapper executes connect & consume
      await new Promise((r) => setTimeout(r, 10));

      const { rabbitmqClient } = await import("@townops/shared-ts");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.connect).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.consume).toHaveBeenCalledWith(
        "alert-queue",
        expect.any(Function)
      );
    });

    describe("Message Consumption Handler", () => {
      const mockMsgOptions = (body: string, routingKey = "case.opened") => ({
        body: body ? Buffer.from(body) : null,
        routingKey,
        nack: vi.fn().mockResolvedValue(undefined),
      });

      const validPayload = {
        caseId: VALID_UUID_1,
        residentId: VALID_UUID_2,
        category: "category",
        channel: "email",
        email: "test@example.com",
      };

      it("should return and log warn for empty body", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        const emptyMsg = mockMsgOptions("");
        await consumeCallback(emptyMsg);

        expect(mockDb.insert).not.toHaveBeenCalled();
      });

      it("should process valid payload correctly and insert to db then send email", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        const msg = mockMsgOptions(JSON.stringify(validPayload), "case.opened");
        try {
          await consumeCallback(msg);
        } catch (err) {
          console.error("Consume callback threw:", err);
        }

        const { logger } = await import("@townops/shared-ts");
        expect(logger.error).not.toHaveBeenCalled();

        expect(mockDb.insert).toHaveBeenCalled();
        expect(mockSendEmail).toHaveBeenCalled();
      });

      it("should handle job.assigned routing and call template", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        const msg = mockMsgOptions(
          JSON.stringify(validPayload),
          "job.assigned"
        );
        await consumeCallback(msg);

        expect(vi.mocked(getJobAssignedEmail)).toHaveBeenCalled();
      });

      it("should handle case.escalated routing and call template", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        const msg = mockMsgOptions(
          JSON.stringify(validPayload),
          "case.escalated"
        );
        await consumeCallback(msg);

        expect(vi.mocked(getCaseEscalatedEmail)).toHaveBeenCalled();
      });

      it("should handle case.no_access routing and call template", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        const msg = mockMsgOptions(
          JSON.stringify(validPayload),
          "case.no_access"
        );
        await consumeCallback(msg);

        expect(vi.mocked(getCaseNoAccessEmail)).toHaveBeenCalled();
      });

      it("should handle job.done routing and call template", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        const msg = mockMsgOptions(JSON.stringify(validPayload), "job.done");
        await consumeCallback(msg);

        expect(vi.mocked(getJobCompletedEmail)).toHaveBeenCalled();
      });

      it("should handle default routing using generic template", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        const msg = mockMsgOptions(
          JSON.stringify(validPayload),
          "unknown.routing"
        );
        await consumeCallback(msg);

        expect(vi.mocked(getGenericAlertEmail)).toHaveBeenCalled();
      });

      it("should throw poison pill error to DLX if invalid JSON is received", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        const badMsg = mockMsgOptions("{ invalid json }", "case.opened");

        await expect(consumeCallback(badMsg)).rejects.toThrow();
      });

      it("should nack and requeue message if non-parse error throws", async () => {
        startAlertQueueWorker();
        await new Promise((r) => setTimeout(r, 10));

        mockSendEmail.mockRejectedValueOnce(new Error("Transient API Failure"));
        const msg = mockMsgOptions(JSON.stringify(validPayload), "case.opened");

        await consumeCallback(msg);

        expect(msg.nack).toHaveBeenCalledWith(false, true);
      });
    });
  });
});
