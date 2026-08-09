import type { Context, Next } from "hono";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => async (_c: Context, next: Next) => next(),
}));

type AssignmentDb = (typeof import("../../src/database/db"))["default"];
type AssignmentSchema = typeof import("../../src/database/schema");
type AssignmentApp = (typeof import("../../src/index"))["app"];
type DrizzleEq = (typeof import("drizzle-orm"))["eq"];

describe("Assignment Atom Integration Tests", () => {
  let db: AssignmentDb;
  let assignments: AssignmentSchema["assignments"];
  let allocationAttempts: AssignmentSchema["allocationAttempts"];
  let assignmentStatusHistory: AssignmentSchema["assignmentStatusHistory"];
  let app: AssignmentApp;
  let eq: DrizzleEq;

  beforeAll(async () => {
    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");
    const appModule = await import("../../src/index");
    const drizzleModule = await import("drizzle-orm");

    db = dbModule.default;
    assignments = schemaModule.assignments;
    allocationAttempts = schemaModule.allocationAttempts;
    assignmentStatusHistory = schemaModule.assignmentStatusHistory;
    app = appModule.app;
    eq = drizzleModule.eq;
  });

  beforeEach(async () => {
    // Clean up tables before each test
    await db.delete(allocationAttempts);
    await db.delete(assignmentStatusHistory);
    await db.delete(assignments);
  });

  it("accepts only the pending Contractor attempt and replays its operation", async () => {
    const caseId = crypto.randomUUID();
    const contractorId = crypto.randomUUID();
    const [assignment] = await db
      .insert(assignments)
      .values({ caseId })
      .returning();
    const [attempt] = await db
      .insert(allocationAttempts)
      .values({
        assignmentId: assignment.id,
        contractorId,
        source: "AUTO_ASSIGN",
        acceptanceSlaMs: 60_000,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        actorId: crypto.randomUUID(),
        actorRole: "SYSTEM",
        operationId: `allocate/${crypto.randomUUID()}`,
      })
      .returning();
    const input = {
      operationId: `accept/${crypto.randomUUID()}`,
      caseId,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      contractorId,
    };

    expect(
      (
        await app.request(
          "/internal/assignments/allocation-attempts/acceptance",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${"a".repeat(32)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...input,
              contractorId: crypto.randomUUID(),
            }),
          }
        )
      ).status
    ).toBe(409);

    const request = () =>
      app.request("/internal/assignments/allocation-attempts/acceptance", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"a".repeat(32)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
    const [accepted, replay] = await Promise.all([request(), request()]);
    expect(
      [accepted.status, replay.status].toSorted((left, right) => left - right)
    ).toEqual([200, 201]);
    expect(
      [(await accepted.json()).outcome, (await replay.json()).outcome].toSorted(
        (left, right) => left.localeCompare(right)
      )
    ).toEqual(["ACCEPTED", "ALREADY_ACCEPTED"]);

    const history = await db
      .select()
      .from(assignmentStatusHistory)
      .where(eq(assignmentStatusHistory.assignmentId, assignment.id));
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe("ALLOCATION_ATTEMPT_ACCEPTED");
  });

  it("rejects a pending Attempt when its Assignment is no longer pending", async () => {
    const caseId = crypto.randomUUID();
    const contractorId = crypto.randomUUID();
    const [assignment] = await db
      .insert(assignments)
      .values({ caseId, status: "BREACHED" })
      .returning();
    const [attempt] = await db
      .insert(allocationAttempts)
      .values({
        assignmentId: assignment.id,
        contractorId,
        source: "AUTO_ASSIGN",
        acceptanceSlaMs: 60_000,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        actorId: crypto.randomUUID(),
        actorRole: "SYSTEM",
        operationId: `allocate/${crypto.randomUUID()}`,
      })
      .returning();

    const response = await app.request(
      "/internal/assignments/allocation-attempts/acceptance",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"a".repeat(32)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operationId: `accept/${crypto.randomUUID()}`,
          caseId,
          assignmentId: assignment.id,
          attemptId: attempt.id,
          contractorId,
        }),
      }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      outcome: "ASSIGNMENT_NOT_PENDING",
    });
    expect(
      await db
        .select()
        .from(assignmentStatusHistory)
        .where(eq(assignmentStatusHistory.assignmentId, assignment.id))
    ).toHaveLength(0);
  });

  it("records Assignment completion once, retains its operation identity, and rejects a different operation", async () => {
    const caseId = crypto.randomUUID();
    const operationId = `complete/${crypto.randomUUID()}/assignment`;
    const [assignment] = await db
      .insert(assignments)
      .values({ caseId, status: "IN_PROGRESS" })
      .returning();
    const complete = (
      completionOperationId = operationId,
      token = "a".repeat(32)
    ) =>
      app.request("/internal/assignments/complete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assignmentId: assignment.id,
          changedBy: crypto.randomUUID(),
          operationId: completionOperationId,
        }),
      });

    const first = await complete();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ outcome: "COMPLETED" });
    const history = await db
      .select()
      .from(assignmentStatusHistory)
      .where(eq(assignmentStatusHistory.assignmentId, assignment.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: "IN_PROGRESS",
      toStatus: "COMPLETED",
      reason: "ASSIGNMENT_COMPLETED",
    });

    const replay = await complete();
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ outcome: "ALREADY_COMPLETED" });
    expect(
      await db
        .select()
        .from(assignmentStatusHistory)
        .where(eq(assignmentStatusHistory.assignmentId, assignment.id))
    ).toHaveLength(1);

    const conflict = await complete(
      `complete/${crypto.randomUUID()}/assignment`
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      outcome: "COMPLETION_OPERATION_CONFLICT",
    });

    const unauthorizedIdentity = await app.request(
      `/internal/assignments/completion-operation/${assignment.id}`
    );
    expect(unauthorizedIdentity.status).toBe(401);
    const identity = await app.request(
      `/internal/assignments/completion-operation/${assignment.id}`,
      { headers: { Authorization: `Bearer ${"a".repeat(32)}` } }
    );
    expect(identity.status).toBe(200);
    expect(await identity.json()).toEqual({
      completionOperationId: operationId,
    });
  });
});
