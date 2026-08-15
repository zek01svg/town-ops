import { ApplicationFailure } from "@temporalio/activity";
import {
  CompleteAppointmentInputSchema,
  CompleteAppointmentResultSchema,
  CompleteAssignmentInputSchema,
  CompleteAssignmentResultSchema,
  CompleteCaseTransitionInputSchema,
  CompleteCaseTransitionResultSchema,
  CompletionInputSchema,
  CaseDtoSchema,
  ProofItemDtoSchema,
  RecordPerformanceEntryInputSchema,
  withServerlessAuth,
} from "@townops/orchestration-contract";
import type {
  CaseDto,
  CompleteAppointmentInput,
  CompleteAppointmentResult,
  CompleteAssignmentInput,
  CompleteAssignmentResult,
  CompleteCaseCommand,
  CompleteCaseTransitionInput,
  CompleteCaseTransitionResult,
  PerformanceEntryDto,
} from "@townops/orchestration-contract";
import { z } from "zod/v4";

const caseResponseSchema = z.object({
  case: z.record(z.string(), z.unknown()),
});
const proofResponseSchema = z.object({ proof: ProofItemDtoSchema });
const appointmentResponseSchema = z.object({
  appointments: z.array(
    z.object({
      id: z.uuid(),
      caseId: z.uuid(),
      assignmentId: z.uuid(),
      contractorId: z.uuid().nullable(),
      status: z.string(),
    })
  ),
});
const assignmentResponseSchema = z.object({
  assignment: z
    .object({
      id: z.uuid(),
      caseId: z.uuid(),
      contractorId: z.uuid().nullable(),
      status: z.string(),
    })
    .nullable(),
  attempt: z
    .object({
      assignmentId: z.uuid(),
      contractorId: z.uuid(),
    })
    .nullable(),
});

const completionOperationIdentityResponseSchema = z.object({
  completionOperationId: z.string().nullable(),
});

type CompleteCaseActivityDependencies = {
  proofAtomUrl: string;
  appointmentAtomUrl: string;
  assignmentAtomUrl: string;
  caseAtomUrl: string;
  metricsAtomUrl: string;
  workerServiceToken: string;
  fetchImpl?: typeof fetch;
  // Mints the Cloud Run IAM ID token `withServerlessAuth` attaches to every
  // atom call (PRS-140 Phase 5). Defaults to the real metadata-server minter.
  mintIdentityToken?: (audience: string) => Promise<string | undefined>;
};

type CompletionValidationResult =
  | { outcome: "READY" }
  | { outcome: "ALREADY_COMPLETED"; case: CaseDto }
  | { outcome: "NOT_IN_PROGRESS" }
  | { outcome: "COMPLETION_INVALID" }
  | { outcome: "APPOINTMENT_MISMATCH" }
  | { outcome: "WRONG_CONTRACTOR" };

