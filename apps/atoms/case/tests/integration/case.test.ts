import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeAll } from "vitest";

let db: typeof import("../../src/database/db").default;
let cases: typeof import("../../src/database/schema").cases;
let caseHistory: typeof import("../../src/database/schema").caseHistory;
let officerAttention: typeof import("../../src/database/schema").officerAttention;
let app: typeof import("../../src/index").app;
let caseService: typeof import("../../src/service");

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
    caseService = await import("../../src/service");
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

  describe("GET /api/cases filters and pagination (PRS-151)", () => {
    it("isolates one resident's rows, applies the default page size of 25, and keeps page 1 / page 2 disjoint with a stable full-set union despite a createdAt tie across 30 seeded rows", async () => {
      const residentId = crypto.randomUUID();
      // One multi-row INSERT: defaultNow() is transaction-scoped, so every
      // row shares an identical createdAt — exactly the tie that made
      // LIMIT/OFFSET pagination non-deterministic before listCases added
      // `cases.id` as a secondary sort key.
      const inserted = await db
        .insert(cases)
        .values(
          Array.from({ length: 30 }, () => ({
            residentId,
            category: "LE" as const,
            description: "Pagination seed",
          }))
        )
        .returning();
      const insertedIds = inserted
        .map((record) => record.id)
        .toSorted((a, b) => a.localeCompare(b));

      const firstPage = await app.request(
        `/api/cases?residentId=${residentId}`
      );
      expect(firstPage.status).toBe(200);
      const firstBody = await firstPage.json();
      expect(firstBody.cases).toHaveLength(25);
      expect(
        firstBody.cases.every(
          (record: { residentId: string }) => record.residentId === residentId
        )
      ).toBe(true);

      const secondPage = await app.request(
        `/api/cases?residentId=${residentId}&page=2`
      );
      expect(secondPage.status).toBe(200);
      const secondBody = await secondPage.json();
      expect(secondBody.cases).toHaveLength(5);

      const firstIds = firstBody.cases.map(
        (record: { id: string }) => record.id
      );
      const secondIds = secondBody.cases.map(
        (record: { id: string }) => record.id
      );

      // The real assertion: no row appears on both pages, and the two
      // pages together cover every seeded row exactly once, in a stable
      // order — not just correctly sized. This is what a missing tiebreak
      // would break with 30 rows sharing one createdAt.
      expect(new Set([...firstIds, ...secondIds]).size).toBe(30);
      expect(
        [...firstIds, ...secondIds].toSorted((a, b) => a.localeCompare(b))
      ).toEqual(insertedIds);
    });

    it("rejects a pageSize over 100", async () => {
      const res = await app.request("/api/cases?pageSize=101");
      expect(res.status).toBe(400);
    });

    it("filters by an explicit ids list, skipping the offset", async () => {
      const residentId = crypto.randomUUID();
      const [caseA, caseB, caseC] = await db
        .insert(cases)
        .values([
          { residentId, category: "LE" as const },
          { residentId, category: "PL" as const },
          { residentId, category: "CL" as const },
        ])
        .returning();

      const res = await app.request(`/api/cases?ids=${caseA.id},${caseB.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(
        body.cases
          .map((record: { id: string }) => record.id)
          .toSorted((a, b) => a.localeCompare(b))
      ).toEqual([caseA.id, caseB.id].toSorted((a, b) => a.localeCompare(b)));
      expect(
        body.cases.map((record: { id: string }) => record.id)
      ).not.toContain(caseC.id);
    });

    it("truncates to pageSize when the ids list is longer, and page is ignored (no offset applied)", async () => {
      const residentId = crypto.randomUUID();
      const inserted = await db
        .insert(cases)
        .values(
          Array.from({ length: 30 }, () => ({
            residentId,
            category: "LE" as const,
          }))
        )
        .returning();
      const ids = inserted.map((record) => record.id);

      // Default pageSize (25) truncates a 30-id list silently rather than
      // rejecting or returning all 30 — pins service.ts's documented
      // behaviour of `.limit(pageSize)` with the offset skipped.
      const truncated = await app.request(`/api/cases?ids=${ids.join(",")}`);
      expect(truncated.status).toBe(200);
      expect((await truncated.json()).cases).toHaveLength(25);

      // page=2 must not truncate further or error when ids is present — the
      // service never calls .offset() on that branch. (Not asserted equal
      // to the page=1 request above: both are ordered by `desc(createdAt)`
      // with no secondary tiebreak, and all 30 rows share one insert
      // batch's timestamp, so which 25 of 30 come back is not guaranteed
      // stable across two separate requests.)
      const page2 = await app.request(`/api/cases?ids=${ids.join(",")}&page=2`);
      expect(page2.status).toBe(200);
      const page2Body = await page2.json();
      expect(page2Body.cases).toHaveLength(25);
      expect(
        page2Body.cases.every((record: { id: string }) =>
          ids.includes(record.id)
        )
      ).toBe(true);

      // A pageSize that covers the whole list returns every id.
      const full = await app.request(
        `/api/cases?ids=${ids.join(",")}&pageSize=30`
      );
      expect(full.status).toBe(200);
      expect(
        (await full.json()).cases
          .map((record: { id: string }) => record.id)
          .toSorted((a, b) => a.localeCompare(b))
      ).toEqual(ids.toSorted((a, b) => a.localeCompare(b)));
    });

    it("rejects a malformed id in the ids list", async () => {
      const res = await app.request(
        `/api/cases?ids=${crypto.randomUUID()},not-a-uuid`
      );
      expect(res.status).toBe(400);
    });

    it("still answers with no query params at all (backwards compatibility)", async () => {
      const res = await app.request("/api/cases");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.cases)).toBe(true);
      // Default pageSize now caps this — a deliberate PRS-151 behaviour
      // change from the old unbounded `db.select().from(cases)` (spec's
      // "Pagination rejects, not caps" locked decision), not a regression.
      expect(body.cases.length).toBeLessThanOrEqual(25);
    });
  });

  describe("Route collisions (PRS-151)", () => {
    it("routes /api/cases/officer-attention to the literal handler, not :id", async () => {
      // If `/:id` shadowed this, `getCaseSchema` (z.uuid()) would reject
      // "officer-attention" as an invalid UUID and this would 400.
      const res = await app.request("/api/cases/officer-attention");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("attentions");
      expect(body).not.toHaveProperty("cases");
    });

    it("still routes /api/cases/:id to the single-case handler alongside the new /:id/history sibling", async () => {
      const [caseRecord] = await db
        .insert(cases)
        .values({ residentId: crypto.randomUUID(), category: "LE" })
        .returning();

      const byId = await app.request(`/api/cases/${caseRecord.id}`);
      expect(byId.status).toBe(200);
      const byIdBody = await byId.json();
      expect(byIdBody).toHaveProperty("cases");
      expect(byIdBody.cases).toHaveLength(1);
      expect(byIdBody.cases[0].id).toBe(caseRecord.id);

      const history = await app.request(`/api/cases/${caseRecord.id}/history`);
      expect(history.status).toBe(200);
      const historyBody = await history.json();
      expect(historyBody).toHaveProperty("history");
      expect(historyBody).not.toHaveProperty("cases");
    });
  });

  describe("GET /api/cases/:id/history (PRS-151)", () => {
    it("returns insert-ordered rows carrying actorId/actorRole/reason/operationId", async () => {
      const openActorId = crypto.randomUUID();
      const openOperationId = `case/history/open/${crypto.randomUUID()}`;
      const newCase = await caseService.createCaseForOperation({
        caseId: crypto.randomUUID(),
        operationId: openOperationId,
        actorId: openActorId,
        actorRole: "RESIDENT",
        input: {
          residentId: crypto.randomUUID(),
          category: "LE",
          priority: "MEDIUM",
          description: "History ordering test",
          postalCode: "123456",
        },
      });

      const assignActorId = crypto.randomUUID();
      const assignOperationId = `case/history/assign/${crypto.randomUUID()}`;
      await caseService.markCaseAssignedForOperation({
        caseId: newCase.id,
        operationId: assignOperationId,
        actorId: assignActorId,
        actorRole: "SYSTEM",
      });

      const cancelActorId = crypto.randomUUID();
      const cancelOperationId = `case/history/cancel/${crypto.randomUUID()}`;
      await caseService.cancelCaseForOperation({
        caseId: newCase.id,
        operationId: cancelOperationId,
        actorId: cancelActorId,
        actorRole: "OFFICER",
        reason: "Resident withdrew the request",
      });

      const res = await app.request(`/api/cases/${newCase.id}/history`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(
        body.history.map((row: { eventType: string }) => row.eventType)
      ).toEqual(["CASE_OPENED", "CASE_ASSIGNED", "CASE_CANCELLED"]);
      expect(body.history[0]).toMatchObject({
        actorId: openActorId,
        actorRole: "RESIDENT",
        reason: null,
        operationId: openOperationId,
      });
      expect(body.history[1]).toMatchObject({
        actorId: assignActorId,
        actorRole: "SYSTEM",
        reason: null,
        operationId: assignOperationId,
      });
      expect(body.history[2]).toMatchObject({
        actorId: cancelActorId,
        actorRole: "OFFICER",
        reason: "Resident withdrew the request",
        operationId: cancelOperationId,
      });
    });

    it("returns [] for a Case with no history rows", async () => {
      const [caseRecord] = await db
        .insert(cases)
        .values({ residentId: crypto.randomUUID(), category: "LE" })
        .returning();

      const res = await app.request(`/api/cases/${caseRecord.id}/history`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ history: [] });
    });
  });
});
