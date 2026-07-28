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
  "ACCEPTANCE_SLA_BREACH",
  "WORK_START_FAILED",
  "MISSED_APPOINTMENT",
  "COMPLETION_FAILED",
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
  startWork: "startWork",
  reportNoAccess: "reportNoAccess",
  replaceAppointment: "replaceAppointment",
  completeCase: "completeCase",
  cancelCase: "cancelCase",
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

/**
 * Every status an Appointment row can hold. A replaced Appointment keeps its
 * row, so NO_ACCESS/RESCHEDULED must parse — a narrower schema turns an
 * ordinary read of a rescheduled Case into a 500.
 */
export const AppointmentStatusSchema = z.enum([
  "SCHEDULED",
  "IN_PROGRESS",
  "NO_ACCESS",
  "RESCHEDULED",
  "CANCELLED",
  "MISSED",
  "COMPLETED",
]);
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
  // The reason supplied when this Appointment was created by a Reschedule.
  reason: z.string().nullable(),
  operationId: z.string().min(1),
  createdAt: z.string(),
});
export type AppointmentDto = z.infer<typeof AppointmentDtoSchema>;

/**
 * What a Resident is allowed to see of an Appointment. `contractorId` is
 * dropped because the Resident app has no Contractor directory to resolve the
 * UUID against, and `attemptId` because allocation bookkeeping would expose
 * Contractor churn across Acceptance SLA Breaches.
 */
export const ResidentAppointmentDtoSchema = AppointmentDtoSchema.pick({
  id: true,
  startTime: true,
  endTime: true,
  status: true,
  reason: true,
});
export type ResidentAppointmentDto = z.infer<
  typeof ResidentAppointmentDtoSchema
>;

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
  z.object({
    outcome: z.literal("OVERRIDE_REASON_REQUIRED"),
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
  z.object({ kind: z.literal("OVERRIDE_REASON_REQUIRED") }),
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

// ─── Acceptance SLA breach and replacement (PRS-144) ───────────────────────

/** The -10 penalty applied exactly once per breached Attempt. */
export const ACCEPTANCE_SLA_BREACH_SCORE_DELTA = -10;

export const BreachAllocationAttemptInputSchema = z
  .object({
    operationId: z.string().min(1),
    attemptId: z.uuid(),
    assignmentId: z.uuid(),
    actorId: z.uuid(),
    actorRole: z.string().min(1),
  })
  .strict();
export type BreachAllocationAttemptInput = z.infer<
  typeof BreachAllocationAttemptInputSchema
>;

/**
 * Idempotent by the Attempt's own status, not by operationId — see the
 * outcome table in the PRS-144 design. `BREACHED` and `ALREADY_BREACHED`
 * both mean "the caller must still apply the penalty and replacement";
 * `ACCEPTED`/`WITHDRAWN` mean "abort, this offer is no longer live".
 */
export const BreachAllocationAttemptResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("BREACHED") }),
    z.object({ outcome: z.literal("ALREADY_BREACHED") }),
    z.object({ outcome: z.literal("ACCEPTED") }),
    z.object({ outcome: z.literal("WITHDRAWN") }),
  ]
);
export type BreachAllocationAttemptResult = z.infer<
  typeof BreachAllocationAttemptResultSchema
>;

