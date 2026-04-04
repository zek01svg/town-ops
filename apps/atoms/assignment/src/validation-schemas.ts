import { z } from "zod/v4";

import { assignmentStatusEnum } from "./database/schema";

export const updateAssignmentStatusSchema = z.object({
  status: assignmentStatusEnum,
  changedBy: z.string().min(1, "changedBy is required"),
  reason: z.string().optional(),
});

export const getAssignmentByCaseSchema = z
  .string()
  .uuid("Invalid case ID format");
export const getAssignmentByIdSchema = z
  .string()
  .uuid("Invalid assignment ID format");
