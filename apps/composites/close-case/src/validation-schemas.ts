import { z } from "zod/v4";

export const proofItemSchema = z.object({
  media_url: z.string().url(),
  type: z.enum(["before", "after", "signature"]),
  remarks: z.string().optional(),
});

export const closeCaseSchema = z.object({
  case_id: z.string().uuid(),
  uploader_id: z.string().uuid(),
  proof_items: z
    .array(proofItemSchema)
    .min(1, "At least one proof item is required"),
  final_status: z.enum(["completed"]).default("completed"),
});

export type CloseCaseInput = z.infer<typeof closeCaseSchema>;
export type ProofItem = z.infer<typeof proofItemSchema>;
