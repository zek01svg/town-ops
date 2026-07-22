import type { CreateCaseActivityInput } from "@townops/orchestration-contract";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import db from "./database/db";
import {
  caseHistory,
  caseOperations,
  cases,
  officerAttention,
} from "./database/schema";

type OfficerAttentionKind = "NO_ELIGIBLE_CONTRACTOR" | "ALLOCATION_FAILED";

const allocationAttentionKinds: OfficerAttentionKind[] = [
  "NO_ELIGIBLE_CONTRACTOR",
  "ALLOCATION_FAILED",
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
            inArray(officerAttention.kind, allocationAttentionKinds),
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
}) {
  return db.transaction(async (tx) => {
    const openAttention = () =>
      tx
        .select()
        .from(officerAttention)
        .where(
          and(
            eq(officerAttention.caseId, input.caseId),
            eq(officerAttention.kind, input.kind),
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
