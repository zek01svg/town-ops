import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReplaceAppointmentInput } from "@townops/orchestration-contract";

import { replaceAppointment } from "@/libr/gateway";

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
      qc.invalidateQueries({ queryKey: ["case", variables.caseId] }),
  });
}