export const RecordPerformanceEntryInputSchema = z
  .object({
    effectId: z.string().min(1),
    contractorId: z.uuid(),
    scoreDelta: z.int(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type RecordPerformanceEntryInput = z.infer<
  typeof RecordPerformanceEntryInputSchema
>;

export const PerformanceEntryDtoSchema = z.object({
  id: z.uuid(),
  contractorId: z.uuid(),
  scoreDelta: z.int(),
  reason: z.string(),
  effectId: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type PerformanceEntryDto = z.infer<typeof PerformanceEntryDtoSchema>;

export const MarkCaseBreachedInputSchema = z
  .object({
    caseId: z.uuid(),
    operationId: z.string().min(1),
    attemptId: z.uuid(),
    actorId: z.uuid(),
    actorRole: z.string().min(1),
    detail: z.string().trim().min(1).max(10_000),
  })
  .strict();
export type MarkCaseBreachedInput = z.infer<typeof MarkCaseBreachedInputSchema>;

export const MarkCaseBreachedResultSchema = z.object({
  outcome: z.enum(["PENDING", "CASE_TERMINAL"]),
});
export type MarkCaseBreachedResult = z.infer<
  typeof MarkCaseBreachedResultSchema
>;

// ─── Start work during the Appointment (PRS-145) ───────────────────────────

export const StartWorkCommandSchema = z.object({
  idempotencyKey: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: z.literal("CONTRACTOR"),
  contractorId: z.uuid(),
  caseId: z.uuid(),
  assignmentId: z.uuid(),
  appointmentId: z.uuid(),
  startTime: AcceptAllocationInputSchema.shape.startTime,
  endTime: AcceptAllocationInputSchema.shape.endTime,
});
export type StartWorkCommand = z.infer<typeof StartWorkCommandSchema>;

export const StartWorkDataSchema = z.object({
  appointment: AppointmentDtoSchema,
  assignment: AssignmentDtoSchema,
  case: CaseDtoSchema,
});
export type StartWorkData = z.infer<typeof StartWorkDataSchema>;

export const StartWorkResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUCCESS"), data: StartWorkDataSchema }),
  z.object({ kind: z.literal("IDEMPOTENCY_KEY_REUSED") }),
  z.object({ kind: z.literal("CASE_MISMATCH") }),
  z.object({ kind: z.literal("APPOINTMENT_MISMATCH") }),
  z.object({ kind: z.literal("NOT_IN_WINDOW") }),
  z.object({ kind: z.literal("NOT_SCHEDULED") }),
  z.object({ kind: z.literal("WRONG_CONTRACTOR") }),
  z.object({ kind: z.literal("NOT_ACCEPTED") }),
  z.object({ kind: z.literal("CASE_TERMINAL") }),
  z.object({ kind: z.literal("WORK_START_FAILED") }),
]);
export type StartWorkResult = z.infer<typeof StartWorkResultSchema>;

export const StartWorkAppointmentInputSchema = z
  .object({
    operationId: z.string().min(1),
    appointmentId: z.uuid(),
    contractorId: z.uuid(),
  })
  .strict();
export type StartWorkAppointmentInput = z.infer<
  typeof StartWorkAppointmentInputSchema
>;

export const StartWorkAppointmentResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("STARTED"),
      appointment: AppointmentDtoSchema,
    }),
    z.object({
      outcome: z.literal("ALREADY_STARTED"),
      appointment: AppointmentDtoSchema,
    }),
    z.object({ outcome: z.literal("NOT_SCHEDULED") }),
    z.object({ outcome: z.literal("WRONG_CONTRACTOR") }),
    z.object({ outcome: z.literal("APPOINTMENT_NOT_FOUND") }),
  ]
);
export type StartWorkAppointmentResult = z.infer<
  typeof StartWorkAppointmentResultSchema
>;

export const MarkAssignmentInProgressInputSchema = z
  .object({
    operationId: z.string().min(1),
    assignmentId: z.uuid(),
    changedBy: z.string().min(1),
  })
  .strict();
export type MarkAssignmentInProgressInput = z.infer<
  typeof MarkAssignmentInProgressInputSchema
>;

export const MarkAssignmentInProgressResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("IN_PROGRESS"),
      assignment: AssignmentDtoSchema,
    }),
    z.object({
      outcome: z.literal("ALREADY_IN_PROGRESS"),
      assignment: AssignmentDtoSchema,
    }),
    z.object({ outcome: z.literal("NOT_ACCEPTED") }),
    z.object({ outcome: z.literal("ASSIGNMENT_NOT_FOUND") }),
  ]
);
export type MarkAssignmentInProgressResult = z.infer<
  typeof MarkAssignmentInProgressResultSchema
