import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

// Create mocks that are hoisted correctly by Vitest
const { mockQuery, mockDb } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5003";
  process.env.JWT_SECRET = "supersecret";
  process.env.RABBITMQ_URL = "amqp://localhost";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";

  const q = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    // eslint-disable-next-line unicorn/no-thenable
    then: vi.fn(),
  };

  const db = {
    select: vi.fn().mockReturnValue(q),
    update: vi.fn().mockReturnValue(q),
    insert: vi.fn().mockReturnValue(q),
  };

  return { mockQuery: q, mockDb: db };
});

vi.mock("@townops/shared-ts", () => {
  return {
    rabbitmqClient: {
      connect: vi.fn().mockResolvedValue(undefined),
      declareExchange: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue(undefined),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    honoLogger: () => async (_c: unknown, next: () => Promise<void>) => {
      await next();
    },
  };
});

vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function (this: any) {
    this.emails = { send: vi.fn() };
  }),
}));

vi.mock("../../src/env", () => ({
  env: {
    DATABASE_URL: "postgres://root:password@localhost:5432/testdb",
    PORT: 5003,
    JWT_SECRET: "supersecret",
    RABBITMQ_URL: "amqp://localhost",
    RESEND_API_KEY: "re_abc123",
    JWKS_URI: "http://localhost",
  },
}));

vi.mock("hono/jwk", () => ({
  jwk: () => (c: unknown, next: () => Promise<void>) => next(),
}));

describe("Alert Atom API Endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.then.mockImplementation((resolve) => resolve([]));
  });

  const VALID_UUID_1 = "123e4567-e89b-12d3-a456-426614174000";
  const VALID_UUID_2 = "123e4567-e89b-12d3-a456-426614174001";

  describe("GET /health", () => {
    it("should return 200 health check", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /api/alerts", () => {
    it("should return 200 and a list of alerts", async () => {
      const mockAlerts = [
        {
          id: VALID_UUID_1,
          caseId: VALID_UUID_1,
          recipientId: VALID_UUID_2,
          channel: "email",
          message: "A new case statement opened",
        },
      ];
      mockQuery.then.mockImplementationOnce((resolve) => resolve(mockAlerts));

      const res = await app.request("/api/alerts");
      if (res.status === 500) {
        console.error("500 Error Body:", await res.json());
      }
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ alerts: mockAlerts });
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe("GET /api/alerts/case/:caseId", () => {
    it("should return 200 and alerts filtered by case", async () => {
      const mockAlert = {
        id: VALID_UUID_1,
        caseId: VALID_UUID_1,
        recipientId: VALID_UUID_2,
        channel: "email",
        message: "A new case statement opened",
      };
      mockQuery.then.mockImplementationOnce((resolve) => resolve([mockAlert]));

      const res = await app.request(`/api/alerts/case/${VALID_UUID_1}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ alerts: [mockAlert] });
      expect(mockQuery.where).toHaveBeenCalled();
    });

    it("should return 400 for invalid caseId UUID", async () => {
      const res = await app.request("/api/alerts/case/not-a-uuid");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/alerts/recipient/:recipientId", () => {
    it("should return 200 and alerts filtered by recipient", async () => {
      const mockAlert = {
        id: VALID_UUID_1,
        caseId: VALID_UUID_1,
        recipientId: VALID_UUID_2,
        channel: "email",
        message: "A new case statement opened",
      };
      mockQuery.then.mockImplementationOnce((resolve) => resolve([mockAlert]));

      const res = await app.request(`/api/alerts/recipient/${VALID_UUID_2}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ alerts: [mockAlert] });
      expect(mockQuery.where).toHaveBeenCalled();
    });

    it("should return 400 for invalid recipientId UUID", async () => {
      const res = await app.request("/api/alerts/recipient/not-a-uuid");
      expect(res.status).toBe(400);
    });
  });
});
