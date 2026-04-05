import { z } from "zod/v4";

export const openCaseSchema = z.object({
  resident_id: z.string().uuid(),
  category: z.string(),
  priority: z.enum(["low", "medium", "high", "emergency"]).default("medium"),
  description: z.string().optional(),
  address_details: z.string().optional(),
  postal_code: z.string().optional(),
});
