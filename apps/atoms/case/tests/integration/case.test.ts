import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

let db: any;
let cases: any;
let caseHistory: any;
let app: any;

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
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
    app = appModule.app;
  });

  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(cases);
  });

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
});
