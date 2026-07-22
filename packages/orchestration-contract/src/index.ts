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

/**
 * The full Case lifecycle. A Case leaves PENDING as soon as allocation commits
 * an Attempt, so this must cover every status the Case atom can hold — a
 * narrower schema turns an ordinary read of a progressed Case into a 500.
 */
export const CaseStatusSchema = z.enum([
  "PENDING",
  "ASSIGNED",
  "IN_PROGRESS",
  "PENDING_RESIDENT_INPUT",
  "COMPLETED",
  "CANCELLED",
]);

export const CaseDtoSchema = z.object({
  id: z.uuid(),
  residentId: z.uuid(),
  category: MaintenanceCategorySchema,
  priority: CasePrioritySchema,
  status: CaseStatusSchema,
  description: z.string(),
  addressDetails: z.string().nullable(),
  postalCode: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type CaseDto = z.infer<typeof CaseDtoSchema>;

export const MarkCaseAssignedResultSchema = z.object({
  outcome: z.enum(["ASSIGNED", "CASE_TERMINAL"]),
});
export type MarkCaseAssignedResult = z.infer<
  typeof MarkCaseAssignedResultSchema
>;

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

export const OfficerAttentionKindSchema = z.enum([
  "NO_ELIGIBLE_CONTRACTOR",
  "ALLOCATION_FAILED",
]);
export type OfficerAttentionKind = z.infer<typeof OfficerAttentionKindSchema>;

export const RaiseOfficerAttentionInputSchema = z
  .object({
    caseId: z.uuid(),
    kind: OfficerAttentionKindSchema,
    detail: z.string().trim().min(1).max(10_000),
    operationId: z.string().min(1),
  })
  .strict();
export type RaiseOfficerAttentionInput = z.infer<
  typeof RaiseOfficerAttentionInputSchema
>;

export const OfficerAttentionDtoSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  kind: OfficerAttentionKindSchema,
  detail: z.string(),
  operationId: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedByOperationId: z.string().nullable(),
});
export type OfficerAttentionDto = z.infer<typeof OfficerAttentionDtoSchema>;

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
export const UPDATE_NAMES = {
  openCase: "openCase",
  allocateContractor: "allocateContractor",
  acceptAllocation: "acceptAllocation",
} as const;
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

// ─── Contractor allocation (PRS-139) ───────────────────────────────────────

/** Default acceptance window for an automatic allocation Attempt. */
export const DEFAULT_ACCEPTANCE_SLA_MS = 60_000;

export const AllocationSourceSchema = z.enum([
  "AUTO_ASSIGN",
  "MANUAL_ASSIGN",
  "BREACH_REASSIGN",
]);
export type AllocationSource = z.infer<typeof AllocationSourceSchema>;

export const AllocationAttemptStatusSchema = z.enum([
  "PENDING_ACCEPTANCE",
  "ACCEPTED",
  "BREACHED",
  "WITHDRAWN",
]);
export type AllocationAttemptStatus = z.infer<
  typeof AllocationAttemptStatusSchema
>;

export const AllocationCandidateSchema = z.object({
  contractorId: z.uuid(),
  activeAssignments: z.int().nonnegative(),
  totalScore: z.int(),
});
export type AllocationCandidate = z.infer<typeof AllocationCandidateSchema>;

export const ManualAllocationInputSchema = z
  .object({
    contractorId: z.uuid(),
    replaceAttemptId: z.uuid().optional(),
    reason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type ManualAllocationInput = z.infer<typeof ManualAllocationInputSchema>;

/**
 * The Workflow's ranking input: every eligible Contractor for a Case's
 * category/sector, joined with their active Assignment load and performance
 * score, plus the fencing epoch observed at fetch time.
 */
export const AllocationSnapshotSchema = z.object({
  epoch: z.int().nonnegative(),
  candidates: z.array(AllocationCandidateSchema),
});
export type AllocationSnapshot = z.infer<typeof AllocationSnapshotSchema>;

export const CommitAllocationInputSchema = z
  .object({
    operationId: z.string().min(1),
    caseId: z.uuid(),
    contractorId: z.uuid(),
    source: AllocationSourceSchema,
    expectedEpoch: z.int().nonnegative(),
    acceptanceSlaMs: z.int().positive(),
    actorId: z.uuid(),
    actorRole: z.string().min(1),
    reason: z.string().optional(),
    // A manual reallocation names the exact pending Attempt it is permitted
    // to withdraw. This prevents a stale Officer command from replacing a
    // newer offer that won the allocation race.
    replaceAttemptId: z.uuid().optional(),
  })
  .strict();
export type CommitAllocationInput = z.infer<typeof CommitAllocationInputSchema>;

export const AssignmentDtoSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssignmentDto = z.infer<typeof AssignmentDtoSchema>;

export const AllocationAttemptDtoSchema = z.object({
  id: z.uuid(),
  assignmentId: z.uuid(),
  contractorId: z.uuid(),
  source: AllocationSourceSchema,
  status: AllocationAttemptStatusSchema,
  acceptanceSlaMs: z.int().nonnegative(),
  deadlineAt: z.string(),
  actorId: z.uuid(),
  actorRole: z.string(),
  reason: z.string().nullable(),
  operationId: z.string(),
  createdAt: z.string(),
});
export type AllocationAttemptDto = z.infer<typeof AllocationAttemptDtoSchema>;

export const AppointmentStatusSchema = z.enum(["SCHEDULED"]);
export type AppointmentStatus = z.infer<typeof AppointmentStatusSchema>;

export const AppointmentDtoSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  assignmentId: z.uuid(),
  attemptId: z.uuid(),
  contractorId: z.uuid(),
  startTime: z.string(),
  endTime: z.string(),
  status: AppointmentStatusSchema,
  operationId: z.string().min(1),
  createdAt: z.string(),
});
export type AppointmentDto = z.infer<typeof AppointmentDtoSchema>;

