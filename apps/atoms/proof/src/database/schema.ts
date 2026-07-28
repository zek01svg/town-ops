import {
  pgTable,
  uuid,
  timestamp,
  text,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const proofType = pgEnum("proof_type", ["before", "after", "signature"]);

export const proofItems = pgTable(
  "proof_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    caseId: uuid("case_id").notNull(),
    uploaderId: uuid("uploader_id").notNull(),
    // Legacy public rows only recorded uploaderId. Completion accepts only rows
    // that also carry this explicit Contractor ownership claim.
    contractorId: uuid("contractor_id"),
    operationId: text("operation_id"),
    payloadHash: text("payload_hash"),
    mediaUrl: text("media_url").notNull(),
    type: proofType().notNull(),
    remarks: text(),
    checksum: text(),
    readyAt: timestamp("ready_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
  },
  (table) => [uniqueIndex("proof_items_operation_id_idx").on(table.operationId)]
);

export const proofItemsInsertSchema = createInsertSchema(proofItems);
export const proofItemsSelectSchema = createSelectSchema(proofItems);
export type ProofItem = z.infer<typeof proofItemsSelectSchema>;
