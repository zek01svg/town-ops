import { vi, describe, it, expect, beforeEach } from "vitest";

// 1. Environment Hoisting
vi.hoisted(() => {
  process.env.PORT = "6002";
  process.env.RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
  process.env.CONTRACTOR_API_URL = "http://contractor-api";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.METRICS_ATOM_URL = "http://metrics-atom";
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
}));

/* eslint-disable import/first */
import { rabbitmqClient } from "@townops/shared-ts";

import { handleCaseOpened } from "../../src/consumer";
import { app } from "../../src/index";
import { assignContractor, selectBest } from "../../src/services";
/* eslint-enable import/first */

describe("Assign Job Composite - Unit Tests", () => {
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

  describe("selectBest", () => {
    it("should pick contractor with fewest jobs", () => {
      const contractors = [
        { contractorId: "A", totalJobs: 5, totalScore: 100 },
        { contractorId: "B", totalJobs: 2, totalScore: 80 },
        { contractorId: "C", totalJobs: 3, totalScore: 90 },
      ];
      const best = selectBest(contractors);
      expect(best.contractorId).toBe("B");
    });

    it("should break ties by highest score", () => {
      const contractors = [
        { contractorId: "A", totalJobs: 3, totalScore: 60 },
        { contractorId: "B", totalJobs: 3, totalScore: 90 },
        { contractorId: "C", totalJobs: 3, totalScore: 75 },
      ];
      const best = selectBest(contractors);
      expect(best.contractorId).toBe("B");
    });
  });

  describe("assignContractor", () => {
    const caseId = "123e4567-e89b-12d3-a456-426614174000";

    it("should complete the full workflow and publish job.assigned", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/search")) {
          return {
            ok: true,
            json: async () => [
              { ContractorUuid: "contractor-1", name: "Fix It Ltd" },
            ],
          };
        }
        if (url.includes("/api/metrics/")) {
          return {
            ok: true,
            json: async () => ({
              metrics: [{ score_delta: 10 }, { score_delta: 5 }],
            }),
          };
        }
        if (url.includes("/api/assignments")) {
          return {
            ok: true,
            json: async () => ({
              assignments: {
                id: "assign-uuid",
                caseId,
                contractorId: "contractor-1",
              },
            }),
          };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await assignContractor(caseId, "510000", "PLUMBING");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).toHaveBeenCalledWith(
        "townops.events",
        "job.assigned",
        expect.objectContaining({
          caseId,
          contractorId: "contractor-1",
          status: "PENDING_ACCEPTANCE",
        })
      );
    });

    it("should throw when no contractors are found", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/search")) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await expect(
        assignContractor(caseId, "510000", "PLUMBING")
      ).rejects.toThrow("No eligible contractors found");
    });

    it("should throw when metrics fetch fails", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/search")) {
          return {
            ok: true,
            json: async () => [{ ContractorUuid: "contractor-1" }],
          };
        }
        if (url.includes("/api/metrics/")) {
          return { ok: false, status: 503 };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await expect(
        assignContractor(caseId, "510000", "PLUMBING")
      ).rejects.toThrow("Metrics fetch failed");
    });

    it("should throw when assignment creation fails", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/search")) {
          return {
            ok: true,
            json: async () => [{ ContractorUuid: "contractor-1" }],
          };
        }
        if (url.includes("/api/metrics/")) {
          return {
            ok: true,
            json: async () => ({ metrics: [] }),
          };
        }
        if (url.includes("/api/assignments")) {
          return { ok: false, status: 500 };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

      await expect(
        assignContractor(caseId, "510000", "PLUMBING")
      ).rejects.toThrow("Assignment creation failed");
    });
  });

  describe("handleCaseOpened consumer", () => {
    function mockSuccessfulDownstream() {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/contractors/search")) {
          return {
            ok: true,
            json: async () => [
              { ContractorUuid: "c-1", name: "Test Contractor" },
            ],
          };
        }
        if (url.includes("/api/metrics/")) {
          return {
            ok: true,
            json: async () => ({ metrics: [{ score_delta: 10 }] }),
          };
        }
        if (url.includes("/api/assignments")) {
          return {
            ok: true,
            json: async () => ({
              assignments: {
                id: "a-1",
                caseId: "test-case",
                contractorId: "c-1",
              },
            }),
          };
        }
        return { ok: false };
      }) as unknown as typeof fetch;
    }

    it("should process a valid event with postalCode and publish job.assigned", async () => {
      mockSuccessfulDownstream();

      const event = {
        caseId: "aaa-111-222-333-444",
        residentId: "res-1",
        category: "PLUMBING",
        priority: "HIGH",
        postalCode: "510000",
      };

      await expect(
        handleCaseOpened(JSON.stringify(event))
      ).resolves.toBeUndefined();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).toHaveBeenCalledWith(
        "townops.events",
        "job.assigned",
        expect.objectContaining({ caseId: event.caseId })
      );
    });

    it("should derive sector code from addressDetails when postalCode is absent", async () => {
      mockSuccessfulDownstream();

      const event = {
        caseId: "bbb-222-333-444-555",
        category: "ELECTRICAL",
        priority: "MEDIUM",
        addressDetails: "730000 Main St",
      };

      await expect(
        handleCaseOpened(JSON.stringify(event))
      ).resolves.toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).toHaveBeenCalledOnce();
    });

    it("should fall back to default sector when postalCode and addressDetails are absent", async () => {
      mockSuccessfulDownstream();

      const event = {
        caseId: "ccc-333-444-555-666",
        category: "GENERAL",
        priority: "LOW",
      };

      await expect(
        handleCaseOpened(JSON.stringify(event))
      ).resolves.toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).toHaveBeenCalledOnce();
    });

    it("should return without throwing on invalid JSON", async () => {
      await expect(handleCaseOpened("{invalid-json")).resolves.toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).not.toHaveBeenCalled();
    });

    it("should return without throwing when caseId is missing from event", async () => {
      const event = {
        residentId: "res-1",
        category: "PLUMBING",
        priority: "LOW",
      };

      await expect(
        handleCaseOpened(JSON.stringify(event))
      ).resolves.toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(rabbitmqClient.publish).not.toHaveBeenCalled();
    });
  });
});
