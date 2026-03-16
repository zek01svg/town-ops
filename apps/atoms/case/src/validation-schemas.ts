import { z } from "zod/v4";

export const getCaseSchema = z.uuid();
export const updateCaseStatusSchema = z.object({
  id: z.uuid(),
  status: z.enum([
    "pending",
    "assigned",
    "dispatched",
    "in_progress",
    "completed",
    "cancelled",
    "escalated",
  ]),
});
