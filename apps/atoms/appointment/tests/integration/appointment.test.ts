import { describe, it, expect, vi, beforeEach } from "vitest";

import db from "../../src/database/db";
import { appointmentSlotClaims, appointments } from "../../src/database/schema";
import { app } from "../../src/index";

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

describe("Appointment Atom Integration Tests", () => {
  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(appointmentSlotClaims);
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

  describe("internal slot claims", () => {
    const workerToken = "test-worker-service-token-at-least-32-chars";

    function payload(overrides: Record<string, unknown> = {}) {
      return {
        operationId: `accept/${crypto.randomUUID()}/reserve`,
        caseId: crypto.randomUUID(),
        assignmentId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        contractorId: crypto.randomUUID(),
        startTime: new Date(Date.now() + 3_600_000).toISOString(),
        endTime: new Date(Date.now() + 7_200_000).toISOString(),
        ...overrides,
      };
    }

    function request(path: string, body: unknown, token = workerToken) {
      return app.request(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    it("rejects callers without the worker token and past slots", async () => {
      expect(
        (
          await request(
            "/internal/appointment-slots/reservations",
            payload(),
            "wrong"
          )
        ).status
      ).toBe(401);
      expect(
        (
          await request(
            "/internal/appointment-slots/reservations",
            payload({
              startTime: new Date(Date.now() - 7_200_000).toISOString(),
              endTime: new Date(Date.now() - 3_600_000).toISOString(),
            })
          )
        ).status
      ).toBe(400);
    });

    it("holds one future Contractor slot and rejects an overlapping hold", async () => {
      const firstPayload = payload();
      const first = await request(
        "/internal/appointment-slots/reservations",
        firstPayload
      );
      expect(first.status).toBe(201);

      const second = await request("/internal/appointment-slots/reservations", {
        ...firstPayload,
        operationId: `accept/${crypto.randomUUID()}/reserve`,
        caseId: crypto.randomUUID(),
        assignmentId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        startTime: new Date(Date.now() + 5_400_000).toISOString(),
        endTime: new Date(Date.now() + 9_000_000).toISOString(),
      });
      expect(second.status).toBe(409);
    });

    it("reuses a reservation by operation and schedules exactly one appointment", async () => {
      const firstPayload = payload();
      const first = await request(
        "/internal/appointment-slots/reservations",
        firstPayload
      );
      const firstData = await first.json();
      const replay = await request(
        "/internal/appointment-slots/reservations",
        firstPayload
      );
      expect(replay.status).toBe(201);
      expect((await replay.json()).claim.id).toBe(firstData.claim.id);

      const confirmation = {
        operationId: `accept/${crypto.randomUUID()}/confirm`,
        claimId: firstData.claim.id,
      };
      const confirmed = await request(
        "/internal/appointment-slots/confirmations",
        confirmation
      );
      expect(confirmed.status).toBe(201);
      expect((await confirmed.json()).appointment.status).toBe("SCHEDULED");
      expect(
        (
          await request(
            "/internal/appointment-slots/confirmations",
            confirmation
          )
        ).status
      ).toBe(201);
    });

    it("replays an existing reservation after its start time has passed", async () => {
      const firstPayload = payload({
        startTime: new Date(Date.now() - 7_200_000).toISOString(),
        endTime: new Date(Date.now() - 3_600_000).toISOString(),
      });
      const [claim] = await db
        .insert(appointmentSlotClaims)
        .values(firstPayload)
        .returning();

      const replay = await request(
        "/internal/appointment-slots/reservations",
        firstPayload
      );

      expect(replay.status).toBe(201);
      expect((await replay.json()).claim.id).toBe(claim.id);
    });

    it("releases a held slot for reuse", async () => {
      const firstPayload = payload();
      const first = await request(
        "/internal/appointment-slots/reservations",
        firstPayload
      );
      const firstData = await first.json();
      expect(
        (
          await request("/internal/appointment-slots/releases", {
            operationId: `accept/${crypto.randomUUID()}/release`,
            claimId: firstData.claim.id,
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request("/internal/appointment-slots/reservations", {
            ...firstPayload,
            operationId: `accept/${crypto.randomUUID()}/reserve`,
          })
        ).status
      ).toBe(201);
    });
  });
});
