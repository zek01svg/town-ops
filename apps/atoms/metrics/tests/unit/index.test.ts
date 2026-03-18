import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

// 1. Setup Environment Variables BEFORE importing anything else
const { mockDb } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5006";
  process.env.JWKS_URI = "http://localhost/jwks";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";

  // Drizzle Mocking Chain
  const mockSelect = vi.fn();
  const mockInsert = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockValues = vi.fn();
  const mockReturning = vi.fn();

  // Chain: select().from().where()
  mockSelect.mockReturnValue({
    from: mockFrom.mockReturnValue({
      where: mockWhere,
    }),
  });

  // Chain: insert().values().returning()
  mockInsert.mockReturnValue({
    values: mockValues.mockReturnValue({
      returning: mockReturning,
    }),
  });

  return {
    mockDb: {
      select: mockSelect,
      insert: mockInsert,
      _mockSelect: mockSelect,
      _mockInsert: mockInsert,
      _mockFrom: mockFrom,
      _mockWhere: mockWhere,
      _mockValues: mockValues,
      _mockReturning: mockReturning,
    },
  };
});

// 2. Mock Modules
vi.mock("../../src/database/db", () => {
  return {
    default: mockDb,
  };
});

// Mock hono/jwk to let requests pass through without validation
vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

describe("Metrics Atom", () => {
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

  describe("GET /api/metrics/:contractor_id", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";

    it("should return metrics for a valid contractor_id", async () => {
      const mockMetrics = [
        {
          id: "1",
          contractorId: validUuid,
          scoreDelta: 5,
          reason: "Good work",
        },
      ];
      mockDb._mockWhere.mockResolvedValue(mockMetrics);

      const res = await app.request(`/api/metrics/${validUuid}`);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.metrics).toEqual(mockMetrics);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should return 400 for an invalid UUID", async () => {
      const res = await app.request("/api/metrics/invalid-uuid");
      expect(res.status).toBe(400); // Validation error from validator()
    });
  });

  describe("POST /api/metrics", () => {
    const validPayload = {
      contractorId: "123e4567-e89b-12d3-a456-426614174000",
      scoreDelta: 10,
      reason: "Completed on time",
    };

    it("should create a metric and return 201", async () => {
      const mockCreated = {
        id: "2",
        ...validPayload,
        createdAt: new Date().toISOString(),
      };
      mockDb._mockReturning.mockResolvedValue([mockCreated]);

      const res = await app.request("/api/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPayload),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.metric).toEqual(mockCreated);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should return 400 for missing required fields", async () => {
      const invalidPayload = { scoreDelta: 10 }; // Missing contractorId, reason

      const res = await app.request("/api/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalidPayload),
      });

      expect(res.status).toBe(400);
    });
  });
});
