import { sql } from "drizzle-orm";
import {
  index,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
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

export const cases = pgTable(
  "cases",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    residentId: uuid("resident_id").notNull(),
    category: caseCategory().notNull(),
    priority: casePriority().default("medium").notNull(),
    status: caseStatus().default("pending").notNull(),
    description: text(),
    addressDetails: text("address_details"),
    postalCode: text("postal_code"),
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
    pgPolicy("Officers view all cases", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'officer'::user_role))))`,
    }),
    pgPolicy("Contractors view assigned cases", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Residents create own cases", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Residents view own cases", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
  ]
);

export const insertCaseSchema = createInsertSchema(cases);
export const selectCaseSchema = createSelectSchema(cases);
export type Case = z.infer<typeof selectCaseSchema>;
export type NewCase = z.infer<typeof insertCaseSchema>;
