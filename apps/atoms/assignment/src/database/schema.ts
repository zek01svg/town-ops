import {
  pgTable,
  uuid,
  timestamp,
  text,
  integer,
  foreignKey,
  pgEnum,
  uniqueIndex,
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
  "IN_PROGRESS",
  "BREACHED",
  "REASSIGNED",
  "CANCELLED",
  "COMPLETED",
]);
export const allocationAttemptStatus = pgEnum("allocation_attempt_status", [
  "PENDING_ACCEPTANCE",
  "ACCEPTED",
  "BREACHED",
  "WITHDRAWN",
]);

export const assignmentStatusEnum = z.enum([
  "PENDING_ACCEPTANCE",
  "ACCEPTED",
  "IN_PROGRESS",
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
export const allocationAttemptStatusEnum = z.enum([
  "PENDING_ACCEPTANCE",
  "ACCEPTED",
  "BREACHED",
  "WITHDRAWN",
]);

export const assignmentStatusHistory = pgTable(
  "assignment_status_history",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
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
    id: uuid().defaultRandom().primaryKey().notNull(),
    caseId: uuid("case_id").notNull(),
    // Relaxed to nullable for PRS-139: the new Allocation model (see
    // allocationAttempts below) carries contractor/SLA/source per Attempt.
    // Legacy rows still populate these directly.
    contractorId: uuid("contractor_id"),
    status: assignmentStatus().default("PENDING_ACCEPTANCE").notNull(),
    completionOperationId: text("completion_operation_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    responseDueAt: timestamp("response_due_at", {
      withTimezone: true,
      mode: "string",
    }),
    acceptedAt: timestamp("accepted_at", {
      withTimezone: true,
      mode: "string",
    }),
    source: assignmentSource(),
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
    // Exactly one stable Assignment per Case (PRS-139) — allocation retries
    // and reassignments reuse this same row instead of creating a new one.
    uniqueIndex("assignments_case_id_idx").on(table.caseId),
  ]
);

export const assignmentsSelectSchema = createSelectSchema(assignments);
export const assignmentsInsertSchema = createInsertSchema(assignments, {
  id: z.string().uuid().optional(),
  status: assignmentStatusEnum.optional(),
  assignedAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  // The legacy /api/assignments route still requires these even though the
  // DB columns are now nullable — only the new PRS-139 model (service.ts,
  // commitAllocationAttempt) inserts an Assignment row without them.
  contractorId: z.string().uuid(),
  responseDueAt: z.string(),
  source: assignmentSourceEnum,
});
export type Assignment = z.infer<typeof assignmentsSelectSchema>;

// ─── Allocation epoch (PRS-139) ─────────────────────────────────────────────
// Single global row fencing concurrent allocation attempts across all Cases
// — see commitAllocationAttempt in service.ts.

export const allocationEpoch = pgTable("allocation_epoch", {
  id: integer().primaryKey().notNull().default(1),
  epoch: integer().notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const allocationEpochSelectSchema = createSelectSchema(allocationEpoch);
export type AllocationEpoch = z.infer<typeof allocationEpochSelectSchema>;

// ─── Allocation attempts (PRS-139) ──────────────────────────────────────────
// Append-only log of "this Contractor was offered this Assignment" events —
// distinct from the `assignments` row above, which the new model treats as
// a single stable per-Case handle.

export const allocationAttempts = pgTable(
  "allocation_attempts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id),
    contractorId: uuid("contractor_id").notNull(),
    source: assignmentSource().notNull(),
    status: allocationAttemptStatus().default("PENDING_ACCEPTANCE").notNull(),
    acceptanceSlaMs: integer("acceptance_sla_ms").notNull(),
    deadlineAt: timestamp("deadline_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    actorId: uuid("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    reason: text(),
    operationId: text("operation_id").notNull(),
    acceptanceOperationId: text("acceptance_operation_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The idempotency claim for one allocation attempt — same pattern as
    // case_history's operation_id unique index.
    uniqueIndex("allocation_attempts_operation_id_idx").on(table.operationId),
    uniqueIndex("allocation_attempts_acceptance_operation_id_idx").on(
      table.acceptanceOperationId
    ),
  ]
);

export const allocationAttemptsSelectSchema =
  createSelectSchema(allocationAttempts);
export const allocationAttemptsInsertSchema = createInsertSchema(
  allocationAttempts,
  {
    id: z.string().uuid().optional(),
    status: allocationAttemptStatusEnum.optional(),
    deadlineAt: z.string(),
    createdAt: z.string().optional(),
  }
);
export type AllocationAttempt = z.infer<typeof allocationAttemptsSelectSchema>;
