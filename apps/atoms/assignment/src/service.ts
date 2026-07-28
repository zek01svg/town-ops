import type {
  CancelAssignmentInput,
  AcceptAllocationAttemptInput,
  BreachAllocationAttemptInput,
  CompleteAssignmentInput,
  CommitAllocationInput,
  MarkAssignmentInProgressInput,
} from "@townops/orchestration-contract";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import db from "./database/db";
import {
  allocationAttempts,
  allocationEpoch,
  assignments,
  assignmentStatusHistory,
} from "./database/schema";

type AssignmentStatus = (typeof assignments.$inferSelect)["status"];

function publicAssignment(assignment: typeof assignments.$inferSelect) {
  const { completionOperationId: _, ...result } = assignment;
  return result;
}

/**
 * Create a new assignment.
 */
export async function createAssignment(
  values: typeof assignments.$inferInsert
) {
  const [assignment] = await db.insert(assignments).values(values).returning();
  if (!assignment) throw new Error("Assignment insert did not return a row");
  return publicAssignment(assignment);
}

/**
 * Get all assignments for a contractor.
 */
export async function getAssignmentsByContractorId(contractorId: string) {
  const assignmentsForContractor = await db.query.assignments.findMany({
    where: eq(assignments.contractorId, contractorId),
  });
  return assignmentsForContractor.map(publicAssignment);
}

/**
 * Find the first assignment matching the given Case ID.
 */
export async function getAssignmentByCaseId(caseId: string) {
  const assignment = await db.query.assignments.findFirst({
    where: eq(assignments.caseId, caseId),
  });
  if (!assignment) return undefined;
  return publicAssignment(assignment);
}

export async function getAssignmentCompletionOperation(assignmentId: string) {
  const [assignment] = await db
    .select({ completionOperationId: assignments.completionOperationId })
    .from(assignments)
    .where(eq(assignments.id, assignmentId));
  return assignment ?? null;
}

/**
 * Get full status history for an assignment.
 */
export async function getStatusHistoryByAssignmentId(assignmentId: string) {
  return db.query.assignmentStatusHistory.findMany({
    where: eq(assignmentStatusHistory.assignmentId, assignmentId),
    orderBy: (t, { asc }) => [asc(t.changedAt)],
  });
}

/**
 * Update assignment status and record status history within a transaction.
 */
export async function updateAssignmentStatus(
  id: string,
  status: AssignmentStatus,
  changedBy: string,
  reason?: string
) {
  return db.transaction(async (tx) => {
    // 1. Get current status for history
    const current = await tx.query.assignments.findFirst({
      where: eq(assignments.id, id),
      columns: { status: true },
    });

    if (!current) {
      return null;
    }

    // 2. Update assignment status
    const [updated] = await tx
      .update(assignments)
      .set({
        status,
        updatedAt: new Date().toISOString(),
        ...(status === "ACCEPTED"
          ? { acceptedAt: new Date().toISOString() }
          : {}),
      })
      .where(eq(assignments.id, id))
      .returning();

    // 3. Record status history
    await tx.insert(assignmentStatusHistory).values({
      assignmentId: id,
      fromStatus: current.status,
      toStatus: status,
      changedBy,
      reason,
    });

    return updated ? publicAssignment(updated) : updated;
  });
}

/**
 * Reassign an existing assignment to a new contractor and reset SLA window.
 */
export async function reassignAssignment(
  id: string,
  contractorId: string,
  responseDueAt: string,
  changedBy: string,
  reason?: string
) {
  return db.transaction(async (tx) => {
    const current = await tx.query.assignments.findFirst({
      where: eq(assignments.id, id),
      columns: { status: true },
    });

    if (!current) {
      return null;
    }

    const now = new Date().toISOString();

    const [updated] = await tx
      .update(assignments)
      .set({
        contractorId,
        status: "PENDING_ACCEPTANCE",
        source: "BREACH_REASSIGN",
        responseDueAt,
        assignedAt: now,
        acceptedAt: null,
        updatedAt: now,
      })
      .where(eq(assignments.id, id))
      .returning();

    await tx.insert(assignmentStatusHistory).values({
      assignmentId: id,
      fromStatus: current.status,
      toStatus: "PENDING_ACCEPTANCE",
      changedBy,
      reason,
    });

    return updated ? publicAssignment(updated) : updated;
  });
}

