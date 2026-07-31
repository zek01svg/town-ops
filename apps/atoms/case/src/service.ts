import type {
  CancelCaseTransitionInput,
  CompleteCaseTransitionInput,
  CreateCaseActivityInput,
  MarkCaseAppointmentReplacedInput,
  MarkCaseBreachedInput,
  MarkCaseInProgressInput,
  MarkCaseNoAccessInput,
  RecordAllocationAcceptanceInput,
} from "@townops/orchestration-contract";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import db from "./database/db";
import {
  caseHistory,
  caseOperations,
  cases,
  officerAttention,
} from "./database/schema";

type CaseStatus = (typeof cases.$inferSelect)["status"];

// The contract carries the priority uppercase; the column stores it lowercase.
// A lookup keeps the mapping total and checked, rather than asserting the
// result of toLowerCase() back into the column's union.
const casePriorityByLevel = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  EMERGENCY: "emergency",
} as const satisfies Record<
  CreateCaseActivityInput["input"]["priority"],
  (typeof cases.$inferSelect)["priority"]
>;

type OfficerAttentionKind =
  | "NO_ELIGIBLE_CONTRACTOR"
  | "ALLOCATION_FAILED"
  | "ACCEPTANCE_SLA_BREACH"
  | "WORK_START_FAILED"
  | "MISSED_APPOINTMENT"
  | "COMPLETION_FAILED"
  | "DERIVED_EFFECT_UNKNOWN";

const allocationAttentionKinds: OfficerAttentionKind[] = [
  "NO_ELIGIBLE_CONTRACTOR",
  "ALLOCATION_FAILED",
];

// A Case going terminal (completed/cancelled) resolves every kind of
// operational attention, including a still-open acceptance SLA breach or
// work-start failure — unlike allocationAttentionKinds above, which
// markCaseAssignedForOperation resolves and which must NOT include
// ACCEPTANCE_SLA_BREACH (a replacement merely being assigned is not the
// replacement being accepted, AC8) or WORK_START_FAILED (an assign must not
// clear a work-start failure, PRS-145).
const terminalResolvedAttentionKinds: OfficerAttentionKind[] = [
  ...allocationAttentionKinds,
  "ACCEPTANCE_SLA_BREACH",
  "WORK_START_FAILED",
  "MISSED_APPOINTMENT",
  "COMPLETION_FAILED",
];

/**
 * Retrieve all cases.
 */
export async function getAllCases() {
  return db.select().from(cases);
}

/**
 * Get a case by its ID.
 */
export async function getCaseById(id: string) {
  return db.select().from(cases).where(eq(cases.id, id));
}

/**
 * Create a new case.
 */
export async function createCase(values: typeof cases.$inferInsert) {
  const [newCase] = await db.insert(cases).values(values).returning();
  if (!newCase) throw new Error("Case insert did not return a row");
  return newCase;
}

/**
 * Create a Case once for a durable workflow operation.
 */
export async function createCaseForOperation(input: CreateCaseActivityInput) {
  return db.transaction(async (tx) => {
    const [insertedOperation] = await tx
      .insert(caseOperations)
      .values({ operationId: input.operationId, caseId: input.caseId })
      .onConflictDoNothing()
      .returning();

    if (!insertedOperation) {
      const [operation] = await tx
        .select()
        .from(caseOperations)
        .where(eq(caseOperations.operationId, input.operationId));
      if (!operation) {
        throw new Error(
          "Case operation was not found after an idempotency conflict"
        );
      }
      const [existingCase] = await tx
        .select()
        .from(cases)
        .where(eq(cases.id, operation.caseId));
      if (!existingCase) {
        throw new Error("Case was not found for an existing opening operation");
      }

      return existingCase;
    }

    const [newCase] = await tx
      .insert(cases)
      .values({
        id: input.caseId,
        residentId: input.input.residentId,
        category: input.input.category,
        priority: casePriorityByLevel[input.input.priority],
        description: input.input.description,
        addressDetails: input.input.addressDetails,
        postalCode: input.input.postalCode,
      })
      .returning();

    if (!newCase) throw new Error("Case insert did not return a row");

    await tx.insert(caseHistory).values({
      caseId: newCase.id,
      eventType: "CASE_OPENED",
      actorId: input.actorId,
      actorRole: input.actorRole,
      operationId: input.operationId,
    });

    return newCase;
  });
}

/**
 * Update case status.
 */
