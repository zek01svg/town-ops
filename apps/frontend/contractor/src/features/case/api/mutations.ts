import { useMutation, useQueryClient } from "@tanstack/react-query";

import { env } from "@/env";
import {
  acceptJobClient,
  closeCaseClient,
  handleNoAccessClient,
  rescheduleJobClient,
} from "@/libr/api";
import { clearAuth, getAuthHeader } from "@/libr/auth-token";

import { caseKeys } from "./query-keys";

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
  const data = await res.json();
  return data.proof.mediaUrl as string;
}

export type AcceptJobInput = {
  case_id: string;
  assignment_id: string;
  contractor_id: string;
  start_time: string;
  end_time: string;
};

export function useAcceptJobMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AcceptJobInput) => {
      const res = await acceptJobClient.api.jobs["accept-job"].$put(
        { json: input },
        { headers: getAuthHeader() }
      );
      if (res.status === 401) clearAuth();
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).message ?? `Error ${res.status}`);
      }
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
      if (res.status === 401) clearAuth();
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).message ?? `Error ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.all }),
  });
}

export type RescheduleJobInput = {
  appointmentId: string;
  residentId: string;
  caseId: string;
  assignmentId: string;
  newStartTime: string;
  newEndTime: string;
};

export function useRescheduleJobMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RescheduleJobInput) => {
      const res = await rescheduleJobClient.api.cases["reschedule-job"].$post(
        { json: input },
        { headers: getAuthHeader() }
      );
      if (res.status === 401) clearAuth();
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).message ?? `Error ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: caseKeys.all });
      qc.invalidateQueries({ queryKey: caseKeys.appointments(vars.caseId) });
    },
  });
}

export type NoAccessInput = {
  case_id: string;
  assignment_id: string;
  contractor_id: string;
  reason?: string;
};

export function useNoAccessMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NoAccessInput) => {
      const res = await handleNoAccessClient.api.cases["no-access"].$put(
        { json: input },
        { headers: getAuthHeader() }
      );
      if (res.status === 401) clearAuth();
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).message ?? `Error ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.all }),
  });
}
