import { z } from "zod/v4";

export const contractorIdSchema = z.uuid();

export const searchQuerySchema = z.object({
  sectorCode: z.string().min(1).max(5),
  categoryCode: z.string().min(1).max(10),
});

export const createContractorSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  contactNum: z.string().max(20).optional(),
  email: z.string().email(),
  isActive: z.boolean().optional().default(true),
});

export const updateContractorSchema = z.object({
  name: z.string().min(1).optional(),
  contactNum: z.string().max(20).optional(),
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
});

export const categoryCodeSchema = z.object({
  categoryCode: z.string().min(1).max(10),
});

export const sectorCodeSchema = z.object({
  sectorCode: z.string().min(1).max(5),
});
