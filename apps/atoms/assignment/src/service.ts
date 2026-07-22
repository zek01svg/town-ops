import type {
  AcceptAllocationAttemptInput,
  CommitAllocationInput,
} from "@townops/orchestration-contract";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import db from "./database/db";
import {
  allocationAttempts,
  allocationEpoch,
  assignments,
  assignmentStatusHistory,
} from "./database/schema";

/**
 * Create a new assignment.
 */
export async function createAssignment(values: any) {
  const [assignment] = await db.insert(assignments).values(values).returning();
  if (!assignment) throw new Error("Assignment insert did not return a row");
  return assignment;
}

/**
 * Get all assignments for a contractor.
 */
export async function getAssignmentsByContractorId(contractorId: string) {
  return db.query.assignments.findMany({
    where: eq(assignments.contractorId, contractorId),
  });
}

/**
 * Find the first assignment matching the given Case ID.
 */
export async function getAssignmentByCaseId(caseId: string) {
  return db.query.assignments.findFirst({
    where: eq(assignments.caseId, caseId),
  });
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
  status: any,
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
      fromStatus: current.status as any,
      toStatus: status,
      changedBy,
      reason,
    });

    return updated;
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
      fromStatus: current.status as any,
      toStatus: "PENDING_ACCEPTANCE",
      changedBy,
      reason,
    });

    return updated;
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

  return { assignment, currentAttempt: currentAttempt ?? null };
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
