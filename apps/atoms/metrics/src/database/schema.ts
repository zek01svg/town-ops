import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const contractorMetrics = pgTable(
  "contractor_metrics",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    contractorId: uuid("contractor_id").notNull(),
    scoreDelta: integer("score_delta").notNull(),
    reason: text().notNull(),
    // Deterministic dedupe key for a durable Workflow effect (PRS-144), e.g.
    // `${attemptId}/acceptance-sla-breach`. Nullable — legacy rows and the
    // legacy /api/metrics route never set it, and Postgres unique indexes
    // permit any number of NULLs.
    effectId: text("effect_id"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
  },
  (table) => [
    uniqueIndex("contractor_metrics_effect_id_idx").on(table.effectId),
  ]
);

export const contractorMetricsSelectSchema =
  createSelectSchema(contractorMetrics);
export const contractorMetricsInsertSchema =
  createInsertSchema(contractorMetrics);
export type ContractorMetric = z.infer<typeof contractorMetricsSelectSchema>;