/**
 * Find the stable Assignment plus its current pending Attempt for a Case,
 * for the Gateway's public read (AC7). Returns null when no Assignment
 * exists yet for the Case (e.g. it is still PENDING).
 */
export async function getAssignmentWithCurrentAttempt(caseId: string) {
  const [assignment] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.caseId, caseId));
  if (!assignment) return null;

  const [currentAttempt] = await db
    .select()
    .from(allocationAttempts)
    .where(
      and(
        eq(allocationAttempts.assignmentId, assignment.id),
        inArray(allocationAttempts.status, ["PENDING_ACCEPTANCE", "ACCEPTED"])
      )
    )
    .orderBy(desc(allocationAttempts.createdAt))
    .limit(1);

  return {
    assignment: publicAssignment(assignment),
    currentAttempt: currentAttempt ?? null,
  };
}

/**
 * Accept exactly the pending Attempt named by a Contractor. Locking both rows
 * makes a concurrent second acceptance observe the committed state instead of
 * accepting a stale offer.
 */
export async function acceptAllocationAttempt(
  input: AcceptAllocationAttemptInput
) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(allocationAttempts)
      .where(eq(allocationAttempts.id, input.attemptId))
      .for("update");
    if (!attempt) return { outcome: "CASE_MISMATCH" as const };

    const [assignment] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.id, attempt.assignmentId))
      .for("update");
    if (
      !assignment ||
      assignment.caseId !== input.caseId ||
      attempt.assignmentId !== input.assignmentId
    ) {
      return { outcome: "CASE_MISMATCH" as const };
    }

    if (
      attempt.status === "ACCEPTED" &&
      attempt.acceptanceOperationId === input.operationId
    ) {
      return { outcome: "ALREADY_ACCEPTED" as const, assignment, attempt };
    }
    if (assignment.status !== "PENDING_ACCEPTANCE") {
      return { outcome: "ASSIGNMENT_NOT_PENDING" as const };
    }
    if (attempt.status !== "PENDING_ACCEPTANCE") {
      return { outcome: "ATTEMPT_NOT_PENDING" as const };
    }
    if (attempt.contractorId !== input.contractorId) {
      return { outcome: "ATTEMPT_NOT_OWNED" as const };
    }

    const now = new Date().toISOString();
    const [acceptedAttempt] = await tx
      .update(allocationAttempts)
      .set({ status: "ACCEPTED", acceptanceOperationId: input.operationId })
      .where(eq(allocationAttempts.id, attempt.id))
      .returning();
    const [acceptedAssignment] = await tx
      .update(assignments)
      .set({ status: "ACCEPTED", acceptedAt: now, updatedAt: now })
      .where(eq(assignments.id, assignment.id))
      .returning();
    if (!acceptedAttempt || !acceptedAssignment) {
      throw new Error("Allocation acceptance update did not return a row");
    }

    await tx.insert(assignmentStatusHistory).values({
      assignmentId: assignment.id,
      fromStatus: assignment.status,
      toStatus: "ACCEPTED",
      changedBy: input.contractorId,
      reason: "ALLOCATION_ATTEMPT_ACCEPTED",
    });

    return {
      outcome: "ACCEPTED" as const,
      assignment: acceptedAssignment,
      attempt: acceptedAttempt,
    };
  });
}

/**
 * Breach one Attempt (PRS-144). Idempotent by the Attempt's own status, not
 * by operationId — `BREACHED` and `ALREADY_BREACHED` are both "the caller
 * must still apply the -10 penalty and the replacement", so a replay or a
 * duplicate timer delivery is safe to call this again. Only `ACCEPTED` and
 * `WITHDRAWN` mean the offer is no longer live and the caller must abort.
 *
 * The Assignment is only reset to BREACHED here if it is still
 * PENDING_ACCEPTANCE — a concurrent manual override could already have moved
 * it elsewhere, and this must not clobber that.
 */
