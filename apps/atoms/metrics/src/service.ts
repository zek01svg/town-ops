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
export async function createMetric(values: any) {
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
