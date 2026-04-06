import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.RESIDENT_ATOM_URL = "http://resident-atom";
  process.env.PORT = "6007";
  process.env.RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
});

const { mockRabbitmqClient, mockLogger, mockHc } = vi.hoisted(() => ({
  mockRabbitmqClient: {
    publish: vi.fn().mockResolvedValue(true),
  },
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockHc: vi.fn(),
}));

vi.mock("@townops/shared-ts", () => ({
  logger: mockLogger,
  honoLogger: () => (c: any, next: any) => next(),
  rabbitmqClient: mockRabbitmqClient,
  corsOrigins: () => ["http://localhost:5173"],
  initSentry: vi.fn(),
  captureHonoException: vi.fn(),
}));

vi.mock("hono/client", () => ({
  hc: mockHc,
}));

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

/* eslint-disable import/first */
import { app } from "../../src/index";
/* eslint-enable import/first */

describe("Handle No Access Composite - Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /health", () => {
    it("should return 200 healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("PUT /api/cases/no-access", () => {
    const validBody = {
      caseId: "123e4567-e89b-12d3-a456-426614174000",
      assignmentId: "223e4567-e89b-12d3-a456-426614174001",
      contractorId: "323e4567-e89b-12d3-a456-426614174002",
      reason: "Resident unavailable",
    };
    const residentId = "423e4567-e89b-12d3-a456-426614174003";

    it("should update case and publish resident alert (Success Path)", async () => {
      const mockCaseClient = {
        api: {
          cases: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                  cases: [{ id: validBody.caseId, residentId }],
                }),
              }),
            },
            "update-case-status": {
              $put: vi.fn().mockResolvedValue({
                ok: true,
              }),
            },
          },
        },
      };

      const mockResidentClient = {
        api: {
          residents: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                  residents: [{ id: residentId, email: "resident@test.dev" }],
                }),
              }),
            },
          },
        },
      };

      mockHc.mockImplementation((url: string) => {
        if (url === "http://case-atom") return mockCaseClient;
        if (url === "http://resident-atom") return mockResidentClient;
        return {};
      });

      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("pending_resident_input");

      // Verify RabbitMQ publishing
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRabbitmqClient.publish).toHaveBeenCalledWith(
        "townops.events",
        "case.no_access",
        expect.objectContaining({
          caseId: validBody.caseId,
          residentId,
          email: "resident@test.dev",
          message: validBody.reason,
        })
      );
    });

    it("should handle single record JSON response from Case Atom", async () => {
      const mockCaseClient = {
        api: {
          cases: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                  id: validBody.caseId,
                  resident_id: residentId,
                }),
              }),
            },
            "update-case-status": {
              $put: vi.fn().mockResolvedValue({ ok: true }),
            },
          },
        },
      };
      const mockResidentClient = {
        api: {
          residents: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ id: residentId, email: "res@test.com" }),
              }),
            },
          },
        },
      };

      mockHc.mockImplementation((url: string) => {
        if (url === "http://case-atom") return mockCaseClient;
        if (url === "http://resident-atom") return mockResidentClient;
        return {};
      });

      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ success: true })
      );
    });

    it("should return 400 for validation failure (missing caseId)", async () => {
      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "oops" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("should return 404 when case record is empty list", async () => {
      const mockCaseClient = {
        api: {
          cases: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ cases: [] }),
              }),
            },
          },
        },
      };

      mockHc.mockImplementation((url: string) => {
        if (url === "http://case-atom") return mockCaseClient;
        return {};
      });

      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Case not found" });
    });

    it("should return 404 when case is not found (404 from atom)", async () => {
      const mockCaseClient = {
        api: {
          cases: {
            ":id": { $get: vi.fn().mockResolvedValue({ ok: false }) },
          },
        },
      };

      mockHc.mockImplementation((url: string) => {
        if (url === "http://case-atom") return mockCaseClient;
        return {};
      });

      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(404);
    });

    it("should return 404 when case record has no residentId", async () => {
      const mockCaseClient = {
        api: {
          cases: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ id: validBody.caseId }), // No residentId
              }),
            },
          },
        },
      };

      mockHc.mockImplementation((url: string) => {
        if (url === "http://case-atom") return mockCaseClient;
        return {};
      });

      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Resident not found" });
    });

    it("should return 404 when resident is not found (404 from atom)", async () => {
      const mockCaseClient = {
        api: {
          cases: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ id: validBody.caseId, residentId }),
              }),
            },
          },
        },
      };
      const mockResidentClient = {
        api: {
          residents: {
            ":id": { $get: vi.fn().mockResolvedValue({ ok: false }) },
          },
        },
      };

      mockHc.mockImplementation((url: string) => {
        if (url === "http://case-atom") return mockCaseClient;
        if (url === "http://resident-atom") return mockResidentClient;
        return {};
      });

      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Resident not found" });
    });

    it("should return 503 when case status update fails", async () => {
      const mockCaseClient = {
        api: {
          cases: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ id: validBody.caseId, residentId }),
              }),
            },
            "update-case-status": {
              $put: vi.fn().mockResolvedValue({ ok: false }),
            },
          },
        },
      };
      const mockResidentClient = {
        api: {
          residents: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ id: residentId }),
              }),
            },
          },
        },
      };

      mockHc.mockImplementation((url: string) => {
        if (url === "http://case-atom") return mockCaseClient;
        if (url === "http://resident-atom") return mockResidentClient;
        return {};
      });

      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "Failed to update case status",
      });
    });

    it("should return 500 when RabbitMQ publishing throws", async () => {
      const mockCaseClient = {
        api: {
          cases: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ id: validBody.caseId, residentId }),
              }),
            },
            "update-case-status": {
              $put: vi.fn().mockResolvedValue({ ok: true }),
            },
          },
        },
      };
      const mockResidentClient = {
        api: {
          residents: {
            ":id": {
              $get: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ id: residentId }),
              }),
            },
          },
        },
      };

      mockHc.mockImplementation((url: string) => {
        if (url === "http://case-atom") return mockCaseClient;
        if (url === "http://resident-atom") return mockResidentClient;
        return {};
      });

      mockRabbitmqClient.publish.mockRejectedValueOnce(
        new Error("RabbitMQ down")
      );

      const res = await app.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "RabbitMQ down" });
    });
  });
});
