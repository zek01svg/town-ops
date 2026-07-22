import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => async (_c: any, next: any) => await next(),
}));

/**
 * `commitAllocationAttempt` is the concurrency boundary every allocation —
 * automatic today, manual later — passes through. Its guarantees are
 * transactional, so they are only meaningful against real PostgreSQL.
 */
describe("Allocation attempt commits", () => {
  let db: any;
  let schema: any;
  let service: any;
  let eq: any;

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

  function input(overrides: Record<string, unknown> = {}) {
    return {
      operationId: `op/${crypto.randomUUID()}`,
      caseId: crypto.randomUUID(),
      contractorId: crypto.randomUUID(),
      source: "AUTO_ASSIGN" as const,
      expectedEpoch: 0,
      acceptanceSlaMs: 60_000,
      actorId: crypto.randomUUID(),
      actorRole: "SYSTEM",
      ...overrides,
    };
  }

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

  it("counts only active attempts toward a Contractor's workload", async () => {
    const contractorId = crypto.randomUUID();
    const first = await service.getAllocationSnapshot();
    const committed = await service.commitAllocationAttempt(
      input({ contractorId, expectedEpoch: first.epoch })
    );

    const withActive = await service.getAllocationSnapshot();
    expect(
      withActive.activeAssignmentCounts.find(
        (row: any) => row.contractorId === contractorId
      )?.activeCount
    ).toBe(1);

    await db
      .update(schema.allocationAttempts)
      .set({ status: "BREACHED" })
      .where(eq(schema.allocationAttempts.id, committed.attempt.id));

    const afterBreach = await service.getAllocationSnapshot();
    expect(
      afterBreach.activeAssignmentCounts.find(
        (row: any) => row.contractorId === contractorId
      )
    ).toBeUndefined();
  });
});
