import { z } from "zod/v4";
export const internalProofUploadSchema = z.object({
  file: z.any(),
  proofItemId: z.uuid(),
  caseId: z.uuid(),
  contractorId: z.uuid(),
  type: z.enum(["BEFORE", "AFTER", "SIGNATURE"]),
  remarks: z.string().trim().max(10_000).optional(),
});

export const internalProofListSchema = z.object({
  contractorId: z.uuid().optional(),
});

export const internalProofLookupSchema = z.object({
  caseId: z.uuid(),
  contractorId: z.uuid(),
});
