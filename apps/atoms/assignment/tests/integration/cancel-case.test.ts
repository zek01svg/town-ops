import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));

describe("Assignment cancellation (PRS-148)", () => {
  let db: typeof import("../../src/database/db").default;
  let schema: typeof import("../../src/database/schema");
  let service: typeof import("../../src/service");

  beforeAll(async () => {
    db = (await import("../../src/database/db")).default;
    schema = await import("../../src/database/schema");
    service = await import("../../src/service");
  });

  async function seedAssignment(
    status:
      | "PENDING_ACCEPTANCE"
      | "ACCEPTED"
      | "IN_PROGRESS" = "PENDING_ACCEPTANCE"
  ) {
    const [assignment] = await db
      .insert(schema.assignments)
      .values({ caseId: crypto.randomUUID(), status })
      .returning();
    if (!assignment) throw new Error("Assignment seed insert failed");
    return assignment;
  }

  it("withdraws a pending Attempt, cancels the stable Assignment, and writes one history row", async () => {
    const assignment = await seedAssignment();
    const [attempt] = await db
      .insert(schema.allocationAttempts)
      .values({
        assignmentId: assignment.id,
        contractorId: crypto.randomUUID(),
        source: "AUTO_ASSIGN",
        status: "PENDING_ACCEPTANCE",
        acceptanceSlaMs: 60_000,
        deadlineAt: "2030-01-01T11:00:00.000Z",
        actorId: crypto.randomUUID(),
        actorRole: "SYSTEM",
        operationId: `${assignment.caseId}/allocation`,
      })
      .returning();
    if (!attempt) throw new Error("Allocation Attempt seed insert failed");
    const input = {
      caseId: assignment.caseId,
      operationId: `${assignment.caseId}/cancel/assignment`,
      changedBy: crypto.randomUUID(),
      reason: "No longer needed",
    };

    expect(await service.cancelAssignmentForCase(input)).toEqual({
      outcome: "CANCELLED",
    });
    expect(await service.cancelAssignmentForCase(input)).toEqual({
      outcome: "ALREADY_CANCELLED",
    });
    const [updatedAttempt] = await db
      .select()
      .from(schema.allocationAttempts)
      .where(eq(schema.allocationAttempts.id, attempt.id));
    expect(updatedAttempt.status).toBe("WITHDRAWN");
    const history = await db
      .select()
      .from(schema.assignmentStatusHistory)
      .where(eq(schema.assignmentStatusHistory.assignmentId, assignment.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: "PENDING_ACCEPTANCE",
      toStatus: "CANCELLED",
      reason: input.reason,
    });
  });

  it("rejects an in-progress Assignment without withdrawing anything", async () => {
    const assignment = await seedAssignment("IN_PROGRESS");

    expect(
      await service.cancelAssignmentForCase({
        caseId: assignment.caseId,
        operationId: `${assignment.caseId}/cancel/assignment`,
        changedBy: crypto.randomUUID(),
        reason: "No longer needed",
      })
    ).toEqual({ outcome: "IN_PROGRESS" });
    const [current] = await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.id, assignment.id));
    expect(current.status).toBe("IN_PROGRESS");
    expect(
      await db
        .select()
        .from(schema.allocationAttempts)
        .where(eq(schema.allocationAttempts.assignmentId, assignment.id))
    ).toHaveLength(0);
  });
});
