import { ApplicationFailure } from "@temporalio/activity";
import {
  MarkCaseAppointmentReplacedInputSchema,
  MarkCaseAppointmentReplacedResultSchema,
  MarkAppointmentMissedInputSchema,
  MarkAppointmentMissedResultSchema,
  MarkCaseNoAccessInputSchema,
  MarkCaseNoAccessResultSchema,
  ReplaceAppointmentSlotInputSchema,
  ReplaceAppointmentSlotResultSchema,
  ReportNoAccessAppointmentInputSchema,
  ReportNoAccessAppointmentResultSchema,
} from "@townops/orchestration-contract";
import type {
  MarkCaseAppointmentReplacedInput,
  MarkCaseAppointmentReplacedResult,
  MarkAppointmentMissedInput,
  MarkAppointmentMissedResult,
  MarkCaseNoAccessInput,
  MarkCaseNoAccessResult,
  ReplaceAppointmentSlotInput,
  ReplaceAppointmentSlotResult,
  ReportNoAccessAppointmentInput,
  ReportNoAccessAppointmentResult,
} from "@townops/orchestration-contract";
import { z } from "zod/v4";

type AppointmentRecoveryActivityDependencies = {
  appointmentAtomUrl: string;
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

// Both Case-atom routes answer with a raw row, which has to be re-cased
// before the contract's CaseDtoSchema will accept it — so the outcome is read
// first, off a shape loose enough to hold the untransformed row.
const caseAtomResponseSchema = z.object({
  outcome: z.string(),
  case: z.record(z.string(), z.unknown()).optional(),
});

/**
 * No-Access and reschedule Saga I/O for PRS-146. Same discipline as
 * start-work.ts: every domain outcome the atoms can return — including the
 * ones they answer with 404/409 — is parsed and returned, so only a genuinely
 * unexpected 4xx or a transient 5xx/network failure throws and the Workflow's
 * Saga stays the sole place that decides what an outcome means.
 */
export function createAppointmentRecoveryActivities({
  appointmentAtomUrl,
  caseAtomUrl,
  workerServiceToken,
  fetchImpl = fetch,
}: AppointmentRecoveryActivityDependencies) {
  async function reportNoAccessAppointment(
    input: ReportNoAccessAppointmentInput
  ): Promise<ReportNoAccessAppointmentResult> {
    const command = ReportNoAccessAppointmentInputSchema.parse(input);
    const response = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/no-access`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    // NO_ACCESS/ALREADY_NO_ACCESS (2xx), APPOINTMENT_NOT_FOUND (404), and
    // NOT_SCHEDULED/WRONG_CONTRACTOR (409) are all known domain outcomes.
    if (response.ok || response.status === 404 || response.status === 409) {
      return ReportNoAccessAppointmentResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Appointment atom rejected the no-access operation",
        "APPOINTMENT_NO_ACCESS_REJECTED"
      );
    }
    throw new Error(`Appointment atom request failed with ${response.status}`);
  }

  async function markAppointmentMissed(
    input: MarkAppointmentMissedInput
  ): Promise<MarkAppointmentMissedResult> {
    const command = MarkAppointmentMissedInputSchema.parse(input);
    const response = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/missed`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    if (response.ok || response.status === 404 || response.status === 409) {
      return MarkAppointmentMissedResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Appointment atom rejected the missed-appointment operation",
        "APPOINTMENT_MISSED_REJECTED"
      );
    }
    throw new Error(`Appointment atom request failed with ${response.status}`);
  }

  async function markCaseNoAccess(
    input: MarkCaseNoAccessInput
  ): Promise<MarkCaseNoAccessResult> {
    const command = MarkCaseNoAccessInputSchema.parse(input);
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}/no-access`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    // PENDING_RESIDENT_INPUT (2xx) and CASE_TERMINAL (409) are known domain
    // outcomes.
    if (response.ok || response.status === 409) {
      const raw = caseAtomResponseSchema.parse(await response.json());
      if (raw.outcome !== "PENDING_RESIDENT_INPUT" || !raw.case) {
        return MarkCaseNoAccessResultSchema.parse(raw);
      }

      // The Case atom's row stores status/priority/category lowercase; the
      // contract's CaseDtoSchema requires them uppercase (same transform as
      // start-work.ts's markCaseInProgress).
      const record = raw.case;
      return MarkCaseNoAccessResultSchema.parse({
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
        "Case atom rejected the no-access operation",
        "CASE_NO_ACCESS_REJECTED"
      );
    }
    throw new Error(`Case atom request failed with ${response.status}`);
  }

  async function replaceAppointmentSlot(
    input: ReplaceAppointmentSlotInput
  ): Promise<ReplaceAppointmentSlotResult> {
    const command = ReplaceAppointmentSlotInputSchema.parse(input);
    const response = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/replacements`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    // REPLACED/ALREADY_REPLACED (2xx), APPOINTMENT_NOT_FOUND (404), and
    // NOT_REPLACEABLE/CASE_MISMATCH/CONFLICT (409) are known domain outcomes.
    if (response.ok || response.status === 404 || response.status === 409) {
      return ReplaceAppointmentSlotResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Appointment atom rejected the replacement operation",
        "APPOINTMENT_REPLACEMENT_REJECTED"
      );
    }
    throw new Error(`Appointment atom request failed with ${response.status}`);
  }

  async function markCaseAppointmentReplaced(
    input: MarkCaseAppointmentReplacedInput
  ): Promise<MarkCaseAppointmentReplacedResult> {
    const command = MarkCaseAppointmentReplacedInputSchema.parse(input);
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}/appointment-replaced`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    // REPLACED (2xx) and CASE_TERMINAL (409) are known domain outcomes.
    if (response.ok || response.status === 409) {
      const raw = caseAtomResponseSchema.parse(await response.json());
      if (raw.outcome !== "REPLACED" || !raw.case) {
        return MarkCaseAppointmentReplacedResultSchema.parse(raw);
      }

      // Same lowercase-row re-casing as markCaseNoAccess above.
      const record = raw.case;
      return MarkCaseAppointmentReplacedResultSchema.parse({
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
        "Case atom rejected the appointment-replaced operation",
        "CASE_APPOINTMENT_REPLACED_REJECTED"
      );
    }
    throw new Error(`Case atom request failed with ${response.status}`);
  }

  return {
    reportNoAccessAppointment,
    markAppointmentMissed,
    markCaseNoAccess,
    replaceAppointmentSlot,
    markCaseAppointmentReplaced,
  };
}
