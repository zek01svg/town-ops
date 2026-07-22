import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));

type Schema = typeof import("../../src/database/schema");
type AttemptInsert = Schema["allocationAttempts"]["$inferInsert"];

/**
 * PRS-144: `breachAllocationAttempt`'s outcome table, the BREACHED ->
 * PENDING_ACCEPTANCE Assignment reset a replacement commit performs, and
 * the AC6 override guard on `commitAllocationAttempt`. These are only
 * meaningful against real PostgreSQL (row locks, unique/history writes).
 */
// The Workflow breaches as the system actor; the atom writes it to
// assignment_status_history.changed_by.
const SYSTEM_ACTOR = {
  actorId: "00000000-0000-0000-0000-000000000000",
  actorRole: "SYSTEM",
};

describe("Acceptance SLA breach (PRS-144)", () => {
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
    await db.delete(schema.allocationEpoch);
  });

  async function seedAttempt(overrides: Partial<AttemptInsert> = {}) {
    const caseId = crypto.randomUUID();
    const contractorId = crypto.randomUUID();
    const [assignment] = await db
      .insert(schema.assignments)
      .values({ caseId })
      .returning();
    const [attempt] = await db
      .insert(schema.allocationAttempts)
      .values({
        assignmentId: assignment.id,
        contractorId,
        source: "AUTO_ASSIGN",
        acceptanceSlaMs: 60_000,
        deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        actorId: crypto.randomUUID(),
        actorRole: "SYSTEM",
        operationId: `allocate/${crypto.randomUUID()}`,
        ...overrides,
      })
      .returning();
    return { assignment, attempt, caseId, contractorId };
  }

  describe("breachAllocationAttempt outcome table", () => {
    it("PENDING_ACCEPTANCE -> BREACHED, and moves the Assignment to BREACHED with one history row", async () => {
      const { assignment, attempt } = await seedAttempt();

      const result = await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${attempt.id}`,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });

      expect(result).toEqual({ outcome: "BREACHED" });

      const [updatedAttempt] = await db
        .select()
        .from(schema.allocationAttempts)
        .where(eq(schema.allocationAttempts.id, attempt.id));
      expect(updatedAttempt.status).toBe("BREACHED");

      const [updatedAssignment] = await db
        .select()
        .from(schema.assignments)
        .where(eq(schema.assignments.id, assignment.id));
      expect(updatedAssignment.status).toBe("BREACHED");

      const history = await db
        .select()
        .from(schema.assignmentStatusHistory)
        .where(eq(schema.assignmentStatusHistory.assignmentId, assignment.id));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: "PENDING_ACCEPTANCE",
        toStatus: "BREACHED",
        reason: "ACCEPTANCE_SLA_BREACH",
        changedBy: SYSTEM_ACTOR.actorId,
      });
    });

    it("BREACHED -> ALREADY_BREACHED on replay, and does not double-write history", async () => {
      const { assignment, attempt } = await seedAttempt();
      const operationId = `${crypto.randomUUID()}/breach/${attempt.id}`;

      const first = await service.breachAllocationAttempt({
        operationId,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });
      expect(first).toEqual({ outcome: "BREACHED" });

      const replay = await service.breachAllocationAttempt({
        operationId,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });
      expect(replay).toEqual({ outcome: "ALREADY_BREACHED" });

      const history = await db
        .select()
        .from(schema.assignmentStatusHistory)
        .where(eq(schema.assignmentStatusHistory.assignmentId, assignment.id));
      expect(history).toHaveLength(1);
    });

    it("ACCEPTED -> ACCEPTED, and never touches the Assignment or history", async () => {
      const { assignment, attempt } = await seedAttempt({ status: "ACCEPTED" });
      await db
        .update(schema.assignments)
        .set({ status: "ACCEPTED" })
        .where(eq(schema.assignments.id, assignment.id));

      const result = await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${attempt.id}`,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });
      expect(result).toEqual({ outcome: "ACCEPTED" });

      const [updatedAssignment] = await db
        .select()
        .from(schema.assignments)
        .where(eq(schema.assignments.id, assignment.id));
      expect(updatedAssignment.status).toBe("ACCEPTED");
      const history = await db
        .select()
        .from(schema.assignmentStatusHistory)
        .where(eq(schema.assignmentStatusHistory.assignmentId, assignment.id));
      expect(history).toHaveLength(0);
    });

    it("WITHDRAWN -> WITHDRAWN, and never touches the Assignment or history", async () => {
      const { assignment, attempt } = await seedAttempt({
        status: "WITHDRAWN",
      });

      const result = await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${attempt.id}`,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });
      expect(result).toEqual({ outcome: "WITHDRAWN" });

      const [updatedAssignment] = await db
        .select()
        .from(schema.assignments)
        .where(eq(schema.assignments.id, assignment.id));
      expect(updatedAssignment.status).toBe("PENDING_ACCEPTANCE");
      const history = await db
        .select()
        .from(schema.assignmentStatusHistory)
        .where(eq(schema.assignmentStatusHistory.assignmentId, assignment.id));
      expect(history).toHaveLength(0);
    });
  });

  describe("replacement commit after a breach", () => {
    it("resets the BREACHED Assignment to PENDING_ACCEPTANCE when committing the replacement Attempt", async () => {
      const { assignment, attempt, caseId } = await seedAttempt();
      await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${attempt.id}`,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });

      const snapshot = await service.getAllocationSnapshot();
      const replacementContractor = crypto.randomUUID();
      const result = await service.commitAllocationAttempt({
        operationId: `op/${crypto.randomUUID()}`,
        caseId,
        contractorId: replacementContractor,
        source: "BREACH_REASSIGN",
        expectedEpoch: snapshot.epoch,
        acceptanceSlaMs: 60_000,
        actorId: crypto.randomUUID(),
        actorRole: "SYSTEM",
      });

      expect(result.outcome).toBe("COMMITTED");
      // Same stable Assignment reused, never a second one.
      expect(result.assignment.id).toBe(assignment.id);
      expect(result.attempt.contractorId).toBe(replacementContractor);

      const [updatedAssignment] = await db
        .select()
        .from(schema.assignments)
        .where(eq(schema.assignments.id, assignment.id));
      expect(updatedAssignment.status).toBe("PENDING_ACCEPTANCE");

      const assignmentRows = await db
        .select()
        .from(schema.assignments)
        .where(eq(schema.assignments.caseId, caseId));
      expect(assignmentRows).toHaveLength(1);

      const history = await db
        .select()
        .from(schema.assignmentStatusHistory)
        .where(eq(schema.assignmentStatusHistory.assignmentId, assignment.id));
      expect(
        history
          .map((row) => row.toStatus)
          .toSorted((l, r) => l.localeCompare(r))
      ).toEqual(["BREACHED", "PENDING_ACCEPTANCE"]);
    });
  });

  describe("AC6: override guard on a reused breached Contractor", () => {
    it("rejects a reason-less manual commit reusing the Contractor who breached on this Assignment", async () => {
      const { assignment, attempt, caseId, contractorId } = await seedAttempt();
      await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${attempt.id}`,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });

      const snapshot = await service.getAllocationSnapshot();
      const result = await service.commitAllocationAttempt({
        operationId: `op/${crypto.randomUUID()}`,
        caseId,
        contractorId,
        source: "MANUAL_ASSIGN",
        expectedEpoch: snapshot.epoch,
        acceptanceSlaMs: 60_000,
        actorId: crypto.randomUUID(),
        actorRole: "OFFICER",
      });

      expect(result).toEqual({ outcome: "OVERRIDE_REASON_REQUIRED" });
      // No new Attempt was inserted — only the original breached one exists.
      const attempts = await db
        .select()
        .from(schema.allocationAttempts)
        .where(eq(schema.allocationAttempts.assignmentId, assignment.id));
      expect(attempts).toHaveLength(1);
    });

    it("commits when a reason accompanies the reused breached Contractor", async () => {
      const { assignment, attempt, caseId, contractorId } = await seedAttempt();
      await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${attempt.id}`,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });

      const snapshot = await service.getAllocationSnapshot();
      const result = await service.commitAllocationAttempt({
        operationId: `op/${crypto.randomUUID()}`,
        caseId,
        contractorId,
        source: "MANUAL_ASSIGN",
        expectedEpoch: snapshot.epoch,
        acceptanceSlaMs: 60_000,
        actorId: crypto.randomUUID(),
        actorRole: "OFFICER",
        reason: "Officer reviewed and reassigned regardless",
      });

      expect(result.outcome).toBe("COMMITTED");
      expect(result.attempt.contractorId).toBe(contractorId);
    });

    it("does not require a reason for a different Contractor who never breached on this Assignment", async () => {
      const { assignment, attempt, caseId } = await seedAttempt();
      await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${attempt.id}`,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });

      const snapshot = await service.getAllocationSnapshot();
      const result = await service.commitAllocationAttempt({
        operationId: `op/${crypto.randomUUID()}`,
        caseId,
        contractorId: crypto.randomUUID(),
        source: "MANUAL_ASSIGN",
        expectedEpoch: snapshot.epoch,
        acceptanceSlaMs: 60_000,
        actorId: crypto.randomUUID(),
        actorRole: "OFFICER",
      });

      expect(result.outcome).toBe("COMMITTED");
    });
  });

  describe("POST /internal/assignments/allocation-attempts/breach", () => {
    it("requires the Worker service token", async () => {
      const res = await app.request(
        "/internal/assignments/allocation-attempts/breach",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationId: "x",
            attemptId: crypto.randomUUID(),
            assignmentId: crypto.randomUUID(),
            ...SYSTEM_ACTOR,
          }),
        }
      );
      expect(res.status).toBe(401);
    });

    it("returns 201 for a fresh breach and 200 for the ALREADY_BREACHED replay", async () => {
      const { assignment, attempt } = await seedAttempt();
      const body = JSON.stringify({
        operationId: `${crypto.randomUUID()}/breach/${attempt.id}`,
        attemptId: attempt.id,
        assignmentId: assignment.id,
        ...SYSTEM_ACTOR,
      });
      const headers = {
        Authorization: `Bearer ${"a".repeat(32)}`,
        "Content-Type": "application/json",
      };

      const first = await app.request(
        "/internal/assignments/allocation-attempts/breach",
        { method: "POST", headers, body }
      );
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({ outcome: "BREACHED" });

      const replay = await app.request(
        "/internal/assignments/allocation-attempts/breach",
        { method: "POST", headers, body }
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ outcome: "ALREADY_BREACHED" });
    });
  });
});