export async function updateCaseStatus(id: string, status: CaseStatus) {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const [updated] = await tx
      .update(cases)
      .set({ status, updatedAt: now })
      .where(eq(cases.id, id))
      .returning();

    if (updated && (status === "completed" || status === "cancelled")) {
      await tx
        .update(officerAttention)
        .set({ resolvedAt: now })
        .where(
          and(
            eq(officerAttention.caseId, id),
            inArray(officerAttention.kind, terminalResolvedAttentionKinds),
            isNull(officerAttention.resolvedAt)
          )
        );
    }

    return updated;
  });
}

/**
 * Stores one unresolved operational exception for a Case. Repeated Workflow
 * retries intentionally return the first still-open record instead of
 * creating attention noise for Officers.
 */
export async function raiseOfficerAttention(input: {
  caseId: string;
  kind: OfficerAttentionKind;
  detail: string;
  operationId: string;
  effectId?: string;
}) {
  // Enforced here, not left to the caller: every route (the generic
  // /officer-attention endpoint and /derived-effect-attention) funnels
  // through this one function, so this is the single choke point where the
  // invariant can be made real. A discriminated input type would push this
  // ripple into /officer-attention's shared six-kind schema, whose effectId
  // is validated as optional regardless of kind — an explicit throw here is
  // the smaller, still-correct fix: without it, a DERIVED_EFFECT_UNKNOWN
  // call missing effectId would reach `eq(effectId, undefined)` and either
  // insert a duplicate open attention or trip the effectId-scoped partial
  // unique index with a confusing DB error instead of this one.
  function requireEffectId(): string {
    if (!input.effectId) {
      throw new Error(
        "raiseOfficerAttention requires effectId for DERIVED_EFFECT_UNKNOWN"
      );
    }
    return input.effectId;
  }

  return db.transaction(async (tx) => {
    const openAttention = () =>
      tx
        .select()
        .from(officerAttention)
        .where(
          and(
            eq(officerAttention.caseId, input.caseId),
            eq(officerAttention.kind, input.kind),
            input.kind === "DERIVED_EFFECT_UNKNOWN"
              ? eq(officerAttention.effectId, requireEffectId())
              : undefined,
            isNull(officerAttention.resolvedAt)
          )
        )
        .limit(1);

    const [existing] = await openAttention();
    if (existing) return existing;

    const [created] = await tx
      .insert(officerAttention)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [concurrent] = await openAttention();
    if (!concurrent) {
      throw new Error("Officer Attention was not found after an insert race");
    }
    return concurrent;
  });
}

export async function resolveDerivedEffectAttention(input: {
  caseId: string;
  effectId: string;
  operationId: string;
}) {
  await db
    .update(officerAttention)
    .set({
      resolvedAt: new Date().toISOString(),
      resolvedByOperationId: input.operationId,
    })
    .where(
      and(
        eq(officerAttention.caseId, input.caseId),
        eq(officerAttention.kind, "DERIVED_EFFECT_UNKNOWN"),
        eq(officerAttention.effectId, input.effectId),
        isNull(officerAttention.resolvedAt)
      )
    );
}

export async function listOfficerAttention(input: {
  state: "open" | "resolved";
  page: number;
  pageSize: number;
}) {
  return db
    .select()
    .from(officerAttention)
    .where(
      input.state === "open"
        ? isNull(officerAttention.resolvedAt)
        : isNotNull(officerAttention.resolvedAt)
    )
    .orderBy(desc(officerAttention.createdAt))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);
}

/**
 * Idempotent write for automatic Contractor allocation (PRS-139): marks a
 * Case assigned and appends a CASE_ASSIGNED history row, once per
 * operationId. Same idempotency pattern as createCaseForOperation — insert
 * the operation claim first, and return the existing Case unchanged when
 * the claim already exists.
 */
export async function markCaseAssignedForOperation(input: {
  caseId: string;
  operationId: string;
  actorId: string;
  actorRole: string;
}) {
  return db.transaction(async (tx) => {
    const [currentCase] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .for("update");
    if (!currentCase) {
      throw new Error("Case was not found to mark as assigned");
    }
    if (
      currentCase.status === "completed" ||
      currentCase.status === "cancelled"
    ) {
      return { outcome: "CASE_TERMINAL" as const };
    }

    const [insertedOperation] = await tx
      .insert(caseOperations)
      .values({ operationId: input.operationId, caseId: input.caseId })
      .onConflictDoNothing()
      .returning();

    if (!insertedOperation) {
      return { outcome: "ASSIGNED" as const };
    }

    const [updatedCase] = await tx
      .update(cases)
      .set({ status: "assigned", updatedAt: new Date().toISOString() })
      .where(eq(cases.id, input.caseId))
      .returning();
    if (!updatedCase) {
      throw new Error("Case was not found to mark as assigned");
    }

    await tx.insert(caseHistory).values({
      caseId: input.caseId,
      eventType: "CASE_ASSIGNED",
      actorId: input.actorId,
      actorRole: input.actorRole,
      operationId: input.operationId,
    });

    await tx
      .update(officerAttention)
      .set({
        resolvedAt: new Date().toISOString(),
        resolvedByOperationId: input.operationId,
      })
      .where(
        and(
          eq(officerAttention.caseId, input.caseId),
          inArray(officerAttention.kind, allocationAttentionKinds),
          isNull(officerAttention.resolvedAt)
        )
      );

    return { outcome: "ASSIGNED" as const };
  });
}

