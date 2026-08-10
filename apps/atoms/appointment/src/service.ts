import {
  AppointmentDtoSchema,
  AppointmentSlotClaimDtoSchema,
} from "@townops/orchestration-contract";
import type {
  CancelAppointmentInput,
  ConfirmAppointmentSlotInput,
  CompleteAppointmentInput,
  ReleaseAppointmentSlotInput,
  MarkAppointmentMissedInput,
  ReplaceAppointmentSlotInput,
  ReportNoAccessAppointmentInput,
  ReserveAppointmentSlotInput,
  StartWorkAppointmentInput,
} from "@townops/orchestration-contract";
import { and, desc, eq } from "drizzle-orm";

import db from "./database/db";
import {
  appointmentSlotClaims,
  appointments,
  appointmentStatusHistory,
} from "./database/schema";

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

/** Reads the violated constraint's name off an unknown thrown value. */
function pgConstraintName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("constraint" in error && typeof error.constraint === "string") {
    return error.constraint;
  }
  if (
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    typeof error.cause.constraint === "string"
  ) {
    return error.cause.constraint;
  }
  return undefined;
}

/**
 * Get all appointments for a given Case ID, newest first. A rescheduled Case
 * keeps every retired Appointment row, so callers picking "the current one"
 * need the order to be defined rather than whatever Postgres returns.
 * @param caseId The UUID of the case.
 */
export async function getAppointmentsByCaseId(caseId: string) {
  const rows = await db
    .select()
    .from(appointments)
    .where(eq(appointments.caseId, caseId))
    .orderBy(desc(appointments.createdAt));
  return rows.map(
    ({ completionOperationId: _, ...appointment }) => appointment
  );
}

export async function getAppointmentCompletionOperation(appointmentId: string) {
  const [appointment] = await db
    .select({ completionOperationId: appointments.completionOperationId })
    .from(appointments)
    .where(eq(appointments.id, appointmentId));
  return appointment ?? null;
}

/**
 * Create a new appointment.
 * @param values The appointment data.
 */
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

/** Completion keeps the active slot claim: the historical visit remains owned. */
export async function completeAppointment(input: CompleteAppointmentInput) {
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
    if (appointment.status === "completed") {
      if (appointment.completionOperationId !== input.operationId) {
        return { outcome: "COMPLETION_OPERATION_CONFLICT" as const };
      }
      return {
        outcome: "ALREADY_COMPLETED" as const,
        appointment: appointmentDto(appointment),
      };
    }
    if (appointment.status !== "in_progress") {
      return { outcome: "NOT_IN_PROGRESS" as const };
    }
    const [updated] = await tx
      .update(appointments)
      .set({
        status: "completed",
        completionOperationId: input.operationId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(appointments.id, appointment.id))
      .returning();
    if (!updated)
      throw new Error("Appointment completion update did not return a row");
    await tx.insert(appointmentStatusHistory).values({
      appointmentId: appointment.id,
      fromStatus: "in_progress",
      toStatus: "completed",
      changedBy: input.contractorId,
      operationId: input.operationId,
    });
    return {
      outcome: "COMPLETED" as const,
      appointment: appointmentDto(updated),
    };
  });
}

/**
 * No-access Saga step 1 (PRS-146): flips a SCHEDULED Appointment to NO_ACCESS.
 * Idempotent by status for the same reason as startWorkAppointment — the
 * Workflow's window gate has already run, so a replay is safe to observe as
 * ALREADY_NO_ACCESS. An in_progress Appointment deliberately falls through to
 * NOT_SCHEDULED: once work has started the visit was not a no-access one, and
 * no report may rewrite that (AC1).
 * The slot claim stays ACTIVE — the wasted interval remains owned by the
 * Contractor until a replacement releases it.
 */
export async function reportNoAccessAppointment(
  input: ReportNoAccessAppointmentInput
) {
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
    if (appointment.status === "no_access") {
      return {
        outcome: "ALREADY_NO_ACCESS" as const,
        appointment: appointmentDto(appointment),
      };
    }
    if (appointment.status !== "scheduled") {
      return { outcome: "NOT_SCHEDULED" as const };
    }

    const [updated] = await tx
      .update(appointments)
      .set({
        status: "no_access",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(appointments.id, appointment.id))
      .returning();
    if (!updated) throw new Error("Appointment update did not return a row");

    return {
      outcome: "NO_ACCESS" as const,
      appointment: appointmentDto(updated),
    };
  });
}

