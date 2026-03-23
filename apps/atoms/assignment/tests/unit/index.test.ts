import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

const { mockQuery, mockDb } = vi.hoisted(() => {
  const q = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    // eslint-disable-next-line unicorn/no-thenable
    then: vi.fn().mockImplementation((resolve: any) => resolve([])),
  };

  const db = {
    select: vi.fn().mockReturnValue(q),
    insert: vi.fn().mockReturnValue(q),
    update: vi.fn().mockReturnValue(q),
    delete: vi.fn().mockReturnValue(q),
  };

  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5003";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
  process.env.NODE_ENV = "test";

  return { mockQuery: q, mockDb: db };
});

// Mock database module
vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

// Setup auth interceptors mock to avoid rejection pipelines overflows
vi.mock("hono/jwk", () => ({ jwk: () => (c: any, next: any) => next() }));

vi.mock("@townops/shared-ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  honoLogger: () => (c: any, next: any) => next(),
}));

describe("Assignment Atom Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.then.mockImplementation((resolve: any) => resolve([]));
  });

  describe("GET /health", () => {
    it("should return healthy check string layout", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /api/assignments", () => {
    it("should return empty list when no assignments exist", async () => {
      mockQuery.then.mockImplementationOnce((resolve: any) => resolve([]));

      const res = await app.request("/api/assignments");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.assignments).toHaveLength(0);
    });

    it("should return populated list of assignments", async () => {
      const mockResult = [
        {
          id: "some-uuid",
          caseId: "case-uuid",
          contractorId: "contractor-uuid",
        },
      ];
      mockQuery.then.mockImplementationOnce((resolve: any) =>
        resolve(mockResult)
      );

      const res = await app.request("/api/assignments");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.assignments).toEqual(mockResult);
    });
  });

  describe("GET /api/assignments/:id", () => {
    it("should return 404 for non-existent records", async () => {
      mockQuery.then.mockImplementationOnce((resolve: any) => resolve([]));

      const res = await app.request(
        "/api/assignments/123e4567-e89b-12d3-a456-426614174000"
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toHaveProperty("error", "Assignment not found");
    });

    it("should return populated row if record found", async () => {
      const row = { id: "123e4567-e89b-12d3-a456-426614174000", caseId: "xyz" };
      mockQuery.then.mockImplementationOnce((resolve: any) => resolve([row]));

      const res = await app.request(
        "/api/assignments/123e4567-e89b-12d3-a456-426614174000"
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.assignment).toEqual(row);
    });
  });

  describe("POST /api/assignments", () => {
    it("should return 400 for malformed json inputs payloads validation triggers failures", async () => {
      const res = await app.request("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: "data" }),
      });
      expect(res.status).toBe(400);
    });

    it("should return 201 with created element mock returning", async () => {
      const payload = {
        caseId: "123e4567-e89b-12d3-a456-426614174000",
        contractorId: "223e4567-e89b-12d3-a456-426614174001",
        status: "pending",
      };

      const mockCreated = { id: "new-id", ...payload };
      mockQuery.then.mockImplementationOnce((resolve: any) =>
        resolve([mockCreated])
      );

      const res = await app.request("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.assignment).toEqual(mockCreated);
    });
  });
});
