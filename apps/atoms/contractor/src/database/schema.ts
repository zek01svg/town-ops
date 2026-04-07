import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod/v4";

// ─── contractors ──────────────────────────────────────────────────────────────

export const contractors = pgTable(
  "contractors",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    name: text("name").notNull(),
    contactNum: varchar("contact_num", { length: 20 }),
    email: text("email").notNull().unique(),
    isActive: boolean("is_active").notNull().default(true),
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
    index("idx_contractors_email").using(
      "btree",
      table.email.asc().nullsLast().op("text_ops")
    ),
    index("idx_contractors_active").using(
      "btree",
      table.isActive.asc().nullsLast()
    ),
  ]
);

// ─── contractor_categories ────────────────────────────────────────────────────

export const contractorCategories = pgTable(
  "contractor_categories",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    contractorId: uuid("contractor_id")
      .notNull()
      .references(() => contractors.id, { onDelete: "cascade" }),
    categoryCode: varchar("category_code", { length: 10 }).notNull(),
  },
  (table) => [
    unique("uq_contractor_category").on(table.contractorId, table.categoryCode),
    index("idx_cat_contractor").using(
      "btree",
      table.contractorId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_cat_code").using(
      "btree",
      table.categoryCode.asc().nullsLast().op("text_ops")
    ),
  ]
);

// ─── contractor_sectors ───────────────────────────────────────────────────────

export const contractorSectors = pgTable(
  "contractor_sectors",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    contractorId: uuid("contractor_id")
      .notNull()
      .references(() => contractors.id, { onDelete: "cascade" }),
    sectorCode: varchar("sector_code", { length: 5 }).notNull(),
  },
  (table) => [
    unique("uq_contractor_sector").on(table.contractorId, table.sectorCode),
    index("idx_sector_contractor").using(
      "btree",
      table.contractorId.asc().nullsLast().op("uuid_ops")
    ),
    index("idx_sector_code").using(
      "btree",
      table.sectorCode.asc().nullsLast().op("text_ops")
    ),
  ]
);

// ─── Zod schemas + types ──────────────────────────────────────────────────────

export const insertContractorSchema = createInsertSchema(contractors);
export const selectContractorSchema = createSelectSchema(contractors);
export const insertCategorySchema = createInsertSchema(contractorCategories);
export const selectCategorySchema = createSelectSchema(contractorCategories);
export const insertSectorSchema = createInsertSchema(contractorSectors);
export const selectSectorSchema = createSelectSchema(contractorSectors);

export type Contractor = z.infer<typeof selectContractorSchema>;
export type NewContractor = z.infer<typeof insertContractorSchema>;
export type ContractorCategory = z.infer<typeof selectCategorySchema>;
export type ContractorSector = z.infer<typeof selectSectorSchema>;