/**
 * Start-work Saga step 3 (PRS-145): marks a Case in_progress and appends a
 * CASE_WORK_STARTED history row, once per operationId. Same claim-then-write
 * shape as markCaseAssignedForOperation — no guard beyond the terminal check,
 * since the Appointment/Assignment atoms are the source of truth for whether
 * starting work was actually valid (accepts a prior status of assigned or
 * pending). No attention resolution here — a work-start failure is only
 * cleared on completion/cancellation (terminalResolvedAttentionKinds), never
 * by an assign or a later start-work success.
 */
export async function markCaseInProgressForOperation(
  input: MarkCaseInProgressInput
) {
  return db.transaction(async (tx) => {
    const [currentCase] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .for("update");
    if (!currentCase) {
      throw new Error("Case was not found to mark in progress");
    }
    if (
      currentCase.status === "completed" ||
      currentCase.status === "cancelled"
    ) {
      return { outcome: "CASE_TERMINAL" as const };
    }

    const [insertedOperation] = await tx
      .insert(caseOperations)
      .values({ operationId: input.operationId, caseId: input.caseId })
      .onConflictDoNothing()
      .returning();

    if (!insertedOperation) {
      return { outcome: "IN_PROGRESS" as const, case: currentCase };
    }

    const [updatedCase] = await tx
      .update(cases)
      .set({ status: "in_progress", updatedAt: new Date().toISOString() })
      .where(eq(cases.id, input.caseId))
      .returning();
    if (!updatedCase) {
      throw new Error("Case was not found to mark in progress");
    }

    await tx.insert(caseHistory).values({
      caseId: input.caseId,
      eventType: "CASE_WORK_STARTED",
      actorId: input.actorId,
      actorRole: input.actorRole,
      operationId: input.operationId,
    });

    return { outcome: "IN_PROGRESS" as const, case: updatedCase };
  });
}

/**
 * Append the acceptance audit event once without changing the Case status,
 * and resolve any open acceptance SLA breach attention (AC8) — a replacement
 * Attempt getting accepted is what actually closes out a breach, not it
 * merely being assigned (see terminalResolvedAttentionKinds above).
 */
export async function recordAllocationAcceptance(
  input: RecordAllocationAcceptanceInput
) {
  return db.transaction(async (tx) => {
    const [caseRecord] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .for("update");
    if (!caseRecord) throw new Error("Case was not found to record acceptance");

    const [created] = await tx
      .insert(caseHistory)
      .values({ ...input, eventType: "ALLOCATION_ATTEMPT_ACCEPTED" })
      .onConflictDoNothing()
      .returning();
    if (created) {
      await tx
        .update(officerAttention)
        .set({
          resolvedAt: new Date().toISOString(),
          resolvedByOperationId: input.operationId,
        })
        .where(
          and(
            eq(officerAttention.caseId, input.caseId),
            eq(officerAttention.kind, "ACCEPTANCE_SLA_BREACH"),
            isNull(officerAttention.resolvedAt)
          )
        );
      return created;
    }

    const [existing] = await tx
      .select()
      .from(caseHistory)
      .where(eq(caseHistory.operationId, input.operationId));
    if (!existing) {
      throw new Error("Case acceptance history was not found after a conflict");
    }
    return existing;
  });
}

/**
 * Idempotent write for the Acceptance SLA breach sequence (PRS-144): returns
 * the Case to PENDING and raises the ACCEPTANCE_SLA_BREACH Officer Attention,
 * once per operationId. Same claim-then-write shape as
 * markCaseAssignedForOperation — the operationId already embeds the breached
 * attemptId (`${caseId}/breach/${attemptId}/pending`), so a replay or a
 * duplicate breach timer converges on this single write.
 */
