import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.PORT = "5006";
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.RESEND_API_KEY = "re_123";
  process.env.JWKS_URI = "http://localhost";
});

// Mock DB
const { mockInsert, mockValues } = vi.hoisted(() => {
  const mockValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockInsert, mockValues };
});
vi.mock("../../src/database/db", () => ({
  default: { insert: mockInsert },
}));

// Capture the RabbitMQ message handler registered by startAlertQueueWorker
let capturedHandler: (msg: any) => Promise<void>;

vi.mock("@townops/shared-ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  honoLogger: () => (_c: any, next: any) => next(),
  rabbitmqClient: {
    connect: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockImplementation((_queue: string, handler: any) => {
      capturedHandler = handler;
      return Promise.resolve();
    }),
  },
}));

// Mock Mailer
const { mockSendEmail } = vi.hoisted(() => {
  const mockSendEmail = vi.fn().mockResolvedValue(undefined);
  return { mockSendEmail };
});
vi.mock("../../src/mailer", () => ({ sendEmail: mockSendEmail }));

// Mock Templates
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

import { rabbitmqClient } from "@townops/shared-ts";

/* eslint-disable import/first */
import {
  getJobAssignedEmail,
  getCaseEscalatedEmail,
  getCaseNoAccessEmail,
  getJobCompletedEmail,
  getGenericAlertEmail,
} from "../../src/email-templates";
import { startAlertQueueWorker } from "../../src/worker";
/* eslint-enable import/first */

const VALID_UUID_1 = "123e4567-e89b-12d3-a456-426614174000";
const VALID_UUID_2 = "123e4567-e89b-12d3-a456-426614174001";

// Schema requires: caseId (uuid), email (email). residentId/recipientId are optional.
const validPayload = {
  caseId: VALID_UUID_1,
  residentId: VALID_UUID_2,
  category: "plumbing",
  channel: "email",
  email: "test@example.com",
};

function makeMsg(
  routingKey: string,
  data: Record<string, unknown> = validPayload
) {
  return {
    routingKey,
    body: Buffer.from(JSON.stringify(data)),
    ack: vi.fn().mockResolvedValue(undefined),
    nack: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Alert Worker", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    startAlertQueueWorker();
    // Flush microtasks so the async IIFE inside startAlertQueueWorker registers the consumer
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  describe("startAlertQueueWorker", () => {
    it("should connect to RabbitMQ and register a consumer for alert-queue", () => {
      const mocked = vi.mocked(rabbitmqClient);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mocked.connect).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mocked.consume).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mocked.consume).toHaveBeenCalledWith(
        "alert-queue",
        expect.any(Function)
      );
    });
  });

  describe("message handler", () => {
    it("should skip insert and email when residentId and recipientId are both absent", async () => {
      // Payload passes schema (residentId/recipientId are optional) but recipientId check fails
      await capturedHandler(
        makeMsg("case.opened", {
          caseId: VALID_UUID_1,
          email: "test@example.com",
        })
      );
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("should drop message (ZodError) when caseId is missing from payload", async () => {
      // caseId is required by alertPayloadSchema — throws ZodError, re-thrown by handler
      const msg = makeMsg("case.opened", {
        residentId: VALID_UUID_2,
        email: "test@example.com",
      });
      await expect(capturedHandler(msg)).rejects.toThrow();
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("should call getJobAssignedEmail for job.assigned routing key", async () => {
      await capturedHandler(makeMsg("job.assigned"));
      expect(vi.mocked(getJobAssignedEmail)).toHaveBeenCalled();
    });

    it("should call getCaseEscalatedEmail for case.escalated routing key", async () => {
      await capturedHandler(makeMsg("case.escalated"));
      expect(vi.mocked(getCaseEscalatedEmail)).toHaveBeenCalled();
    });

    it("should call getCaseNoAccessEmail for case.no_access routing key", async () => {
      await capturedHandler(makeMsg("case.no_access"));
      expect(vi.mocked(getCaseNoAccessEmail)).toHaveBeenCalled();
    });

    it("should call getJobCompletedEmail for job.done routing key", async () => {
      await capturedHandler(makeMsg("job.done"));
      expect(vi.mocked(getJobCompletedEmail)).toHaveBeenCalled();
    });

    it("should call getGenericAlertEmail for alert.notify routing key", async () => {
      await capturedHandler(makeMsg("alert.notify"));
      expect(vi.mocked(getGenericAlertEmail)).toHaveBeenCalled();
    });

    it("should call getGenericAlertEmail for unrecognised routing keys", async () => {
      await capturedHandler(makeMsg("unknown.event"));
      expect(vi.mocked(getGenericAlertEmail)).toHaveBeenCalled();
    });

    it("should insert an audit record for valid messages", async () => {
      await capturedHandler(makeMsg("job.assigned"));
      expect(mockInsert).toHaveBeenCalledOnce();
      expect(mockValues).toHaveBeenCalledOnce();
    });

    it("should send email when payload contains an email field", async () => {
      await capturedHandler(makeMsg("case.opened"));
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "test@example.com" })
      );
    });

    it("should throw (poison pill to DLX) when message body is invalid JSON", async () => {
      const badMsg = {
        routingKey: "case.opened",
        body: Buffer.from("{ invalid json }"),
        ack: vi.fn(),
        nack: vi.fn(),
      };
      await expect(capturedHandler(badMsg)).rejects.toThrow(SyntaxError);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("should nack and requeue message on transient (non-parse) failure", async () => {
      mockSendEmail.mockRejectedValueOnce(new Error("Transient API failure"));
      const msg = makeMsg("case.opened");
      await capturedHandler(msg);
      expect(msg.nack).toHaveBeenCalledWith(false, true);
    });
  });
});
