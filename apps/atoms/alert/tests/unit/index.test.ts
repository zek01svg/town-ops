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
    orderBy: vi.fn().mockReturnThis(),
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
    corsOrigins: () => ["http://localhost:5173"],
    workerAuth: () => async (_c: unknown, next: () => Promise<void>) => {
      await next();
    },
    initSentry: vi.fn(),
    captureHonoException: vi.fn(),
  };
});

vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

vi.mock("resend", () => ({
  Resend: vi
    .fn()
    .mockImplementation(
      function (this: { emails: { send: ReturnType<typeof vi.fn> } }) {
        this.emails = { send: vi.fn() };
      }
    ),
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

  describe("GET /internal/effects/case/:caseId — toEffectSummary projection (PRS-151)", () => {
    it("projects null contractorId/scoreDelta for an EMAIL summary and never leaks payload", async () => {
      const emailRow = {
        id: "effect-1",
        caseId: VALID_UUID_1,
        type: "EMAIL",
        purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION",
        status: "SENT",
        payload: {
          type: "EMAIL",
          to: "resident@example.com",
          subject: "Case update",
          html: "<p>secret-html-body</p>",
        },
        providerId: null,
        providerIdempotencyKey: "effect-1",
        attempts: 1,
        lastError: null,
        nextRetryAt: null,
        waiverActorId: null,
        waiverReason: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      };
      mockQuery.then.mockImplementationOnce((resolve) => resolve([emailRow]));

      const res = await app.request(`/internal/effects/case/${VALID_UUID_1}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.effects).toEqual([
        {
          id: "effect-1",
          caseId: VALID_UUID_1,
          type: "EMAIL",
          purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION",
          status: "SENT",
          providerId: null,
          providerIdempotencyKey: "effect-1",
          attempts: 1,
          lastError: null,
          nextRetryAt: null,
          waiverActorId: null,
          waiverReason: null,
          contractorId: null,
          scoreDelta: null,
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
      ]);
      expect(JSON.stringify(body)).not.toContain("secret-html-body");
    });

    it("projects contractorId/scoreDelta for a PERFORMANCE_ENTRY summary and never leaks payload", async () => {
      const performanceRow = {
        id: "effect-2",
        caseId: VALID_UUID_1,
        type: "PERFORMANCE_ENTRY",
        purpose: "ATTEMPT_BREACH_PERFORMANCE",
        status: "SENT",
        payload: {
          type: "PERFORMANCE_ENTRY",
          contractorId: VALID_UUID_2,
          scoreDelta: -5,
          reason: "secret-internal-reason",
        },
        providerId: null,
        providerIdempotencyKey: "effect-2",
        attempts: 1,
        lastError: null,
        nextRetryAt: null,
        waiverActorId: null,
        waiverReason: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      };
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([performanceRow])
      );

      const res = await app.request(`/internal/effects/case/${VALID_UUID_1}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.effects).toEqual([
        {
          id: "effect-2",
          caseId: VALID_UUID_1,
          type: "PERFORMANCE_ENTRY",
          purpose: "ATTEMPT_BREACH_PERFORMANCE",
          status: "SENT",
          providerId: null,
          providerIdempotencyKey: "effect-2",
          attempts: 1,
          lastError: null,
          nextRetryAt: null,
          waiverActorId: null,
          waiverReason: null,
          contractorId: VALID_UUID_2,
          scoreDelta: -5,
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
      ]);
      expect(JSON.stringify(body)).not.toContain("secret-internal-reason");
    });
  });
});