>;

export const MarkCaseInProgressInputSchema = z
  .object({
    caseId: z.uuid(),
    operationId: z.string().min(1),
    actorId: z.uuid(),
    actorRole: z.literal("CONTRACTOR"),
  })
  .strict();
export type MarkCaseInProgressInput = z.infer<
  typeof MarkCaseInProgressInputSchema
>;

export const MarkCaseInProgressResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("IN_PROGRESS"), case: CaseDtoSchema }),
  z.object({ outcome: z.literal("CASE_TERMINAL") }),
]);
export type MarkCaseInProgressResult = z.infer<
  typeof MarkCaseInProgressResultSchema
>;

export function canonicalStartWorkPayload(
  caseId: string,
  appointmentId: string
) {
  return JSON.stringify({
    caseId,
    appointmentId,
  });
}

// ─── Contractor completion (PRS-147) ──────────────────────────────────────

export const ProofItemTypeSchema = z.enum(["BEFORE", "AFTER", "SIGNATURE"]);
export type ProofItemType = z.infer<typeof ProofItemTypeSchema>;

export const ProofItemDtoSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  contractorId: z.uuid().nullable(),
  mediaUrl: z.string(),
  type: ProofItemTypeSchema,
  remarks: z.string().nullable(),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  ready: z.boolean(),
  createdAt: z.string().nullable(),
});
export type ProofItemDto = z.infer<typeof ProofItemDtoSchema>;

export const UploadProofItemInputSchema = z
  .object({
    proofItemId: z.uuid(),
    caseId: z.uuid(),
    contractorId: z.uuid(),
    type: ProofItemTypeSchema,
    remarks: z.string().trim().max(10_000).optional(),
  })
  .strict();
export type UploadProofItemInput = z.infer<typeof UploadProofItemInputSchema>;

export const CompletionInputSchema = z
  .object({
    report: z.string().trim().min(1).max(10_000),
    proofItemIds: z.array(z.uuid()).min(1),
  })
  .strict()
  .transform((input) => ({
    ...input,
    proofItemIds: [...new Set(input.proofItemIds)].toSorted(),
  }));
export type CompletionInput = z.infer<typeof CompletionInputSchema>;

export const CompleteCaseCommandSchema = z.object({
  idempotencyKey: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: z.literal("CONTRACTOR"),
  contractorId: z.uuid(),
  caseId: z.uuid(),
  assignmentId: z.uuid(),
  appointmentId: z.uuid(),
  input: CompletionInputSchema,
});
export type CompleteCaseCommand = z.infer<typeof CompleteCaseCommandSchema>;

export const CompleteCaseDataSchema = z.object({
  appointment: AppointmentDtoSchema,
  assignment: AssignmentDtoSchema,
  case: CaseDtoSchema,
});
export type CompleteCaseData = z.infer<typeof CompleteCaseDataSchema>;

export const CompleteCaseResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUCCESS"), data: CompleteCaseDataSchema }),
  z.object({ kind: z.literal("IDEMPOTENCY_KEY_REUSED") }),
  z.object({ kind: z.literal("CASE_MISMATCH") }),
  z.object({ kind: z.literal("APPOINTMENT_MISMATCH") }),
  z.object({ kind: z.literal("NOT_IN_PROGRESS") }),
  z.object({ kind: z.literal("WRONG_CONTRACTOR") }),
  z.object({ kind: z.literal("COMPLETION_INVALID") }),
  z.object({ kind: z.literal("COMPLETION_FAILED") }),
]);
export type CompleteCaseResult = z.infer<typeof CompleteCaseResultSchema>;

export const CompleteAppointmentInputSchema = z
  .object({
    operationId: z.string().min(1),
    appointmentId: z.uuid(),
    contractorId: z.uuid(),
  })
  .strict();
export type CompleteAppointmentInput = z.infer<
  typeof CompleteAppointmentInputSchema
>;

