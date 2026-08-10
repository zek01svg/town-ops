import { ApplicationFailure } from "@temporalio/activity";
import {
  MarkAssignmentInProgressInputSchema,
  MarkAssignmentInProgressResultSchema,
  MarkCaseInProgressInputSchema,
  MarkCaseInProgressResultSchema,
  StartWorkAppointmentInputSchema,
  StartWorkAppointmentResultSchema,
} from "@townops/orchestration-contract";
import type {
  MarkAssignmentInProgressInput,
  MarkAssignmentInProgressResult,
  MarkCaseInProgressInput,
  MarkCaseInProgressResult,
  StartWorkAppointmentInput,
  StartWorkAppointmentResult,
} from "@townops/orchestration-contract";
import { z } from "zod/v4";

type StartWorkActivityDependencies = {
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

/**
 * Start-work Saga I/O for PRS-145. Each atom route returns its domain
 * outcomes (NOT_SCHEDULED, WRONG_CONTRACTOR, CASE_TERMINAL, …) as 2xx/4xx
 * bodies to be parsed and returned as results, exactly like
 * allocate-contractor.ts's acceptAllocation — only a genuinely unexpected
 * 4xx or a transient 5xx/network failure throws, so the Workflow's boundary
 * and Saga logic stay the sole place that decides what a domain outcome
 * means.
 */
export function createStartWorkActivities({
  appointmentAtomUrl,
  assignmentAtomUrl,
  caseAtomUrl,
  workerServiceToken,
  fetchImpl = fetch,
}: StartWorkActivityDependencies) {
  async function startWorkAppointment(
    input: StartWorkAppointmentInput
  ): Promise<StartWorkAppointmentResult> {
    const command = StartWorkAppointmentInputSchema.parse(input);
    const response = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/start-work`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    // STARTED/ALREADY_STARTED (2xx), APPOINTMENT_NOT_FOUND (404), and
    // NOT_SCHEDULED/WRONG_CONTRACTOR (409) are all known domain outcomes —
    // parse and return them rather than throwing.
    if (response.ok || response.status === 404 || response.status === 409) {
      return StartWorkAppointmentResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Appointment atom rejected the start-work operation",
        "APPOINTMENT_START_WORK_REJECTED"
      );
    }
    throw new Error(`Appointment atom request failed with ${response.status}`);
  }

  async function markAssignmentInProgress(
    input: MarkAssignmentInProgressInput
  ): Promise<MarkAssignmentInProgressResult> {
    const command = MarkAssignmentInProgressInputSchema.parse(input);
    const response = await fetchImpl(
      `${assignmentAtomUrl}/internal/assignments/start-work`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    // IN_PROGRESS/ALREADY_IN_PROGRESS (2xx), ASSIGNMENT_NOT_FOUND (404), and
    // NOT_ACCEPTED (409) are known domain outcomes.
    if (response.ok || response.status === 404 || response.status === 409) {
      return MarkAssignmentInProgressResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Assignment atom rejected the start-work operation",
        "ASSIGNMENT_START_WORK_REJECTED"
      );
    }
    throw new Error(`Assignment atom request failed with ${response.status}`);
  }

  async function markCaseInProgress(
    input: MarkCaseInProgressInput
  ): Promise<MarkCaseInProgressResult> {
    const command = MarkCaseInProgressInputSchema.parse(input);
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}/start-work`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    // IN_PROGRESS (2xx) and CASE_TERMINAL (409) are known domain outcomes.
    if (response.ok || response.status === 409) {
      const raw = z
        .object({
          outcome: z.string(),
          case: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(await response.json());
      if (raw.outcome !== "IN_PROGRESS" || !raw.case) {
        return MarkCaseInProgressResultSchema.parse(raw);
      }

      // The Case atom's row stores status/priority/category lowercase; the
      // contract's CaseDtoSchema requires them uppercase (same transform as
      // open-case.ts's response mapping).
      const record = raw.case;
      return MarkCaseInProgressResultSchema.parse({
        outcome: raw.outcome,
        case: {
          ...record,
          category: String(record.category).toUpperCase(),
          priority: String(record.priority).toUpperCase(),
          status: String(record.status).toUpperCase(),
          addressDetails: record.addressDetails ?? null,
          createdAt: record.createdAt ?? null,
          updatedAt: record.updatedAt ?? null,
        },
      });
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Case atom rejected the start-work operation",
        "CASE_START_WORK_REJECTED"
      );
    }
    throw new Error(`Case atom request failed with ${response.status}`);
  }

  return {
    startWorkAppointment,
    markAssignmentInProgress,
    markCaseInProgress,
  };
}