export async function markCaseBreachedForOperation(
  input: MarkCaseBreachedInput
) {
  return db.transaction(async (tx) => {
    const [currentCase] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .for("update");
    if (!currentCase) {
      throw new Error("Case was not found to mark as breached");
    }
    if (
      currentCase.status === "completed" ||
      currentCase.status === "cancelled"
    ) {
      return { outcome: "CASE_TERMINAL" as const };
    }

    const [insertedOperation] = await tx
      .insert(caseOperations)
      .values({ operationId: input.operationId, caseId: input.caseId })
      .onConflictDoNothing()
      .returning();

    if (!insertedOperation) {
      return { outcome: "PENDING" as const };
    }

    const [updatedCase] = await tx
      .update(cases)
      .set({ status: "pending", updatedAt: new Date().toISOString() })
      .where(eq(cases.id, input.caseId))
      .returning();
    if (!updatedCase) {
      throw new Error("Case was not found to mark as breached");
    }

    await tx.insert(caseHistory).values({
      caseId: input.caseId,
      eventType: "CASE_ALLOCATION_BREACHED",
      actorId: input.actorId,
      actorRole: input.actorRole,
      operationId: input.operationId,
    });

    await tx
      .insert(officerAttention)
      .values({
        caseId: input.caseId,
        kind: "ACCEPTANCE_SLA_BREACH",
        detail: input.detail,
        operationId: input.operationId,
      })
      .onConflictDoNothing();

    return { outcome: "PENDING" as const };
  });
}

/**
 * No-access Saga step 2 (PRS-146): parks the Case on the Resident, who has to
 * arrange a new visit, and appends a CASE_NO_ACCESS history row once per
 * operationId. Same claim-then-write shape as markCaseInProgressForOperation
 * — the Appointment atom already ruled on whether the report was valid, so
 * the terminal check is the only guard this write owns. No Officer Attention:
 * a locked door is a routine outcome, not an operational exception.
 */
