import { z } from "zod/v4";

export const getCaseSchema = z.uuid();
export const updateCaseStatusSchema = z.object({
  id: z.uuid(),
  status: z.enum([
    "pending",
    "assigned",
    "dispatched",
    "in_progress",
    "pending_resident_input",
    "completed",
    "cancelled",
    "escalated",
  ]),
});

export const markCaseAssignedSchema = z
  .object({
    operationId: z.string().min(1),
    actorId: z.uuid(),
    actorRole: z.string().min(1),
  })
  .strict();
