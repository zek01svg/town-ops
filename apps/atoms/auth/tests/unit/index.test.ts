import { describe, it, expect, vi } from "vitest";

import { app } from "../../src/index";

// Setup necessary environment variables via hoisted mocks before imports evaluate
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.BETTER_AUTH_SECRET = "8183b03d6053e0f618df1ba7b99bdb7f";
  process.env.BETTER_AUTH_URL = "http://localhost:5001";
  process.env.GOOGLE_CLIENT_ID = "test_google_id";
  process.env.GOOGLE_CLIENT_SECRET = "test_google_secret";
  process.env.PORT = "5001";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
});

// Mock database interactions to isolate server checks
const { dbMock } = vi.hoisted(() => {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };

  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi
      .fn()
      .mockResolvedValue([
        { id: "123", email: "test@example.com", name: "Test User" },
      ]),
  };

  const mock = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnThis(),
    transaction: vi.fn().mockImplementation((cb) => cb(mock as any)),
  };

  return {
    dbMock: mock,
    selectMockChain: selectChain,
    insertMockChain: insertChain,
  };
});

vi.mock("../../src/database/db", () => ({
  default: dbMock,
}));

describe("Auth Atom API Endpoints", () => {
  describe("GET /health", () => {
    it("should return 200 and healthy status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /scalar", () => {
    it("should return 200 and render API reference", async () => {
      const res = await app.request("/scalar");
      expect(res.status).toBe(200);
    });
  });

  describe("API Calls to /api/auth", () => {
    it("should simulate sign-up/email with mock db responses", async () => {
      const payload = {
        name: "Test User",
        email: "test@example.com",
        password: "SuperSecretPassword123!",
      };

      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("user");
      expect(data.user.email).toBe(payload.email);
    });
  });
});