export async function markCaseNoAccessForOperation(
  input: MarkCaseNoAccessInput
) {
  return db.transaction(async (tx) => {
    const [currentCase] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .for("update");
    if (!currentCase) {
      throw new Error("Case was not found to mark as no access");
    }
    if (
      currentCase.status === "completed" ||
      currentCase.status === "cancelled"
    ) {
      return { outcome: "CASE_TERMINAL" as const };
    }

    const [insertedOperation] = await tx
      .insert(caseOperations)
      .values({ operationId: input.operationId, caseId: input.caseId })
      .onConflictDoNothing()
      .returning();

    if (!insertedOperation) {
      return { outcome: "PENDING_RESIDENT_INPUT" as const, case: currentCase };
    }

    const [updatedCase] = await tx
      .update(cases)
      .set({
        status: "pending_resident_input",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(cases.id, input.caseId))
      .returning();
    if (!updatedCase) {
      throw new Error("Case was not found to mark as no access");
    }

    await tx.insert(caseHistory).values({
      caseId: input.caseId,
      eventType: "CASE_NO_ACCESS",
      actorId: input.actorId,
      actorRole: input.actorRole,
      operationId: input.operationId,
    });

    return { outcome: "PENDING_RESIDENT_INPUT" as const, case: updatedCase };
  });
}

/**
 * Reschedule Saga step 2 (PRS-146): records the replacement Appointment once
 * per operationId. Only a Case parked on the Resident returns to `assigned` —
 * that is the recovery from No Access (AC7). A proactive reschedule of a Case
 * that is already assigned or in progress must leave the status alone: moving
 * the visit changes nothing about where the work stands.
 */
export async function markCaseAppointmentReplacedForOperation(
  input: MarkCaseAppointmentReplacedInput
) {
  return db.transaction(async (tx) => {
    const [currentCase] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .for("update");
    if (!currentCase) {
      throw new Error("Case was not found to record a replacement");
    }
    if (
      currentCase.status === "completed" ||
      currentCase.status === "cancelled"
    ) {
      return { outcome: "CASE_TERMINAL" as const };
    }

    const [insertedOperation] = await tx
      .insert(caseOperations)
      .values({ operationId: input.operationId, caseId: input.caseId })
      .onConflictDoNothing()
      .returning();

    let resultCase = currentCase;
    if (insertedOperation) {
      const [updatedCase] = await tx
        .update(cases)
        .set({
          status:
            currentCase.status === "pending_resident_input"
              ? "assigned"
              : currentCase.status,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(cases.id, input.caseId))
        .returning();
      if (!updatedCase) {
        throw new Error("Case was not found to record a replacement");
      }
      resultCase = updatedCase;

      await tx.insert(caseHistory).values({
        caseId: input.caseId,
        eventType: "CASE_APPOINTMENT_REPLACED",
        actorId: input.actorId,
        actorRole: input.actorRole,
        operationId: input.operationId,
      });
    }

    await tx
      .update(officerAttention)
      .set({
        resolvedAt: new Date().toISOString(),
        resolvedByOperationId: input.operationId,
      })
      .where(
        and(
          eq(officerAttention.caseId, input.caseId),
          eq(officerAttention.kind, "MISSED_APPOINTMENT"),
          isNull(officerAttention.resolvedAt)
        )
      );

    return { outcome: "REPLACED" as const, case: resultCase };
  });
}

/**
 * Completion Saga final step: only the active Case may become terminal. The
 * stored operation identity makes a retry reconstruct success while a second
 * terminal operation remains a conflict instead of silently changing report
 * or evidence selection.
 */
export async function completeCaseForOperation(
  input: CompleteCaseTransitionInput
) {
  return db.transaction(async (tx) => {
    const [currentCase] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .for("update");
    if (!currentCase) throw new Error("Case was not found to complete");

    if (currentCase.status === "completed") {
      if (currentCase.completionOperationId === input.operationId) {
        await tx
          .update(officerAttention)
          .set({
            resolvedAt: new Date().toISOString(),
            resolvedByOperationId: input.operationId,
          })
          .where(
            and(
              eq(officerAttention.caseId, input.caseId),
              eq(officerAttention.kind, "COMPLETION_FAILED"),
              isNull(officerAttention.resolvedAt)
            )
          );
        return { outcome: "ALREADY_COMPLETED" as const, case: currentCase };
      }
      return { outcome: "CASE_TERMINAL" as const };
    }
    if (currentCase.status === "cancelled") {
      return { outcome: "CASE_TERMINAL" as const };
    }
    if (currentCase.status !== "in_progress") {
      return { outcome: "NOT_IN_PROGRESS" as const };
    }

    const now = new Date().toISOString();
    const [completed] = await tx
      .update(cases)
      .set({
        status: "completed",
        completionOperationId: input.operationId,
        completionReport: input.report.trim(),
        completionProofItemIds: [...new Set(input.proofItemIds)].toSorted(),
        updatedAt: now,
      })
      .where(eq(cases.id, input.caseId))
      .returning();
    if (!completed)
      throw new Error("Case completion update did not return a row");

    await tx.insert(caseHistory).values({
      caseId: input.caseId,
      eventType: "CASE_COMPLETED",
      actorId: input.actorId,
      actorRole: input.actorRole,
      operationId: input.operationId,
    });
    await tx
      .update(officerAttention)
      .set({ resolvedAt: now, resolvedByOperationId: input.operationId })
      .where(
        and(
          eq(officerAttention.caseId, input.caseId),
          inArray(officerAttention.kind, terminalResolvedAttentionKinds),
          isNull(officerAttention.resolvedAt)
        )
      );

    return { outcome: "COMPLETED" as const, case: completed };
  });
}

/**
 * Cancellation is the final step of the PRS-148 forward-only Saga. The
 * Worker reaches this only after Appointment and Assignment have converged;
 * this row lock keeps a retry from appending a second terminal history row.
 */
export async function cancelCaseForOperation(input: CancelCaseTransitionInput) {
  return db.transaction(async (tx) => {
    const [currentCase] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .for("update");
    if (!currentCase) throw new Error("Case was not found to cancel");

    if (currentCase.status === "cancelled") {
      return { outcome: "ALREADY_CANCELLED" as const, case: currentCase };
    }
    if (
      currentCase.status === "completed" ||
      currentCase.status === "in_progress"
    ) {
      return { outcome: "NOT_CANCELLABLE" as const };
    }

    const [insertedOperation] = await tx
      .insert(caseOperations)
      .values({ operationId: input.operationId, caseId: input.caseId })
      .onConflictDoNothing()
      .returning();
    if (!insertedOperation) {
      throw new Error(
        "Case cancellation operation was not found after conflict"
      );
    }

    const now = new Date().toISOString();
    const [cancelled] = await tx
      .update(cases)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(cases.id, input.caseId))
      .returning();
    if (!cancelled)
      throw new Error("Case cancellation update did not return a row");

    await tx.insert(caseHistory).values({
      caseId: input.caseId,
      eventType: "CASE_CANCELLED",
      actorId: input.actorId,
      actorRole: input.actorRole,
      reason: input.reason,
      operationId: input.operationId,
    });
    await tx
      .update(officerAttention)
      .set({ resolvedAt: now, resolvedByOperationId: input.operationId })
      .where(
        and(
          eq(officerAttention.caseId, input.caseId),
          inArray(officerAttention.kind, terminalResolvedAttentionKinds),
          isNull(officerAttention.resolvedAt)
        )
      );

    return { outcome: "CANCELLED" as const, case: cancelled };
  });
}
