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
const { dbMock, insertMockChain } = vi.hoisted(() => {
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

vi.mock("@townops/shared-ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
  honoLogger: () => (c: any, next: any) => next(),
  corsOrigins: () => ["http://localhost:5173"],
  initSentry: vi.fn(),
  captureHonoException: vi.fn(),
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

    // These two tests exercise the privilege-field guarantee described in
    // `apps/atoms/auth/src/auth.ts`: public sign-up can never elect Officer
    // status or link a Contractor ID. The mocked `insert().returning()` value
    // is a fixed fixture that does not carry `role`/`contractor_id`, so the
    // *response* body cannot prove anything here (it would look identical
    // whether or not the guard existed). The only direct evidence is what
    // better-auth actually handed to the mocked `db.insert(...).values(...)`
    // call, so that is what these assertions inspect.
    it("cannot self-elect an Officer role: signup always persists RESIDENT regardless of the requested role", async () => {
      insertMockChain.values.mockClear();

      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Attempted Officer",
          email: "officer-attempt@example.com",
          password: "SuperSecretPassword123!",
          role: "OFFICER",
        }),
      });

      expect(res.status).toBe(200);
      const [userInsertValues] = insertMockChain.values.mock.calls[0];
      expect(userInsertValues).toMatchObject({ role: "RESIDENT" });
      expect(userInsertValues.role).not.toBe("OFFICER");
    });

    it("rejects a contractorId injection outright, so a signup attempt can never link an Account to a Contractor", async () => {
      insertMockChain.values.mockClear();

      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Attempted Officer",
          email: "officer-attempt-2@example.com",
          password: "SuperSecretPassword123!",
          role: "OFFICER",
          contractorId: "11111111-1111-1111-1111-111111111111",
        }),
      });

      // `contractorId` has `input: false` and no `defaultValue`, so unlike
      // `role` it is not silently overridden -- better-auth hard-rejects the
      // whole request before any Account is created. That is a *stronger*
      // guarantee than "stripped": this proves Contractor linkage cannot be
      // requested at all through public signup, not merely that it would be
      // ignored.
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "FIELD_NOT_ALLOWED",
        message: expect.stringContaining("contractorId"),
      });
      expect(insertMockChain.values).not.toHaveBeenCalled();
    });
  });
});
