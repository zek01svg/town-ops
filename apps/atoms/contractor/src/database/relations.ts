import { relations } from "drizzle-orm";

import { contractorCategories, contractorSectors, contractors } from "./schema";

export const contractorsRelations = relations(contractors, ({ many }) => ({
  categories: many(contractorCategories),
  sectors: many(contractorSectors),
}));

export const contractorCategoriesRelations = relations(
  contractorCategories,
  ({ one }) => ({
    contractor: one(contractors, {
      fields: [contractorCategories.contractorId],
      references: [contractors.id],
    }),
  })
);

export const contractorSectorsRelations = relations(
  contractorSectors,
  ({ one }) => ({
    contractor: one(contractors, {
      fields: [contractorSectors.contractorId],
      references: [contractors.id],
    }),
  })
);
