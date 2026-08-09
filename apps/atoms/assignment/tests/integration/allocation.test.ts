import type { CommitAllocationInput } from "@townops/orchestration-contract";
import type { MiddlewareHandler } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type AllocationService = typeof import("../../src/service");
type AssignmentDatabase = typeof import("../../src/database/db").default;
type AssignmentSchema = typeof import("../../src/database/schema");
type CommitResult = Awaited<
  ReturnType<AllocationService["commitAllocationAttempt"]>
>;

function input(
  overrides: Partial<CommitAllocationInput> = {}
): CommitAllocationInput {
  return {
    operationId: `op/${crypto.randomUUID()}`,
    caseId: crypto.randomUUID(),
    contractorId: crypto.randomUUID(),
    source: "AUTO_ASSIGN",
    expectedEpoch: 0,
    acceptanceSlaMs: 60_000,
    actorId: crypto.randomUUID(),
    actorRole: "SYSTEM",
    ...overrides,
  };
}

vi.mock("hono/jwk", () => ({
  jwk: () => (async (_context, next) => await next()) as MiddlewareHandler,
}));

/**
 * `commitAllocationAttempt` is the concurrency boundary every allocation —
 * automatic today, manual later — passes through. Its guarantees are
 * transactional, so they are only meaningful against real PostgreSQL.
 */
