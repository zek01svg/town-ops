import { ApplicationFailure } from "@temporalio/activity";
import {
  CancelAppointmentInputSchema,
  CancelAppointmentResultSchema,
  CancelAssignmentInputSchema,
  CancelAssignmentResultSchema,
  CancelCaseTransitionInputSchema,
  CancelCaseTransitionResultSchema,
  CaseDtoSchema,
} from "@townops/orchestration-contract";
import type {
  CancelAppointmentInput,
  CancelAppointmentResult,
  CancelAssignmentInput,
  CancelAssignmentResult,
  CancelCaseTransitionInput,
  CancelCaseTransitionResult,
  CaseDto,
} from "@townops/orchestration-contract";
import { z } from "zod/v4";

type CancelCaseActivityDependencies = {
  appointmentAtomUrl: string;
  assignmentAtomUrl: string;
  caseAtomUrl: string;
  workerServiceToken: string;
  fetchImpl?: typeof fetch;
};

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

/** I/O-only steps for the forward-only Case cancellation Saga. */
export function createCancelCaseActivities({
  appointmentAtomUrl,
  assignmentAtomUrl,
  caseAtomUrl,
  workerServiceToken,
  fetchImpl = fetch,
}: CancelCaseActivityDependencies) {
  async function cancelScheduledAppointment(
    input: CancelAppointmentInput
  ): Promise<CancelAppointmentResult> {
    const response = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/cancel`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(CancelAppointmentInputSchema.parse(input)),
      }
    );
    if (response.ok || response.status === 409) {
      return CancelAppointmentResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Appointment atom rejected cancellation",
        "APPOINTMENT_CANCELLATION_REJECTED"
      );
    }
    throw new Error(`Appointment atom request failed with ${response.status}`);
  }

  async function cancelAssignmentForCase(
    input: CancelAssignmentInput
  ): Promise<CancelAssignmentResult> {
    const response = await fetchImpl(
      `${assignmentAtomUrl}/internal/assignments/cancel`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(CancelAssignmentInputSchema.parse(input)),
      }
    );
    if (response.ok || response.status === 409) {
      return CancelAssignmentResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Assignment atom rejected cancellation",
        "ASSIGNMENT_CANCELLATION_REJECTED"
      );
    }
    throw new Error(`Assignment atom request failed with ${response.status}`);
  }

  async function cancelCase(
    input: CancelCaseTransitionInput
  ): Promise<CancelCaseTransitionResult> {
    const command = CancelCaseTransitionInputSchema.parse(input);
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}/cancel`,
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
      if (!raw.case) return CancelCaseTransitionResultSchema.parse(raw);
      return CancelCaseTransitionResultSchema.parse({
        outcome: raw.outcome,
        case: toCaseDto(raw.case),
      });
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Case atom rejected cancellation",
        "CASE_CANCELLATION_REJECTED"
      );
    }
    throw new Error(`Case atom request failed with ${response.status}`);
  }

  return { cancelScheduledAppointment, cancelAssignmentForCase, cancelCase };
}