export async function breachAllocationAttempt(
  input: BreachAllocationAttemptInput
) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(allocationAttempts)
      .where(eq(allocationAttempts.id, input.attemptId))
      .for("update");
    if (!attempt || attempt.assignmentId !== input.assignmentId) {
      throw new Error("Allocation attempt was not found to breach");
    }

    if (attempt.status === "ACCEPTED") {
      return { outcome: "ACCEPTED" as const };
    }
    if (attempt.status === "WITHDRAWN") {
      return { outcome: "WITHDRAWN" as const };
    }
    if (attempt.status === "BREACHED") {
      return { outcome: "ALREADY_BREACHED" as const };
    }

    await tx
      .update(allocationAttempts)
      .set({ status: "BREACHED" })
      .where(eq(allocationAttempts.id, attempt.id));

    const [assignment] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.id, attempt.assignmentId))
      .for("update");
    if (assignment && assignment.status === "PENDING_ACCEPTANCE") {
      await tx
        .update(assignments)
        .set({ status: "BREACHED", updatedAt: new Date().toISOString() })
        .where(eq(assignments.id, assignment.id));
      await tx.insert(assignmentStatusHistory).values({
        assignmentId: assignment.id,
        fromStatus: assignment.status,
        toStatus: "BREACHED",
        changedBy: input.actorId,
        reason: "ACCEPTANCE_SLA_BREACH",
      });
    }

    return { outcome: "BREACHED" as const };
  });
}

/**
 * Start-work Saga step 2 (PRS-145): ACCEPTED -> IN_PROGRESS. Idempotent by
 * the Assignment's own status, not by operationId — same pattern as
 * `breachAllocationAttempt` (PRS-144). `IN_PROGRESS` already means the
 * caller must still proceed to the Case write; only a status other than
 * ACCEPTED/IN_PROGRESS means the offer is not in a state work can start from.
 */
export async function markAssignmentInProgress(
  input: MarkAssignmentInProgressInput
) {
  return db.transaction(async (tx) => {
    const [assignment] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.id, input.assignmentId))
      .for("update");
    if (!assignment) return { outcome: "ASSIGNMENT_NOT_FOUND" as const };

    if (assignment.status === "IN_PROGRESS") {
      return { outcome: "ALREADY_IN_PROGRESS" as const, assignment };
    }
    if (assignment.status !== "ACCEPTED") {
      return { outcome: "NOT_ACCEPTED" as const };
    }

    const [updated] = await tx
      .update(assignments)
      .set({ status: "IN_PROGRESS", updatedAt: new Date().toISOString() })
      .where(eq(assignments.id, assignment.id))
      .returning();
    if (!updated) throw new Error("Assignment update did not return a row");

    await tx.insert(assignmentStatusHistory).values({
      assignmentId: assignment.id,
      fromStatus: "ACCEPTED",
      toStatus: "IN_PROGRESS",
      changedBy: input.changedBy,
      reason: "WORK_STARTED",
    });

    return { outcome: "IN_PROGRESS" as const, assignment: updated };
  });
}

/** Completion is status-idempotent and records one terminal history row. */
export async function completeAssignment(input: CompleteAssignmentInput) {
  return db.transaction(async (tx) => {
    const [assignment] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.id, input.assignmentId))
      .for("update");
    if (!assignment) return { outcome: "ASSIGNMENT_NOT_FOUND" as const };
    if (assignment.status === "COMPLETED") {
      if (assignment.completionOperationId !== input.operationId) {
        return { outcome: "COMPLETION_OPERATION_CONFLICT" as const };
      }
      return { outcome: "ALREADY_COMPLETED" as const, assignment };
    }
    if (assignment.status !== "IN_PROGRESS") {
      return { outcome: "NOT_IN_PROGRESS" as const };
    }
    const [updated] = await tx
      .update(assignments)
      .set({
        status: "COMPLETED",
        completionOperationId: input.operationId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(assignments.id, assignment.id))
      .returning();
    if (!updated)
      throw new Error("Assignment completion update did not return a row");
    await tx.insert(assignmentStatusHistory).values({
      assignmentId: assignment.id,
      fromStatus: "IN_PROGRESS",
      toStatus: "COMPLETED",
      changedBy: input.changedBy,
      reason: "ASSIGNMENT_COMPLETED",
    });
    return { outcome: "COMPLETED" as const, assignment: updated };
  });
}

/**
 * Cancels the Case's stable pre-work Assignment. A pending offer is withdrawn
 * before the Assignment goes terminal; accepted and breached Assignments are
 * cancelled without touching contractor performance.
 */
