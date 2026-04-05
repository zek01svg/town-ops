import { vi, describe, it, expect, beforeEach } from "vitest";

// 1. Environment Hoisting
vi.hoisted(() => {
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.METRICS_ATOM_URL = "http://metrics-atom";
  process.env.CONTRACTOR_API_URL = "http://contractor-api";
  process.env.PORT = "6005";
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
    consume: vi.fn().mockResolvedValue(undefined),
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
import { handleSlaBreach } from "../../src/worker";
/* eslint-enable import/first */

// 3. Mock Hono Client
vi.mock("hono/client", () => ({
  hc: vi.fn(),
}));

const validBody = {
  assignment_id: "123e4567-e89b-12d3-a456-426614174000",
  case_id: "223e4567-e89b-12d3-a456-426614174001",
  breach_details: "No acknowledgment within 2 hours",
  new_assignee_id: "backup-worker-01",
  penalty: 10,
};

const mockCaseUpdate = vi.fn();
const mockAssignmentUpdate = vi.fn();
const mockMetricsCreate = vi.fn();

function buildMockClients(
  caseOk: boolean,
  assignmentOk: boolean,
  metricsOk: boolean
) {
  const caseClient = {
    api: {
      cases: {
        "update-case-status": { $put: mockCaseUpdate },
      },
    },
  };

  const assignmentClient = {
    api: {
      assignments: {
        ":id": {
          status: { $put: mockAssignmentUpdate },
        },
      },
    },
  };

  const metricsClient = {
    api: {
      metrics: { $post: mockMetricsCreate },
    },
  };

  mockCaseUpdate.mockResolvedValue({
    ok: caseOk,
    json: async () => ({
      cases: { id: validBody.case_id, status: "escalated" },
    }),
  });

  mockAssignmentUpdate.mockResolvedValue({
    ok: assignmentOk,
    json: async () => ({
      assignments: { id: validBody.assignment_id, status: "REASSIGNED" },
    }),
  });

  mockMetricsCreate.mockResolvedValue({
    ok: metricsOk,
    json: async () => ({ metric: { id: "metric-uuid", scoreDelta: -10 } }),
  });

  (hc as any).mockImplementation((url: string) => {
    if (url === "http://case-atom") return caseClient;
    if (url === "http://assignment-atom") return assignmentClient;
    if (url === "http://metrics-atom") return metricsClient;
    return {};
  });
}

describe("Handle Breach Composite - Unit Tests", () => {
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

  describe("PUT /api/assignments/handle-breach", () => {
    it("should handle breach successfully when all steps succeed", async () => {
      buildMockClients(true, true, true);

      const res = await app.request("/api/assignments/handle-breach", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.case).toBeDefined();
      expect(data.assignment).toBeDefined();
      expect(data.metrics).toBeDefined();
      expect(mockCaseUpdate).toHaveBeenCalledOnce();
      expect(mockAssignmentUpdate).toHaveBeenCalledOnce();
      expect(mockMetricsCreate).toHaveBeenCalledOnce();
    });

    it("should return 400 for validation failure (missing fields)", async () => {
      const res = await app.request("/api/assignments/handle-breach", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: "not-a-uuid" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("should return 500 when case update fails", async () => {
      buildMockClients(false, true, true);

      const res = await app.request("/api/assignments/handle-breach", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("case");
      expect(mockAssignmentUpdate).not.toHaveBeenCalled();
      expect(mockMetricsCreate).not.toHaveBeenCalled();
    });

    it("should return 500 when assignment reassignment fails", async () => {
      buildMockClients(true, false, true);

      const res = await app.request("/api/assignments/handle-breach", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("assignment");
      expect(mockMetricsCreate).not.toHaveBeenCalled();
    });

    it("should return 500 when penalty recording fails", async () => {
      buildMockClients(true, true, false);

      const res = await app.request("/api/assignments/handle-breach", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("penalty");
    });
  });

  describe("handleSlaBreach worker", () => {
    it("should process sla.breached event and publish case.escalated", async () => {
      const event = {
        assignment_id: "aaa-111",
        case_id: "bbb-222",
        contractor_id: "contractor-old",
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/backup")) {
          return {
            ok: true,
            json: async () => ({ worker_id: "backup-worker-01" }),
          };
        }
        if (url.includes("/api/assignments/")) {
          return { ok: true, json: async () => ({}) };
        }
        if (url.includes("/api/cases/update-case-status")) {
          return { ok: true, json: async () => ({}) };
        }
        if (url.includes("/api/metrics")) {
          return { ok: true, json: async () => ({}) };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await handleSlaBreach(JSON.stringify(event));

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).toHaveBeenCalledWith(
        "townops.events",
        "case.escalated",
        expect.objectContaining({
          caseId: event.case_id,
          assignmentId: event.assignment_id,
        })
      );
    });

    it("should log error and return without throwing for bad payload", async () => {
      // Missing assignment_id and case_id — invalid payload
      await expect(
        handleSlaBreach(JSON.stringify({ some: "garbage" }))
      ).resolves.toBeUndefined();
    });

    it("should throw when a downstream call fails (enabling NACK)", async () => {
      const event = {
        assignment_id: "aaa-333",
        case_id: "bbb-444",
        contractor_id: "contractor-old",
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/backup")) {
          return { ok: false, status: 503 };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await expect(handleSlaBreach(JSON.stringify(event))).rejects.toThrow(
        "Backup contractor query failed"
      );
    });

    it("should throw when assignment update fails (step 2)", async () => {
      const event = { assignment_id: "aaa-step2", case_id: "bbb-step2" };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/backup")) {
          return { ok: true, json: async () => ({ worker_id: "backup-01" }) };
        }
        if (url.includes("/api/assignments/")) {
          return { ok: false, status: 500 };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await expect(handleSlaBreach(JSON.stringify(event))).rejects.toThrow(
        "Assignment reassignment failed"
      );
    });

    it("should throw when case escalation fails (step 3)", async () => {
      const event = { assignment_id: "aaa-step3", case_id: "bbb-step3" };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/backup")) {
          return { ok: true, json: async () => ({ worker_id: "backup-01" }) };
        }
        if (url.includes("/api/assignments/")) {
          return { ok: true, json: async () => ({}) };
        }
        if (url.includes("/api/cases/update-case-status")) {
          return { ok: false, status: 500 };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await expect(handleSlaBreach(JSON.stringify(event))).rejects.toThrow(
        "Case escalation failed"
      );
    });

    it("should throw when penalty recording fails (step 4)", async () => {
      const event = { assignment_id: "aaa-step4", case_id: "bbb-step4" };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/backup")) {
          return { ok: true, json: async () => ({ worker_id: "backup-01" }) };
        }
        if (url.includes("/api/assignments/")) {
          return { ok: true, json: async () => ({}) };
        }
        if (url.includes("/api/cases/update-case-status")) {
          return { ok: true, json: async () => ({}) };
        }
        if (url.includes("/api/metrics")) {
          return { ok: false, status: 500 };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await expect(handleSlaBreach(JSON.stringify(event))).rejects.toThrow(
        "Penalty recording failed"
      );
    });

    it("should return without throwing on unparseable JSON", async () => {
      await expect(
        handleSlaBreach("{not-valid-json}")
      ).resolves.toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).not.toHaveBeenCalled();
    });
  });
});
