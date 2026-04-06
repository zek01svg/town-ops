import { z } from "zod";

export const openCaseSchema = z.object({
  resident_id: z.string().uuid("Must be a valid UUID"),
  category: z.string().min(1, "Category is required"),
  priority: z.enum(["low", "medium", "high", "emergency"]),
  description: z.string(),
  address_details: z.string(),
  postal_code: z.string(),
});

export type OpenCaseInput = z.infer<typeof openCaseSchema>;
