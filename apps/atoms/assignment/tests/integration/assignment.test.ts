import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => async (_c: any, next: any) => await next(),
}));

describe("Assignment Atom Integration Tests", () => {
  let db: any;
  let assignments: any;
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
    assignmentStatusHistory = schemaModule.assignmentStatusHistory;
    app = appModule.app;
    eq = drizzleModule.eq;
  });

  beforeEach(async () => {
    // Clean up tables before each test
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
});
