import { eq } from "drizzle-orm";

import db from "./database/db";
import { profiles } from "./database/schema";

/**
 * Get resident by ID.
 */
export async function getResidentById(id: string) {
  return db.select().from(profiles).where(eq(profiles.id, id));
}

/**
 * Search residents by postal code.
 */
export async function getResidentsByPostalCode(postalCode: string) {
  return db.select().from(profiles).where(eq(profiles.postalCode, postalCode));
}

/**
 * Create a new resident profile.
 */
export async function createResident(values: any) {
  const [newResident] = await db.insert(profiles).values(values).returning();
  return newResident;
}

/**
 * Update an existing resident profile.
 */
export async function updateResident(id: string, values: any) {
  const [updated] = await db
    .update(profiles)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(profiles.id, id))
    .returning();
  return updated;
}
