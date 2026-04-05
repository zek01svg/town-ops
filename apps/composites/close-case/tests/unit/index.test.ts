import { vi, describe, it, expect, beforeEach } from "vitest";

// 1. Environment Hoisting
vi.hoisted(() => {
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.PROOF_ATOM_URL = "http://proof-atom";
  process.env.PORT = "6004";
  process.env.RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
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
    connect: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(true),
  },
}));

// Mock jwk middleware to bypass auth
vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

/* eslint-disable import/first */
import { rabbitmqClient } from "@townops/shared-ts";
import { hc } from "hono/client";

import { app } from "../../src/index";
/* eslint-enable import/first */

// 3. Mock Hono Client
vi.mock("hono/client", () => ({
  hc: vi.fn(),
}));

const validBody = {
  case_id: "123e4567-e89b-12d3-a456-426614174000",
  uploader_id: "223e4567-e89b-12d3-a456-426614174001",
  proof_items: [
    {
      media_url: "https://example.com/photo.jpg",
      type: "before",
      remarks: "Leaking pipe",
    },
    { media_url: "https://example.com/after.jpg", type: "after" },
  ],
  final_status: "completed" as const,
};

const mockCaseGet = vi.fn();
const mockCaseUpdate = vi.fn();
const mockProofPost = vi.fn();

function buildMockClients(
  caseGetOk: boolean,
  caseGetStatus: number,
  proofOk: boolean,
  caseUpdateOk: boolean
) {
  const caseClient = {
    api: {
      cases: {
        ":id": { $get: mockCaseGet },
        "update-case-status": { $put: mockCaseUpdate },
      },
    },
  };

  const proofClient = {
    api: {
      proof: {
        batch: { $post: mockProofPost },
      },
    },
  };

  mockCaseGet.mockResolvedValue({
    ok: caseGetOk,
    status: caseGetStatus,
    json: async () => ({
      cases: [{ id: validBody.case_id, status: "in_progress" }],
    }),
  });

  mockProofPost.mockResolvedValue({
    ok: proofOk,
    json: async () => ({
      proof: validBody.proof_items.map((item) => ({
        ...item,
        id: "proof-uuid",
        caseId: validBody.case_id,
      })),
    }),
  });

  mockCaseUpdate.mockResolvedValue({
    ok: caseUpdateOk,
    json: async () => ({
      cases: { id: validBody.case_id, status: "completed" },
    }),
  });

  (hc as any).mockImplementation((url: string) => {
    if (url === "http://case-atom") return caseClient;
    if (url === "http://proof-atom") return proofClient;
    return {};
  });
}

describe("Close Case Composite - Unit Tests", () => {
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

  describe("POST /api/cases/close-case", () => {
    it("should close case successfully when all steps succeed", async () => {
      buildMockClients(true, 200, true, true);

      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.case_id).toBe(validBody.case_id);
      expect(data.proof_stored).toBe(2);
      expect(data.message).toContain(validBody.case_id);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).toHaveBeenCalledWith(
        "townops.events",
        "job.done",
        expect.objectContaining({ caseId: validBody.case_id })
      );
    });

    it("should return 400 for validation failure (empty proof_items)", async () => {
      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, proof_items: [] }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("should return 404 when case is not found", async () => {
      buildMockClients(false, 404, true, true);

      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain(validBody.case_id);
      expect(mockProofPost).not.toHaveBeenCalled();
    });

    it("should return 502 when case service returns non-404 error on verification", async () => {
      buildMockClients(false, 500, true, true);

      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(502);
      expect(mockProofPost).not.toHaveBeenCalled();
    });

    it("should return 502 when proof service fails", async () => {
      buildMockClients(true, 200, false, true);

      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toContain("Proof service");
      expect(mockCaseUpdate).not.toHaveBeenCalled();
    });

    it("should return 502 when case status update fails", async () => {
      buildMockClients(true, 200, true, false);

      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toContain("Case service");
    });

    it("should return 400 for missing required fields (no uploader_id or proof_items)", async () => {
      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: validBody.case_id }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("should succeed with a single proof item and omitted final_status (defaults to completed)", async () => {
      buildMockClients(true, 200, true, true);

      const body = {
        case_id: validBody.case_id,
        uploader_id: validBody.uploader_id,
        proof_items: [
          { media_url: "https://example.com/only.jpg", type: "after" },
        ],
      };

      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.proof_stored).toBe(1);
    });

    it("should return 200 even when RabbitMQ publish throws (non-fatal)", async () => {
      buildMockClients(true, 200, true, true);
      (rabbitmqClient.publish as any).mockRejectedValueOnce(
        new Error("AMQP connection lost")
      );

      const res = await app.request("/api/cases/close-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      // Non-fatal — still succeeds
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });
});