export const CompleteAppointmentResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("COMPLETED"),
    appointment: AppointmentDtoSchema,
  }),
  z.object({
    outcome: z.literal("ALREADY_COMPLETED"),
    appointment: AppointmentDtoSchema,
  }),
  z.object({ outcome: z.literal("COMPLETION_OPERATION_CONFLICT") }),
  z.object({ outcome: z.literal("NOT_IN_PROGRESS") }),
  z.object({ outcome: z.literal("WRONG_CONTRACTOR") }),
  z.object({ outcome: z.literal("APPOINTMENT_NOT_FOUND") }),
]);
export type CompleteAppointmentResult = z.infer<
  typeof CompleteAppointmentResultSchema
>;

export const CompleteAssignmentInputSchema = z
  .object({
    operationId: z.string().min(1),
    assignmentId: z.uuid(),
    changedBy: z.string().min(1),
  })
  .strict();
export type CompleteAssignmentInput = z.infer<
  typeof CompleteAssignmentInputSchema
>;

export const CompleteAssignmentResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("COMPLETED"),
    assignment: AssignmentDtoSchema,
  }),
  z.object({
    outcome: z.literal("ALREADY_COMPLETED"),
    assignment: AssignmentDtoSchema,
  }),
  z.object({ outcome: z.literal("COMPLETION_OPERATION_CONFLICT") }),
  z.object({ outcome: z.literal("NOT_IN_PROGRESS") }),
  z.object({ outcome: z.literal("ASSIGNMENT_NOT_FOUND") }),
]);
export type CompleteAssignmentResult = z.infer<
  typeof CompleteAssignmentResultSchema
>;

export const CompleteCaseTransitionInputSchema = z
  .object({
    caseId: z.uuid(),
    operationId: z.string().min(1),
    actorId: z.uuid(),
    actorRole: z.literal("CONTRACTOR"),
    report: z.string().trim().min(1).max(10_000),
    proofItemIds: z.array(z.uuid()).min(1),
  })
  .strict();
export type CompleteCaseTransitionInput = z.infer<
  typeof CompleteCaseTransitionInputSchema
>;

export const CompleteCaseTransitionResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("COMPLETED"), case: CaseDtoSchema }),
    z.object({ outcome: z.literal("ALREADY_COMPLETED"), case: CaseDtoSchema }),
    z.object({ outcome: z.literal("CASE_TERMINAL") }),
    z.object({ outcome: z.literal("NOT_IN_PROGRESS") }),
  ]
);
export type CompleteCaseTransitionResult = z.infer<
  typeof CompleteCaseTransitionResultSchema
>;

/** Reward applied once when a Contractor completes an Assignment. */
export const ASSIGNMENT_COMPLETED_SCORE_DELTA = 10;

export function canonicalCompletionPayload(
  caseId: string,
  input: CompletionInput
) {
  return JSON.stringify({
    caseId,
    report: input.report.trim(),
    proofItemIds: [...new Set(input.proofItemIds)].toSorted(),
  });
}

// ─── Cancel Case (PRS-148) ────────────────────────────────────────────────

export const CancelCaseInputSchema = z
  .object({
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type CancelCaseInput = z.infer<typeof CancelCaseInputSchema>;

export const CancelCaseCommandSchema = z.object({
  idempotencyKey: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: ActorRoleSchema,
  caseId: z.uuid(),
  input: CancelCaseInputSchema,
});
export type CancelCaseCommand = z.infer<typeof CancelCaseCommandSchema>;

export const CancelCaseDataSchema = z.object({ case: CaseDtoSchema });
export type CancelCaseData = z.infer<typeof CancelCaseDataSchema>;

export const CancelCaseResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUCCESS"), data: CancelCaseDataSchema }),
  z.object({ kind: z.literal("IDEMPOTENCY_KEY_REUSED") }),
  z.object({ kind: z.literal("CASE_MISMATCH") }),
  z.object({ kind: z.literal("NOT_CANCELLABLE") }),
]);
export type CancelCaseResult = z.infer<typeof CancelCaseResultSchema>;

