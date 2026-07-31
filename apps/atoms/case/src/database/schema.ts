import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const caseCategory = pgEnum("case_category", [
  "LE",
  "PL",
  "LF",
  "LS",
  "CL",
  "PC",
  "PG",
  "ID",
  "PT",
  "CW",
  "FS",
  "RC",
  "SC",
  "GN",
]);
export const casePriority = pgEnum("case_priority", [
  "low",
  "medium",
  "high",
  "emergency",
]);
export const caseStatus = pgEnum("case_status", [
  "pending",
  "assigned",
  "dispatched",
  "in_progress",
  "pending_resident_input",
  "completed",
  "cancelled",
  "escalated",
]);

export const officerAttentionKind = pgEnum("officer_attention_kind", [
  "NO_ELIGIBLE_CONTRACTOR",
  "ALLOCATION_FAILED",
  "ACCEPTANCE_SLA_BREACH",
  "WORK_START_FAILED",
  "MISSED_APPOINTMENT",
  "COMPLETION_FAILED",
  "DERIVED_EFFECT_UNKNOWN",
]);

export const cases = pgTable(
  "cases",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    residentId: uuid("resident_id").notNull(),
    category: caseCategory().notNull(),
    priority: casePriority().default("medium").notNull(),
    status: caseStatus().default("pending").notNull(),
    description: text(),
    addressDetails: text("address_details"),
    postalCode: text("postal_code"),
    // Nullable for legacy rows. These are workflow persistence fields, not
    // part of the public Case DTO.
    completionOperationId: text("completion_operation_id"),
    completionReport: text("completion_report"),
    completionProofItemIds: jsonb("completion_proof_item_ids").$type<
      string[]
    >(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
  },
  (table) => [
    index("idx_cases_postal").using(
      "btree",
      table.postalCode.asc().nullsLast().op("text_ops")
    ),
    index("idx_cases_resident").using(
      "btree",
      table.residentId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_cases_status").using(
      "btree",
      table.status.asc().nullsLast().op("enum_ops")
    ),
  ]
);

export const caseOperations = pgTable("case_operations", {
  operationId: text("operation_id").primaryKey(),
  // This row is the transaction's durable idempotency claim, created before
  // its Case. The transaction rolls it back if Case creation fails.
  caseId: uuid("case_id").notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).defaultNow(),
});

export const caseHistory = pgTable(
  "case_history",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    reason: text("reason"),
    operationId: text("operation_id").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
  },
  (table) => [
    uniqueIndex("case_history_operation_id_idx").on(table.operationId),
  ]
);

/**
 * An unresolved operational exception that needs an Officer decision. The
 * partial unique index lets repeated Workflow retries converge on one open
 * record while retaining resolved history for the Case.
 */
export const officerAttention = pgTable(
  "officer_attention",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    kind: officerAttentionKind().notNull(),
    detail: text().notNull(),
    operationId: text("operation_id").notNull(),
    effectId: text("effect_id"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", {
      withTimezone: true,
      mode: "string",
    }),
    resolvedByOperationId: text("resolved_by_operation_id"),
  },
  (table) => [
    uniqueIndex("officer_attention_open_case_kind_idx")
      .on(table.caseId, table.kind)
      .where(sql`${table.resolvedAt} IS NULL AND ${table.effectId} IS NULL`),
    uniqueIndex("officer_attention_open_effect_idx")
      .on(table.caseId, table.kind, table.effectId)
      .where(
        sql`${table.resolvedAt} IS NULL AND ${table.effectId} IS NOT NULL`
      ),
  ]
);

export const insertCaseSchema = createInsertSchema(cases);
export const selectCaseSchema = createSelectSchema(cases);
export type Case = z.infer<typeof selectCaseSchema>;
export type NewCase = z.infer<typeof insertCaseSchema>;
