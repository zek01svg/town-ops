import { vi, describe, it, expect, beforeEach } from "vitest";

// 1. Environment Hoisting
vi.hoisted(() => {
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.RESIDENT_ATOM_URL = "http://resident-atom";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.PORT = "3000";
});

// 2. Mock Shared Libraries
vi.mock("@townops/shared-ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  honoLogger: () => (c: any, next: any) => next(),
  rabbitmqClient: {
    publish: vi.fn().mockResolvedValue(true),
  },
  corsOrigins: () => ["http://localhost:5173"],
}));

// Mock jwk middleware to bypass auth
vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

/* eslint-disable import/first */
import { rabbitmqClient } from "@townops/shared-ts";
import { hc } from "hono/client";

import { app } from "../../src/index";
/* eslint-disable import/first */

// 3. Mock Hono Client
vi.mock("hono/client", () => ({
  hc: vi.fn(),
}));

describe("Open Case Composite - Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /health", () => {
    it("should return 200 Healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("POST /api/cases/open-case", () => {
    const validRequestBody = {
      resident_id: "123e4567-e89b-12d3-a456-426614174000",
      category: "plumbing",
      priority: "high",
      description: "Leaking tap",
      address_details: "Floor 2",
    };

    it("should open case successfully and publish event", async () => {
      // Setup mocks
      const mockResidentResponse = {
        ok: true,
        json: async () => ({ id: "resident-uuid" }),
      };
      const mockCaseResponse = {
        ok: true,
        json: async () => ({ cases: { id: "case-uuid" } }),
      };

      const mockResidentClient = {
        api: {
          residents: {
            ":id": { $get: vi.fn().mockResolvedValue(mockResidentResponse) },
          },
        },
      };

      const mockCaseClient = {
        api: {
          cases: {
            "new-case": { $post: vi.fn().mockResolvedValue(mockCaseResponse) },
          },
        },
      };

      (hc as any).mockImplementation((url: string) => {
        if (url === "http://resident-atom") return mockResidentClient;
        if (url === "http://case-atom") return mockCaseClient;
        return {};
      });

      // Assertions
      const res = await app.request("/api/cases/open-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validRequestBody),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.message).toBe("Case opened successfully");
      expect(data.case.resident_id).toBe(validRequestBody.resident_id);

      // Verify RabbitMQ publish
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).toHaveBeenCalledWith(
        "townops.events",
        "case.opened",
        expect.objectContaining({
          caseId: "case-uuid",
          residentId: validRequestBody.resident_id,
          category: validRequestBody.category,
        })
      );
    });

    it("should return 400 for validation failure (invalid UUID)", async () => {
      const res = await app.request("/api/cases/open-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resident_id: "invalid-uuid",
          category: "plumbing",
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("should return 400 when resident is not found", async () => {
      // Mock Resident response to be NOT OK
      const mockResidentResponse = { ok: false };
      const mockResidentClient = {
        api: {
          residents: {
            ":id": { $get: vi.fn().mockResolvedValue(mockResidentResponse) },
          },
        },
      };

      (hc as any).mockImplementation((url: string) => {
        if (url === "http://resident-atom") return mockResidentClient;
        return {};
      });

      const res = await app.request("/api/cases/open-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validRequestBody),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Resident not found");
    });

    it("should return 500 when case creation fails", async () => {
      // Mock Resident succeeds
      const mockResidentResponse = {
        ok: true,
        json: async () => ({ id: "resident-uuid" }),
      };
      const mockResidentClient = {
        api: {
          residents: {
            ":id": { $get: vi.fn().mockResolvedValue(mockResidentResponse) },
          },
        },
      };

      // Mock Case creation FAILS
      const mockCaseResponse = { ok: false };
      const mockCaseClient = {
        api: {
          cases: {
            "new-case": { $post: vi.fn().mockResolvedValue(mockCaseResponse) },
          },
        },
      };

      (hc as any).mockImplementation((url: string) => {
        if (url === "http://resident-atom") return mockResidentClient;
        if (url === "http://case-atom") return mockCaseClient;
        return {};
      });

      const res = await app.request("/api/cases/open-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validRequestBody),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Failed to create case");
    });
  });
});
