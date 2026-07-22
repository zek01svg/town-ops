import {
  AppointmentDtoSchema,
  AppointmentSlotClaimDtoSchema,
} from "@townops/orchestration-contract";
import type {
  ConfirmAppointmentSlotInput,
  ReleaseAppointmentSlotInput,
  ReserveAppointmentSlotInput,
} from "@townops/orchestration-contract";
import { eq } from "drizzle-orm";

import db from "./database/db";
import { appointmentSlotClaims, appointments } from "./database/schema";

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
export async function createAppointment(values: any) {
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
    const code =
      (error as { code?: string; cause?: { code?: string } }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
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
