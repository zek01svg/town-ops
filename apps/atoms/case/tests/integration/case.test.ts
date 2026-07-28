import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeAll } from "vitest";

let db: typeof import("../../src/database/db").default;
let cases: typeof import("../../src/database/schema").cases;
let caseHistory: typeof import("../../src/database/schema").caseHistory;
let officerAttention: typeof import("../../src/database/schema").officerAttention;
let app: typeof import("../../src/index").app;

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

describe("Case Atom Integration Tests", () => {
  beforeAll(async () => {
    console.log(
      "TEST RUNNER process.env.DATABASE_URL:",
      process.env.DATABASE_URL
    );

    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");
    const appModule = await import("../../src/index");

    db = dbModule.default;
    cases = schemaModule.cases;
    caseHistory = schemaModule.caseHistory;
    officerAttention = schemaModule.officerAttention;
    app = appModule.app;
  });

  // No blanket beforeEach delete here: every test below inserts its own
  // randomUUID()-keyed Case and filters assertions by that exact ID, so
  // isolation never depended on the table being empty. A blanket
  // `db.delete(cases)` was previously here, but officer-attention.test.ts
  // runs against the same shared Testcontainer DB concurrently (integration
  // files have no per-file isolation) and keeps one fixed-ID Case alive
  // across its whole suite — that blanket delete intermittently raced it
  // out from under it.
  const VALID_UUID_2 = "123e4567-e89b-12d3-a456-426614174001";

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("CRUD flows", () => {
    it("should create a case and retrieve it back from container DB", async () => {
      const payload = {
        residentId: VALID_UUID_2,
        category: "LE",
        description: "Integration test description",
        status: "pending" as const,
      };

      // 1. Create
      const postRes = await app.request("/api/cases/new-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (postRes.status !== 201) {
        console.error(
          "POST /api/cases/new-case FAILED:",
          postRes.status,
          await postRes.text()
        );
      }

      expect(postRes.status).toBe(201);
      const postData = await postRes.json();
      expect(postData.cases).toHaveProperty("id");
      expect(postData.cases.category).toBe(payload.category);

      const caseId = postData.cases.id;

      // 2. Retrieve by ID
      const getRes = await app.request(`/api/cases/${caseId}`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.cases).toHaveLength(1);
      expect(getData.cases[0].id).toBe(caseId);
    });
  });

  it("records allocation acceptance history once with its Contractor actor", async () => {
    const [caseRecord] = await db
      .insert(cases)
      .values({
        residentId: crypto.randomUUID(),
        category: "LE",
        description: "Acceptance history test",
      })
      .returning();
    const body = {
      caseId: caseRecord.id,
      operationId: `accept/${crypto.randomUUID()}`,
      actorId: crypto.randomUUID(),
      actorRole: "CONTRACTOR",
    };
    const request = () =>
      app.request(`/internal/cases/${caseRecord.id}/allocation-acceptance`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"a".repeat(32)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(201);
    const history = await db
      .select()
      .from(caseHistory)
      .where(eq(caseHistory.caseId, caseRecord.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      eventType: "ALLOCATION_ATTEMPT_ACCEPTED",
      actorId: body.actorId,
      actorRole: "CONTRACTOR",
      operationId: body.operationId,
    });
  });

  it("resolves a post-terminal COMPLETION_FAILED attention when the same completion operation recovers", async () => {
    const [caseRecord] = await db
      .insert(cases)
      .values({
        residentId: crypto.randomUUID(),
        category: "LE",
        description: "Completion recovery test",
        status: "in_progress",
      })
      .returning();
    const operationId = `completion/${crypto.randomUUID()}`;
    const completeBody = {
      caseId: caseRecord.id,
      operationId,
      actorId: crypto.randomUUID(),
      actorRole: "CONTRACTOR",
      report: "Completed after metrics recovery.",
      proofItemIds: [crypto.randomUUID(), crypto.randomUUID()],
    };
    const complete = () =>
      app.request(`/internal/cases/${caseRecord.id}/complete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"a".repeat(32)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(completeBody),
      });

    expect((await complete()).status).toBe(201);
    const attentionResponse = await app.request(
      `/internal/cases/${caseRecord.id}/officer-attention`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"a".repeat(32)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "COMPLETION_FAILED",
          detail: "Metrics atom rejected the completion reward.",
          operationId: `${operationId}/completion-failed`,
        }),
      }
    );
    expect(attentionResponse.status).toBe(201);

    const replay = await complete();
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({
      outcome: "ALREADY_COMPLETED",
    });

    const [attention] = await db
      .select()
      .from(officerAttention)
      .where(eq(officerAttention.caseId, caseRecord.id));
    expect(attention).toMatchObject({ kind: "COMPLETION_FAILED" });
    expect(attention.resolvedAt).not.toBeNull();
    expect(attention.resolvedByOperationId).toBe(operationId);
  });
});
