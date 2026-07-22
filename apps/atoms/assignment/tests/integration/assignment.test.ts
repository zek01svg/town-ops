import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => async (_c: any, next: any) => await next(),
}));

describe("Assignment Atom Integration Tests", () => {
  let db: any;
  let assignments: any;
  let allocationAttempts: any;
  let assignmentStatusHistory: any;
  let app: any;
  let eq: any;

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

  it("should create a new assignment", async () => {
    const caseId = crypto.randomUUID();
    const contractorId = crypto.randomUUID();

    const res = await app.request("/api/assignments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        caseId,
        contractorId,
        source: "AUTO_ASSIGN",
        status: "PENDING_ACCEPTANCE",
        responseDueAt: new Date(Date.now() + 3600000 * 2).toISOString(),
        notes: "Test assignment",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.assignments).toBeDefined();
    expect(body.assignments.caseId).toBe(caseId);
    expect(body.assignments.status).toBe("PENDING_ACCEPTANCE");
  });

  it("should retrieve assignment by case_id", async () => {
    const caseId = crypto.randomUUID();
    const contractorId = crypto.randomUUID();

    // Setup: seed an assignment
    const [inserted] = await db
      .insert(assignments)
      .values({
        caseId,
        contractorId,
        source: "MANUAL_ASSIGN",
        status: "PENDING_ACCEPTANCE",
        responseDueAt: new Date().toISOString(),
      })
      .returning();

    const res = await app.request(`/api/assignments/${caseId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments).toBeDefined();
    expect(body.assignments.id).toBe(inserted.id);
  });

  it("should update status and record history", async () => {
    const caseId = crypto.randomUUID();
    const contractorId = crypto.randomUUID();

    // Setup: seed an assignment
    const [inserted] = await db
      .insert(assignments)
      .values({
        caseId,
        contractorId,
        source: "AUTO_ASSIGN",
        status: "PENDING_ACCEPTANCE",
        responseDueAt: new Date().toISOString(),
      })
      .returning();

    const res = await app.request(`/api/assignments/${inserted.id}/status`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "ACCEPTED",
        changedBy: "test-user",
        reason: "Contractor accepted via portal",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments.status).toBe("ACCEPTED");
    expect(body.assignments.acceptedAt).not.toBeNull();

    // Check history record
    const history = await db
      .select()
      .from(assignmentStatusHistory)
      .where(eq(assignmentStatusHistory.assignmentId, inserted.id));
    expect(history).toHaveLength(1);
    expect(history[0].fromStatus).toBe("PENDING_ACCEPTANCE");
    expect(history[0].toStatus).toBe("ACCEPTED");
    expect(history[0].changedBy).toBe("test-user");
  });

  it("should return 404 for non-existent assignment update", async () => {
    const fakeId = crypto.randomUUID();
    const res = await app.request(`/api/assignments/${fakeId}/status`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "BREACHED",
        changedBy: "system",
      }),
    });

    expect(res.status).toBe(404);
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
});
