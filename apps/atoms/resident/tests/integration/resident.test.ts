import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Type-only imports are erased at runtime, so they type the deferred `await
// import()` bindings below without breaking the env-var timing those need.
import type ResidentDb from "../../src/database/db";
import type { profiles as ProfilesTable } from "../../src/database/schema";
import type { app as ResidentApp } from "../../src/index";

let db: typeof ResidentDb;
let profiles: typeof ProfilesTable;
let app: typeof ResidentApp;

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

describe("Resident Atom Integration Tests", () => {
  beforeAll(async () => {
    console.log(
      "TEST RUNNER process.env.DATABASE_URL:",
      process.env.DATABASE_URL
    );

    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");
    const appModule = await import("../../src/index");

    db = dbModule.default;
    profiles = schemaModule.profiles;
    app = appModule.app;
  });

  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(profiles);
  });

  const VALID_UUID = "123e4567-e89b-12d3-a456-426614174001";
  const TEST_RESIDENT = {
    id: VALID_UUID,
    fullName: "Integration Test User",
    email: "integration_test@example.com",
    contactNumber: "91234567",
    postalCode: "123456",
  };

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("Resident CRUD and Search flows", () => {
    it("should create a resident and lookup via ID and Postal Code", async () => {
      // 1. Create Resident
      const postRes = await app.request("/api/residents/new-resident", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(TEST_RESIDENT),
      });

      if (postRes.status !== 201) {
        console.error(
          "POST /api/residents/new-resident FAILED:",
          postRes.status,
          await postRes.clone().text()
        );
      }

      console.log("POST /api/residents/new-resident status:", postRes.status);
      expect(postRes.status).toBe(201);
      const postData = await postRes.json();
      expect(postData.resident).toHaveProperty("id");
      expect(postData.resident.fullName).toBe(TEST_RESIDENT.fullName);

      // 2. Retrieve by ID
      const getRes = await app.request(`/api/residents/${VALID_UUID}`);
      console.log("GET /api/residents/:id status:", getRes.status);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.residents).toHaveLength(1);
      expect(getData.residents[0].id).toBe(VALID_UUID);

      // 3. Search by Postal Code
      const searchRes = await app.request(
        `/api/residents/search?postalCode=${TEST_RESIDENT.postalCode}`
      );
      console.log("GET /api/residents/search status:", searchRes.status);
      expect(searchRes.status).toBe(200);
      const searchData = await searchRes.json();
      expect(searchData.residents).toHaveLength(1);
      expect(searchData.residents[0].fullName).toBe(TEST_RESIDENT.fullName);

      // 4. Update Resident
      const updatedPayload = {
        id: VALID_UUID,
        fullName: "Integration Updated User",
        email: "integration_test@example.com",
      };
      const putRes = await app.request("/api/residents/update-resident", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedPayload),
      });

      expect(putRes.status).toBe(200);
      const putData = await putRes.json();
      expect(putData.resident.fullName).toBe(updatedPayload.fullName);
    });
  });

  describe("GET /internal/residents/:id/contact (PRS-150)", () => {
    const workerToken = "a".repeat(32);
    const CONTACT_UUID = "123e4567-e89b-12d3-a456-426614174010";

    beforeEach(async () => {
      await db.insert(profiles).values({
        id: CONTACT_UUID,
        fullName: "Contact Test User",
        email: "contact_test@example.com",
        contactNumber: "91234567",
        postalCode: "123456",
      });
    });

    it("returns exactly id, email, and fullName for the correct Worker service token", async () => {
      const res = await app.request(
        `/internal/residents/${CONTACT_UUID}/contact`,
        { headers: { Authorization: `Bearer ${workerToken}` } }
      );

      expect(res.status).toBe(200);
      const { contact } = await res.json();
      // Exact-shape assertion: a future widening of getResidentContact's
      // select() to include e.g. contactNumber or postalCode must fail this.
      expect(contact).toEqual({
        id: CONTACT_UUID,
        email: "contact_test@example.com",
        fullName: "Contact Test User",
      });
      expect(Object.keys(contact).toSorted()).toEqual([
        "email",
        "fullName",
        "id",
      ]);
    });

    it("returns 404 for an unknown resident ID", async () => {
      const res = await app.request(
        "/internal/residents/00000000-0000-0000-0000-000000000000/contact",
        { headers: { Authorization: `Bearer ${workerToken}` } }
      );

      expect(res.status).toBe(404);
    });
  });
});
