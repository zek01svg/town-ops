import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const contractorMetrics = pgTable("contractor_metrics", {
  id: uuid()
    .default(sql`uuid_generate_v4()`)
    .primaryKey()
    .notNull(),
  contractorId: uuid("contractor_id").notNull(),
  scoreDelta: integer("score_delta").notNull(),
  reason: text().notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).defaultNow(),
});

export const contractorMetricsSelectSchema =
  createSelectSchema(contractorMetrics);
export const contractorMetricsInsertSchema =
  createInsertSchema(contractorMetrics);
export type ContractorMetric = z.infer<typeof contractorMetricsSelectSchema>;
