import { z } from "zod/v4";
export const getProofSchema = z.object({ case_id: z.string().uuid() });

export const uploadProofSchema = z.object({
  file: z.any(),
  caseId: z.string().uuid(),
  uploaderId: z.string().uuid(),
  type: z.enum(["before", "after", "signature"]),
  remarks: z.string().optional(),
});
