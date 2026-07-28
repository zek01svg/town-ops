import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod/v4";

import { env } from "@/env";
import { clearAuth, getAuthHeader } from "@/libr/auth-token";

import { auditKeys } from "./audit-queries";
import { caseKeys } from "./query-keys";

async function throwIfRequestFailed(res: Response) {
  if (res.ok) return;
  if (res.status === 401) clearAuth();
  const parsed = z
    .object({
      message: z.string().optional(),
      error: z.object({ message: z.string().optional() }).optional(),
    })
    .safeParse(await res.json().catch(() => ({})));
  const body = parsed.success ? parsed.data : {};
  throw new Error(body.error?.message ?? body.message ?? `Error ${res.status}`);
}

export async function uploadProofFile(
  file: File,
  caseId: string,
  type: "before" | "after",
  idempotencyKey: string
) {
  const form = new FormData();
  form.append("file", file);
  form.append("type", type.toUpperCase());

  const res = await fetch(
    `${env.VITE_GATEWAY_URL}/api/cases/${caseId}/proof-items`,
    {
      method: "POST",
      headers: { ...getAuthHeader(), "Idempotency-Key": idempotencyKey },
      body: form,
    }
  );
  await throwIfRequestFailed(res);
  return z
    .object({
      data: z.object({
        id: z.string(),
        type: z.enum(["BEFORE", "AFTER"]),
        mediaUrl: z.string(),
      }),
    })
    .parse(await res.json()).data;
}

export async function getReadyProofItems(caseId: string) {
  const res = await fetch(
    `${env.VITE_GATEWAY_URL}/api/cases/${caseId}/proof-items`,
    {
      headers: getAuthHeader(),
    }
  );
  await throwIfRequestFailed(res);
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
    .parse(await res.json()).data;
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
    mutationFn: async (input: AcceptJobInput) => {
      const res = await fetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/allocation-attempts/${input.attemptId}/acceptance`,
        {
          method: "PUT",
          headers: {
            ...getAuthHeader(),
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            startTime: input.startTime,
            endTime: input.endTime,
          }),
        }
      );
      await throwIfRequestFailed(res);
      return res.json();
    },
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
    mutationFn: async (input: StartWorkInput) => {
      const res = await fetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/appointments/${input.appointmentId}/start-work`,
        {
          method: "PUT",
          headers: {
            ...getAuthHeader(),
            "Idempotency-Key": input.idempotencyKey,
          },
        }
      );
      await throwIfRequestFailed(res);
      return res.json();
    },
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
    mutationFn: async (input: CompleteCaseInput) => {
      const res = await fetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/completion`,
        {
          method: "PUT",
          headers: {
            ...getAuthHeader(),
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            report: input.report,
            proofItemIds: input.proofItemIds,
          }),
        }
      );
      await throwIfRequestFailed(res);
      return res.json();
    },
    onSuccess: (_, input) => {
      void qc.invalidateQueries({ queryKey: caseKeys.all });
      void qc.invalidateQueries({ queryKey: caseKeys.detail(input.caseId) });
      void qc.invalidateQueries({
        queryKey: caseKeys.appointments(input.caseId),
      });
      void qc.invalidateQueries({
        queryKey: caseKeys.proofItems(input.caseId),
      });
      void qc.invalidateQueries({ queryKey: auditKeys.timeline(input.caseId) });
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
    mutationFn: async (input: NoAccessInput) => {
      const res = await fetch(
        `${env.VITE_GATEWAY_URL}/api/cases/${input.caseId}/appointments/${input.appointmentId}/no-access`,
        {
          method: "PUT",
          headers: {
            ...getAuthHeader(),
            "Idempotency-Key": input.idempotencyKey,
          },
        }
      );
      await throwIfRequestFailed(res);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.all }),
  });
}
