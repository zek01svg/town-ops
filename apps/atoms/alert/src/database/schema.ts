import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";

export const alertChannel = pgEnum("alert_channel", ["email", "sms"]);
export const derivedEffectType = pgEnum("derived_effect_type", [
  "EMAIL",
  "PERFORMANCE_ENTRY",
]);
export const derivedEffectStatus = pgEnum("derived_effect_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "UNKNOWN",
  "WAIVED",
]);
export const alerts = pgTable("alerts", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  caseId: uuid("case_id"),
  recipientId: uuid("recipient_id").notNull(),
  channel: alertChannel().default("email").notNull(),
  message: text().notNull(),
  sentAt: timestamp("sent_at", {
    withTimezone: true,
    mode: "string",
  }).defaultNow(),
});

type DerivedEffectPayload =
  | { type: "EMAIL"; to: string; subject: string; html: string }
  | {
      type: "PERFORMANCE_ENTRY";
      contractorId: string;
      scoreDelta: number;
      reason: string;
    };

/**
 * Immutable outbox for side effects derived from a committed Case write.
 * It deliberately lives with the notification provider, not the Case atom:
 * Case owns lifecycle truth while this atom owns provider delivery state.
 */
export const derivedEffects = pgTable(
  "derived_effects",
  {
    id: text("id").primaryKey(),
    caseId: uuid("case_id").notNull(),
    type: derivedEffectType("type").notNull(),
    purpose: text("purpose").notNull(),
    status: derivedEffectStatus("status").default("PENDING").notNull(),
    payload: jsonb("payload").$type<DerivedEffectPayload>().notNull(),
    providerId: text("provider_id"),
    providerIdempotencyKey: text("provider_idempotency_key").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    nextRetryAt: timestamp("next_retry_at", {
      withTimezone: true,
      mode: "string",
    }),
    waiverActorId: uuid("waiver_actor_id"),
    waiverReason: text("waiver_reason"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("derived_effects_case_idx").on(table.caseId),
    index("derived_effects_case_status_idx").on(table.caseId, table.status),
  ]
);

export const selectAlertSchema = createSelectSchema(alerts);
export const insertAlertSchema = createInsertSchema(alerts);
