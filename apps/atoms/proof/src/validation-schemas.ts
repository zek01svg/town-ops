import { z } from "zod/v4";
export const getProofSchema = z.object({ case_id: z.string().uuid() });

export const uploadProofSchema = z.object({
  file: z.any(),
  caseId: z.string().uuid(),
  uploaderId: z.string().uuid(),
  type: z.enum(["before", "after", "signature"]),
  remarks: z.string().optional(),
});

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
