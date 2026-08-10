import { and, eq } from "drizzle-orm";

import db from "./database/db";
import {
  contractorCategories,
  contractorSectors,
  contractors,
} from "./database/schema";
import type { NewContractor } from "./database/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function withRelations(contractorId: string) {
  const [categories, sectors] = await Promise.all([
    db
      .select()
      .from(contractorCategories)
      .where(eq(contractorCategories.contractorId, contractorId)),
    db
      .select()
      .from(contractorSectors)
      .where(eq(contractorSectors.contractorId, contractorId)),
  ]);
  return { categories, sectors };
}

// ─── Contractors ──────────────────────────────────────────────────────────────

export async function getAllContractors() {
  const rows = await db.select().from(contractors);
  return Promise.all(
    rows.map(async (c) => ({ ...c, ...(await withRelations(c.id)) }))
  );
}

export async function getContractorById(id: string) {
  const [contractor] = await db
    .select()
    .from(contractors)
    .where(eq(contractors.id, id));
  if (!contractor) return null;
  return { ...contractor, ...(await withRelations(id)) };
}

export async function createContractor(values: NewContractor) {
  const [contractor] = await db.insert(contractors).values(values).returning();
  if (!contractor) throw new Error("Insert failed");
  return contractor;
}

export async function updateContractor(
  id: string,
  values: Partial<NewContractor>
) {
  const [contractor] = await db
    .update(contractors)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(contractors.id, id))
    .returning();
  return contractor ?? null;
}

export async function deactivateContractor(id: string) {
  const [contractor] = await db
    .update(contractors)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(eq(contractors.id, id))
    .returning();
  return contractor ?? null;
}

// ─── Categories ───────────────────────────────────────────────────────────────

export async function getCategoriesByContractor(contractorId: string) {
  return db
    .select()
    .from(contractorCategories)
    .where(eq(contractorCategories.contractorId, contractorId));
}

export async function addCategory(contractorId: string, categoryCode: string) {
  const [row] = await db
    .insert(contractorCategories)
    .values({ contractorId, categoryCode })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function removeCategory(
  contractorId: string,
  categoryCode: string
) {
  const [row] = await db
    .delete(contractorCategories)
    .where(
      and(
        eq(contractorCategories.contractorId, contractorId),
        eq(contractorCategories.categoryCode, categoryCode)
      )
    )
    .returning();
  return row ?? null;
}

// ─── Sectors ─────────────────────────────────────────────────────────────────

export async function getSectorsByContractor(contractorId: string) {
  return db
    .select()
    .from(contractorSectors)
    .where(eq(contractorSectors.contractorId, contractorId));
}

export async function addSector(contractorId: string, sectorCode: string) {
  const [row] = await db
    .insert(contractorSectors)
    .values({ contractorId, sectorCode })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function removeSector(contractorId: string, sectorCode: string) {
  const [row] = await db
    .delete(contractorSectors)
    .where(
      and(
        eq(contractorSectors.contractorId, contractorId),
        eq(contractorSectors.sectorCode, sectorCode)
      )
    )
    .returning();
  return row ?? null;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function searchContractors(
  sectorCode: string,
  categoryCode: string
) {
  const rows = await db
    .select({
      id: contractors.id,
      name: contractors.name,
      email: contractors.email,
      contactNum: contractors.contactNum,
      isActive: contractors.isActive,
    })
    .from(contractors)
    .innerJoin(
      contractorSectors,
      and(
        eq(contractorSectors.contractorId, contractors.id),
        eq(contractorSectors.sectorCode, sectorCode)
      )
    )
    .innerJoin(
      contractorCategories,
      and(
        eq(contractorCategories.contractorId, contractors.id),
        eq(contractorCategories.categoryCode, categoryCode)
      )
    )
    .where(eq(contractors.isActive, true));

  // Deduplicate (multiple sector/category rows for same contractor possible)
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}
