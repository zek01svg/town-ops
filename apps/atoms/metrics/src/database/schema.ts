import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const performanceEntries = pgTable(
  "performance_entries",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    contractorId: uuid("contractor_id").notNull(),
    scoreDelta: integer("score_delta").notNull(),
    reason: text().notNull(),
    // Deterministic dedupe key for a durable Workflow effect (PRS-144), e.g.
    // `${attemptId}/acceptance-sla-breach`. Nullable — legacy rows and the
    // existing rows may not set it, and Postgres unique indexes permit any
    // number of NULLs.
    effectId: text("effect_id"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
  },
  (table) => [
    uniqueIndex("performance_entries_effect_id_idx").on(table.effectId),
  ]
);

export const performanceEntriesSelectSchema =
  createSelectSchema(performanceEntries);
export type PerformanceEntry = z.infer<typeof performanceEntriesSelectSchema>;
