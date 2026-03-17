import { sql } from "drizzle-orm";
import { pgTable, uuid, timestamp, index, pgEnum } from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";

export const appointmentStatus = pgEnum("appointment_status", [
  "scheduled",
  "rescheduled",
  "cancelled",
  "missed",
  "completed",
]);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    caseId: uuid("case_id").notNull(),
    assignmentId: uuid("assignment_id").notNull(),
    startTime: timestamp("start_time", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    endTime: timestamp("end_time", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    status: appointmentStatus().default("scheduled").notNull(),
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
  ]
);

export const appointmentSelectSchema = createSelectSchema(appointments);
export const appointmentInsertSchema = createInsertSchema(appointments);
export type Appointment = typeof appointments.$inferSelect;
