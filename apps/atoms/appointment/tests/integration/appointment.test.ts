import { describe, it, expect, vi, beforeEach } from "vitest";

import db from "../../src/database/db";
import { appointments } from "../../src/database/schema";
import { app } from "../../src/index";

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

describe("Appointment Atom Integration Tests", () => {
  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(appointments);
  });

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("CRUD flows", () => {
    it("should create an appointment and list it back by caseId", async () => {
      const payload = {
        caseId: "123e4567-e89b-12d3-a456-426614174000",
        assignmentId: "223e4567-e89b-12d3-a456-426614174001",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600000).toISOString(),
        status: "scheduled" as const,
      };

      // 1. Create
      const postRes = await app.request("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(postRes.status).toBe(201);
      const postData = await postRes.json();
      expect(postData.appointment).toHaveProperty("id");
      expect(postData.appointment.caseId).toBe(payload.caseId);

      // 2. List
      const getRes = await app.request(`/api/appointments/${payload.caseId}`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.appointments).toHaveLength(1);
      expect(getData.appointments[0].id).toBe(postData.appointment.id);
    });
  });
});
