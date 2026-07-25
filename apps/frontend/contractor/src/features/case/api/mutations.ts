import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod/v4";

import { env } from "@/env";
import { closeCaseClient } from "@/libr/api";
import { clearAuth, getAuthHeader } from "@/libr/auth-token";

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
  uploaderId: string,
  type: "before" | "after",
  remarks?: string
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("caseId", caseId);
  form.append("uploaderId", uploaderId);
  form.append("type", type);
  if (remarks) form.append("remarks", remarks);

  const res = await fetch(`${env.VITE_PROOF_ATOM_URL}/api/proof`, {
    method: "POST",
    headers: getAuthHeader(),
    body: form,
  });
  if (!res.ok) throw new Error(`Proof upload failed: ${res.status}`);
  const data = z
    .object({ proof: z.object({ mediaUrl: z.string() }) })
    .parse(await res.json());
  return data.proof.mediaUrl;
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

export type CloseCaseInput = {
  case_id: string;
  uploader_id: string;
  proof_items: Array<{
    media_url: string;
    type: "before" | "after" | "signature";
    remarks?: string;
  }>;
  final_status?: "completed";
};

export function useCloseCaseMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CloseCaseInput) => {
      const res = await closeCaseClient.api.cases["close-case"].$post(
        { json: input },
        { headers: getAuthHeader() }
      );
      await throwIfRequestFailed(res);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.all }),
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
