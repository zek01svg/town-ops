import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod/v4";

import { env } from "@/env";
import { handleBreachClient, openCaseClient } from "@/libr/api";
import { clearAuth, fetchWithAuth, getAuthHeader } from "@/libr/auth-token";

import type { OpenCaseInput } from "../validation-schemas";
import { caseKeys } from "./query-keys";

const errorMessageSchema = z.object({ message: z.string().optional() });

export function useOpenCaseMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: OpenCaseInput) => {
      const res = await openCaseClient.api.cases["open-case"].$post(
        { json: input },
        { headers: getAuthHeader() }
      );
      if (String(res.status) === "401") clearAuth();
      if (!res.ok) {
        const error = errorMessageSchema.safeParse(
          await res.json().catch(() => undefined)
        );
        throw new Error(error.data?.message ?? `Error ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: caseKeys.all });
    },
  });
}

const gatewayErrorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
});

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
    mutationFn: async (input: ReplaceAppointmentInput) => {
      const res = await fetchWithAuth(
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
      );
      if (!res.ok) {
        const body = gatewayErrorSchema.safeParse(
          await res.json().catch(() => ({}))
        );
        throw new Error(
          body.data?.error?.message ?? `The reschedule failed (${res.status})`
        );
      }
      return res.json();
    },
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: caseKeys.all });
      void qc.invalidateQueries({
        queryKey: caseKeys.gatewayCase(vars.caseId),
      });
    },
  });
}

export type HandleBreachInput = {
  assignment_id: string;
  case_id: string;
  breach_details: string;
  new_assignee_id: string;
  penalty: number;
};

export function useHandleBreachMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: HandleBreachInput) => {
      const res = await handleBreachClient.api.assignments[
        "handle-breach"
      ].$put({ json: input }, { headers: getAuthHeader() });
      if (String(res.status) === "401") clearAuth();
      if (!res.ok) {
        const error = errorMessageSchema.safeParse(
          await res.json().catch(() => undefined)
        );
        throw new Error(error.data?.message ?? `Error ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: caseKeys.all });
    },
  });
}
