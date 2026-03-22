import { describe, it, expect, vi, beforeEach } from "vitest";

import db from "../../src/database/db";
import { assignments } from "../../src/database/schema";
import { app } from "../../src/index";

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

describe("Assignment Atom Integration Tests", () => {
  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(assignments);
  });

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("CRUD flows", () => {
    it("should create an assignment and list it back from container DB", async () => {
      const payload = {
        caseId: "123e4567-e89b-12d3-a456-426614174000",
        contractorId: "223e4567-e89b-12d3-a456-426614174002",
        status: "pending" as const,
      };

      // 1. Create
      const postRes = await app.request("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(postRes.status).toBe(201);
      const postData = await postRes.json();
      expect(postData.assignment).toHaveProperty("id");
      expect(postData.assignment.caseId).toBe(payload.caseId);

      // 2. List
      const getRes = await app.request("/api/assignments");
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.assignments).toHaveLength(1);
      expect(getData.assignments[0].id).toBe(postData.assignment.id);
    });
  });
});