export const CancelAppointmentInputSchema = z
  .object({
    caseId: z.uuid(),
    operationId: z.string().min(1),
    changedBy: z.uuid(),
  })
  .strict();
export type CancelAppointmentInput = z.infer<
  typeof CancelAppointmentInputSchema
>;

export const CancelAppointmentResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("CANCELLED"),
    appointment: AppointmentDtoSchema,
  }),
  z.object({
    outcome: z.literal("ALREADY_CANCELLED"),
    appointment: AppointmentDtoSchema,
  }),
  z.object({ outcome: z.literal("NO_SCHEDULED_APPOINTMENT") }),
  z.object({ outcome: z.literal("IN_PROGRESS") }),
]);
export type CancelAppointmentResult = z.infer<
  typeof CancelAppointmentResultSchema
>;

export const CancelAssignmentInputSchema = z
  .object({
    caseId: z.uuid(),
    operationId: z.string().min(1),
    changedBy: z.uuid(),
    reason: CancelCaseInputSchema.shape.reason,
  })
  .strict();
export type CancelAssignmentInput = z.infer<typeof CancelAssignmentInputSchema>;

export const CancelAssignmentResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("CANCELLED") }),
  z.object({ outcome: z.literal("ALREADY_CANCELLED") }),
  z.object({ outcome: z.literal("NO_ASSIGNMENT") }),
  z.object({ outcome: z.literal("IN_PROGRESS") }),
  z.object({ outcome: z.literal("NOT_CANCELLABLE") }),
]);
export type CancelAssignmentResult = z.infer<
  typeof CancelAssignmentResultSchema
>;

export const CancelCaseTransitionInputSchema = z
  .object({
    caseId: z.uuid(),
    operationId: z.string().min(1),
    actorId: z.uuid(),
    actorRole: ActorRoleSchema,
    reason: CancelCaseInputSchema.shape.reason,
  })
  .strict();
export type CancelCaseTransitionInput = z.infer<
  typeof CancelCaseTransitionInputSchema
>;

export const CancelCaseTransitionResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("CANCELLED"), case: CaseDtoSchema }),
    z.object({
      outcome: z.literal("ALREADY_CANCELLED"),
      case: CaseDtoSchema,
    }),
    z.object({ outcome: z.literal("NOT_CANCELLABLE") }),
  ]
);
export type CancelCaseTransitionResult = z.infer<
  typeof CancelCaseTransitionResultSchema
>;

export function canonicalCancelCasePayload(
  caseId: string,
  input: CancelCaseInput
) {
  return JSON.stringify({ caseId, reason: input.reason.trim() });
}

// ─── Handle No Access and rescheduling (PRS-146) ───────────────────────────

export const ReportNoAccessCommandSchema = z.object({
  idempotencyKey: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: z.literal("CONTRACTOR"),
  contractorId: z.uuid(),
  caseId: z.uuid(),
  appointmentId: z.uuid(),
  startTime: AcceptAllocationInputSchema.shape.startTime,
  endTime: AcceptAllocationInputSchema.shape.endTime,
});
export type ReportNoAccessCommand = z.infer<typeof ReportNoAccessCommandSchema>;

export const ReportNoAccessDataSchema = z.object({
  appointment: AppointmentDtoSchema,
  case: CaseDtoSchema,
});
export type ReportNoAccessData = z.infer<typeof ReportNoAccessDataSchema>;

export const ReportNoAccessResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUCCESS"), data: ReportNoAccessDataSchema }),
  z.object({ kind: z.literal("IDEMPOTENCY_KEY_REUSED") }),
  z.object({ kind: z.literal("CASE_MISMATCH") }),
  z.object({ kind: z.literal("APPOINTMENT_MISMATCH") }),
  z.object({ kind: z.literal("NOT_IN_WINDOW") }),
  z.object({ kind: z.literal("NOT_SCHEDULED") }),
  z.object({ kind: z.literal("WRONG_CONTRACTOR") }),
  z.object({ kind: z.literal("CASE_TERMINAL") }),
]);
export type ReportNoAccessResult = z.infer<typeof ReportNoAccessResultSchema>;

