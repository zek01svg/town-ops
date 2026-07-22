import type { RecordPerformanceEntryInput } from "@townops/orchestration-contract";
import { eq, sql } from "drizzle-orm";

import db from "./database/db";
import { contractorMetrics } from "./database/schema";

/**
 * Get metrics for a specific contractor.
 */
export async function getMetricsByContractorId(contractorId: string) {
  return db
    .select()
    .from(contractorMetrics)
    .where(eq(contractorMetrics.contractorId, contractorId));
}

/**
 * Create a new contractor metric record.
 */
export async function createMetric(
  values: typeof contractorMetrics.$inferInsert
) {
  const [metric] = await db
    .insert(contractorMetrics)
    .values(values)
    .returning();
  return metric;
}

/**
 * Total performance score per Contractor (PRS-139) — a plain SQL sum/group
 * by, not a JS aggregation. A Contractor with no metric rows simply has no
 * entry; the Workflow treats a missing Contractor as score 0.
 */
export async function getScoreTotals() {
  return db
    .select({
      contractorId: contractorMetrics.contractorId,
      totalScore: sql<number>`sum(${contractorMetrics.scoreDelta})::int`,
    })
    .from(contractorMetrics)
    .groupBy(contractorMetrics.contractorId);
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
    .insert(contractorMetrics)
    .values({
      contractorId: input.contractorId,
      scoreDelta: input.scoreDelta,
      reason: input.reason,
      effectId: input.effectId,
    })
    .onConflictDoNothing({ target: contractorMetrics.effectId })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(contractorMetrics)
    .where(eq(contractorMetrics.effectId, input.effectId));
  if (!existing) {
    throw new Error(
      "Contractor metric was not found after an effect-id conflict"
    );
  }
  return existing;
}
