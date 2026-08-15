import {
  DerivedEffectSummarySchema,
  RecordPerformanceEntryInputSchema,
  withServerlessAuth,
} from "@townops/orchestration-contract";
import type { DerivedEffectSummary } from "@townops/orchestration-contract";
import { z } from "zod/v4";

type EmailEffect = {
  id: string;
  caseId: string;
  type: "EMAIL";
  purpose:
    | "ATTEMPT_ASSIGNMENT_NOTIFICATION"
    | "ATTEMPT_BREACH_NOTIFICATION"
    | "APPOINTMENT_NO_ACCESS_NOTIFICATION"
    | "APPOINTMENT_RESCHEDULE_RESIDENT_NOTIFICATION"
    | "APPOINTMENT_RESCHEDULE_CONTRACTOR_NOTIFICATION"
    | "ASSIGNMENT_COMPLETION_NOTIFICATION";
  recipient: { type: "RESIDENT" | "CONTRACTOR"; id: string };
  startTime?: string;
  endTime?: string;
};

type PerformanceEffect = {
  id: string;
  caseId: string;
  type: "PERFORMANCE_ENTRY";
  purpose: "ATTEMPT_BREACH_PERFORMANCE" | "ASSIGNMENT_COMPLETION_PERFORMANCE";
  contractorId: string;
  scoreDelta: number;
  reason: string;
};

export type DerivedEffectIntent = EmailEffect | PerformanceEffect;

type Dependencies = {
  alertAtomUrl: string;
  residentAtomUrl: string;
  contractorAtomUrl: string;
  metricsAtomUrl: string;
  caseAtomUrl: string;
  workerServiceToken: string;
  fetchImpl?: typeof fetch;
  // Mints the Cloud Run IAM ID token `withServerlessAuth` attaches to every
  // atom call (PRS-140 Phase 5). Defaults to the real metadata-server minter.
  mintIdentityToken?: (audience: string) => Promise<string | undefined>;
};

const summaryResponseSchema = z.object({
  effect: DerivedEffectSummarySchema.nullable(),
});
const contactResponseSchema = z.object({
  contact: z.object({ email: z.email() }),
});
const retryConflictSchema = z.object({ error: z.string().optional() });

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function effectPath(id: string) {
  return encodeURIComponent(id);
}

function emailFor(effect: EmailEffect, to: string) {
  const subjectByPurpose = {
    ATTEMPT_ASSIGNMENT_NOTIFICATION: "TownOps: Job Assigned",
    ATTEMPT_BREACH_NOTIFICATION: "TownOps: Assignment Acceptance Overdue",
    APPOINTMENT_NO_ACCESS_NOTIFICATION: "TownOps: Access Issue Encountered",
    APPOINTMENT_RESCHEDULE_RESIDENT_NOTIFICATION:
      "TownOps: Appointment Rescheduled",
    APPOINTMENT_RESCHEDULE_CONTRACTOR_NOTIFICATION:
      "TownOps: Appointment Rescheduled",
    ASSIGNMENT_COMPLETION_NOTIFICATION: "TownOps: Job Completed",
  } as const;
  const body =
    effect.purpose === "ATTEMPT_ASSIGNMENT_NOTIFICATION"
      ? "You have been assigned a job."
      : effect.purpose === "ATTEMPT_BREACH_NOTIFICATION"
        ? "The acceptance deadline for your assignment has passed."
        : effect.purpose === "APPOINTMENT_NO_ACCESS_NOTIFICATION"
          ? "A contractor could not access the property."
          : effect.purpose === "ASSIGNMENT_COMPLETION_NOTIFICATION"
            ? "The work on your case is complete."
            : `Your appointment has been rescheduled to ${effect.startTime} – ${effect.endTime}.`;
  return {
    to,
    subject: subjectByPurpose[effect.purpose],
    html: `<h1>${subjectByPurpose[effect.purpose].replace("TownOps: ", "")}</h1><p>${body}</p><p>Case ID: ${effect.caseId}</p>`,
  };
}

