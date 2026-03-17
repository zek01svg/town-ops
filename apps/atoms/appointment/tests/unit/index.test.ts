import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

const { mockDb } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5004";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";

  const dbChains = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
  };

  return { mockDb: dbChains };
});

vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
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
      mockDb.where.mockResolvedValue(sampleAppointments);

      // Act
      const res = await app.request(`/api/appointments/${mockCaseId}`);

      // Assert
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ appointments: sampleAppointments });
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should return empty list if none found", async () => {
      // Arrange
      const mockCaseId = "123e4567-e89b-12d3-a456-426614174000";
      mockDb.where.mockResolvedValue([]);

      // Act
      const res = await app.request(`/api/appointments/${mockCaseId}`);

      // Assert
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ appointments: [] });
    });

    it("should return error for invalid UUID case ID", async () => {
      // Act
      const res = await app.request("/api/appointments/not-a-uuid");

      // Assert
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/appointments", () => {
    it("should create appointment on valid fields", async () => {
      // Arrange
      const payload = {
        caseId: "123e4567-e89b-12d3-a456-426614174000",
        assignmentId: "223e4567-e89b-12d3-a456-426614174002",
        startTime: "2024-01-01T10:00:00Z",
        endTime: "2024-01-01T11:00:00Z",
        status: "scheduled",
      };

      const createdItem = {
        id: "mocked-uuid-123",
        ...payload,
      };

      mockDb.insert.mockReturnThis();
      mockDb.values.mockReturnThis();
      mockDb.returning.mockResolvedValue([createdItem]);

      // Act
      const res = await app.request("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // Assert
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ appointment: createdItem });
    });

    it("should return error for missing fields setup", async () => {
      // Arrange
      const incompletePayload = {
        status: "scheduled",
      };

      // Act
      const res = await app.request("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(incompletePayload),
      });

      // Assert
      expect(res.status).toBe(400);
    });
  });
});
