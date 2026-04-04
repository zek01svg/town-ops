import { eq } from "drizzle-orm";

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
