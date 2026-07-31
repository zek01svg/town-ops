import type { ProvisionResidentInput } from "@townops/orchestration-contract";
import { eq } from "drizzle-orm";

import db from "./database/db";
import { profiles } from "./database/schema";

/**
 * Get resident by ID.
 */
export async function getResidentById(id: string) {
  return db.select().from(profiles).where(eq(profiles.id, id));
}

export async function getResidentContact(id: string) {
  const [resident] = await db
    .select({
      id: profiles.id,
      email: profiles.email,
      fullName: profiles.fullName,
    })
    .from(profiles)
    .where(eq(profiles.id, id));
  return resident ?? null;
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
export async function createResident(values: typeof profiles.$inferInsert) {
  const [newResident] = await db.insert(profiles).values(values).returning();
  if (!newResident) throw new Error("Resident insert did not return a row");
  return newResident;
}

/**
 * Update an existing resident profile.
 */
export async function updateResident(
  id: string,
  values: Partial<typeof profiles.$inferInsert>
) {
  const [updated] = await db
    .update(profiles)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(profiles.id, id))
    .returning();
  return updated;
}

/**
 * Idempotent write for the Resident Provisioning workflow. The profile ID
 * always equals the Account ID, so a retried Activity converges on the same
 * row instead of creating a duplicate. The email unique constraint is also
 * absorbed by the conflict-do-nothing — if the insert is silently skipped
 * and no row owns the Account ID either, the email already belongs to a
 * different Account, and this returns null.
 */
export async function ensureResidentProfile(input: ProvisionResidentInput) {
  const [inserted] = await db
    .insert(profiles)
    .values({
      id: input.accountId,
      fullName: input.fullName,
      email: input.email,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, input.accountId));
  return existing ?? null;
}