export const AcceptAllocationInputSchema = z
  .object({
    startTime: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), {
        message: "startTime must be an ISO timestamp",
      }),
    endTime: z.string().refine((value) => Number.isFinite(Date.parse(value)), {
      message: "endTime must be an ISO timestamp",
    }),
  })
  .strict()
  .refine((value) => Date.parse(value.endTime) > Date.parse(value.startTime), {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });
export type AcceptAllocationInput = z.infer<typeof AcceptAllocationInputSchema>;

export const ReserveAppointmentSlotInputSchema = z
  .object({
    operationId: z.string().min(1),
    caseId: z.uuid(),
    assignmentId: z.uuid(),
    attemptId: z.uuid(),
    contractorId: z.uuid(),
    startTime: AcceptAllocationInputSchema.shape.startTime,
    endTime: AcceptAllocationInputSchema.shape.endTime,
  })
  .strict()
  .refine((value) => Date.parse(value.endTime) > Date.parse(value.startTime), {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });
export type ReserveAppointmentSlotInput = z.infer<
  typeof ReserveAppointmentSlotInputSchema
>;

export const AppointmentSlotClaimDtoSchema = z.object({
  id: z.uuid(),
  operationId: z.string().min(1),
  caseId: z.uuid(),
  assignmentId: z.uuid(),
  attemptId: z.uuid(),
  contractorId: z.uuid(),
  startTime: z.string(),
  endTime: z.string(),
  status: z.enum(["HELD", "ACTIVE", "RELEASED"]),
});
export type AppointmentSlotClaimDto = z.infer<
  typeof AppointmentSlotClaimDtoSchema
>;

export const ConfirmAppointmentSlotInputSchema = z
  .object({ operationId: z.string().min(1), claimId: z.uuid() })
  .strict();
export type ConfirmAppointmentSlotInput = z.infer<
  typeof ConfirmAppointmentSlotInputSchema
>;

export const ReleaseAppointmentSlotInputSchema =
  ConfirmAppointmentSlotInputSchema;
export type ReleaseAppointmentSlotInput = z.infer<
  typeof ReleaseAppointmentSlotInputSchema
>;

export const AcceptAllocationAttemptInputSchema = z
  .object({
    operationId: z.string().min(1),
    caseId: z.uuid(),
    assignmentId: z.uuid(),
    attemptId: z.uuid(),
    contractorId: z.uuid(),
  })
  .strict();
export type AcceptAllocationAttemptInput = z.infer<
  typeof AcceptAllocationAttemptInputSchema
>;

export const AcceptAllocationAttemptResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("ACCEPTED"),
      assignment: AssignmentDtoSchema,
      attempt: AllocationAttemptDtoSchema,
    }),
    z.object({
      outcome: z.literal("ALREADY_ACCEPTED"),
      assignment: AssignmentDtoSchema,
      attempt: AllocationAttemptDtoSchema,
    }),
    z.object({ outcome: z.literal("ASSIGNMENT_NOT_PENDING") }),
    z.object({ outcome: z.literal("ATTEMPT_NOT_PENDING") }),
    z.object({ outcome: z.literal("ATTEMPT_NOT_OWNED") }),
    z.object({ outcome: z.literal("CASE_MISMATCH") }),
  ]
);
export type AcceptAllocationAttemptResult = z.infer<
  typeof AcceptAllocationAttemptResultSchema
>;

export const RecordAllocationAcceptanceInputSchema = z
  .object({
    caseId: z.uuid(),
    operationId: z.string().min(1),
    actorId: z.uuid(),
    actorRole: z.literal("CONTRACTOR"),
  })
  .strict();