/**
 * The reason is optional *here* and required at the Gateway. AC4 demands one
 * for a proactive Reschedule and AC5 (recovery after No Access) does not, so
 * required-ness depends on the Appointment's current status — which this
 * schema validates the request *body* against and the body deliberately does
 * not carry: a client-supplied status would be spoofable. The Gateway applies
 * the rule once it has derived the status itself.
 */
export const ReplaceAppointmentInputSchema = z
  .object({
    startTime: AcceptAllocationInputSchema.shape.startTime,
    endTime: AcceptAllocationInputSchema.shape.endTime,
    reason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
  .refine((value) => Date.parse(value.endTime) > Date.parse(value.startTime), {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });
export type ReplaceAppointmentInput = z.infer<
  typeof ReplaceAppointmentInputSchema
>;

export const ReplaceAppointmentCommandSchema = z.object({
  idempotencyKey: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1),
  actorId: z.uuid(),
  actorRole: ActorRoleSchema,
  caseId: z.uuid(),
  appointmentId: z.uuid(),
  input: ReplaceAppointmentInputSchema,
  // The Workflow owns the time gates but cannot query the Appointment it is
  // replacing, so the Gateway carries the old row's interval and status in —
  // exactly as StartWorkCommand carries startTime/endTime. Deliberately not
  // part of canonicalReplaceAppointmentPayload below: the hash represents
  // what the caller asked for, and on a same-key retry previousStatus has
  // legitimately moved (SCHEDULED -> RESCHEDULED), which would turn a valid
  // retry into a spurious IDEMPOTENCY_KEY_REUSED.
  previousStartTime: AcceptAllocationInputSchema.shape.startTime,
  previousStatus: AppointmentStatusSchema,
});
export type ReplaceAppointmentCommand = z.infer<
  typeof ReplaceAppointmentCommandSchema
>;

export const ReplaceAppointmentDataSchema = ReportNoAccessDataSchema;
export type ReplaceAppointmentData = z.infer<
  typeof ReplaceAppointmentDataSchema
>;

export const ReplaceAppointmentResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUCCESS"), data: ReplaceAppointmentDataSchema }),
  z.object({ kind: z.literal("IDEMPOTENCY_KEY_REUSED") }),
  z.object({ kind: z.literal("CASE_MISMATCH") }),
  z.object({ kind: z.literal("APPOINTMENT_MISMATCH") }),
  z.object({ kind: z.literal("NOT_REPLACEABLE") }),
  z.object({ kind: z.literal("NOT_FUTURE") }),
  z.object({ kind: z.literal("APPOINTMENT_CONFLICT") }),
  z.object({ kind: z.literal("CASE_TERMINAL") }),
]);
export type ReplaceAppointmentResult = z.infer<
  typeof ReplaceAppointmentResultSchema
>;

/** The Contractor acting on their own scheduled Appointment. */
export const ReportNoAccessAppointmentInputSchema = z
  .object({
    operationId: z.string().min(1),
    appointmentId: z.uuid(),
    contractorId: z.uuid(),
  })
  .strict();
export type ReportNoAccessAppointmentInput = z.infer<
  typeof ReportNoAccessAppointmentInputSchema
>;

export const ReportNoAccessAppointmentResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("NO_ACCESS"),
      appointment: AppointmentDtoSchema,
    }),
    z.object({
      outcome: z.literal("ALREADY_NO_ACCESS"),
      appointment: AppointmentDtoSchema,
    }),
    z.object({ outcome: z.literal("NOT_SCHEDULED") }),
    z.object({ outcome: z.literal("WRONG_CONTRACTOR") }),
    z.object({ outcome: z.literal("APPOINTMENT_NOT_FOUND") }),
  ]
);
export type ReportNoAccessAppointmentResult = z.infer<
  typeof ReportNoAccessAppointmentResultSchema
>;

