import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OpenCaseInput } from "@townops/orchestration-contract";
import { gatewayFetch } from "@townops/ui/libr/gateway";

import { env } from "@/env";

import { caseKeys } from "./query-keys";

export function useOpenCaseMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OpenCaseInput) =>
      gatewayFetch(
        `${env.VITE_GATEWAY_URL}/api/cases`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(input),
        },
        env.VITE_AUTH_URL
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: caseKeys.all });
    },
  });
}

export type ReplaceAppointmentInput = {
  caseId: string;
  appointmentId: string;
  startTime: string;
  endTime: string;
  reason?: string;
  idempotencyKey: string;
};

/**
 * Reschedules a Case's live Appointment. The Gateway requires the reason when
 * the Appointment is still SCHEDULED and accepts it without one when the
 * Contractor has already reported No Access — the caller decides which, from
 * the status it read.
 */
export function useReplaceAppointmentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReplaceAppointmentInput) =>
      gatewayFetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/appointments/${input.appointmentId}/replacement`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            startTime: input.startTime,
            endTime: input.endTime,
            reason: input.reason,
          }),
        },
        env.VITE_AUTH_URL
      ),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: caseKeys.all });
      void qc.invalidateQueries({
        queryKey: caseKeys.gatewayCase(vars.caseId),
      });
    },
  });
}

export type CancelCaseInput = {
  caseId: string;
  reason: string;
  idempotencyKey: string;
};

export function useCancelCaseMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CancelCaseInput) =>
      gatewayFetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/cancel`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({ reason: input.reason }),
        },
        env.VITE_AUTH_URL
      ),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: caseKeys.all });
      void qc.invalidateQueries({
        queryKey: caseKeys.gatewayCase(vars.caseId),
      });
    },
  });
}

export function useRepairEffectMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      caseId: string;
      effectId: string;
      action: "retry" | "waive";
      reason?: string;
      acknowledgeDuplicateRisk?: boolean;
    }) =>
      gatewayFetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/effects/${encodeURIComponent(input.effectId)}/${input.action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(
            input.action === "waive"
              ? { reason: input.reason }
              : { acknowledgeDuplicateRisk: input.acknowledgeDuplicateRisk }
          ),
        },
        env.VITE_AUTH_URL
      ),
    onSuccess: (_, input) => {
      void qc.invalidateQueries({ queryKey: caseKeys.effects(input.caseId) });
    },
  });
}
