import { useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@townops/ui/libr/gateway";
import { z } from "zod/v4";

import { env } from "@/env";

import { caseKeys } from "./query-keys";

export async function uploadProofFile(
  file: File,
  caseId: string,
  type: "before" | "after",
  idempotencyKey: string
) {
  const form = new FormData();
  form.append("file", file);
  form.append("type", type.toUpperCase());

  const body = await gatewayFetch(
    `${env.VITE_GATEWAY_URL}/api/cases/${caseId}/proof-items`,
    {
      method: "POST",
      // No Content-Type here — the browser sets the multipart boundary for
      // FormData bodies; fetchWithAuth only ever overwrites Authorization.
      headers: { "Idempotency-Key": idempotencyKey },
      body: form,
    },
    env.VITE_GATEWAY_URL
  );
  return z
    .object({
      data: z.object({
        id: z.string(),
        type: z.enum(["BEFORE", "AFTER"]),
        mediaUrl: z.string(),
      }),
    })
    .parse(body).data;
}

export async function getReadyProofItems(caseId: string) {
  const body = await gatewayFetch(
    `${env.VITE_GATEWAY_URL}/api/cases/${caseId}/proof-items`,
    {},
    env.VITE_GATEWAY_URL
  );
  return z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          type: z.enum(["BEFORE", "AFTER", "SIGNATURE"]),
          mediaUrl: z.string(),
        })
      ),
    })
    .parse(body).data;
}

export type AcceptJobInput = {
  caseId: string;
  attemptId: string;
  startTime: string;
  endTime: string;
  idempotencyKey: string;
};

export function useAcceptJobMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptJobInput) =>
      gatewayFetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/allocation-attempts/${input.attemptId}/acceptance`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            startTime: input.startTime,
            endTime: input.endTime,
          }),
        },
        env.VITE_GATEWAY_URL
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.all }),
  });
}

export type StartWorkInput = {
  caseId: string;
  appointmentId: string;
  idempotencyKey: string;
};

export function useStartWorkMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartWorkInput) =>
      gatewayFetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/appointments/${input.appointmentId}/start-work`,
        {
          method: "PUT",
          headers: {
            "Idempotency-Key": input.idempotencyKey,
          },
        },
        env.VITE_GATEWAY_URL
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.all }),
  });
}

export type CompleteCaseInput = {
  caseId: string;
  report: string;
  proofItemIds: string[];
  idempotencyKey: string;
};

export function useCompleteCaseMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CompleteCaseInput) =>
      gatewayFetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/completion`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            report: input.report,
            proofItemIds: input.proofItemIds,
          }),
        },
        env.VITE_GATEWAY_URL
      ),
    onSuccess: (_, input) => {
      void qc.invalidateQueries({ queryKey: caseKeys.all });
      void qc.invalidateQueries({ queryKey: caseKeys.detail(input.caseId) });
      void qc.invalidateQueries({
        queryKey: caseKeys.proofItems(input.caseId),
      });
      void qc.invalidateQueries({ queryKey: caseKeys.timeline(input.caseId) });
      void qc.invalidateQueries({ queryKey: ["gateway-case", input.caseId] });
    },
  });
}

export type NoAccessInput = {
  caseId: string;
  appointmentId: string;
  idempotencyKey: string;
};

export function useNoAccessMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NoAccessInput) =>
      gatewayFetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/appointments/${input.appointmentId}/no-access`,
        {
          method: "PUT",
          headers: {
            "Idempotency-Key": input.idempotencyKey,
          },
        },
        env.VITE_GATEWAY_URL
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.all }),
  });
}
