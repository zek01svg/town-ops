import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CancelCaseInput,
  ReplaceAppointmentInput,
} from "@townops/orchestration-contract";

import { cancelCase, replaceAppointment } from "@/libr/gateway";

import { caseKeys } from "./query-keys";

export type ReplaceAppointmentVariables = {
  caseId: string;
  appointmentId: string;
  input: ReplaceAppointmentInput;
  idempotencyKey: string;
};

/**
 * Reschedules the Resident's live Appointment through the Gateway — the only
 * backend this app can reach. A success invalidates the Case read so the panel
 * shows the new interval without a manual refresh.
 */
export function useReplaceAppointmentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (variables: ReplaceAppointmentVariables) =>
      replaceAppointment(
        variables.caseId,
        variables.appointmentId,
        variables.input,
        variables.idempotencyKey
      ),
    onSuccess: (_, variables) =>
      qc.invalidateQueries({ queryKey: caseKeys.detail(variables.caseId) }),
  });
}

export type CancelCaseVariables = {
  caseId: string;
  input: CancelCaseInput;
  idempotencyKey: string;
};

export function useCancelCaseMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (variables: CancelCaseVariables) =>
      cancelCase(variables.caseId, variables.input, variables.idempotencyKey),
    onSuccess: (_, variables) => {
      // Cancelling moves the Case's status, which the list row also shows —
      // both reads must go stale together.
      void qc.invalidateQueries({
        queryKey: caseKeys.detail(variables.caseId),
      });
      void qc.invalidateQueries({ queryKey: caseKeys.list });
    },
  });
}
