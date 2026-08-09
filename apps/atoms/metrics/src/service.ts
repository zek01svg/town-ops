import type { RecordPerformanceEntryInput } from "@townops/orchestration-contract";
import { eq, sql } from "drizzle-orm";

import db from "./database/db";
import { performanceEntries } from "./database/schema";

/**
 * Total performance score per Contractor (PRS-139) — a plain SQL sum/group
 * by, not a JS aggregation. A Contractor with no metric rows simply has no
 * entry; the Workflow treats a missing Contractor as score 0.
 */
export async function getScoreTotals() {
  return db
    .select({
      contractorId: performanceEntries.contractorId,
      totalScore: sql<number>`sum(${performanceEntries.scoreDelta})::int`,
    })
    .from(performanceEntries)
    .groupBy(performanceEntries.contractorId);
}

/**
 * Records one performance entry exactly once per durable Workflow effect
 * (PRS-144, e.g. the -10 acceptance SLA breach penalty). `effectId` is the
 * whole idempotency mechanism here — a duplicate insert conflicts on the
 * unique index and this re-selects the row already written by the first
 * attempt, so a replay or a duplicate timer delivery always gets back the
 * one entry that exists.
 */
export async function recordPerformanceEntry(
  input: RecordPerformanceEntryInput
) {
  const [inserted] = await db
    .insert(performanceEntries)
    .values({
      contractorId: input.contractorId,
      scoreDelta: input.scoreDelta,
      reason: input.reason,
      effectId: input.effectId,
    })
    .onConflictDoNothing({ target: performanceEntries.effectId })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(performanceEntries)
    .where(eq(performanceEntries.effectId, input.effectId));
  if (!existing) {
    throw new Error(
      "Performance entry was not found after an effect-id conflict"
    );
  }
  return existing;
}
