import { eq } from "drizzle-orm";

import db from "./database/db";
import { assignments, assignmentStatusHistory } from "./database/schema";

/**
 * Create a new assignment.
 */
export async function createAssignment(values: any) {
  const [assignment] = await db.insert(assignments).values(values).returning();
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
