import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

// Create mocks that are hoisted correctly by Vitest
const { mockQuery, mockDb } = vi.hoisted(() => {
  // Set mock environment variables before running tests
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5002"; // Distinct from case atom
  process.env.JWT_SECRET = "supersecret";
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

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

describe("Resident Atom API Endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default resolve value for queries:
    mockQuery.then.mockImplementation((resolve) => resolve([]));
  });

  const VALID_UUID_1 = "123e4567-e89b-12d3-a456-426614174000";
  const TEST_RESIDENT = {
    id: VALID_UUID_1,
    fullName: "John Doe",
    email: "john.doe@example.com",
    role: "resident",
    contactNumber: "12345678",
    postalCode: "123456",
    isActive: true,
  };

  describe("GET /health", () => {
    it("should return 200 and healthy status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /api/residents/:id", () => {
    it("should return 200 and resident with given ID", async () => {
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([TEST_RESIDENT])
      );

      const res = await app.request(`/api/residents/${VALID_UUID_1}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ residents: [TEST_RESIDENT] });
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockQuery.from).toHaveBeenCalled();
      expect(mockQuery.where).toHaveBeenCalled();
    });

    it("should return 400 for invalid UUID", async () => {
      const res = await app.request("/api/residents/not-a-uuid");
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });

    it("should return 500 when database throws an error", async () => {
      mockQuery.then.mockImplementationOnce((_, reject) =>
        reject(new Error("DB query failed"))
      );

      const res = await app.request(`/api/residents/${VALID_UUID_1}`);
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/residents/search", () => {
    it("should return 200 and resident found by postal code", async () => {
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([TEST_RESIDENT])
      );

      const res = await app.request("/api/residents/search?postalCode=123456");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ residents: [TEST_RESIDENT] });
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockQuery.where).toHaveBeenCalled();
    });

    it("should return 400 for invalid postal code length", async () => {
      const res = await app.request("/api/residents/search?postalCode=12345"); // 5 chars
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/residents/new-resident", () => {
    it("should create a new resident and return 201", async () => {
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([TEST_RESIDENT])
      );

      const payload = {
        id: VALID_UUID_1, // Assuming schema requires ID if no default
        fullName: "John Doe",
        email: "john.doe@example.com",
        role: "resident",
        contactNumber: "12345678",
        postalCode: "123456",
      };

      const res = await app.request("/api/residents/new-resident", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ resident: TEST_RESIDENT });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should return 400 for invalid payload", async () => {
      const res = await app.request("/api/residents/new-resident", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: "Missing Email" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/residents/update-resident", () => {
    it("should update resident and return 200", async () => {
      const updatedResident = { ...TEST_RESIDENT, fullName: "Jane Doe" };
      mockQuery.then.mockImplementationOnce((resolve) =>
        resolve([updatedResident])
      );

      const payload = {
        id: VALID_UUID_1,
        fullName: "Jane Doe",
        email: "john.doe@example.com",
        role: "resident",
      };

      const res = await app.request("/api/residents/update-resident", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ resident: updatedResident });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("should return 400 for invalid payload (missing id)", async () => {
      const payload = {
        fullName: "Jane Doe",
      };

      const res = await app.request("/api/residents/update-resident", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
    });
  });
});
