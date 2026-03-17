import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";

export const alertChannel = pgEnum("alert_channel", ["email", "sms"]);
export const alerts = pgTable("alerts", {
  id: uuid()
    .default(sql`uuid_generate_v4()`)
    .primaryKey()
    .notNull(),
  caseId: uuid("case_id"),
  recipientId: uuid("recipient_id").notNull(),
  channel: alertChannel().default("email").notNull(),
  message: text().notNull(),
  sentAt: timestamp("sent_at", {
    withTimezone: true,
    mode: "string",
  }).defaultNow(),
});

export const selectAlertSchema = createSelectSchema(alerts);
export const insertAlertSchema = createInsertSchema(alerts);
