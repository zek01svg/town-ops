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

  describe("POST /api/contractors", () => {
    it("should create a new contractor", async () => {
      const res = await app.request("/api/contractors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "API Test Contractor",
          email: "api@test.com",
          contactNum: "9999999999",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.contractor.name).toBe("API Test Contractor");
    });

    it("should return 400 for invalid data", async () => {
      const res = await app.request("/api/contractors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "", // Invalid name
          email: "invalid-email",
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/contractors/:id", () => {
    it("should return a contractor", async () => {
      const c = await contractorService.createContractor({
        name: "Get Test",
        email: "get@test.com",
      });
      const res = await app.request(`/api/contractors/${c.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contractor.name).toBe("Get Test");
    });

    it("should return 404 for non-existent contractor", async () => {
      const res = await app.request(
        "/api/contractors/00000000-0000-0000-0000-000000000000"
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/contractors/:id", () => {
    it("should update a contractor", async () => {
      const c = await contractorService.createContractor({
        name: "Update Test",
        email: "update@test.com",
      });
      const res = await app.request(`/api/contractors/${c.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated via API" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contractor.name).toBe("Updated via API");
    });
  });

  describe("DELETE /api/contractors/:id", () => {
    it("should deactivate a contractor", async () => {
      const c = await contractorService.createContractor({
        name: "Delete Test",
        email: "delete@test.com",
      });
      const res = await app.request(`/api/contractors/${c.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contractor.isActive).toBe(false);
    });
  });

  describe("POST /api/contractors/:id/categories", () => {
    it("should add a category", async () => {
      const c = await contractorService.createContractor({
        name: "Category Route Test",
        email: "catroute@test.com",
      });
      const res = await app.request(`/api/contractors/${c.id}/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryCode: "API_CAT" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.category.categoryCode).toBe("API_CAT");
    });

    it("should return 409 for duplicate category", async () => {
      const c = await contractorService.createContractor({
        name: "Duplicate Cat Test",
        email: "dup@test.com",
      });
      await contractorService.addCategory(c.id, "DUP_CAT");
      const res = await app.request(`/api/contractors/${c.id}/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryCode: "DUP_CAT" }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /api/contractors/search", () => {
    it("should search contractors", async () => {
      const c = await contractorService.createContractor({
        name: "Search Route Test",
        email: "searchroute@test.com",
      });
      await contractorService.addSector(c.id, "S1");
      await contractorService.addCategory(c.id, "K1");

      const res = await app.request(
        "/api/contractors/search?sectorCode=S1&categoryCode=K1"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contractors).toHaveLength(1);
      expect(body.contractors[0].name).toBe("Search Route Test");
    });
  });
});
