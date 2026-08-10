import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

// Create mocks that are hoisted correctly by Vitest
const { mockQuery, mockDb } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5003";
  process.env.JWT_SECRET = "supersecret";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";

  const q = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
    // eslint-disable-next-line unicorn/no-thenable
    then: vi.fn(),
  };

  const db = {
    select: vi.fn().mockReturnValue(q),
    update: vi.fn().mockReturnValue(q),
    insert: vi.fn().mockReturnValue(q),
    // beginEffect/succeedEffect/failEffect wrap their writes in a
    // transaction; hand the callback the same query builder as `tx`.
    transaction: vi.fn(),
  };
  db.transaction.mockImplementation(async (cb) => cb(db));

  return { mockQuery: q, mockDb: db };
});

vi.mock("@townops/shared-ts", () => {
  return {
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

const { mockEmailsSend } = vi.hoisted(() => ({
  mockEmailsSend: vi
    .fn()
    .mockResolvedValue({ data: { id: "provider-mock-id" } }),
}));

vi.mock("resend", () => ({
  Resend: vi
    .fn()
    .mockImplementation(
      function (this: { emails: { send: ReturnType<typeof vi.fn> } }) {
        this.emails = { send: mockEmailsSend };
      }
    ),
}));

vi.mock("../../src/env", () => ({
  env: {
    DATABASE_URL: "postgres://root:password@localhost:5432/testdb",
    PORT: 5003,
    JWT_SECRET: "supersecret",
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

    // clearAllMocks clears call history but NOT the mockImplementationOnce
    // queue, so an unconsumed Once from a prior test (e.g. a handler that
    // returns before exhausting its queued db calls) would leak into the
    // next test and resolve the wrong row. Fully reset both queues, then
    // restore their default resolved values.
    mockQuery.then.mockReset();
    mockQuery.then.mockImplementation((resolve) => resolve([]));
    mockEmailsSend.mockReset();
    mockEmailsSend.mockResolvedValue({ data: { id: "provider-mock-id" } });
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

  describe("POST /internal/effects/:id/dispatch-email — Temporal-driven delivery (PRS-203)", () => {
    const effectId = "effect-dispatch-1";
    const emailPayload = {
      type: "EMAIL",
      to: "resident@example.com",
      subject: "Job Assigned",
      html: "<p>hi</p>",
    };
    const pendingRow = {
      id: effectId,
      caseId: VALID_UUID_1,
      type: "EMAIL",
      purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION",
      status: "PENDING",
      payload: emailPayload,
      providerId: null,
      providerIdempotencyKey: effectId,
      attempts: 0,
      lastError: null,
      nextRetryAt: null,
      waiverActorId: null,
      waiverReason: null,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    const begunRow = { ...pendingRow, attempts: 1 };

    it("begins the effect, sends the email, and marks it SENT with the provider ID", async () => {
      const sentRow = {
        ...begunRow,
        status: "SENT",
        providerId: "provider-mock-id",
      };
      mockQuery.then
        .mockImplementationOnce((resolve) => resolve([pendingRow])) // beginEffect: effectForUpdate
        .mockImplementationOnce((resolve) => resolve([begunRow])) // beginEffect: update().returning()
        .mockImplementationOnce((resolve) => resolve([begunRow])) // getEffect
        .mockImplementationOnce((resolve) => resolve([begunRow])) // succeedEffect: effectForUpdate
        .mockImplementationOnce((resolve) => resolve([sentRow])); // succeedEffect: update().returning()

      const res = await app.request(
        `/internal/effects/${effectId}/dispatch-email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nextRetryAt: "2030-01-01T00:05:00.000Z" }),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.effect).toMatchObject({
        status: "SENT",
        providerId: "provider-mock-id",
      });
      expect(body.effect.payload).toBeUndefined();
      expect(mockEmailsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [emailPayload.to],
          subject: emailPayload.subject,
          headers: { "Idempotency-Key": effectId },
        })
      );
    });

    it("fails the effect via failEffect when the email provider rejects", async () => {
      mockEmailsSend.mockRejectedValueOnce(new Error("provider down"));
      const failedRow = {
        ...begunRow,
        status: "FAILED",
        lastError: "provider down",
        nextRetryAt: "2030-01-01T00:05:00.000Z",
      };
      mockQuery.then
        .mockImplementationOnce((resolve) => resolve([pendingRow])) // beginEffect: effectForUpdate
        .mockImplementationOnce((resolve) => resolve([begunRow])) // beginEffect: update().returning()
        .mockImplementationOnce((resolve) => resolve([begunRow])) // getEffect
        .mockImplementationOnce((resolve) => resolve([begunRow])) // failEffect: effectForUpdate
        .mockImplementationOnce((resolve) => resolve([failedRow])); // failEffect: update().returning()

      const res = await app.request(
        `/internal/effects/${effectId}/dispatch-email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nextRetryAt: "2030-01-01T00:05:00.000Z" }),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.effect).toMatchObject({
        status: "FAILED",
        lastError: "provider down",
      });
    });
  });
});
