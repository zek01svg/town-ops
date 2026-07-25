import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

type Schema = typeof import("../../src/database/schema");
type AppointmentInsert = Schema["appointments"]["$inferInsert"];

function at(hours: number) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

/**
 * PRS-146: `reportNoAccessAppointment` (SCHEDULED -> NO_ACCESS) and
 * `replaceAppointmentSlot` (retire + rebook in one transaction). The
 * transaction boundary is the load-bearing part — the replacement releases the
 * old claim before inserting the new one, so a genuine clash with a different
 * live claim has to take the release down with it.
 */
describe("No access and reschedule (PRS-146)", () => {
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
    await db.delete(schema.appointments);
    await db.delete(schema.appointmentSlotClaims);
  });

  /** A booked Appointment plus the ACTIVE slot claim that owns its interval. */
  async function seedBooking(
    overrides: Partial<AppointmentInsert> & {
      contractorId?: string;
      caseId?: string;
      startTime?: string;
      endTime?: string;
    } = {}
  ) {
    const contractorId = overrides.contractorId ?? crypto.randomUUID();
    const caseId = overrides.caseId ?? crypto.randomUUID();
    const assignmentId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const startTime = overrides.startTime ?? at(1);
    const endTime = overrides.endTime ?? at(2);

    const [claim] = await db
      .insert(schema.appointmentSlotClaims)
      .values({
        operationId: `seed/${crypto.randomUUID()}/claim`,
        caseId,
        assignmentId,
        attemptId,
        contractorId,
        startTime,
        endTime,
        status: "ACTIVE",
      })
      .returning();
    if (!claim) throw new Error("Slot claim seed insert failed");

    const [appointment] = await db
      .insert(schema.appointments)
      .values({
        caseId,
        assignmentId,
        attemptId,
        contractorId,
        operationId: `seed/${crypto.randomUUID()}/appointment`,
        slotClaimId: claim.id,
        startTime,
        endTime,
        status: "scheduled",
        ...overrides,
      })
      .returning();
    if (!appointment) throw new Error("Appointment seed insert failed");

    return { appointment, claim, contractorId, caseId };
  }

  async function claimById(id: string) {
    const [row] = await db
      .select()
      .from(schema.appointmentSlotClaims)
      .where(eq(schema.appointmentSlotClaims.id, id));
    return row;
  }

  async function appointmentById(id: string) {
    const [row] = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, id));
    return row;
  }

  describe("reportNoAccessAppointment outcome table", () => {
    it("SCHEDULED -> NO_ACCESS and leaves the spent slot claim ACTIVE", async () => {
      const { appointment, claim, contractorId } = await seedBooking();

      const result = await service.reportNoAccessAppointment({
        operationId: `${crypto.randomUUID()}/no-access/appointment`,
        appointmentId: appointment.id,
        contractorId,
      });

      expect(result.outcome).toBe("NO_ACCESS");
      if (result.outcome !== "NO_ACCESS") throw new Error("unreachable");
      expect(result.appointment.status).toBe("NO_ACCESS");

      expect((await appointmentById(appointment.id)).status).toBe("no_access");
      expect((await claimById(claim.id)).status).toBe("ACTIVE");
    });

    it("replays as ALREADY_NO_ACCESS", async () => {
      const { appointment, contractorId } = await seedBooking();
      const command = {
        operationId: `${crypto.randomUUID()}/no-access/appointment`,
        appointmentId: appointment.id,
        contractorId,
      };

      expect((await service.reportNoAccessAppointment(command)).outcome).toBe(
        "NO_ACCESS"
      );

      const replay = await service.reportNoAccessAppointment(command);
      expect(replay.outcome).toBe("ALREADY_NO_ACCESS");
      if (replay.outcome !== "ALREADY_NO_ACCESS")
        throw new Error("unreachable");
      expect(replay.appointment.status).toBe("NO_ACCESS");
    });

    it("rejects the wrong Contractor without mutating the row", async () => {
      const { appointment } = await seedBooking();

      const result = await service.reportNoAccessAppointment({
        operationId: `${crypto.randomUUID()}/no-access/appointment`,
        appointmentId: appointment.id,
        contractorId: crypto.randomUUID(),
      });

      expect(result).toEqual({ outcome: "WRONG_CONTRACTOR" });
      expect((await appointmentById(appointment.id)).status).toBe("scheduled");
    });

    // AC1: the report is only meaningful before work starts.
    it("refuses an in_progress Appointment with NOT_SCHEDULED", async () => {
      const { appointment, contractorId } = await seedBooking({
        status: "in_progress",
      });

      const result = await service.reportNoAccessAppointment({
        operationId: `${crypto.randomUUID()}/no-access/appointment`,
        appointmentId: appointment.id,
        contractorId,
      });

      expect(result).toEqual({ outcome: "NOT_SCHEDULED" });
      expect((await appointmentById(appointment.id)).status).toBe(
        "in_progress"
      );
    });

    it("returns APPOINTMENT_NOT_FOUND for an unknown id", async () => {
      const result = await service.reportNoAccessAppointment({
        operationId: `${crypto.randomUUID()}/no-access/appointment`,
        appointmentId: crypto.randomUUID(),
        contractorId: crypto.randomUUID(),
      });

      expect(result).toEqual({ outcome: "APPOINTMENT_NOT_FOUND" });
    });
  });

  describe("replaceAppointmentSlot outcome table", () => {
    it("retires a scheduled Appointment and books its replacement", async () => {
      const { appointment, claim, caseId, contractorId } = await seedBooking();
      const operationId = `${crypto.randomUUID()}/replace`;

      const result = await service.replaceAppointmentSlot({
        operationId,
        caseId,
        appointmentId: appointment.id,
        startTime: at(24),
        endTime: at(25),
      });

      expect(result.outcome).toBe("REPLACED");
      if (result.outcome !== "REPLACED") throw new Error("unreachable");
      expect(result.appointment.status).toBe("SCHEDULED");
      expect(result.appointment.id).not.toBe(appointment.id);
      expect(result.appointment.contractorId).toBe(contractorId);

      expect((await appointmentById(appointment.id)).status).toBe(
        "rescheduled"
      );
      expect((await claimById(claim.id)).status).toBe("RELEASED");

      const [newClaim] = await db
        .select()
        .from(schema.appointmentSlotClaims)
        .where(
          eq(schema.appointmentSlotClaims.operationId, `${operationId}/claim`)
        );
      expect(newClaim.status).toBe("ACTIVE");

      const replacement = await appointmentById(result.appointment.id);
      expect(replacement.status).toBe("scheduled");
      expect(replacement.slotClaimId).toBe(newClaim.id);
    });

    // AC5: recovery from No Access must not erase the No Access outcome.
    it("keeps a no_access Appointment no_access while still booking a replacement", async () => {
      const { appointment, claim, caseId } = await seedBooking({
        status: "no_access",
      });

      const result = await service.replaceAppointmentSlot({
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: appointment.id,
        startTime: at(24),
        endTime: at(25),
      });

      expect(result.outcome).toBe("REPLACED");
      if (result.outcome !== "REPLACED") throw new Error("unreachable");

      expect((await appointmentById(appointment.id)).status).toBe("no_access");
      expect((await claimById(claim.id)).status).toBe("RELEASED");
      expect((await appointmentById(result.appointment.id)).status).toBe(
        "scheduled"
      );
    });

    // The release precedes the insert precisely so this is legal.
    it("allows the replacement to overlap the interval it retires", async () => {
      const { appointment, caseId } = await seedBooking({
        startTime: at(1),
        endTime: at(2),
      });

      const result = await service.replaceAppointmentSlot({
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: appointment.id,
        startTime: at(1.5),
        endTime: at(2.5),
      });

      expect(result.outcome).toBe("REPLACED");
    });

    // AC6: a clash with a different live claim rolls the whole thing back.
    it("returns CONFLICT and leaves the database untouched when the new interval clashes", async () => {
      const { appointment, claim, caseId, contractorId } = await seedBooking({
        startTime: at(1),
        endTime: at(2),
      });
      // A second live commitment for the same Contractor, elsewhere in the day.
      const other = await seedBooking({
        contractorId,
        startTime: at(5),
        endTime: at(6),
      });
      const operationId = `${crypto.randomUUID()}/replace`;

      const result = await service.replaceAppointmentSlot({
        operationId,
        caseId,
        appointmentId: appointment.id,
        startTime: at(5.5),
        endTime: at(6.5),
      });

      expect(result).toEqual({ outcome: "CONFLICT" });

      // The old schedule survives intact.
      expect((await appointmentById(appointment.id)).status).toBe("scheduled");
      expect((await claimById(claim.id)).status).toBe("ACTIVE");
      expect((await claimById(other.claim.id)).status).toBe("ACTIVE");

      const appointmentRows = await db.select().from(schema.appointments);
      expect(appointmentRows).toHaveLength(2);
      expect(
        appointmentRows.some(
          (row) => row.operationId === `${operationId}/appointment`
        )
      ).toBe(false);

      const claimRows = await db.select().from(schema.appointmentSlotClaims);
      expect(claimRows).toHaveLength(2);
      expect(
        claimRows.some((row) => row.operationId === `${operationId}/claim`)
      ).toBe(false);
    });

    it("replays as ALREADY_REPLACED without booking a second replacement", async () => {
      const { appointment, caseId } = await seedBooking();
      const command = {
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: appointment.id,
        startTime: at(24),
        endTime: at(25),
      };

      const first = await service.replaceAppointmentSlot(command);
      expect(first.outcome).toBe("REPLACED");
      if (first.outcome !== "REPLACED") throw new Error("unreachable");

      const replay = await service.replaceAppointmentSlot(command);
      expect(replay.outcome).toBe("ALREADY_REPLACED");
      if (replay.outcome !== "ALREADY_REPLACED") throw new Error("unreachable");
      expect(replay.appointment.id).toBe(first.appointment.id);

      expect(await db.select().from(schema.appointments)).toHaveLength(2);
      expect(await db.select().from(schema.appointmentSlotClaims)).toHaveLength(
        2
      );
    });

    /**
     * The replay check sits behind the `FOR UPDATE` lock, and these two tests
     * are the only thing stopping someone moving it back in front. Ahead of
     * the lock, both callers read a pre-winner snapshot: the loser then
     * answered NOT_REPLACEABLE for a `scheduled` source (whose status the
     * winner had just retired) and violated appointments_operation_id_idx for
     * a `no_access` source (whose status the winner correctly left alone).
     * Both are reachable in production whenever an Activity's StartToClose
     * timeout fires while the first attempt is still running.
     */
    it.each([
      { label: "scheduled", seedStatus: "scheduled" as const },
      { label: "no_access", seedStatus: "no_access" as const },
    ])(
      "is idempotent under concurrent replay of a $label source",
      async ({ seedStatus }) => {
        const { appointment, caseId } = await seedBooking({
          status: seedStatus,
        });
        const command = {
          operationId: `${crypto.randomUUID()}/replace`,
          caseId,
          appointmentId: appointment.id,
          startTime: at(24),
          endTime: at(25),
        };

        const settled = await Promise.allSettled([
          service.replaceAppointmentSlot(command),
          service.replaceAppointmentSlot(command),
        ]);

        const rejected = settled.filter((r) => r.status === "rejected");
        expect(rejected).toEqual([]);

        const outcomes = settled.flatMap((r) =>
          r.status === "fulfilled" ? [r.value] : []
        );
        expect(outcomes.map((o) => o.outcome).toSorted()).toEqual([
          "ALREADY_REPLACED",
          "REPLACED",
        ]);

        // Both callers must be told about the same replacement, or a retry
        // hands its caller an Appointment that does not exist.
        const winner = outcomes.find((o) => o.outcome === "REPLACED");
        const loser = outcomes.find((o) => o.outcome === "ALREADY_REPLACED");
        if (winner?.outcome !== "REPLACED") throw new Error("unreachable");
        if (loser?.outcome !== "ALREADY_REPLACED") {
          throw new Error("unreachable");
        }
        expect(loser.appointment.id).toBe(winner.appointment.id);

        const replacements = (
          await db.select().from(schema.appointments)
        ).filter(
          (row) => row.operationId === `${command.operationId}/appointment`
        );
        expect(replacements).toHaveLength(1);
        expect(replacements[0]?.id).toBe(winner.appointment.id);
        expect(await db.select().from(schema.appointments)).toHaveLength(2);
        expect(
          await db.select().from(schema.appointmentSlotClaims)
        ).toHaveLength(2);
      }
    );

    /**
     * A no_access Appointment keeps its status when replaced (AC5), so unlike
     * a `scheduled` source it stays eligible under the status guard. Without
     * the one-live-per-Attempt index a second replacement under a fresh
     * operation ID booked a second live Appointment, and the first one's
     * claim went on holding the Contractor's calendar while
     * `lookupAppointment` only ever surfaced the newest.
     */
    it("refuses to replace a no_access Appointment that was already replaced", async () => {
      const { appointment, caseId } = await seedBooking({
        status: "no_access",
      });

      const first = await service.replaceAppointmentSlot({
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: appointment.id,
        startTime: at(24),
        endTime: at(25),
      });
      expect(first.outcome).toBe("REPLACED");

      // A different operation ID, so the replay short-circuit cannot catch it.
      const second = await service.replaceAppointmentSlot({
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: appointment.id,
        startTime: at(48),
        endTime: at(49),
      });
      expect(second.outcome).toBe("NOT_REPLACEABLE");

      const live = (await db.select().from(schema.appointments)).filter(
        (row) => row.status === "scheduled"
      );
      expect(live).toHaveLength(1);
      const activeClaims = (
        await db.select().from(schema.appointmentSlotClaims)
      ).filter((row) => row.status === "ACTIVE");
      expect(activeClaims).toHaveLength(1);
    });

    it("refuses an Appointment that is neither scheduled nor no_access", async () => {
      const { appointment, caseId } = await seedBooking({
        status: "in_progress",
      });

      const result = await service.replaceAppointmentSlot({
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: appointment.id,
        startTime: at(24),
        endTime: at(25),
      });

      expect(result).toEqual({ outcome: "NOT_REPLACEABLE" });
      expect((await appointmentById(appointment.id)).status).toBe(
        "in_progress"
      );
    });

    it("returns CASE_MISMATCH for an Appointment on another Case", async () => {
      const { appointment } = await seedBooking();

      const result = await service.replaceAppointmentSlot({
        operationId: `${crypto.randomUUID()}/replace`,
        caseId: crypto.randomUUID(),
        appointmentId: appointment.id,
        startTime: at(24),
        endTime: at(25),
      });

      expect(result).toEqual({ outcome: "CASE_MISMATCH" });
      expect((await appointmentById(appointment.id)).status).toBe("scheduled");
    });

    it("returns APPOINTMENT_NOT_FOUND for an unknown id", async () => {
      const result = await service.replaceAppointmentSlot({
        operationId: `${crypto.randomUUID()}/replace`,
        caseId: crypto.randomUUID(),
        appointmentId: crypto.randomUUID(),
        startTime: at(24),
        endTime: at(25),
      });

      expect(result).toEqual({ outcome: "APPOINTMENT_NOT_FOUND" });
    });
  });

  describe("getAppointmentsByCaseId", () => {
    it("returns the Case's Appointments newest first", async () => {
      const caseId = crypto.randomUUID();
      const older = await seedBooking({
        caseId,
        startTime: at(1),
        endTime: at(2),
        createdAt: "2030-01-01T10:00:00.000Z",
      });
      const newer = await seedBooking({
        caseId,
        startTime: at(5),
        endTime: at(6),
        createdAt: "2030-01-02T10:00:00.000Z",
      });

      const rows = await service.getAppointmentsByCaseId(caseId);
      expect(rows.map((row) => row.id)).toEqual([
        newer.appointment.id,
        older.appointment.id,
      ]);
    });
  });

  describe("internal routes", () => {
    const workerToken = "test-worker-service-token-at-least-32-chars";
    const headers = {
      Authorization: `Bearer ${workerToken}`,
      "Content-Type": "application/json",
    };

    function post(path: string, body: unknown, authorized = true) {
      return app.request(`/internal/appointment-slots/${path}`, {
        method: "POST",
        headers: authorized ? headers : { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("requires the Worker service token on both routes", async () => {
      const { appointment, caseId, contractorId } = await seedBooking();
      expect(
        (
          await post(
            "no-access",
            { operationId: "x", appointmentId: appointment.id, contractorId },
            false
          )
        ).status
      ).toBe(401);
      expect(
        (
          await post(
            "replacements",
            {
              operationId: "x",
              caseId,
              appointmentId: appointment.id,
              startTime: at(24),
              endTime: at(25),
            },
            false
          )
        ).status
      ).toBe(401);
    });

    it("maps no-access outcomes onto 201/409/404", async () => {
      const { appointment, contractorId } = await seedBooking();
      const body = {
        operationId: `${crypto.randomUUID()}/no-access/appointment`,
        appointmentId: appointment.id,
        contractorId,
      };

      const first = await post("no-access", body);
      expect(first.status).toBe(201);
      const firstBody = await first.json();
      expect(firstBody.outcome).toBe("NO_ACCESS");
      expect(firstBody.appointment.status).toBe("NO_ACCESS");

      const replay = await post("no-access", body);
      expect(replay.status).toBe(201);
      expect((await replay.json()).outcome).toBe("ALREADY_NO_ACCESS");

      const wrongContractor = await post("no-access", {
        ...body,
        contractorId: crypto.randomUUID(),
      });
      expect(wrongContractor.status).toBe(409);

      const missing = await post("no-access", {
        ...body,
        appointmentId: crypto.randomUUID(),
      });
      expect(missing.status).toBe(404);
    });

    it("maps replacement outcomes onto 201/409/404", async () => {
      const { appointment, caseId, contractorId } = await seedBooking({
        startTime: at(1),
        endTime: at(2),
      });
      await seedBooking({ contractorId, startTime: at(5), endTime: at(6) });

      const conflict = await post("replacements", {
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: appointment.id,
        startTime: at(5.5),
        endTime: at(6.5),
      });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).outcome).toBe("CONFLICT");

      const missing = await post("replacements", {
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: crypto.randomUUID(),
        startTime: at(24),
        endTime: at(25),
      });
      expect(missing.status).toBe(404);

      const ok = await post("replacements", {
        operationId: `${crypto.randomUUID()}/replace`,
        caseId,
        appointmentId: appointment.id,
        startTime: at(24),
        endTime: at(25),
      });
      expect(ok.status).toBe(201);
      const okBody = await ok.json();
      expect(okBody.outcome).toBe("REPLACED");
      expect(okBody.appointment.status).toBe("SCHEDULED");
    });
  });
});
