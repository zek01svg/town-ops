import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  timestamp,
  index,
  pgPolicy,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const assignmentStatus = pgEnum("assignment_status", [
  "pending",
  "accepted",
  "rejected",
  "completed",
]);

export const assignments = pgTable(
  "assignments",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    caseId: uuid("case_id").notNull(),
    contractorId: uuid("contractor_id").notNull(),
    status: assignmentStatus().default("pending").notNull(),
    assignedAt: timestamp("assigned_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("idx_assignments_case").using(
      "btree",
      table.caseId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_assignments_contractor").using(
      "btree",
      table.contractorId.asc().nullsLast().op("uuid_ops")
    ),
    pgPolicy("Contractors update own assignments", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`(contractor_id = auth.uid())`,
    }),
    pgPolicy("Contractors view own assignments", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Officers manage assignments", {
      as: "permissive",
      for: "all",
      to: ["public"],
    }),
  ]
);

export const selectAssignmentSchema = createSelectSchema(assignments);
export const insertAssignmentSchema = createInsertSchema(assignments);

export type Assignment = z.infer<typeof selectAssignmentSchema>;
