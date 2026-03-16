import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

// Create mocks that are hoisted correctly by Vitest
const { mockQuery, mockDb } = vi.hoisted(() => {
  // Set mock environment variables before running tests
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5001";
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

vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

describe("Case Atom API Endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default resolve value for queries:
    mockQuery.then.mockImplementation((resolve) => resolve([]));
  });

  const VALID_UUID_1 = "123e4567-e89b-12d3-a456-426614174000";
  const VALID_UUID_2 = "123e4567-e89b-12d3-a456-426614174001";

  describe("GET /health", () => {
    it("should return 200 and healthy status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /api/cases", () => {
    it("should return 200 and a list of cases", async () => {
      const mockCases = [
        {
          id: VALID_UUID_1,
          residentId: VALID_UUID_2,
          category: "LE",
          priority: "medium",
          status: "pending",
        },
      ];
      mockQuery.then.mockImplementationOnce((resolve) => resolve(mockCases));

      const res = await app.request("/api/cases");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cases: mockCases });
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockQuery.from).toHaveBeenCalled();
    });

    it("should return 500 when database throws an error", async () => {
      // Mock throw in query Promise
      mockQuery.then.mockImplementationOnce((_, reject) =>
        reject(new Error("DB query failed"))
      );

      const res = await app.request("/api/cases");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/cases/:id", () => {
    it("should return 200 and case with given ID", async () => {
      const mockCase = {
        id: VALID_UUID_1,
        residentId: VALID_UUID_2,
        category: "LE",
        priority: "medium",
        status: "pending",
      };
      mockQuery.then.mockImplementationOnce((resolve) => resolve([mockCase]));

      const res = await app.request(`/api/cases/${VALID_UUID_1}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cases: [mockCase] });
      expect(mockQuery.where).toHaveBeenCalled();
    });

    it("should return 400 for invalid UUID", async () => {
      const res = await app.request("/api/cases/not-a-uuid");
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });
  });

  describe("PUT /api/cases/update-case-status/", () => {
    it("should update case status and return 200", async () => {
      const updatedCase = { id: VALID_UUID_1, status: "assigned" };
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([updatedCase])
      );

      const payload = { id: VALID_UUID_1, status: "assigned" };
      const res = await app.request("/api/cases/update-case-status/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cases: updatedCase });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("should return 400 for invalid status", async () => {
      const payload = { id: VALID_UUID_1, status: "invalid-status" };
      const res = await app.request("/api/cases/update-case-status/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });

    it("should return 400 for invalid UUID", async () => {
      const payload = { id: "not-a-uuid", status: "assigned" };
      const res = await app.request("/api/cases/update-case-status/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });
  });

  describe("POST /api/cases/new-case", () => {
    it("should create a new case and return 201", async () => {
      const newCaseData = {
        id: VALID_UUID_1,
        residentId: VALID_UUID_2,
        category: "LE",
        status: "pending",
      };
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([newCaseData])
      );

      const payload = {
        residentId: VALID_UUID_2,
        category: "LE",
        status: "pending",
      };
      const res = await app.request("/api/cases/new-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ cases: newCaseData });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should return 400 for invalid payload", async () => {
      const res = await app.request("/api/cases/new-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // Empty payload
      });

      expect(res.status).toBe(400);
    });
  });
});
