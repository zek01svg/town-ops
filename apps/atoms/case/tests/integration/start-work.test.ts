import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

function startWorkInput(
  caseId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    caseId,
    operationId: `${caseId}/start-work/case`,
    actorId: crypto.randomUUID(),
    actorRole: "CONTRACTOR" as const,
    ...overrides,
  };
}

/**
 * PRS-145: `markCaseInProgressForOperation` — Saga step 3. Every test seeds
 * its own randomUUID()-keyed Case, since case.test.ts and
 * officer-attention.test.ts run concurrently against the same shared
 * Testcontainer DB with no per-file isolation (see their own comments).
 */
describe("Start work (PRS-145)", () => {
  let db: typeof import("../../src/database/db").default;
  let cases: typeof import("../../src/database/schema").cases;
  let caseHistory: typeof import("../../src/database/schema").caseHistory;
  let caseOperations: typeof import("../../src/database/schema").caseOperations;
  let caseService: typeof import("../../src/service");
  let app: typeof import("../../src/index").app;

  beforeAll(async () => {
    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");
    const appModule = await import("../../src/index");

    db = dbModule.default;
    cases = schemaModule.cases;
    caseHistory = schemaModule.caseHistory;
    caseOperations = schemaModule.caseOperations;
    caseService = await import("../../src/service");
    app = appModule.app;
  });

  async function seedCase(
    status: "pending" | "assigned" | "completed" | "cancelled" = "assigned"
  ) {
    const [caseRecord] = await db
      .insert(cases)
      .values({
        residentId: crypto.randomUUID(),
        category: "LE",
        status,
      })
      .returning();
    if (!caseRecord) throw new Error("Case seed insert failed");
    return caseRecord;
  }

  describe("markCaseInProgressForOperation outcome table", () => {
    it("assigned -> in_progress with one CASE_WORK_STARTED history row", async () => {
      const caseRecord = await seedCase("assigned");

      const result = await caseService.markCaseInProgressForOperation(
        startWorkInput(caseRecord.id)
      );

      expect(result.outcome).toBe("IN_PROGRESS");
      if (result.outcome !== "IN_PROGRESS") throw new Error("unreachable");
      expect(result.case.status).toBe("in_progress");

      const history = await db
        .select()
        .from(caseHistory)
        .where(eq(caseHistory.caseId, caseRecord.id));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ eventType: "CASE_WORK_STARTED" });

      const operations = await db
        .select()
        .from(caseOperations)
        .where(eq(caseOperations.caseId, caseRecord.id));
      expect(operations).toHaveLength(1);
      expect(operations[0].operationId).toBe(
        startWorkInput(caseRecord.id).operationId
      );
    });

    it("accepts a pending Case too (do not require a specific source status)", async () => {
      const caseRecord = await seedCase("pending");

      const result = await caseService.markCaseInProgressForOperation(
        startWorkInput(caseRecord.id)
      );

      expect(result.outcome).toBe("IN_PROGRESS");
    });

    it("is idempotent by operationId — a replay writes no new history", async () => {
      const caseRecord = await seedCase("assigned");
      const input = startWorkInput(caseRecord.id);

      const first = await caseService.markCaseInProgressForOperation(input);
      const replay = await caseService.markCaseInProgressForOperation(input);

      expect(first.outcome).toBe("IN_PROGRESS");
      expect(replay.outcome).toBe("IN_PROGRESS");
      if (replay.outcome !== "IN_PROGRESS") throw new Error("unreachable");
      expect(replay.case.status).toBe("in_progress");

      const history = await db
        .select()
        .from(caseHistory)
        .where(eq(caseHistory.caseId, caseRecord.id));
      expect(history).toHaveLength(1);

      const operations = await db
        .select()
        .from(caseOperations)
        .where(eq(caseOperations.caseId, caseRecord.id));
      expect(operations).toHaveLength(1);
    });

    it("returns CASE_TERMINAL for a completed Case and leaves it untouched", async () => {
      const caseRecord = await seedCase("completed");

      const result = await caseService.markCaseInProgressForOperation(
        startWorkInput(caseRecord.id)
      );

      expect(result).toEqual({ outcome: "CASE_TERMINAL" });
      const [row] = await db
        .select()
        .from(cases)
        .where(eq(cases.id, caseRecord.id));
      expect(row.status).toBe("completed");

      const operations = await db
        .select()
        .from(caseOperations)
        .where(eq(caseOperations.caseId, caseRecord.id));
      expect(operations).toHaveLength(0);
    });

    it("returns CASE_TERMINAL for a cancelled Case and leaves it untouched", async () => {
      const caseRecord = await seedCase("cancelled");

      const result = await caseService.markCaseInProgressForOperation(
        startWorkInput(caseRecord.id)
      );

      expect(result).toEqual({ outcome: "CASE_TERMINAL" });
      const [row] = await db
        .select()
        .from(cases)
        .where(eq(cases.id, caseRecord.id));
      expect(row.status).toBe("cancelled");

      const operations = await db
        .select()
        .from(caseOperations)
        .where(eq(caseOperations.caseId, caseRecord.id));
      expect(operations).toHaveLength(0);
    });
  });

  describe("POST /internal/cases/:id/start-work", () => {
    it("requires the Worker service token", async () => {
      const caseRecord = await seedCase("assigned");
      const res = await app.request(
        `/internal/cases/${caseRecord.id}/start-work`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(startWorkInput(caseRecord.id)),
        }
      );
      expect(res.status).toBe(401);
    });

    it("returns 201 for a fresh start and 201 for the replay", async () => {
      const caseRecord = await seedCase("assigned");
      const body = JSON.stringify(startWorkInput(caseRecord.id));
      const headers = {
        Authorization: `Bearer ${"a".repeat(32)}`,
        "Content-Type": "application/json",
      };

      const first = await app.request(
        `/internal/cases/${caseRecord.id}/start-work`,
        { method: "POST", headers, body }
      );
      expect(first.status).toBe(201);
      expect((await first.json()).outcome).toBe("IN_PROGRESS");

      const replay = await app.request(
        `/internal/cases/${caseRecord.id}/start-work`,
        { method: "POST", headers, body }
      );
      expect(replay.status).toBe(201);
      expect((await replay.json()).outcome).toBe("IN_PROGRESS");
    });

    it("rejects a body whose caseId does not match the path", async () => {
      const caseRecord = await seedCase("assigned");
      const res = await app.request(
        `/internal/cases/${caseRecord.id}/start-work`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${"a".repeat(32)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            startWorkInput(caseRecord.id, { caseId: crypto.randomUUID() })
          ),
        }
      );
      expect(res.status).toBe(400);
    });

    it("returns 409 for a completed Case", async () => {
      const caseRecord = await seedCase("completed");
      const res = await app.request(
        `/internal/cases/${caseRecord.id}/start-work`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${"a".repeat(32)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(startWorkInput(caseRecord.id)),
        }
      );
      expect(res.status).toBe(409);
    });
  });
});
