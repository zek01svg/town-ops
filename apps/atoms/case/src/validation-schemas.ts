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

export const raiseOfficerAttentionSchema = z
  .object({
    kind: z.enum([
      "NO_ELIGIBLE_CONTRACTOR",
      "ALLOCATION_FAILED",
      "WORK_START_FAILED",
      "MISSED_APPOINTMENT",
      "COMPLETION_FAILED",
      "DERIVED_EFFECT_UNKNOWN",
    ]),
    detail: z.string().trim().min(1).max(10_000),
    operationId: z.string().min(1),
    effectId: z.string().min(1).optional(),
  })
  .strict();

export const officerAttentionListSchema = z.object({
  state: z.enum(["open", "resolved"]).default("open"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  caseId: z.uuid().optional(),
});

export const caseListSchema = z.object({
  residentId: z.uuid().optional(),
  status: z
    .enum([
      "pending",
      "assigned",
      "dispatched",
      "in_progress",
      "pending_resident_input",
      "completed",
      "cancelled",
      "escalated",
    ])
    .optional(),
  // A CSV of Case UUIDs (the Gateway's contractor-scope fan-in, PRS-151).
  // `.pipe` rejects a malformed entry the same way a bad `residentId` does.
  ids: z
    .string()
    .optional()
    .transform((value) => value?.split(","))
    .pipe(z.array(z.uuid()).optional()),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});
