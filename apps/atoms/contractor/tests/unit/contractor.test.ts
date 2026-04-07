import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

// Create mocks that are hoisted correctly by Vitest
const { mockQuery, mockDb } = vi.hoisted(() => {
  // Set mock environment variables before running tests
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5009";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";

  const q = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    // eslint-disable-next-line unicorn/no-thenable
    then: vi.fn(),
  };

  const db = {
    select: vi.fn().mockReturnValue(q),
    update: vi.fn().mockReturnValue(q),
    insert: vi.fn().mockReturnValue(q),
    delete: vi.fn().mockReturnValue(q),
  };

  return { mockQuery: q, mockDb: db };
});

vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

describe("Contractor Atom API Endpoints (Unit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default resolve value for queries:
    mockQuery.then.mockImplementation((resolve) => resolve([]));
  });

  const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
  const TEST_CONTRACTOR = {
    id: VALID_UUID,
    name: "Test Contractor",
    email: "test@example.com",
    contactNum: "12345678",
    isActive: true,
  };

  describe("GET /health", () => {
    it("should return 200 and healthy status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /api/contractors", () => {
    it("should return 200 and list of contractors", async () => {
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([TEST_CONTRACTOR])
      );
      // mockup withRelations
      mockQuery.then.mockImplementation((resolve) => resolve([]));

      const res = await app.request("/api/contractors");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.contractors).toBeDefined();
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe("POST /api/contractors", () => {
    it("should create a new contractor and return 201", async () => {
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([TEST_CONTRACTOR])
      );

      const payload = {
        name: "New Contractor",
        email: "new@example.com",
        contactNum: "87654321",
      };

      const res = await app.request("/api/contractors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ contractor: TEST_CONTRACTOR });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should return 400 for invalid email", async () => {
      const res = await app.request("/api/contractors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Invalid", email: "not-an-email" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/contractors/:id", () => {
    it("should return 200 and contractor", async () => {
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([TEST_CONTRACTOR])
      );

      const res = await app.request(`/api/contractors/${VALID_UUID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.contractor.id).toBe(VALID_UUID);
    });

    it("should return 404 if not found", async () => {
      mockQuery.then.mockImplementationOnce((resolve) => resolve([]));
      const res = await app.request(`/api/contractors/${VALID_UUID}`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/contractors/search", () => {
    it("should return 200 and search results", async () => {
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([TEST_CONTRACTOR])
      );

      const res = await app.request(
        "/api/contractors/search?sectorCode=S1&categoryCode=K1"
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.contractors).toHaveLength(1);
      expect(mockQuery.innerJoin).toHaveBeenCalledTimes(2);
    });
  });
});
