import { z } from "zod/v4";

export const alertsByCaseSchema = z.object({
  caseId: z.uuid(),
});

export const alertsByRecipientSchema = z.object({
  recipientId: z.uuid(),
});

export const alertPayloadSchema = z.object({
  caseId: z.uuid(),
  residentId: z.uuid().optional(),
  recipientId: z.uuid().optional(),
  category: z.string().optional(),
  contractor: z.string().optional(),
  description: z.string().optional(),
  message: z.string().optional(),
  channel: z.enum(["email", "sms"]).optional().default("email"),
  email: z.email(),
});
