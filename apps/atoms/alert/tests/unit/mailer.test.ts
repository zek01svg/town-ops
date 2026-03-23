import { logger } from "@townops/shared-ts";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { sendEmail } from "../../src/mailer";

const { mockEmailsSend } = vi.hoisted(() => ({
  mockEmailsSend: vi.fn(),
}));

vi.mock("resend", () => {
  return {
    Resend: vi.fn().mockImplementation(function (this: any) {
      this.emails = {
        send: mockEmailsSend,
      };
    }),
  };
});

vi.mock("@townops/shared-ts", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/env", () => ({
  env: {
    RESEND_API_KEY: "re_123",
    DATABASE_URL: "postgres://root:password@localhost:5432/testdb",
    RABBITMQ_URL: "amqp://localhost",
    JWKS_URI: "http://localhost",
  },
}));

describe("Mailer", () => {
  const options = {
    to: "test@example.com",
    subject: "Test Subject",
    html: "<p>Test Content</p>",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sendEmail", () => {
    it("should send email successfully and log info", async () => {
      const mockResult = { id: "msg_id" };
      mockEmailsSend.mockResolvedValueOnce({ data: mockResult });

      const data = await sendEmail(options);

      expect(mockEmailsSend).toHaveBeenCalledWith({
        from: "TownOps <townops@resend.dev>",
        to: [options.to],
        subject: options.subject,
        html: options.html,
      });
      expect(data).toEqual(mockResult);
      expect(logger.info).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("should throw error and log error on failure", async () => {
      const mockError = new Error("API Limit Reached");
      mockEmailsSend.mockRejectedValueOnce(mockError);

      await expect(sendEmail(options)).rejects.toThrow("API Limit Reached");

      expect(logger.error).toHaveBeenCalled();
      expect(logger.info).not.not.toHaveBeenCalled();
    });
  });
});
