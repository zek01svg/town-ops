import { z } from "zod/v4";

export const handleNoAccessSchema = z.object({
  caseId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  contractorId: z.string().uuid(),
  reason: z.string().optional(),
});
