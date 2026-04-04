import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  timestamp,
  text,
  foreignKey,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";
import z from "zod/v4";

export const assignmentSource = pgEnum("assignment_source", [
  "AUTO_ASSIGN",
  "MANUAL_ASSIGN",
  "BREACH_REASSIGN",
]);
export const assignmentStatus = pgEnum("assignment_status", [
  "PENDING_ACCEPTANCE",
  "ACCEPTED",
  "BREACHED",
  "REASSIGNED",
  "CANCELLED",
  "COMPLETED",
]);

export const assignmentStatusEnum = z.enum([
  "PENDING_ACCEPTANCE",
  "ACCEPTED",
  "BREACHED",
  "REASSIGNED",
  "CANCELLED",
  "COMPLETED",
]);
export const assignmentSourceEnum = z.enum([
  "AUTO_ASSIGN",
  "MANUAL_ASSIGN",
  "BREACH_REASSIGN",
]);

export const assignmentStatusHistory = pgTable(
  "assignment_status_history",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    assignmentId: uuid("assignment_id").notNull(),
    fromStatus: assignmentStatus("from_status"),
    toStatus: assignmentStatus("to_status").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    changedBy: text("changed_by").notNull(),
    reason: text(),
  },
  (table) => [
    foreignKey({
      columns: [table.assignmentId],
      foreignColumns: [assignments.id],
      name: "assignment_status_history_assignment_id_fkey",
    }),
  ]
);

export const assignmentStatusHistorySelectSchema = createSelectSchema(
  assignmentStatusHistory
);
export const assignmentStatusHistoryInsertSchema = createInsertSchema(
  assignmentStatusHistory,
  {
    id: z.string().uuid().optional(),
    changedAt: z.string().optional(),
  }
);
export type AssignmentStatusHistory = z.infer<
  typeof assignmentStatusHistorySelectSchema
>;

export const assignments = pgTable(
  "assignments",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    caseId: uuid("case_id").notNull(),
    contractorId: uuid("contractor_id").notNull(),
    status: assignmentStatus().default("PENDING_ACCEPTANCE").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    responseDueAt: timestamp("response_due_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    acceptedAt: timestamp("accepted_at", {
      withTimezone: true,
      mode: "string",
    }),
    source: assignmentSource().notNull(),
    reassignedFromAssignmentId: uuid("reassigned_from_assignment_id"),
    notes: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reassignedFromAssignmentId],
      foreignColumns: [table.id],
      name: "assignments_reassigned_from_assignment_id_fkey",
    }),
  ]
);

export const assignmentsSelectSchema = createSelectSchema(assignments);
export const assignmentsInsertSchema = createInsertSchema(assignments, {
  id: z.string().uuid().optional(),
  status: assignmentStatusEnum.optional(),
  assignedAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Assignment = z.infer<typeof assignmentsSelectSchema>;
