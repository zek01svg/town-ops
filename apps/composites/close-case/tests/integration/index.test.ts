import { describe, it, expect, vi, beforeEach } from "vitest";

// 1. Mocks and Environment — must precede all imports
const { mockLogger, mockRabbitMQ } = vi.hoisted(() => {
  return {
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    mockRabbitMQ: {
      connect: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockImplementation(async () => {
        // Simple mock implementation
        return true;
      }),
      consume: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.hoisted(() => {
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.PROOF_ATOM_URL = "http://proof-atom";
  process.env.PORT = "6004";
  // RABBITMQ_URL is provided by global-setup.ts Testcontainer
});

vi.mock("@townops/shared-ts", () => ({
  logger: mockLogger,
  honoLogger: () => (_c: any, next: any) => next(),
  rabbitmqClient: mockRabbitMQ,
}));

// Bypass JWK auth — integration focus is downstream orchestration
vi.mock("hono/jwk", () => ({
  jwk: () => (_c: any, next: () => Promise<void>) => next(),
}));

/* eslint-disable import/first */
import { app } from "../../src/index";
/* eslint-enable import/first */

// ── Fixtures ────────────────────────────────────────────────────────────────

const CASE_ID = "123e4567-e89b-12d3-a456-426614174000";
const UPLOADER_ID = "223e4567-e89b-12d3-a456-426614174001";

const validBody = {
  case_id: CASE_ID,
  uploader_id: UPLOADER_ID,
  proof_items: [
    {
      media_url: "http://storage.com/image1.jpg",
      type: "after",
      remarks: "Work completed",
    },
  ],
  final_status: "completed",
};

// ── Fetch mock factory ───────────────────────────────────────────────────────

function makeFetch(
  opts: {
    caseExists?: boolean;
    caseVerifyOk?: boolean;
    proofStoreOk?: boolean;
    caseUpdateOk?: boolean;
  } = {}
) {
  const {
    caseExists = true,
    caseVerifyOk = true,
    proofStoreOk = true,
    caseUpdateOk = true,
  } = opts;

  return vi
    .fn()
    .mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();

        // 1. Verify case exists check
        if (url.includes(`/api/cases/${CASE_ID}`) && init?.method === "GET") {
          if (!caseVerifyOk)
            return new Response("Downstream error", { status: 500 });
          if (!caseExists) return new Response("Not found", { status: 404 });
          return new Response(
            JSON.stringify({ cases: [{ id: CASE_ID, status: "IN_PROGRESS" }] }),
            { status: 200 }
          );
        }

        // 2. Store proof items
        if (url.includes("/api/proof") && init?.method === "POST") {
          if (!proofStoreOk)
            return new Response("Store failed", { status: 500 });
          return new Response(JSON.stringify({ proof: [{ id: "proof-id" }] }), {
            status: 200,
          });
        }

        // 3. Update case status
        if (
          url.includes("/api/cases/update-case-status") &&
          init?.method === "PUT"
        ) {
          if (!caseUpdateOk)
            return new Response("Update failed", { status: 500 });
          return new Response(
            JSON.stringify({ cases: { id: CASE_ID, status: "completed" } }),
            {
              status: 200,
            }
          );
        }

        return new Response("Not found", { status: 404 });
      }
    );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Close Case Composite - Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should successfully close a case when all downstream calls succeed", async () => {
    globalThis.fetch = makeFetch();

    const res = await app.request("/api/cases/close-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.proof_stored).toBe(1);

    // Verify RabbitMQ publish
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(
      "townops.events",
      "job.done",
      expect.objectContaining({ caseId: CASE_ID })
    );
  });

  it("should return 404 if case does not exist", async () => {
    globalThis.fetch = makeFetch({ caseExists: false });

    const res = await app.request("/api/cases/close-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/not found/i);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRabbitMQ.publish).not.toHaveBeenCalled();
  });

  it("should return 502 if case verification fails", async () => {
    globalThis.fetch = makeFetch({ caseVerifyOk: false });

    const res = await app.request("/api/cases/close-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(502);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRabbitMQ.publish).not.toHaveBeenCalled();
  });

  it("should return 502 if proof storage fails", async () => {
    globalThis.fetch = makeFetch({ proofStoreOk: false });

    const res = await app.request("/api/cases/close-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(502);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRabbitMQ.publish).not.toHaveBeenCalled();
  });

  it("should return 502 if case status update fails", async () => {
    globalThis.fetch = makeFetch({ caseUpdateOk: false });

    const res = await app.request("/api/cases/close-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(502);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRabbitMQ.publish).not.toHaveBeenCalled();
  });

  it("should finish successfully even if RabbitMQ publish fails (non-fatal)", async () => {
    globalThis.fetch = makeFetch();
    // eslint-disable-next-line @typescript-eslint/require-await
    mockRabbitMQ.publish.mockImplementationOnce(async () => {
      throw new Error("Broke");
    });

    const res = await app.request("/api/cases/close-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // Should have logged the error but not failed the request
  });

  it("should return 400 on validation failure (missing caseId)", async () => {
    const res = await app.request("/api/cases/close-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, case_id: "not-a-uuid" }),
    });

    expect(res.status).toBe(400);
  });
});
