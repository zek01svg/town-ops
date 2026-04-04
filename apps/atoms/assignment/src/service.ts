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
 * Find the first assignment matching the given Case ID.
 */
export async function getAssignmentByCaseId(caseId: string) {
  return db.query.assignments.findFirst({
    where: eq(assignments.caseId, caseId),
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