/**
 * Workflow-owned expiry transition. The ACTIVE slot claim deliberately stays
 * put until a replacement releases it, just as it does for No Access.
 */
export async function markAppointmentMissed(input: MarkAppointmentMissedInput) {
  return db.transaction(async (tx) => {
    const [appointment] = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, input.appointmentId))
      .for("update");
    if (!appointment) return { outcome: "APPOINTMENT_NOT_FOUND" as const };
    if (appointment.status === "missed") {
      return {
        outcome: "ALREADY_MISSED" as const,
        appointment: appointmentDto(appointment),
      };
    }
    if (appointment.status !== "scheduled") {
      return { outcome: "NOT_SCHEDULED" as const };
    }

    const [updated] = await tx
      .update(appointments)
      .set({ status: "missed", updatedAt: new Date().toISOString() })
      .where(eq(appointments.id, appointment.id))
      .returning();
    if (!updated) throw new Error("Appointment update did not return a row");

    return { outcome: "MISSED" as const, appointment: appointmentDto(updated) };
  });
}

/**
 * Cancels the live scheduled Appointment for a Case and releases its active
 * slot in the same transaction. Historical No Access and Missed rows remain
 * untouched; a Case without a scheduled visit is already converged here.
 */
export async function cancelScheduledAppointment(
  input: CancelAppointmentInput
) {
  return db.transaction(async (tx) => {
    const [inProgress] = await tx
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.caseId, input.caseId),
          eq(appointments.status, "in_progress")
        )
      )
      .for("update");
    if (inProgress) return { outcome: "IN_PROGRESS" as const };

    const [scheduled] = await tx
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.caseId, input.caseId),
          eq(appointments.status, "scheduled")
        )
      )
      .for("update");
    if (!scheduled) {
      const [cancelled] = await tx
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.caseId, input.caseId),
            eq(appointments.status, "cancelled")
          )
        )
        .limit(1);
      return cancelled
        ? {
            outcome: "ALREADY_CANCELLED" as const,
            appointment: appointmentDto(cancelled),
          }
        : { outcome: "NO_SCHEDULED_APPOINTMENT" as const };
    }

    if (scheduled.slotClaimId) {
      await tx
        .update(appointmentSlotClaims)
        .set({ status: "RELEASED" })
        .where(eq(appointmentSlotClaims.id, scheduled.slotClaimId));
    }
    const [cancelled] = await tx
      .update(appointments)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(eq(appointments.id, scheduled.id))
      .returning();
    if (!cancelled)
      throw new Error("Appointment cancellation update did not return a row");

    await tx.insert(appointmentStatusHistory).values({
      appointmentId: scheduled.id,
      fromStatus: "scheduled",
      toStatus: "cancelled",
      changedBy: input.changedBy,
      operationId: input.operationId,
    });
    return {
      outcome: "CANCELLED" as const,
      appointment: appointmentDto(cancelled),
    };
  });
}

/**
 * Reschedule Saga step 1 (PRS-146): retires an Appointment and books its
 * replacement in one transaction, so a Case is never left with neither.
 *
 * The replay check sits behind the FOR UPDATE lock, not in front of it. Two
 * concurrent attempts of the same operation — an Activity retry firing while
 * the first attempt is still running — serialise on that lock, and under READ
 * COMMITTED the check then runs on a snapshot fresh enough to see the winner's
 * committed replacement, so the loser answers ALREADY_REPLACED. Ahead of the
 * lock it reads a pre-winner snapshot and goes on to answer NOT_REPLACEABLE
 * for a retired `scheduled` source, or to violate
 * appointments_operation_id_idx for a `no_access` source the winner correctly
 * left alone. The lock is not a mutation, so nothing is written before the
 * replay short-circuit either way.
 *
 * The old claim is RELEASED before the new one is inserted: both belong to
 * the same Contractor, and appointment_slot_claims_contractor_interval_excl
 * would reject a replacement touching the very interval being retired.
 *
 * A 23P01 from a genuine clash with another live claim is therefore allowed to
 * escape the transaction callback rather than be swallowed inside it. Postgres
 * has already aborted the transaction at that point, so the release and the
 * retirement roll back with it and the original schedule survives intact
 * (AC6); returning CONFLICT from inside would instead commit a Case that has
 * lost its Appointment.
 */