export async function cancelAssignmentForCase(input: CancelAssignmentInput) {
  return db.transaction(async (tx) => {
    const [assignment] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.caseId, input.caseId))
      .for("update");
    if (!assignment) return { outcome: "NO_ASSIGNMENT" as const };
    if (assignment.status === "CANCELLED") {
      return { outcome: "ALREADY_CANCELLED" as const };
    }
    if (assignment.status === "IN_PROGRESS") {
      return { outcome: "IN_PROGRESS" as const };
    }
    if (assignment.status === "COMPLETED") {
      return { outcome: "NOT_CANCELLABLE" as const };
    }

    await tx
      .update(allocationAttempts)
      .set({ status: "WITHDRAWN" })
      .where(
        and(
          eq(allocationAttempts.assignmentId, assignment.id),
          eq(allocationAttempts.status, "PENDING_ACCEPTANCE")
        )
      );
    const [cancelled] = await tx
      .update(assignments)
      .set({ status: "CANCELLED", updatedAt: new Date().toISOString() })
      .where(eq(assignments.id, assignment.id))
      .returning();
    if (!cancelled)
      throw new Error("Assignment cancellation update did not return a row");

    await tx.insert(assignmentStatusHistory).values({
      assignmentId: assignment.id,
      fromStatus: assignment.status,
      toStatus: "CANCELLED",
      changedBy: input.changedBy,
      reason: input.reason,
    });
    return { outcome: "CANCELLED" as const };
  });
}

/**
 * Global allocation snapshot: the fencing epoch plus the number of active
 * (PENDING_ACCEPTANCE or ACCEPTED) Allocation Attempts per Contractor.
 * Ranked candidate selection happens in the Workflow, not here — this is
 * I/O only.
 */
export async function getAllocationSnapshot() {
  await db
    .insert(allocationEpoch)
    .values({ id: 1, epoch: 0 })
    .onConflictDoNothing();
  const [epoch] = await db
    .select()
    .from(allocationEpoch)
    .where(eq(allocationEpoch.id, 1));
  if (!epoch) throw new Error("Allocation epoch row could not be created");

  const activeAssignmentCounts = await db
    .select({
      contractorId: allocationAttempts.contractorId,
      activeCount: sql<number>`count(*)::int`,
    })
    .from(allocationAttempts)
    .where(
      inArray(allocationAttempts.status, ["PENDING_ACCEPTANCE", "ACCEPTED"])
    )
    .groupBy(allocationAttempts.contractorId);

  return { epoch: epoch.epoch, activeAssignmentCounts };
}

/**
 * Commits one allocation Attempt for a Case, in a single transaction:
 * dedupe on operationId, fence on the global epoch (row-locked), upsert the
 * Case's stable Assignment, guard against a concurrent active Attempt, then
 * insert the Attempt and bump the epoch. Automatic and manual allocation
 * both pass through this same guard (see ACTIVE_ATTEMPT_EXISTS below).
 */
