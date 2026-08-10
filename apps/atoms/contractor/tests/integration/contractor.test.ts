import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import db from "../../src/database/db";
import { contractors } from "../../src/database/schema";
import { app } from "../../src/index";
import * as contractorService from "../../src/service";

describe("Contractor API Integration Tests", () => {
  beforeEach(async () => {
    // Clean up database before each test
    await db.execute(
      sql`TRUNCATE TABLE ${contractors} RESTART IDENTITY CASCADE`
    );
  });

  describe("GET /health", () => {
    it("should return 200 and status healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("healthy");
    });
  });

  describe("GET /internal/contractors/:id/contact (PRS-150)", () => {
    const workerToken = "a".repeat(32);

    it("returns exactly id, email, and name for the correct Worker service token", async () => {
      const c = await contractorService.createContractor({
        name: "Contact Test",
        email: "contact@test.com",
        contactNum: "9999999999",
      });

      const res = await app.request(`/internal/contractors/${c.id}/contact`, {
        headers: { Authorization: `Bearer ${workerToken}` },
      });

      expect(res.status).toBe(200);
      const { contact } = await res.json();
      // Exact-shape assertion: a future widening of getContractorContact's
      // select() to include e.g. contactNum or isActive must fail this.
      expect(contact).toEqual({
        id: c.id,
        email: "contact@test.com",
        name: "Contact Test",
      });
      expect(Object.keys(contact).toSorted()).toEqual(["email", "id", "name"]);
    });

    it("returns 404 for an unknown contractor ID", async () => {
      const res = await app.request(
        "/internal/contractors/00000000-0000-0000-0000-000000000000/contact",
        { headers: { Authorization: `Bearer ${workerToken}` } }
      );

      expect(res.status).toBe(404);
    });
  });
});