function nonRetryable(message: string, type: string) {
  return ApplicationFailure.nonRetryable(message, type);
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function toCaseDto(record: Record<string, unknown>): CaseDto {
  return CaseDtoSchema.parse({
    ...record,
    category: String(record.category).toUpperCase(),
    priority: String(record.priority).toUpperCase(),
    status: String(record.status).toUpperCase(),
    addressDetails: record.addressDetails ?? null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
  });
}

/** I/O-only activities for the forward-only Contractor completion Saga. */
export function createCompleteCaseActivities({
  proofAtomUrl,
  appointmentAtomUrl,
  assignmentAtomUrl,
  caseAtomUrl,
  metricsAtomUrl,
  workerServiceToken,
  fetchImpl: injectedFetch = fetch,
  mintIdentityToken,
}: CompleteCaseActivityDependencies) {
  const fetchImpl = withServerlessAuth(injectedFetch, mintIdentityToken);
  async function getCompletionOperationId(url: string) {
    const response = await fetchImpl(url, {
      headers: authHeaders(workerServiceToken),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `Completion identity request failed with ${response.status}`
      );
    }
    return completionOperationIdentityResponseSchema.parse(
      await response.json()
    ).completionOperationId;
  }

  async function validateCompletion(
    input: CompleteCaseCommand
  ): Promise<CompletionValidationResult> {
    const command = z
      .object({
        operationId: z.string().min(1),
        caseId: z.uuid(),
        contractorId: z.uuid(),
        assignmentId: z.uuid(),
        appointmentId: z.uuid(),
        input: CompletionInputSchema,
      })
      .parse(input);
    const caseResponse = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}`,
      { headers: authHeaders(workerServiceToken) }
    );
    if (caseResponse.status === 404) {
      throw nonRetryable("Case does not exist", "CASE_NOT_FOUND");
    }
    if (!caseResponse.ok) {
      throw new Error(`Case atom request failed with ${caseResponse.status}`);
    }
    const rawCase = caseResponseSchema.parse(await caseResponse.json()).case;
    const isCompletionReplay =
      rawCase.status === "completed" &&
      rawCase.completionOperationId === `${command.operationId}/case`;
    if (rawCase.status === "completed" && !isCompletionReplay) {
      return { outcome: "NOT_IN_PROGRESS" };
    }
    if (rawCase.status !== "in_progress" && !isCompletionReplay) {
      return { outcome: "NOT_IN_PROGRESS" };
    }

    const [appointmentResponse, assignmentResponse] = await Promise.all([
      fetchImpl(`${appointmentAtomUrl}/api/appointments/${command.caseId}`, {
        headers: authHeaders(workerServiceToken),
      }),
      fetchImpl(
        `${assignmentAtomUrl}/api/assignments/by-case/${command.caseId}`,
        { headers: authHeaders(workerServiceToken) }
      ),
    ]);
    if (!appointmentResponse.ok) {
      throw new Error(
        `Appointment atom request failed with ${appointmentResponse.status}`
      );
    }
    if (!assignmentResponse.ok) {
      throw new Error(
        `Assignment atom request failed with ${assignmentResponse.status}`
      );
    }

    const appointment = appointmentResponseSchema
      .parse(await appointmentResponse.json())
      .appointments.find((item) => item.id === command.appointmentId);
    if (
      !appointment ||
      appointment.caseId !== command.caseId ||
      appointment.assignmentId !== command.assignmentId
    ) {
      return { outcome: "APPOINTMENT_MISMATCH" };
    }
    if (appointment.contractorId !== command.contractorId) {
      return { outcome: "WRONG_CONTRACTOR" };
    }

    const assignmentSnapshot = assignmentResponseSchema.parse(
      await assignmentResponse.json()
    );
    const assignment = assignmentSnapshot.assignment;
    if (
      !assignment ||
      assignment.id !== command.assignmentId ||
      assignment.caseId !== command.caseId
    ) {
      return { outcome: "APPOINTMENT_MISMATCH" };
    }
    const attempt = assignmentSnapshot.attempt;
    if (attempt && attempt.assignmentId !== command.assignmentId) {
      return { outcome: "APPOINTMENT_MISMATCH" };
    }
    if (
      (attempt?.contractorId ?? assignment.contractorId) !==
      command.contractorId
    ) {
      return { outcome: "WRONG_CONTRACTOR" };
    }

    const appointmentStatus = appointment.status.toUpperCase();
    const assignmentStatus = assignment.status.toUpperCase();
    if (
      !["IN_PROGRESS", "COMPLETED"].includes(appointmentStatus) ||
      !["IN_PROGRESS", "COMPLETED"].includes(assignmentStatus)
    ) {
      return { outcome: "NOT_IN_PROGRESS" };
    }
    const [appointmentCompletionOperationId, assignmentCompletionOperationId] =
      await Promise.all([
        appointmentStatus === "COMPLETED"
          ? getCompletionOperationId(
              `${appointmentAtomUrl}/internal/appointment-slots/completion-operation/${command.appointmentId}`
            )
          : undefined,
        assignmentStatus === "COMPLETED"
          ? getCompletionOperationId(
              `${assignmentAtomUrl}/internal/assignments/completion-operation/${command.assignmentId}`
            )
          : undefined,
      ]);
    if (
      (appointmentStatus === "COMPLETED" &&
        appointmentCompletionOperationId !==
          `${command.operationId}/appointment`) ||
      (assignmentStatus === "COMPLETED" &&
        assignmentCompletionOperationId !== `${command.operationId}/assignment`)
    ) {
      return { outcome: "NOT_IN_PROGRESS" };
    }
    if (isCompletionReplay) {
      if (
        appointmentStatus !== "COMPLETED" ||
        assignmentStatus !== "COMPLETED"
      ) {
        return { outcome: "NOT_IN_PROGRESS" };
      }
      return { outcome: "ALREADY_COMPLETED", case: toCaseDto(rawCase) };
    }

    const proofItems = await Promise.all(
      command.input.proofItemIds.map(async (proofItemId) => {
        const response = await fetchImpl(
          `${proofAtomUrl}/internal/proof-items/${proofItemId}/resolve?${new URLSearchParams(
            {
              caseId: command.caseId,
              contractorId: command.contractorId,
            }
          )}`,
          { headers: authHeaders(workerServiceToken) }
        );
        if (response.status === 404) return null;
        if (!response.ok) {
          throw new Error(`Proof atom request failed with ${response.status}`);
        }
        return proofResponseSchema.parse(await response.json()).proof;
      })
    );
    if (
      proofItems.some((proof) => proof === null) ||
      !proofItems.some((proof) => proof?.type === "BEFORE") ||
      !proofItems.some((proof) => proof?.type === "AFTER")
    ) {
      return { outcome: "COMPLETION_INVALID" };
    }
    return { outcome: "READY" };
  }

  async function completeAppointment(
    input: CompleteAppointmentInput
  ): Promise<CompleteAppointmentResult> {
    const response = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/complete`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(CompleteAppointmentInputSchema.parse(input)),
      }
    );
    if (response.ok || response.status === 404 || response.status === 409) {
      return CompleteAppointmentResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Appointment atom rejected completion",
        "APPOINTMENT_COMPLETION_REJECTED"
      );
    }
    throw new Error(`Appointment atom request failed with ${response.status}`);
  }

  async function completeAssignment(
    input: CompleteAssignmentInput
  ): Promise<CompleteAssignmentResult> {
    const response = await fetchImpl(
      `${assignmentAtomUrl}/internal/assignments/complete`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(CompleteAssignmentInputSchema.parse(input)),
      }
    );
    if (response.ok || response.status === 404 || response.status === 409) {
      return CompleteAssignmentResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Assignment atom rejected completion",
        "ASSIGNMENT_COMPLETION_REJECTED"
      );
    }
    throw new Error(`Assignment atom request failed with ${response.status}`);
  }

  async function completeCase(
    input: CompleteCaseTransitionInput
  ): Promise<CompleteCaseTransitionResult> {
    const command = CompleteCaseTransitionInputSchema.parse(input);
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}/complete`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );
    if (response.ok || response.status === 409) {
      const raw = z
        .object({
          outcome: z.string(),
          case: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(await response.json());
      if (!raw.case) return CompleteCaseTransitionResultSchema.parse(raw);
      return CompleteCaseTransitionResultSchema.parse({
        outcome: raw.outcome,
        case: toCaseDto(raw.case),
      });
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Case atom rejected completion",
        "CASE_COMPLETION_REJECTED"
      );
    }
    throw new Error(`Case atom request failed with ${response.status}`);
  }

  async function recordCompletionPerformance(input: {
    effectId: string;
    contractorId: string;
    scoreDelta: number;
    reason: string;
  }): Promise<PerformanceEntryDto> {
    const response = await fetchImpl(
      `${metricsAtomUrl}/internal/performance/entries`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(RecordPerformanceEntryInputSchema.parse(input)),
      }
    );
    if (response.ok) {
      return z
        .object({ entry: z.unknown() })
        .transform(({ entry }) => entry)
        .pipe(
          z.object({
            id: z.uuid(),
            contractorId: z.uuid(),
            scoreDelta: z.int(),
            reason: z.string(),
            effectId: z.string().nullable(),
            createdAt: z.string().nullable(),
          })
        )
        .parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Metrics atom rejected completion reward",
        "PERFORMANCE_ENTRY_REJECTED"
      );
    }
    throw new Error(`Metrics atom request failed with ${response.status}`);
  }

  return {
    validateCompletion,
    completeAppointment,
    completeAssignment,
    completeCase,
    recordCompletionPerformance,
  };
}
