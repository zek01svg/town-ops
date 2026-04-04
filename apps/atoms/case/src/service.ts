import { eq } from "drizzle-orm";

import db from "./database/db";
import { cases } from "./database/schema";

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
  return newCase;
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
