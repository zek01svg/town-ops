import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";

import db from "../../src/database/db";
import {
  appointmentSlotClaims,
  appointments,
  appointmentStatusHistory,
} from "../../src/database/schema";
import { app } from "../../src/index";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: Context, next: Next) => next(),
}));

const workerToken = "test-worker-service-token-at-least-32-chars";

function reservationPayload(overrides: Record<string, unknown> = {}) {
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

function internalRequest(path: string, body: unknown, token = workerToken) {
  return app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function completionRequest(
  appointmentId: string,
  contractorId: string,
  operationId: string,
  token = workerToken
) {
  return app.request("/internal/appointment-slots/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appointmentId, contractorId, operationId }),
  });
}

describe("Appointment Atom Integration Tests", () => {
  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(appointmentSlotClaims);
    await db.delete(appointmentStatusHistory);
    await db.delete(appointments);
  });

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("internal slot claims", () => {
    it("rejects callers without the worker token and past slots", async () => {
      expect(
        (
          await internalRequest(
            "/internal/appointment-slots/reservations",
            reservationPayload(),
            "wrong"
          )
        ).status
      ).toBe(401);
      expect(
        (
          await internalRequest(
            "/internal/appointment-slots/reservations",
            reservationPayload({
              startTime: new Date(Date.now() - 7_200_000).toISOString(),
              endTime: new Date(Date.now() - 3_600_000).toISOString(),
            })
          )
        ).status
      ).toBe(400);
    });

    it("holds one future Contractor slot and rejects an overlapping hold", async () => {
      const firstPayload = reservationPayload();
      const first = await internalRequest(
        "/internal/appointment-slots/reservations",
        firstPayload
      );
      expect(first.status).toBe(201);

      const second = await internalRequest(
        "/internal/appointment-slots/reservations",
        {
          ...firstPayload,
          operationId: `accept/${crypto.randomUUID()}/reserve`,
          caseId: crypto.randomUUID(),
          assignmentId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          startTime: new Date(Date.now() + 5_400_000).toISOString(),
          endTime: new Date(Date.now() + 9_000_000).toISOString(),
        }
      );
      expect(second.status).toBe(409);
    });

    it("reuses a reservation by operation and schedules exactly one appointment", async () => {
      const firstPayload = reservationPayload();
      const first = await internalRequest(
        "/internal/appointment-slots/reservations",
        firstPayload
      );
      const firstData = await first.json();
      const replay = await internalRequest(
        "/internal/appointment-slots/reservations",
        firstPayload
      );
      expect(replay.status).toBe(201);
      expect((await replay.json()).claim.id).toBe(firstData.claim.id);

      const confirmation = {
        operationId: `accept/${crypto.randomUUID()}/confirm`,
        claimId: firstData.claim.id,
      };
      const confirmed = await internalRequest(
        "/internal/appointment-slots/confirmations",
        confirmation
      );
      expect(confirmed.status).toBe(201);
      expect((await confirmed.json()).appointment.status).toBe("SCHEDULED");
      expect(
        (
          await internalRequest(
            "/internal/appointment-slots/confirmations",
            confirmation
          )
        ).status
      ).toBe(201);
    });

    it("replays an existing reservation after its start time has passed", async () => {
      const firstPayload = reservationPayload({
        startTime: new Date(Date.now() - 7_200_000).toISOString(),
        endTime: new Date(Date.now() - 3_600_000).toISOString(),
      });
      const [claim] = await db
        .insert(appointmentSlotClaims)
        .values(firstPayload)
        .returning();

      const replay = await internalRequest(
        "/internal/appointment-slots/reservations",
        firstPayload
      );

      expect(replay.status).toBe(201);
      expect((await replay.json()).claim.id).toBe(claim.id);
    });

    it("releases a held slot for reuse", async () => {
      const firstPayload = reservationPayload();
      const first = await internalRequest(
        "/internal/appointment-slots/reservations",
        firstPayload
      );
      const firstData = await first.json();
      expect(
        (
          await internalRequest("/internal/appointment-slots/releases", {
            operationId: `accept/${crypto.randomUUID()}/release`,
            claimId: firstData.claim.id,
          })
        ).status
      ).toBe(200);
      expect(
        (
          await internalRequest("/internal/appointment-slots/reservations", {
            ...firstPayload,
            operationId: `accept/${crypto.randomUUID()}/reserve`,
          })
        ).status
      ).toBe(201);
    });
  });

  describe("internal completion (PRS-147)", () => {
    it("completes once, retains its completion claim, and rejects a different operation", async () => {
      const contractorId = crypto.randomUUID();
      const operationId = `complete/${crypto.randomUUID()}/appointment`;
      const [appointment] = await db
        .insert(appointments)
        .values({
          caseId: crypto.randomUUID(),
          assignmentId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          contractorId,
          operationId: `start/${crypto.randomUUID()}/appointment`,
          startTime: "2030-01-01T09:00:00.000Z",
          endTime: "2030-01-01T10:00:00.000Z",
          status: "in_progress",
        })
        .returning();

      const first = await completionRequest(
        appointment.id,
        contractorId,
        operationId
      );
      expect(first.status).toBe(201);
      expect(await first.json()).toMatchObject({ outcome: "COMPLETED" });

      const [history] = await db
        .select()
        .from(appointmentStatusHistory)
        .where(eq(appointmentStatusHistory.appointmentId, appointment.id));
      expect(history).toMatchObject({
        appointmentId: appointment.id,
        fromStatus: "in_progress",
        toStatus: "completed",
        changedBy: contractorId,
        operationId,
      });

      const replay = await completionRequest(
        appointment.id,
        contractorId,
        operationId
      );
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({
        outcome: "ALREADY_COMPLETED",
      });
      expect(
        await db
          .select()
          .from(appointmentStatusHistory)
          .where(eq(appointmentStatusHistory.appointmentId, appointment.id))
      ).toHaveLength(1);

      const conflicting = await completionRequest(
        appointment.id,
        contractorId,
        `complete/${crypto.randomUUID()}/appointment`
      );
      expect(conflicting.status).toBe(409);
      expect(await conflicting.json()).toEqual({
        outcome: "COMPLETION_OPERATION_CONFLICT",
      });

      const unauthorizedIdentity = await app.request(
        `/internal/appointment-slots/completion-operation/${appointment.id}`
      );
      expect(unauthorizedIdentity.status).toBe(401);
      const identity = await app.request(
        `/internal/appointment-slots/completion-operation/${appointment.id}`,
        { headers: { Authorization: `Bearer ${workerToken}` } }
      );
      expect(identity.status).toBe(200);
      expect(await identity.json()).toEqual({
        completionOperationId: operationId,
      });

      const publicRead = await app.request(
        `/api/appointments/${appointment.caseId}`,
        { headers: { Authorization: `Bearer ${workerToken}` } }
      );
      expect(publicRead.status).toBe(200);
      expect((await publicRead.json()).appointments[0]).not.toHaveProperty(
        "completionOperationId"
      );
    });

    it("rejects a different Contractor without changing the appointment or history", async () => {
      const contractorId = crypto.randomUUID();
      const [appointment] = await db
        .insert(appointments)
        .values({
          caseId: crypto.randomUUID(),
          assignmentId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          contractorId,
          operationId: `start/${crypto.randomUUID()}/appointment`,
          startTime: "2030-01-01T09:00:00.000Z",
          endTime: "2030-01-01T10:00:00.000Z",
          status: "in_progress",
        })
        .returning();

      const response = await completionRequest(
        appointment.id,
        crypto.randomUUID(),
        `complete/${crypto.randomUUID()}/appointment`
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ outcome: "WRONG_CONTRACTOR" });
      expect(
        await db
          .select()
          .from(appointmentStatusHistory)
          .where(eq(appointmentStatusHistory.appointmentId, appointment.id))
      ).toEqual([]);
    });
  });
});