export type RecordAllocationAcceptanceInput = z.infer<
  typeof RecordAllocationAcceptanceInputSchema
>;

export const AcceptAllocationCommandSchema = z.object({
  idempotencyKey: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: z.literal("CONTRACTOR"),
  contractorId: z.uuid(),
  caseId: z.uuid(),
  assignmentId: z.uuid(),
  attemptId: z.uuid(),
  input: AcceptAllocationInputSchema,
});
export type AcceptAllocationCommand = z.infer<
  typeof AcceptAllocationCommandSchema
>;

export const AcceptAllocationDataSchema = z.object({
  assignment: AssignmentDtoSchema,
  attempt: AllocationAttemptDtoSchema,
  appointment: AppointmentDtoSchema,
});
export type AcceptAllocationData = z.infer<typeof AcceptAllocationDataSchema>;

export const AcceptAllocationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUCCESS"), data: AcceptAllocationDataSchema }),
  z.object({ kind: z.literal("IDEMPOTENCY_KEY_REUSED") }),
  z.object({ kind: z.literal("ASSIGNMENT_NOT_PENDING") }),
  z.object({ kind: z.literal("ATTEMPT_NOT_PENDING") }),
  z.object({ kind: z.literal("ATTEMPT_NOT_OWNED") }),
  z.object({ kind: z.literal("CASE_MISMATCH") }),
  z.object({ kind: z.literal("APPOINTMENT_CONFLICT") }),
  z.object({ kind: z.literal("APPOINTMENT_NOT_FUTURE") }),
]);
export type AcceptAllocationResult = z.infer<
  typeof AcceptAllocationResultSchema
>;

export const CommitAllocationResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("COMMITTED"),
    attempt: AllocationAttemptDtoSchema,
    assignment: AssignmentDtoSchema,
    epoch: z.int().nonnegative(),
  }),
  z.object({
    outcome: z.literal("ALREADY_COMMITTED"),
    attempt: AllocationAttemptDtoSchema,
    assignment: AssignmentDtoSchema,
  }),
  z.object({
    outcome: z.literal("STALE_EPOCH"),
    epoch: z.int().nonnegative(),
  }),
  z.object({
    outcome: z.literal("ACTIVE_ATTEMPT_EXISTS"),
    attempt: AllocationAttemptDtoSchema,
  }),
  z.object({
    outcome: z.literal("REPLACEMENT_ATTEMPT_NOT_PENDING"),
  }),
]);
export type CommitAllocationResult = z.infer<
  typeof CommitAllocationResultSchema
>;

export const ManualAllocationCommandSchema = z.object({
  idempotencyKey: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: z.literal("OFFICER"),
  caseId: z.uuid(),
  category: MaintenanceCategorySchema,
  postalCode: z.string().regex(/^\d{6}$/),
  input: ManualAllocationInputSchema,
});
export type ManualAllocationCommand = z.infer<
  typeof ManualAllocationCommandSchema
>;

export const ManualAllocationDataSchema = z.object({
  assignment: AssignmentDtoSchema,
  attempt: AllocationAttemptDtoSchema,
});
export type ManualAllocationData = z.infer<typeof ManualAllocationDataSchema>;

export const ManualAllocationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUCCESS"), data: ManualAllocationDataSchema }),
  z.object({ kind: z.literal("IDEMPOTENCY_KEY_REUSED") }),
  z.object({ kind: z.literal("CONTRACTOR_NOT_ELIGIBLE") }),
  z.object({ kind: z.literal("ACTIVE_ATTEMPT_EXISTS") }),
  z.object({ kind: z.literal("REPLACEMENT_ATTEMPT_NOT_PENDING") }),
  z.object({ kind: z.literal("CASE_TERMINAL") }),
  z.object({ kind: z.literal("ALLOCATION_FAILED"), reason: z.string() }),
]);
export type ManualAllocationResult = z.infer<
  typeof ManualAllocationResultSchema
>;

export function canonicalManualAllocationPayload(
  caseId: string,
  input: ManualAllocationInput
) {
  return JSON.stringify({
    caseId,
    contractorId: input.contractorId,
    replaceAttemptId: input.replaceAttemptId ?? null,
    reason: input.reason ?? null,
  });
}

export function canonicalAcceptAllocationPayload(
  caseId: string,
  attemptId: string,
  input: AcceptAllocationInput
) {
  return JSON.stringify({
    caseId,
    attemptId,
    startTime: input.startTime,
    endTime: input.endTime,
  });
}

/** First two characters of a 6-digit Singapore postal code — its sector. */
export function postalSector(postalCode: string) {
  return postalCode.slice(0, 2);
}
