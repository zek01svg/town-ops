import { useMutation, useQueryClient } from "@tanstack/react-query";

import { handleBreachClient, openCaseClient } from "@/libr/api";
import { clearAuth, getAuthHeader } from "@/libr/auth-token";

import type { OpenCaseInput } from "../validation-schemas";
import { caseKeys } from "./query-keys";

export function useOpenCaseMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: OpenCaseInput) => {
      const res = await openCaseClient.api.cases["open-case"].$post(
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: caseKeys.all });
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
      const res = await handleBreachClient.api.assignments["handle-breach"].$put(
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: caseKeys.all });
    },
  });
}
