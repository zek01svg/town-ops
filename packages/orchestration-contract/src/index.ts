import { z } from "zod/v4";

export const MaintenanceCategorySchema = z.enum([
  "LE",
  "PL",
  "LF",
  "LS",
  "CL",
  "PC",
  "PG",
  "ID",
  "PT",
  "CW",
  "FS",
  "RC",
  "SC",
  "GN",
]);

export const CasePrioritySchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "EMERGENCY",
]);

export const OpenCaseInputSchema = z
  .object({
    residentId: z.uuid(),
    category: MaintenanceCategorySchema,
    priority: CasePrioritySchema,
    description: z.string().trim().min(1).max(10_000),
    addressDetails: z.string().trim().max(1_000).optional(),
    postalCode: z.string().regex(/^\d{6}$/),
  })
  .strict();

export type OpenCaseInput = z.infer<typeof OpenCaseInputSchema>;

export const ResidentOpenCaseInputSchema = OpenCaseInputSchema.omit({
  residentId: true,
}).strict();

export type ResidentOpenCaseInput = z.infer<typeof ResidentOpenCaseInputSchema>;

export const AccountRoleSchema = z.enum(["RESIDENT", "OFFICER", "CONTRACTOR"]);

export type AccountRole = z.infer<typeof AccountRoleSchema>;

export const ActorRoleSchema = z.enum(["RESIDENT", "OFFICER"]);

export type ActorRole = z.infer<typeof ActorRoleSchema>;

export const CreateCaseActivityInputSchema = z.object({
  caseId: z.uuid(),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: ActorRoleSchema,
  input: OpenCaseInputSchema,
});

export type CreateCaseActivityInput = z.infer<
  typeof CreateCaseActivityInputSchema
>;

export const CaseDtoSchema = z.object({
  id: z.uuid(),
  residentId: z.uuid(),
  category: MaintenanceCategorySchema,
  priority: CasePrioritySchema,
  status: z.literal("PENDING"),
  description: z.string(),
  addressDetails: z.string().nullable(),
  postalCode: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type CaseDto = z.infer<typeof CaseDtoSchema>;

export const OpenCaseCommandSchema = z.object({
  idempotencyKey: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: ActorRoleSchema,
  input: OpenCaseInputSchema,
});

export type OpenCaseCommand = z.infer<typeof OpenCaseCommandSchema>;

export const OpenCaseResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUCCESS"), data: CaseDtoSchema }),
  z.object({ kind: z.literal("IDEMPOTENCY_KEY_REUSED") }),
]);

export type OpenCaseResult = z.infer<typeof OpenCaseResultSchema>;

export const OperationSchema = z.object({
  caseId: z.uuid(),
  workflowId: z.string(),
  updateId: z.string(),
  idempotencyKey: z.uuid(),
});

export type Operation = z.infer<typeof OperationSchema>;

export type SuccessEnvelope<T> = { data: T; operation: Operation };

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
    operation: OperationSchema.optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ProvisionResidentInputSchema = z
  .object({
    accountId: z.uuid(),
    fullName: z.string().trim().min(1).max(200),
    email: z.email(),
  })
  .strict();

export type ProvisionResidentInput = z.infer<
  typeof ProvisionResidentInputSchema
>;

export const ResidentProfileDtoSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.string(),
});

export type ResidentProfileDto = z.infer<typeof ResidentProfileDtoSchema>;

export const ProvisioningStateSchema = z.enum([
  "PROVISIONED",
  "PROVISIONING",
  "NOT_APPLICABLE",
]);

export const MeDtoSchema = z.object({
  accountId: z.uuid(),
  role: AccountRoleSchema,
  residentId: z.uuid().nullable(),
  contractorId: z.string().nullable(),
  provisioningState: ProvisioningStateSchema,
  canOpenCases: z.boolean(),
});

export type MeDto = z.infer<typeof MeDtoSchema>;

export const WORKFLOW_NAMES = {
  case: "CaseWorkflow",
  residentProvisioning: "ResidentProvisioningWorkflow",
} as const;
export const UPDATE_NAMES = { openCase: "openCase" } as const;
export const ORCHESTRATION_TASK_QUEUE = "townops-orchestration";

export function caseWorkflowId(caseId: string) {
  return `case/${caseId}`;
}

export function residentProvisioningWorkflowId(accountId: string) {
  return `resident-provisioning/${accountId}`;
}

export function canonicalOpenCasePayload(input: OpenCaseInput) {
  return JSON.stringify({
    residentId: input.residentId,
    category: input.category,
    priority: input.priority,
    description: input.description,
    addressDetails: input.addressDetails,
    postalCode: input.postalCode,
  });
}
