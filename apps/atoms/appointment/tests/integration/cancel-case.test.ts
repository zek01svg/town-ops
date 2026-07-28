import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

describe("Appointment cancellation (PRS-148)", () => {
  let db: typeof import("../../src/database/db").default;
  let schema: typeof import("../../src/database/schema");
  let service: typeof import("../../src/service");

  beforeAll(async () => {
    db = (await import("../../src/database/db")).default;
    schema = await import("../../src/database/schema");
    service = await import("../../src/service");
  });

  async function seedScheduledAppointment(
    status: "scheduled" | "in_progress" = "scheduled"
  ) {
    const caseId = crypto.randomUUID();
    const assignmentId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const contractorId = crypto.randomUUID();
    const [claim] = await db
      .insert(schema.appointmentSlotClaims)
      .values({
        operationId: `${caseId}/claim`,
        caseId,
        assignmentId,
        attemptId,
        contractorId,
        startTime: "2030-01-01T10:00:00.000Z",
        endTime: "2030-01-01T11:00:00.000Z",
        status: "ACTIVE",
      })
      .returning();
    if (!claim) throw new Error("Appointment claim seed failed");
    const [appointment] = await db
      .insert(schema.appointments)
      .values({
        caseId,
        assignmentId,
        attemptId,
        contractorId,
        operationId: `${caseId}/appointment`,
        slotClaimId: claim.id,
        startTime: claim.startTime,
        endTime: claim.endTime,
        status,
      })
      .returning();
    if (!appointment) throw new Error("Appointment seed insert failed");
    return { caseId, claim, appointment };
  }

  it("cancels the scheduled Appointment, releases its active claim, and writes one operation history row", async () => {
    const { caseId, claim, appointment } = await seedScheduledAppointment();
    const input = {
      caseId,
      operationId: `${caseId}/cancel/appointment`,
      changedBy: crypto.randomUUID(),
    };

    const first = await service.cancelScheduledAppointment(input);
    const replay = await service.cancelScheduledAppointment(input);

    expect(first.outcome).toBe("CANCELLED");
    expect(replay.outcome).toBe("ALREADY_CANCELLED");
    const [updatedClaim] = await db
      .select()
      .from(schema.appointmentSlotClaims)
      .where(eq(schema.appointmentSlotClaims.id, claim.id));
    expect(updatedClaim.status).toBe("RELEASED");
    const history = await db
      .select()
      .from(schema.appointmentStatusHistory)
      .where(eq(schema.appointmentStatusHistory.appointmentId, appointment.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: "scheduled",
      toStatus: "cancelled",
      operationId: input.operationId,
    });
  });

  it("rejects a start-work race and leaves the Appointment intact", async () => {
    const { caseId, appointment } =
      await seedScheduledAppointment("in_progress");

    expect(
      await service.cancelScheduledAppointment({
        caseId,
        operationId: `${caseId}/cancel/appointment`,
        changedBy: crypto.randomUUID(),
      })
    ).toEqual({ outcome: "IN_PROGRESS" });
    const [current] = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointment.id));
    expect(current.status).toBe("in_progress");
  });
});
