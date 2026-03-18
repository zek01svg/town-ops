import { z } from "zod/v4";

import { insertProfileSchema } from "./database/schema";

export const getResidentByIDSchema = z.object({ id: z.string().uuid() });
export const getResidentByPostalSchema = z.object({
  postalCode: z.string().length(6),
});
export const newResidentSchema = insertProfileSchema;
export const updateResidentSchema = insertProfileSchema.omit({
  createdAt: true,
  updatedAt: true,
});
