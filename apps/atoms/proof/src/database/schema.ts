import { sql } from "drizzle-orm";
import { pgTable, uuid, timestamp, text, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const proofType = pgEnum("proof_type", ["before", "after", "signature"]);

export const proofItems = pgTable("proof_items", {
  id: uuid()
    .default(sql`uuid_generate_v4()`)
    .primaryKey()
    .notNull(),
  caseId: uuid("case_id").notNull(),
  uploaderId: uuid("uploader_id").notNull(),
  mediaUrl: text("media_url").notNull(),
  type: proofType().notNull(),
  remarks: text(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).defaultNow(),
});

export const proofItemsInsertSchema = createInsertSchema(proofItems);
export const proofItemsSelectSchema = createSelectSchema(proofItems);
export type ProofItem = z.infer<typeof proofItemsSelectSchema>;
