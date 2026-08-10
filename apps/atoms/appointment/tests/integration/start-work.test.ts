import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

type Schema = typeof import("../../src/database/schema");
type AppointmentInsert = Schema["appointments"]["$inferInsert"];

/**
 * PRS-145: `startWorkAppointment`'s SCHEDULED -> IN_PROGRESS transition —
 * Saga step 1. Idempotent by status (ALREADY_STARTED on replay), not by
 * operationId; the Workflow's window gate is what makes replay safe here.
 */
describe("Start work (PRS-145)", () => {
  let db: typeof import("../../src/database/db").default;
  let schema: Schema;
  let service: typeof import("../../src/service");
  let app: typeof import("../../src/index").app;
  let eq: typeof import("drizzle-orm").eq;

  beforeAll(async () => {
    db = (await import("../../src/database/db")).default;
    schema = await import("../../src/database/schema");
    service = await import("../../src/service");
    app = (await import("../../src/index")).app;
    eq = (await import("drizzle-orm")).eq;
  });

  beforeEach(async () => {
    await db.delete(schema.appointmentSlotClaims);
    await db.delete(schema.appointments);
  });

  async function seedAppointment(overrides: Partial<AppointmentInsert> = {}) {
    const contractorId = crypto.randomUUID();
    const [appointment] = await db
      .insert(schema.appointments)
      .values({
        caseId: crypto.randomUUID(),
        assignmentId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        contractorId,
        operationId: `op/${crypto.randomUUID()}/appointment`,
        startTime: new Date(Date.now() - 60_000).toISOString(),
        endTime: new Date(Date.now() + 3_600_000).toISOString(),
        status: "scheduled",
        ...overrides,
      })
      .returning();
    if (!appointment) throw new Error("Appointment seed insert failed");
    return { appointment, contractorId };
  }

  describe("startWorkAppointment outcome table", () => {
    it("SCHEDULED -> IN_PROGRESS", async () => {
      const { appointment, contractorId } = await seedAppointment();

      const result = await service.startWorkAppointment({
        operationId: `${crypto.randomUUID()}/start-work/appointment`,
        appointmentId: appointment.id,
        contractorId,
      });

      expect(result.outcome).toBe("STARTED");
      if (result.outcome !== "STARTED") throw new Error("unreachable");
      expect(result.appointment.status).toBe("IN_PROGRESS");

      const [row] = await db
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, appointment.id));
      expect(row.status).toBe("in_progress");
    });

    it("replays as ALREADY_STARTED and keeps exactly one in_progress row", async () => {
      const { appointment, contractorId } = await seedAppointment();
      const command = {
        operationId: `${crypto.randomUUID()}/start-work/appointment`,
        appointmentId: appointment.id,
        contractorId,
      };

      const first = await service.startWorkAppointment(command);
      expect(first.outcome).toBe("STARTED");

      const replay = await service.startWorkAppointment(command);
      expect(replay.outcome).toBe("ALREADY_STARTED");
      if (replay.outcome !== "ALREADY_STARTED") throw new Error("unreachable");
      expect(replay.appointment.status).toBe("IN_PROGRESS");

      const rows = await db
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, appointment.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("in_progress");
    });

    it("rejects the wrong Contractor without mutating the row", async () => {
      const { appointment } = await seedAppointment();

      const result = await service.startWorkAppointment({
        operationId: `${crypto.randomUUID()}/start-work/appointment`,
        appointmentId: appointment.id,
        contractorId: crypto.randomUUID(),
      });

      expect(result).toEqual({ outcome: "WRONG_CONTRACTOR" });

      const [row] = await db
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, appointment.id));
      expect(row.status).toBe("scheduled");
    });

    it("refuses a non-scheduled Appointment", async () => {
      const { appointment, contractorId } = await seedAppointment({
        status: "cancelled",
      });

      const result = await service.startWorkAppointment({
        operationId: `${crypto.randomUUID()}/start-work/appointment`,
        appointmentId: appointment.id,
        contractorId,
      });

      expect(result).toEqual({ outcome: "NOT_SCHEDULED" });
    });

    it("returns APPOINTMENT_NOT_FOUND for an unknown id", async () => {
      const result = await service.startWorkAppointment({
        operationId: `${crypto.randomUUID()}/start-work/appointment`,
        appointmentId: crypto.randomUUID(),
        contractorId: crypto.randomUUID(),
      });

      expect(result).toEqual({ outcome: "APPOINTMENT_NOT_FOUND" });
    });
  });

  describe("POST /internal/appointment-slots/start-work", () => {
    const workerToken = "test-worker-service-token-at-least-32-chars";

    function request(body: unknown) {
      return app.request("/internal/appointment-slots/start-work", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    it("requires the Worker service token", async () => {
      const { appointment, contractorId } = await seedAppointment();
      const res = await app.request("/internal/appointment-slots/start-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "x",
          appointmentId: appointment.id,
          contractorId,
        }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 201 for a fresh start and 201 for the ALREADY_STARTED replay", async () => {
      const { appointment, contractorId } = await seedAppointment();
      const body = {
        operationId: `${crypto.randomUUID()}/start-work/appointment`,
        appointmentId: appointment.id,
        contractorId,
      };

      const first = await request(body);
      expect(first.status).toBe(201);
      const firstBody = await first.json();
      expect(firstBody.outcome).toBe("STARTED");
      // AC8 / route contract: the HTTP boundary emits the uppercase DTO
      // status, not the lowercase DB row value.
      expect(firstBody.appointment.status).toBe("IN_PROGRESS");

      const replay = await request(body);
      expect(replay.status).toBe(201);
      const replayBody = await replay.json();
      expect(replayBody.outcome).toBe("ALREADY_STARTED");
      expect(replayBody.appointment.status).toBe("IN_PROGRESS");
    });

    it("returns 409 for the wrong Contractor and a non-scheduled Appointment", async () => {
      const { appointment } = await seedAppointment({ status: "missed" });
      const res = await request({
        operationId: `${crypto.randomUUID()}/start-work/appointment`,
        appointmentId: appointment.id,
        contractorId: crypto.randomUUID(),
      });
      expect(res.status).toBe(409);
    });
  });
});