describe("Allocation attempt commits", () => {
  let db: AssignmentDatabase;
  let schema: AssignmentSchema;
  let service: AllocationService;
  let eq: typeof import("drizzle-orm").eq;

  beforeAll(async () => {
    db = (await import("../../src/database/db")).default;
    schema = await import("../../src/database/schema");
    service = await import("../../src/service");
    eq = (await import("drizzle-orm")).eq;
  });

  beforeEach(async () => {
    await db.delete(schema.allocationAttempts);
    await db.delete(schema.assignmentStatusHistory);
    await db.delete(schema.assignments);
    await db.delete(schema.allocationEpoch);
  });

  it("commits a first attempt and advances the epoch by exactly one", async () => {
    const before = await service.getAllocationSnapshot();
    const result = await service.commitAllocationAttempt(
      input({ expectedEpoch: before.epoch })
    );

    expect(result.outcome).toBe("COMMITTED");
    const after = await service.getAllocationSnapshot();
    expect(after.epoch).toBe(before.epoch + 1);
  });

  it("copies the Acceptance SLA onto the attempt as a deadline", async () => {
    const snapshot = await service.getAllocationSnapshot();
    const result = await service.commitAllocationAttempt(
      input({ expectedEpoch: snapshot.epoch, acceptanceSlaMs: 60_000 })
    );

    const deadline = new Date(result.attempt.deadlineAt).getTime();
    const created = new Date(result.attempt.createdAt ?? Date.now()).getTime();
    // Copied onto the Attempt so later configuration changes cannot rewrite
    // history for an Attempt already offered.
    expect(result.attempt.acceptanceSlaMs).toBe(60_000);
    expect(deadline - created).toBeGreaterThanOrEqual(59_000);
  });

  it("deduplicates a retried operation instead of appending a second attempt", async () => {
    const snapshot = await service.getAllocationSnapshot();
    const command = input({ expectedEpoch: snapshot.epoch });

    const first = await service.commitAllocationAttempt(command);
    // An Activity retry replays the exact same operation ID.
    const replay = await service.commitAllocationAttempt(command);

    expect(first.outcome).toBe("COMMITTED");
    expect(replay.outcome).toBe("ALREADY_COMMITTED");
    expect(replay.attempt.id).toBe(first.attempt.id);

    const rows = await db
      .select()
      .from(schema.allocationAttempts)
      .where(eq(schema.allocationAttempts.operationId, command.operationId));
    expect(rows).toHaveLength(1);
  });

  it("deduplicates concurrent replays after the allocation epoch advances", async () => {
    const snapshot = await service.getAllocationSnapshot();
    const command = input({ expectedEpoch: snapshot.epoch });
    let commits: [Promise<CommitResult>, Promise<CommitResult>] | undefined;

    // Hold the epoch while both transactions pass their initial operation-ID
    // lookup, reproducing an Activity retry that races with its first attempt.
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.allocationEpoch)
        .where(eq(schema.allocationEpoch.id, 1))
        .for("update");

      commits = [
        service.commitAllocationAttempt(command),
        service.commitAllocationAttempt(command),
      ];
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    if (!commits) throw new Error("Expected concurrent commits to be started");
    const outcomes = await Promise.all(commits);
    expect(
      outcomes
        .map((result) => result.outcome)
        .toSorted((left, right) => left.localeCompare(right))
    ).toEqual(["ALREADY_COMMITTED", "COMMITTED"]);

    const rows = await db
      .select()
      .from(schema.allocationAttempts)
      .where(eq(schema.allocationAttempts.operationId, command.operationId));
    expect(rows).toHaveLength(1);
  });

  it("rejects a commit made against a stale epoch without writing an attempt", async () => {
    const snapshot = await service.getAllocationSnapshot();
    await service.commitAllocationAttempt(
      input({ expectedEpoch: snapshot.epoch })
    );

    const stale = input({ expectedEpoch: snapshot.epoch });
    const result = await service.commitAllocationAttempt(stale);

    expect(result.outcome).toBe("STALE_EPOCH");
    const rows = await db
      .select()
      .from(schema.allocationAttempts)
      .where(eq(schema.allocationAttempts.operationId, stale.operationId));
    expect(rows).toHaveLength(0);
  });

  it("refuses a second active attempt for the same Case", async () => {
    const caseId = crypto.randomUUID();
    const first = await service.getAllocationSnapshot();
    await service.commitAllocationAttempt(
      input({ caseId, expectedEpoch: first.epoch })
    );

    const second = await service.getAllocationSnapshot();
    const result = await service.commitAllocationAttempt(
      input({ caseId, expectedEpoch: second.epoch })
    );

    expect(result.outcome).toBe("ACTIVE_ATTEMPT_EXISTS");
  });

  it("does not create an Assignment for a replacement target that is not pending", async () => {
    const caseId = crypto.randomUUID();
    const snapshot = await service.getAllocationSnapshot();
    const result = await service.commitAllocationAttempt({
      ...input({
        caseId,
        source: "MANUAL_ASSIGN",
        expectedEpoch: snapshot.epoch,
      }),
      replaceAttemptId: crypto.randomUUID(),
    });

    expect(result.outcome).toBe("REPLACEMENT_ATTEMPT_NOT_PENDING");
    const assignmentRows = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.caseId, caseId));
    expect(assignmentRows).toHaveLength(0);
  });

  it("keeps exactly one stable Assignment for a Case across reallocation", async () => {
    const caseId = crypto.randomUUID();
    const first = await service.getAllocationSnapshot();
    const committed = await service.commitAllocationAttempt(
      input({ caseId, expectedEpoch: first.epoch })
    );

    // Withdraw the pending Attempt so a replacement is allowed, the way
    // reallocation will.
    await db
      .update(schema.allocationAttempts)
      .set({ status: "WITHDRAWN" })
      .where(eq(schema.allocationAttempts.id, committed.attempt.id));

    const second = await service.getAllocationSnapshot();
    const replacement = await service.commitAllocationAttempt(
      input({ caseId, expectedEpoch: second.epoch })
    );

    expect(replacement.outcome).toBe("COMMITTED");
    // The Assignment is the Case's stable identity: reallocation appends an
    // Attempt, it never creates a second Assignment.
    expect(replacement.assignment.id).toBe(committed.assignment.id);
    const assignmentRows = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.caseId, caseId));
    expect(assignmentRows).toHaveLength(1);
  });

  it("replaces only the named pending Attempt and keeps its Assignment", async () => {
    const caseId = crypto.randomUUID();
    const firstSnapshot = await service.getAllocationSnapshot();
    const original = await service.commitAllocationAttempt(
      input({ caseId, expectedEpoch: firstSnapshot.epoch })
    );
    const replacementSnapshot = await service.getAllocationSnapshot();

    const replacement = await service.commitAllocationAttempt({
      ...input({
        caseId,
        source: "MANUAL_ASSIGN",
        expectedEpoch: replacementSnapshot.epoch,
      }),
      replaceAttemptId: original.attempt.id,
    });

    expect(replacement.outcome).toBe("COMMITTED");
    expect(replacement.assignment.id).toBe(original.assignment.id);
    expect(replacement.attempt.source).toBe("MANUAL_ASSIGN");

    const [withdrawn] = await db
      .select()
      .from(schema.allocationAttempts)
      .where(eq(schema.allocationAttempts.id, original.attempt.id));
    expect(withdrawn?.status).toBe("WITHDRAWN");

    const assignmentRows = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.caseId, caseId));
    expect(assignmentRows).toHaveLength(1);
  });

  it("counts only active attempts toward a Contractor's workload", async () => {
    const contractorId = crypto.randomUUID();
    const first = await service.getAllocationSnapshot();
    const committed = await service.commitAllocationAttempt(
      input({ contractorId, expectedEpoch: first.epoch })
    );

    const withActive = await service.getAllocationSnapshot();
    expect(
      withActive.activeAssignmentCounts.find(
        (row) => row.contractorId === contractorId
      )?.activeCount
    ).toBe(1);

    await db
      .update(schema.allocationAttempts)
      .set({ status: "BREACHED" })
      .where(eq(schema.allocationAttempts.id, committed.attempt.id));

    const afterBreach = await service.getAllocationSnapshot();
    expect(
      afterBreach.activeAssignmentCounts.find(
        (row) => row.contractorId === contractorId
      )
    ).toBeUndefined();
  });
});
