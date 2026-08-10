import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

const { mockDb } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5004";
  process.env.WORKER_SERVICE_TOKEN =
    "test-worker-service-token-at-least-32-chars";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";

  const dbChains = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    // getAppointmentsByCaseId now ends on .orderBy(), so that is the awaited
    // link of the chain (PRS-146).
    orderBy: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
  };

  return { mockDb: dbChains };
});

const workerToken = "test-worker-service-token-at-least-32-chars";

vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

describe("Appointment Atom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /health", () => {
    it("should return 200 health check", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /api/appointments/:case_id", () => {
    it("requires the Worker service token", async () => {
      const caseId = "123e4567-e89b-12d3-a456-426614174000";
      const responses = await Promise.all([
        app.request(`/api/appointments/${caseId}`),
        app.request(`/api/appointments/${caseId}`, {
          headers: { Authorization: `Bearer ${"b".repeat(32)}` },
        }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([401, 401]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("should return the list of appointments for a valid case ID", async () => {
      // Arrange
      const mockCaseId = "123e4567-e89b-12d3-a456-426614174000";
      const sampleAppointments = [
        {
          id: "1",
          caseId: mockCaseId,
          assignmentId: "2",
          startTime: "2024-01-01T10:00:00Z",
          endTime: "2024-01-01T11:00:00Z",
          status: "scheduled",
        },
      ];
      mockDb.select.mockReturnThis();
      mockDb.from.mockReturnThis();
      mockDb.where.mockReturnThis();
      mockDb.orderBy.mockResolvedValue(sampleAppointments);

      // Act
      const res = await app.request(`/api/appointments/${mockCaseId}`, {
        headers: { Authorization: `Bearer ${workerToken}` },
      });

      // Assert
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ appointments: sampleAppointments });
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should return empty list if none found", async () => {
      // Arrange
      const mockCaseId = "123e4567-e89b-12d3-a456-426614174000";
      mockDb.orderBy.mockResolvedValue([]);

      // Act
      const res = await app.request(`/api/appointments/${mockCaseId}`, {
        headers: { Authorization: `Bearer ${workerToken}` },
      });

      // Assert
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ appointments: [] });
    });

    it("should return error for invalid UUID case ID", async () => {
      // Act
      const res = await app.request("/api/appointments/not-a-uuid", {
        headers: { Authorization: `Bearer ${workerToken}` },
      });

      // Assert
      expect(res.status).toBe(400);
    });
  });
});