export async function replaceAppointmentSlot(
  input: ReplaceAppointmentSlotInput
) {
  const claimOperationId = `${input.operationId}/claim`;
  const appointmentOperationId = `${input.operationId}/appointment`;

  try {
    return await db.transaction(async (tx) => {
      const [previous] = await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, input.appointmentId))
        .for("update");
      if (!previous) return { outcome: "APPOINTMENT_NOT_FOUND" as const };

      // Behind the lock, still before any mutation — see the docblock; moving
      // this ahead of the lock reopens the concurrent-replay race.
      const [replacement] = await tx
        .select()
        .from(appointments)
        .where(eq(appointments.operationId, appointmentOperationId));
      if (replacement) {
        return {
          outcome: "ALREADY_REPLACED" as const,
          appointment: appointmentDto(replacement),
        };
      }

      if (previous.caseId !== input.caseId) {
        return { outcome: "CASE_MISMATCH" as const };
      }
      // attemptId/contractorId are nullable for legacy public-route rows, and
      // a slot claim cannot be issued without them.
      if (
        (previous.status !== "scheduled" &&
          previous.status !== "no_access" &&
          previous.status !== "missed") ||
        !previous.attemptId ||
        !previous.contractorId
      ) {
        return { outcome: "NOT_REPLACEABLE" as const };
      }

      if (previous.slotClaimId) {
        await tx
          .update(appointmentSlotClaims)
          .set({ status: "RELEASED" })
          .where(eq(appointmentSlotClaims.id, previous.slotClaimId));
      }

      // reserveAppointmentSlot recovers from a duplicate operation_id by
      // catching the 23505; inside a transaction that is not an option, since
      // the violation aborts the whole transaction. The insert absorbs the
      // replay itself instead. Naming the conflict target is load-bearing —
      // an untargeted DO NOTHING would also swallow the gist exclusion
      // violation this transaction must roll back on.
      let [claim] = await tx
        .insert(appointmentSlotClaims)
        .values({
          operationId: claimOperationId,
          caseId: previous.caseId,
          assignmentId: previous.assignmentId,
          attemptId: previous.attemptId,
          contractorId: previous.contractorId,
          startTime: input.startTime,
          endTime: input.endTime,
          status: "ACTIVE",
        })
        .onConflictDoNothing({ target: appointmentSlotClaims.operationId })
        .returning();
      if (!claim) {
        [claim] = await tx
          .select()
          .from(appointmentSlotClaims)
          .where(eq(appointmentSlotClaims.operationId, claimOperationId));
        if (!claim) {
          throw new Error("Appointment slot claim was not found after a reuse");
        }
      }

      // A no-access Appointment keeps its outcome; only a still-scheduled one
      // is retired as rescheduled (AC5).
      if (previous.status === "scheduled") {
        await tx
          .update(appointments)
          .set({ status: "rescheduled", updatedAt: new Date().toISOString() })
          .where(eq(appointments.id, previous.id));
      }

      // The reason lands on the new row, not the retired one. The audit trail
      // emits one event per Appointment row timestamped createdAt, and this
      // row's createdAt *is* the moment of the Reschedule; on the retired row
      // the same text would render at that Appointment's original booking
      // time, chronologically ahead of the event it explains.
      const [appointment] = await tx
        .insert(appointments)
        .values({
          caseId: previous.caseId,
          assignmentId: previous.assignmentId,
          attemptId: previous.attemptId,
          contractorId: previous.contractorId,
          operationId: appointmentOperationId,
          slotClaimId: claim.id,
          startTime: input.startTime,
          endTime: input.endTime,
          status: "scheduled",
          reason: input.reason ?? null,
        })
        .returning();
      if (!appointment)
        throw new Error("Appointment insert did not return a row");

      return {
        outcome: "REPLACED" as const,
        appointment: appointmentDto(appointment),
      };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23P01") return { outcome: "CONFLICT" as const };
    // The Attempt already owns a live Appointment, so this one was superseded
    // by a replacement the caller had not seen. Matched by constraint name so
    // an operation-id collision — a different 23505 entirely — still surfaces.
    if (
      pgErrorCode(error) === "23505" &&
      pgConstraintName(error) === "appointments_one_live_per_attempt"
    ) {
      return { outcome: "NOT_REPLACEABLE" as const };
    }
    throw error;
  }
}