export async function commitAllocationAttempt(input: CommitAllocationInput) {
  return db.transaction(async (tx) => {
    await tx
      .insert(allocationEpoch)
      .values({ id: 1, epoch: 0 })
      .onConflictDoNothing();
    const [epochRow] = await tx
      .select()
      .from(allocationEpoch)
      .where(eq(allocationEpoch.id, 1))
      .for("update");
    if (!epochRow) {
      throw new Error("Allocation epoch row could not be created");
    }

    // Check the operation claim after taking the epoch lock. A concurrent
    // retry now observes the committed Attempt instead of losing the epoch
    // race and reporting STALE_EPOCH.
    const [existingAttempt] = await tx
      .select()
      .from(allocationAttempts)
      .where(eq(allocationAttempts.operationId, input.operationId));

    if (existingAttempt) {
      const [assignment] = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.id, existingAttempt.assignmentId));
      if (!assignment) {
        throw new Error(
          "Assignment was not found for an existing allocation attempt"
        );
      }
      return {
        outcome: "ALREADY_COMMITTED" as const,
        attempt: existingAttempt,
        assignment,
      };
    }

    if (epochRow.epoch !== input.expectedEpoch) {
      return { outcome: "STALE_EPOCH" as const, epoch: epochRow.epoch };
    }

    let [assignment] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.caseId, input.caseId));

    // AC6: an Officer reassigning to a Contractor who already breached on
    // this same Assignment must say why — in either the replace or the
    // non-replace path, since a manual command can reuse a breached
    // Contractor either way.
    if (input.source === "MANUAL_ASSIGN" && !input.reason && assignment) {
      const [priorBreach] = await tx
        .select()
        .from(allocationAttempts)
        .where(
          and(
            eq(allocationAttempts.assignmentId, assignment.id),
            eq(allocationAttempts.contractorId, input.contractorId),
            eq(allocationAttempts.status, "BREACHED")
          )
        )
        .limit(1);
      if (priorBreach) {
        return { outcome: "OVERRIDE_REASON_REQUIRED" as const };
      }
    }

    if (input.replaceAttemptId) {
      if (!assignment) {
        return { outcome: "REPLACEMENT_ATTEMPT_NOT_PENDING" as const };
      }

      const [pendingAttempt] = await tx
        .select()
        .from(allocationAttempts)
        .where(
          and(
            eq(allocationAttempts.id, input.replaceAttemptId),
            eq(allocationAttempts.assignmentId, assignment.id),
            eq(allocationAttempts.status, "PENDING_ACCEPTANCE")
          )
        );
      if (!pendingAttempt) {
        return { outcome: "REPLACEMENT_ATTEMPT_NOT_PENDING" as const };
      }

      await tx
        .update(allocationAttempts)
        .set({ status: "WITHDRAWN" })
        .where(eq(allocationAttempts.id, pendingAttempt.id));
    } else {
      await tx
        .insert(assignments)
        .values({ caseId: input.caseId })
        .onConflictDoNothing();
      [assignment] = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.caseId, input.caseId));
      if (!assignment) {
        throw new Error("Assignment could not be created for the Case");
      }

      const [activeAttempt] = await tx
        .select()
        .from(allocationAttempts)
        .where(
          and(
            eq(allocationAttempts.assignmentId, assignment.id),
            eq(allocationAttempts.status, "PENDING_ACCEPTANCE")
          )
        );
      if (activeAttempt) {
        return {
          outcome: "ACTIVE_ATTEMPT_EXISTS" as const,
          attempt: activeAttempt,
        };
      }

      // A replacement Attempt after a breach (PRS-144) reuses this same
      // stable Assignment. Reopen it here as part of committing the new
      // Attempt, or the replacement's own acceptance would hit
      // ASSIGNMENT_NOT_PENDING. Guarded to BREACHED only — never clobber
      // ACCEPTED/COMPLETED/CANCELLED.
      if (assignment.status === "BREACHED") {
        const [reopened] = await tx
          .update(assignments)
          .set({
            status: "PENDING_ACCEPTANCE",
            updatedAt: new Date().toISOString(),
          })
          .where(eq(assignments.id, assignment.id))
          .returning();
        if (!reopened) {
          throw new Error("Assignment could not be reopened after a breach");
        }
        assignment = reopened;
        await tx.insert(assignmentStatusHistory).values({
          assignmentId: assignment.id,
          fromStatus: "BREACHED",
          toStatus: "PENDING_ACCEPTANCE",
          changedBy: input.actorId,
          reason: "ACCEPTANCE_SLA_BREACH_REASSIGN",
        });
      }
    }

    const deadlineAt = new Date(
      Date.now() + input.acceptanceSlaMs
    ).toISOString();
    const [attempt] = await tx
      .insert(allocationAttempts)
      .values({
        assignmentId: assignment.id,
        contractorId: input.contractorId,
        source: input.source,
        acceptanceSlaMs: input.acceptanceSlaMs,
        deadlineAt,
        actorId: input.actorId,
        actorRole: input.actorRole,
        reason: input.reason,
        operationId: input.operationId,
      })
      .returning();
    if (!attempt) {
      throw new Error("Allocation attempt insert did not return a row");
    }

    const [updatedEpoch] = await tx
      .update(allocationEpoch)
      .set({ epoch: epochRow.epoch + 1, updatedAt: new Date().toISOString() })
      .where(eq(allocationEpoch.id, 1))
      .returning();
    if (!updatedEpoch) {
      throw new Error("Allocation epoch row could not be updated");
    }

    return {
      outcome: "COMMITTED" as const,
      attempt,
      assignment,
      epoch: updatedEpoch.epoch,
    };
  });
}
