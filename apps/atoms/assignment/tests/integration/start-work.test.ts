import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));

type Schema = typeof import("../../src/database/schema");
type AssignmentInsert = Schema["assignments"]["$inferInsert"];

/**
 * PRS-145: `markAssignmentInProgress`'s ACCEPTED -> IN_PROGRESS transition —
 * Saga step 2. Idempotent by the Assignment's own status, mirroring
 * PRS-144's `breachAllocationAttempt`.
 */
describe("Start work (PRS-145)", () => {
  let db: typeof import("../../src/database/db").default;
  let schema: Schema;
  let service: typeof import("../../src/service");
  let app: typeof import("../../src/index").app;
  let eq: typeof import("drizzle-orm").eq;

  beforeAll(async () => {
    db = (await import("../../src/database/db")).default;
    schema = await import("../../src/database/schema");
    service = await import("../../src/service");
    app = (await import("../../src/index")).app;
    eq = (await import("drizzle-orm")).eq;
  });

  beforeEach(async () => {
    await db.delete(schema.allocationAttempts);
    await db.delete(schema.assignmentStatusHistory);
    await db.delete(schema.assignments);
  });

  async function seedAssignment(overrides: Partial<AssignmentInsert> = {}) {
    const [assignment] = await db
      .insert(schema.assignments)
      .values({
        caseId: crypto.randomUUID(),
        status: "ACCEPTED",
        ...overrides,
      })
      .returning();
    if (!assignment) throw new Error("Assignment seed insert failed");
    return assignment;
  }

  describe("markAssignmentInProgress outcome table", () => {
    it("ACCEPTED -> IN_PROGRESS with one history row", async () => {
      const assignment = await seedAssignment();

      const result = await service.markAssignmentInProgress({
        operationId: `${crypto.randomUUID()}/start-work/assignment`,
        assignmentId: assignment.id,
        changedBy: "contractor",
      });

      expect(result.outcome).toBe("IN_PROGRESS");
      if (result.outcome !== "IN_PROGRESS") throw new Error("unreachable");
      expect(result.assignment.status).toBe("IN_PROGRESS");

      const history = await db
        .select()
        .from(schema.assignmentStatusHistory)
        .where(eq(schema.assignmentStatusHistory.assignmentId, assignment.id));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: "ACCEPTED",
        toStatus: "IN_PROGRESS",
        reason: "WORK_STARTED",
        changedBy: "contractor",
      });
    });

    it("replays as ALREADY_IN_PROGRESS and does not double-write history", async () => {
      const assignment = await seedAssignment();
      const command = {
        operationId: `${crypto.randomUUID()}/start-work/assignment`,
        assignmentId: assignment.id,
        changedBy: "contractor",
      };

      const first = await service.markAssignmentInProgress(command);
      expect(first.outcome).toBe("IN_PROGRESS");

      const replay = await service.markAssignmentInProgress(command);
      expect(replay.outcome).toBe("ALREADY_IN_PROGRESS");

      const history = await db
        .select()
        .from(schema.assignmentStatusHistory)
        .where(eq(schema.assignmentStatusHistory.assignmentId, assignment.id));
      expect(history).toHaveLength(1);
    });

    it("rejects a PENDING_ACCEPTANCE Assignment", async () => {
      const assignment = await seedAssignment({
        status: "PENDING_ACCEPTANCE",
      });

      const result = await service.markAssignmentInProgress({
        operationId: `${crypto.randomUUID()}/start-work/assignment`,
        assignmentId: assignment.id,
        changedBy: "contractor",
      });

      expect(result).toEqual({ outcome: "NOT_ACCEPTED" });
    });

    it("returns ASSIGNMENT_NOT_FOUND for an unknown id", async () => {
      const result = await service.markAssignmentInProgress({
        operationId: `${crypto.randomUUID()}/start-work/assignment`,
        assignmentId: crypto.randomUUID(),
        changedBy: "contractor",
      });

      expect(result).toEqual({ outcome: "ASSIGNMENT_NOT_FOUND" });
    });
  });

  describe("POST /internal/assignments/start-work", () => {
    it("requires the Worker service token", async () => {
      const assignment = await seedAssignment();
      const res = await app.request("/internal/assignments/start-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "x",
          assignmentId: assignment.id,
          changedBy: "contractor",
        }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 201 for a fresh start and 201 for the ALREADY_IN_PROGRESS replay", async () => {
      const assignment = await seedAssignment();
      const body = JSON.stringify({
        operationId: `${crypto.randomUUID()}/start-work/assignment`,
        assignmentId: assignment.id,
        changedBy: "contractor",
      });
      const headers = {
        Authorization: `Bearer ${"a".repeat(32)}`,
        "Content-Type": "application/json",
      };

      const first = await app.request("/internal/assignments/start-work", {
        method: "POST",
        headers,
        body,
      });
      expect(first.status).toBe(201);
      expect((await first.json()).outcome).toBe("IN_PROGRESS");

      const replay = await app.request("/internal/assignments/start-work", {
        method: "POST",
        headers,
        body,
      });
      expect(replay.status).toBe(201);
      expect((await replay.json()).outcome).toBe("ALREADY_IN_PROGRESS");
    });

    it("returns 409 for a PENDING_ACCEPTANCE Assignment", async () => {
      const assignment = await seedAssignment({ status: "PENDING_ACCEPTANCE" });
      const res = await app.request("/internal/assignments/start-work", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"a".repeat(32)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operationId: `${crypto.randomUUID()}/start-work/assignment`,
          assignmentId: assignment.id,
          changedBy: "contractor",
        }),
      });
      expect(res.status).toBe(409);
    });
  });
});
