import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  timestamp,
  index,
  pgEnum,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";

export const appointmentStatus = pgEnum("appointment_status", [
  "scheduled",
  "in_progress",
  "no_access",
  "rescheduled",
  "cancelled",
  "missed",
  "completed",
]);

export const appointmentSlotClaimStatus = pgEnum(
  "appointment_slot_claim_status",
  ["HELD", "ACTIVE", "RELEASED"]
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    caseId: uuid("case_id").notNull(),
    assignmentId: uuid("assignment_id").notNull(),
    // These are nullable for the legacy public create route. Internal slot
    // confirmation always supplies them before publishing a scheduled slot.
    attemptId: uuid("attempt_id"),
    contractorId: uuid("contractor_id"),
    operationId: text("operation_id"),
    completionOperationId: text("completion_operation_id"),
    slotClaimId: uuid("slot_claim_id"),
    startTime: timestamp("start_time", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    endTime: timestamp("end_time", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    status: appointmentStatus().default("scheduled").notNull(),
    reason: text("reason"),
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
    index("idx_appointments_case").using(
      "btree",
      table.caseId.asc().nullsLast().op("uuid_ops")
    ),
    uniqueIndex("appointments_operation_id_idx").on(table.operationId),
    uniqueIndex("appointments_slot_claim_id_idx").on(table.slotClaimId),
    // At most one live Appointment per Attempt. A `no_access` row keeps its
    // status when replaced (AC5), so nothing in the status guard stops it
    // being replaced twice — this does.
    uniqueIndex("appointments_one_live_per_attempt")
      .on(table.attemptId)
      .where(sql`${table.status} IN ('scheduled', 'in_progress')`),
  ]
);

export const appointmentStatusHistory = pgTable(
  "appointment_status_history",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id),
    fromStatus: appointmentStatus("from_status"),
    toStatus: appointmentStatus("to_status").notNull(),
    changedAt: timestamp("changed_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    changedBy: text("changed_by").notNull(),
    operationId: text("operation_id").notNull(),
  },
  (table) => [
    uniqueIndex("appointment_status_history_appointment_id_idx").on(
      table.appointmentId
    ),
  ]
);

export const appointmentSlotClaims = pgTable(
  "appointment_slot_claims",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    operationId: text("operation_id").notNull(),
    caseId: uuid("case_id").notNull(),
    assignmentId: uuid("assignment_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    contractorId: uuid("contractor_id").notNull(),
    startTime: timestamp("start_time", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    endTime: timestamp("end_time", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    status: appointmentSlotClaimStatus().default("HELD").notNull(),
  },
  (table) => [
    uniqueIndex("appointment_slot_claims_operation_id_idx").on(
      table.operationId
    ),
  ]
);

export const appointmentSelectSchema = createSelectSchema(appointments);
export const appointmentInsertSchema = createInsertSchema(appointments);
export type Appointment = typeof appointments.$inferSelect;
