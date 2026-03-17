import { z } from "zod/v4";

import { insertAssignmentSchema } from "./database/schema";

export const assignmentsByCaseSchema = z.object({
  caseId: z.string().uuid(),
});

export const assignmentsByContractorSchema = z.object({
  contractorId: z.string().uuid(),
});

export const getAssignmentByIdSchema = z.object({
  id: z.string().uuid(),
});

export const updateAssignmentStatusSchema = z.object({
  status: z.enum(["pending", "accepted", "rejected", "completed"]),
});

export const newAssignmentSchema = insertAssignmentSchema.omit({
  id: true,
  assignedAt: true,
  completedAt: true,
});
