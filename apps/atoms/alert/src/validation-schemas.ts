import { z } from "zod/v4";

export const alertsByCaseSchema = z.object({
  caseId: z.uuid(),
});

export const alertsByRecipientSchema = z.object({
  recipientId: z.uuid(),
});

const effectPurposeSchema = z.enum([
  "ATTEMPT_ASSIGNMENT_NOTIFICATION",
  "ATTEMPT_BREACH_NOTIFICATION",
  "ATTEMPT_BREACH_PERFORMANCE",
  "APPOINTMENT_NO_ACCESS_NOTIFICATION",
  "APPOINTMENT_RESCHEDULE_RESIDENT_NOTIFICATION",
  "APPOINTMENT_RESCHEDULE_CONTRACTOR_NOTIFICATION",
  "ASSIGNMENT_COMPLETION_NOTIFICATION",
  "ASSIGNMENT_COMPLETION_PERFORMANCE",
]);

export const reserveEffectSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    caseId: z.uuid(),
    type: z.literal("EMAIL"),
    purpose: effectPurposeSchema,
    to: z.email(),
    subject: z.string().min(1).max(500),
    html: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    caseId: z.uuid(),
    type: z.literal("PERFORMANCE_ENTRY"),
    purpose: effectPurposeSchema,
    contractorId: z.uuid(),
    scoreDelta: z.int(),
    reason: z.string().trim().min(1).max(1_000),
  }),
]);

export const effectIdSchema = z.object({ id: z.string().min(1) });
export const failEffectSchema = z
  .object({
    error: z.string().trim().min(1).max(10_000),
    nextRetryAt: z.string().datetime(),
  })
  .strict();
