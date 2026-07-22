import type { CreateCaseActivityInput } from "@townops/orchestration-contract";
import { eq } from "drizzle-orm";

import db from "./database/db";
import { caseHistory, caseOperations, cases } from "./database/schema";

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
export async function createCase(values: any) {
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
        priority: input.input.priority.toLowerCase() as
          | "low"
          | "medium"
          | "high"
          | "emergency",
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
export async function updateCaseStatus(id: string, status: any) {
  const [updated] = await db
    .update(cases)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(cases.id, id))
    .returning();
  return updated;
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
    const [insertedOperation] = await tx
      .insert(caseOperations)
      .values({ operationId: input.operationId, caseId: input.caseId })
      .onConflictDoNothing()
      .returning();

    if (!insertedOperation) {
      const [existingCase] = await tx
        .select()
        .from(cases)
        .where(eq(cases.id, input.caseId));
      if (!existingCase) {
        throw new Error(
          "Case was not found for an existing assignment operation"
        );
      }
      return existingCase;
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

    return updatedCase;
  });
}