export function createDerivedEffectActivities({
  alertAtomUrl,
  residentAtomUrl,
  contractorAtomUrl,
  metricsAtomUrl,
  caseAtomUrl,
  workerServiceToken,
  fetchImpl: injectedFetch = fetch,
  mintIdentityToken,
}: Dependencies) {
  const fetchImpl = withServerlessAuth(injectedFetch, mintIdentityToken);
  async function parseEffect(response: Response) {
    const body = summaryResponseSchema.parse(await response.json());
    if (!body.effect)
      throw new Error("Effect endpoint did not return an effect");
    return body.effect;
  }

  async function reserveEffect(
    intent: DerivedEffectIntent
  ): Promise<DerivedEffectSummary> {
    const existing = await fetchImpl(
      `${alertAtomUrl}/internal/effects/${effectPath(intent.id)}`,
      {
        headers: { Authorization: `Bearer ${workerServiceToken}` },
      }
    );
    if (existing.ok) return parseEffect(existing);
    if (existing.status !== 404) {
      throw new Error(`Effect lookup failed with ${existing.status}`);
    }

    let payload: Record<string, unknown>;
    if (intent.type === "EMAIL") {
      const atomUrl =
        intent.recipient.type === "RESIDENT"
          ? residentAtomUrl
          : contractorAtomUrl;
      const response = await fetchImpl(
        `${atomUrl}/internal/${intent.recipient.type === "RESIDENT" ? "residents" : "contractors"}/${intent.recipient.id}/contact`,
        { headers: { Authorization: `Bearer ${workerServiceToken}` } }
      );
      if (!response.ok)
        throw new Error(`Contact lookup failed with ${response.status}`);
      const { contact } = contactResponseSchema.parse(await response.json());
      payload = { ...intent, ...emailFor(intent, contact.email) };
    } else {
      payload = intent;
    }
    const response = await fetchImpl(
      `${alertAtomUrl}/internal/effects/reserve`,
      {
        method: "POST",
        headers: headers(workerServiceToken),
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok)
      throw new Error(`Effect reservation failed with ${response.status}`);
    return parseEffect(response);
  }

  async function dispatchEmailEffect(input: {
    id: string;
    nextRetryAt: string;
  }) {
    const response = await fetchImpl(
      `${alertAtomUrl}/internal/effects/${effectPath(input.id)}/dispatch-email`,
      {
        method: "POST",
        headers: headers(workerServiceToken),
        body: JSON.stringify({ nextRetryAt: input.nextRetryAt }),
      }
    );
    if (!response.ok)
      throw new Error(`Email dispatch failed with ${response.status}`);
    return parseEffect(response);
  }

  async function dispatchPerformanceEffect(input: {
    id: string;
    contractorId: string;
    scoreDelta: number;
    reason: string;
    nextRetryAt: string;
  }) {
    const begun = await fetchImpl(
      `${alertAtomUrl}/internal/effects/${effectPath(input.id)}/begin`,
      {
        method: "POST",
        headers: headers(workerServiceToken),
      }
    );
    if (!begun.ok) throw new Error(`Effect begin failed with ${begun.status}`);
    const existing = await parseEffect(begun);
    if (existing.status !== "PENDING") return existing;
    try {
      const response = await fetchImpl(
        `${metricsAtomUrl}/internal/performance/entries`,
        {
          method: "POST",
          headers: headers(workerServiceToken),
          body: JSON.stringify(
            RecordPerformanceEntryInputSchema.parse({
              effectId: input.id,
              contractorId: input.contractorId,
              scoreDelta: input.scoreDelta,
              reason: input.reason,
            })
          ),
        }
      );
      if (!response.ok)
        throw new Error(`Metrics entry failed with ${response.status}`);
      const metric = z
        .object({ entry: z.object({ id: z.string() }) })
        .parse(await response.json());
      const completed = await fetchImpl(
        `${alertAtomUrl}/internal/effects/${effectPath(input.id)}/succeed`,
        {
          method: "POST",
          headers: headers(workerServiceToken),
          body: JSON.stringify({ providerId: metric.entry.id }),
        }
      );
      if (!completed.ok)
        throw new Error(`Effect completion failed with ${completed.status}`);
      return parseEffect(completed);
    } catch (error) {
      const failed = await fetchImpl(
        `${alertAtomUrl}/internal/effects/${effectPath(input.id)}/fail`,
        {
          method: "POST",
          headers: headers(workerServiceToken),
          body: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            nextRetryAt: input.nextRetryAt,
          }),
        }
      );
      if (!failed.ok) throw error;
      return parseEffect(failed);
    }
  }

  async function markEffectUnknown(id: string) {
    const response = await fetchImpl(
      `${alertAtomUrl}/internal/effects/${effectPath(id)}/unknown`,
      {
        method: "POST",
        headers: headers(workerServiceToken),
      }
    );
    if (!response.ok)
      throw new Error(
        `Effect unknown transition failed with ${response.status}`
      );
    return parseEffect(response);
  }

  async function retryEffect(input: {
    id: string;
    acknowledgeDuplicateRisk: boolean;
  }) {
    const response = await fetchImpl(
      `${alertAtomUrl}/internal/effects/${effectPath(input.id)}/retry`,
      {
        method: "POST",
        headers: headers(workerServiceToken),
        body: JSON.stringify(input),
      }
    );
    if (response.status === 404) return { kind: "NOT_FOUND" as const };
    if (response.status === 409) {
      const parsed = retryConflictSchema.safeParse(await response.json());
      const requiresAck =
        parsed.success && parsed.data.error?.includes("acknowledgement");
      return requiresAck
        ? { kind: "ACK_REQUIRED" as const }
        : { kind: "NOT_REPAIRABLE" as const };
    }
    if (!response.ok)
      throw new Error(`Effect retry failed with ${response.status}`);
    return { kind: "SUCCESS" as const, effect: await parseEffect(response) };
  }

  async function waiveEffect(input: {
    id: string;
    actorId: string;
    reason: string;
  }) {
    const response = await fetchImpl(
      `${alertAtomUrl}/internal/effects/${effectPath(input.id)}/waive`,
      {
        method: "POST",
        headers: headers(workerServiceToken),
        body: JSON.stringify(input),
      }
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`Effect waiver failed with ${response.status}`);
    return parseEffect(response);
  }

  async function raiseDerivedEffectAttention(input: {
    caseId: string;
    effectId: string;
    detail: string;
  }) {
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${input.caseId}/derived-effect-attention`,
      {
        method: "POST",
        headers: headers(workerServiceToken),
        body: JSON.stringify({
          kind: "DERIVED_EFFECT_UNKNOWN",
          detail: input.detail,
          effectId: input.effectId,
          operationId: `${input.effectId}/attention`,
        }),
      }
    );
    if (!response.ok)
      throw new Error(`Effect attention failed with ${response.status}`);
  }

  async function resolveDerivedEffectAttention(input: {
    caseId: string;
    effectId: string;
  }) {
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${input.caseId}/derived-effect-attention/${effectPath(input.effectId)}/resolve`,
      {
        method: "POST",
        headers: headers(workerServiceToken),
        body: JSON.stringify({ operationId: `${input.effectId}/resolved` }),
      }
    );
    if (!response.ok && response.status !== 204)
      throw new Error(
        `Effect attention resolution failed with ${response.status}`
      );
  }

  return {
    reserveEffect,
    dispatchEmailEffect,
    dispatchPerformanceEffect,
    markEffectUnknown,
    retryEffect,
    waiveEffect,
    raiseDerivedEffectAttention,
    resolveDerivedEffectAttention,
  };
}
