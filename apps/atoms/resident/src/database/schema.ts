import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  pgPolicy,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { createSelectSchema, createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const profiles = pgTable(
  "profiles",
  {
    id: uuid().primaryKey().notNull(),
    fullName: text("full_name").notNull(),
    email: text().notNull(),
    contactNumber: text("contact_number"),
    postalCode: text("postal_code"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    unique("profiles_email_key").on(table.email),
    index("profiles_postal_code_idx").on(table.postalCode),
    pgPolicy("Public profile view", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
    pgPolicy("Users can edit own profile", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
  ]
);

export const selectProfileSchema = createSelectSchema(profiles);
export const insertProfileSchema = createInsertSchema(profiles);
export type Profile = z.infer<typeof selectProfileSchema>;
