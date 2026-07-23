import {
  AppointmentDtoSchema,
  AppointmentSlotClaimDtoSchema,
} from "@townops/orchestration-contract";
import type {
  ConfirmAppointmentSlotInput,
  ReleaseAppointmentSlotInput,
  ReserveAppointmentSlotInput,
  StartWorkAppointmentInput,
} from "@townops/orchestration-contract";
import { eq } from "drizzle-orm";

import db from "./database/db";
import { appointmentSlotClaims, appointments } from "./database/schema";

/** Reads a Postgres error code off an unknown thrown value without an unsafe cast. */
function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if (
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    typeof error.cause.code === "string"
  ) {
    return error.cause.code;
  }
  return undefined;
}

/**
 * Get all appointments for a given Case ID.
 * @param caseId The UUID of the case.
 */
export async function getAppointmentsByCaseId(caseId: string) {
  return db.select().from(appointments).where(eq(appointments.caseId, caseId));
}

/**
 * Create a new appointment.
 * @param values The appointment data.
 */
export async function createAppointment(
  values: typeof appointments.$inferInsert
) {
  const rows = await db.insert(appointments).values(values).returning();
  return rows[0];
}

function claimDto(claim: typeof appointmentSlotClaims.$inferSelect) {
  return AppointmentSlotClaimDtoSchema.parse(claim);
}

function appointmentDto(appointment: typeof appointments.$inferSelect) {
  return AppointmentDtoSchema.parse({
    ...appointment,
    status: appointment.status.toUpperCase(),
  });
}

export async function reserveAppointmentSlot(
  input: ReserveAppointmentSlotInput
) {
  const [existing] = await db
    .select()
    .from(appointmentSlotClaims)
    .where(eq(appointmentSlotClaims.operationId, input.operationId));
  if (existing) return { outcome: "HELD" as const, claim: claimDto(existing) };

  if (Date.parse(input.startTime) <= Date.now()) {
    return { outcome: "PAST" as const };
  }

  try {
    const [claim] = await db
      .insert(appointmentSlotClaims)
      .values(input)
      .returning();
    if (!claim)
      throw new Error("Appointment slot claim insert did not return a row");
    return { outcome: "HELD" as const, claim: claimDto(claim) };
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === "23P01") return { outcome: "CONFLICT" as const };
    if (code === "23505") {
      const [reused] = await db
        .select()
        .from(appointmentSlotClaims)
        .where(eq(appointmentSlotClaims.operationId, input.operationId));
      if (reused) return { outcome: "HELD" as const, claim: claimDto(reused) };
    }
    throw error;
  }
}

export async function confirmAppointmentSlot(
  input: ConfirmAppointmentSlotInput
) {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(appointmentSlotClaims)
      .where(eq(appointmentSlotClaims.id, input.claimId))
      .for("update");
    if (!claim) return { outcome: "CLAIM_NOT_FOUND" as const };

    const [existing] = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.slotClaimId, claim.id));
    if (existing) {
      return {
        outcome: "CONFIRMED" as const,
        appointment: appointmentDto(existing),
      };
    }
    if (claim.status !== "HELD") return { outcome: "CLAIM_NOT_HELD" as const };

    const [appointment] = await tx
      .insert(appointments)
      .values({
        caseId: claim.caseId,
        assignmentId: claim.assignmentId,
        attemptId: claim.attemptId,
        contractorId: claim.contractorId,
        operationId: input.operationId,
        slotClaimId: claim.id,
        startTime: claim.startTime,
        endTime: claim.endTime,
        status: "scheduled",
      })
      .returning();
    if (!appointment)
      throw new Error("Appointment insert did not return a row");

    await tx
      .update(appointmentSlotClaims)
      .set({ status: "ACTIVE" })
      .where(eq(appointmentSlotClaims.id, claim.id));

    return {
      outcome: "CONFIRMED" as const,
      appointment: appointmentDto(appointment),
    };
  });
}

export async function releaseAppointmentSlot(
  input: ReleaseAppointmentSlotInput
) {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(appointmentSlotClaims)
      .where(eq(appointmentSlotClaims.id, input.claimId))
      .for("update");
    if (!claim) return { outcome: "CLAIM_NOT_FOUND" as const };
    if (claim.status === "ACTIVE") return { outcome: "CLAIM_ACTIVE" as const };
    if (claim.status === "RELEASED") return { outcome: "RELEASED" as const };

    await tx
      .update(appointmentSlotClaims)
      .set({ status: "RELEASED" })
      .where(eq(appointmentSlotClaims.id, claim.id));
    return { outcome: "RELEASED" as const };
  });
}

/**
 * Start-work Saga step 1 (PRS-145): flips a SCHEDULED Appointment to
 * IN_PROGRESS. Idempotent by status, not by operationId — a replay after the
 * Workflow's window gate already let it through is safe to observe as
 * ALREADY_STARTED rather than re-checked against a stored operationId.
 */
export async function startWorkAppointment(input: StartWorkAppointmentInput) {
  return db.transaction(async (tx) => {
    const [appointment] = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, input.appointmentId))
      .for("update");
    if (!appointment) return { outcome: "APPOINTMENT_NOT_FOUND" as const };
    if (appointment.contractorId !== input.contractorId) {
      return { outcome: "WRONG_CONTRACTOR" as const };
    }
    if (appointment.status === "in_progress") {
      return {
        outcome: "ALREADY_STARTED" as const,
        appointment: appointmentDto(appointment),
      };
    }
    if (appointment.status !== "scheduled") {
      return { outcome: "NOT_SCHEDULED" as const };
    }

    const [updated] = await tx
      .update(appointments)
      .set({ status: "in_progress", updatedAt: new Date().toISOString() })
      .where(eq(appointments.id, appointment.id))
      .returning();
    if (!updated) throw new Error("Appointment update did not return a row");

    return {
      outcome: "STARTED" as const,
      appointment: appointmentDto(updated),
    };
  });
}