/** Workflow-owned expiry of an unattended scheduled Appointment. */
export const MarkAppointmentMissedInputSchema = z
  .object({
    operationId: z.string().min(1),
    appointmentId: z.uuid(),
  })
  .strict();
export type MarkAppointmentMissedInput = z.infer<
  typeof MarkAppointmentMissedInputSchema
>;

export const MarkAppointmentMissedResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("MISSED"),
      appointment: AppointmentDtoSchema,
    }),
    z.object({
      outcome: z.literal("ALREADY_MISSED"),
      appointment: AppointmentDtoSchema,
    }),
    z.object({ outcome: z.literal("NOT_SCHEDULED") }),
    z.object({ outcome: z.literal("APPOINTMENT_NOT_FOUND") }),
  ]
);
export type MarkAppointmentMissedResult = z.infer<
  typeof MarkAppointmentMissedResultSchema
>;

export const ReplaceAppointmentSlotInputSchema = z
  .object({
    operationId: z.string().min(1),
    caseId: z.uuid(),
    appointmentId: z.uuid(),
    startTime: AcceptAllocationInputSchema.shape.startTime,
    endTime: AcceptAllocationInputSchema.shape.endTime,
    reason: ReplaceAppointmentInputSchema.shape.reason,
  })
  .strict()
  .refine((value) => Date.parse(value.endTime) > Date.parse(value.startTime), {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });
export type ReplaceAppointmentSlotInput = z.infer<
  typeof ReplaceAppointmentSlotInputSchema
>;

export const ReplaceAppointmentSlotResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("REPLACED"),
      appointment: AppointmentDtoSchema,
    }),
    z.object({
      outcome: z.literal("ALREADY_REPLACED"),
      appointment: AppointmentDtoSchema,
    }),
    z.object({ outcome: z.literal("NOT_REPLACEABLE") }),
    z.object({ outcome: z.literal("CONFLICT") }),
    z.object({ outcome: z.literal("CASE_MISMATCH") }),
    z.object({ outcome: z.literal("APPOINTMENT_NOT_FOUND") }),
  ]
);
export type ReplaceAppointmentSlotResult = z.infer<
  typeof ReplaceAppointmentSlotResultSchema
>;

/** Contractor-driven, same shape as the start-work Case write. */
export const MarkCaseNoAccessInputSchema = MarkCaseInProgressInputSchema;
export type MarkCaseNoAccessInput = z.infer<typeof MarkCaseNoAccessInputSchema>;

export const MarkCaseNoAccessResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("PENDING_RESIDENT_INPUT"),
    case: CaseDtoSchema,
  }),
  z.object({ outcome: z.literal("CASE_TERMINAL") }),
]);
export type MarkCaseNoAccessResult = z.infer<
  typeof MarkCaseNoAccessResultSchema
>;

export const MarkCaseAppointmentReplacedInputSchema = z
  .object({
    caseId: z.uuid(),
    operationId: z.string().min(1),
    actorId: z.uuid(),
    actorRole: ActorRoleSchema,
  })
  .strict();
export type MarkCaseAppointmentReplacedInput = z.infer<
  typeof MarkCaseAppointmentReplacedInputSchema
>;

export const MarkCaseAppointmentReplacedResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("REPLACED"), case: CaseDtoSchema }),
    z.object({ outcome: z.literal("CASE_TERMINAL") }),
  ]
);
export type MarkCaseAppointmentReplacedResult = z.infer<
  typeof MarkCaseAppointmentReplacedResultSchema
>;

export function canonicalReportNoAccessPayload(
  caseId: string,
  appointmentId: string
) {
  return JSON.stringify({
    caseId,
    appointmentId,
  });
}

export function canonicalReplaceAppointmentPayload(
  caseId: string,
  appointmentId: string,
  input: ReplaceAppointmentInput
) {
  return JSON.stringify({
    caseId,
    appointmentId,
    startTime: input.startTime,
    endTime: input.endTime,
    reason: input.reason,
  });
}
