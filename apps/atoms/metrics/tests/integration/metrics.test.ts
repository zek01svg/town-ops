import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

let db: any;
let contractorMetrics: any;
let app: any;

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

describe("Metrics Atom Integration Tests", () => {
  beforeAll(async () => {
    console.log(
      "TEST RUNNER process.env.DATABASE_URL:",
      process.env.DATABASE_URL
    );

    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");
    const appModule = await import("../../src/index");

    db = dbModule.default;
    contractorMetrics = schemaModule.contractorMetrics;
    app = appModule.app;
  });

  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(contractorMetrics);
  });

  const VALID_CONTRACTOR_ID = "123e4567-e89b-12d3-a456-426614174001";

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("Metrics CRUD flows", () => {
    it("should create a metric and retrieve it back from container DB", async () => {
      const payload = {
        contractorId: VALID_CONTRACTOR_ID,
        scoreDelta: 5,
        reason: "Completed job early (Integration Test)",
      };

      // 1. Create Metric
      const postRes = await app.request("/api/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (postRes.status !== 201) {
        console.error(
          "POST /api/metrics FAILED:",
          postRes.status,
          await postRes.text()
        );
      }

      expect(postRes.status).toBe(201);
      const postData = await postRes.json();
      expect(postData.metric).toHaveProperty("id");
      expect(postData.metric.scoreDelta).toBe(payload.scoreDelta);
      expect(postData.metric.reason).toBe(payload.reason);

      // 2. Retrieve Metric by Contractor ID
      const getRes = await app.request(`/api/metrics/${payload.contractorId}`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.metrics).toHaveLength(1);
      expect(getData.metrics[0].contractorId).toBe(payload.contractorId);
      expect(getData.metrics[0].scoreDelta).toBe(payload.scoreDelta);
    });
  });
});
