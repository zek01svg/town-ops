import { queryOptions } from "@tanstack/react-query";

import { env } from "@/env";
import { fetchWithAuth } from "@/libr/auth-token";
import { auth } from "@/libr/auth";

import { mapApiCaseToItem } from "../lib/map-case";
import { caseKeys } from "./query-keys";

async function getContractorId(): Promise<string | null> {
  const session = await auth.getSession();
  return (session?.data?.user as any)?.contractorId ?? null;
}

export const caseQueries = {
  all: () =>
    queryOptions({
      queryKey: caseKeys.all,
      enabled: !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async () => {
        const contractorId = await getContractorId();
        if (!contractorId) return [];

        // Get all assignments for this contractor to get case IDs
        const assignmentsRes = await fetchWithAuth(
          `${env.VITE_ASSIGNMENT_ATOM_URL}/api/assignments/contractor/${contractorId}`,
          {},
          env.VITE_AUTH_URL,
        );
        if (!assignmentsRes.ok) return [];
        const { assignments } = await assignmentsRes.json();
        if (!assignments?.length) return [];

        const caseIds: string[] = [...new Set(assignments.map((a: any) => a.caseId as string))];

        // Fetch all cases, then filter to only this contractor's
        const res = await fetchWithAuth(
          `${env.VITE_CASE_ATOM_URL}/api/cases`,
          {},
          env.VITE_AUTH_URL,
        );
        if (!res.ok) throw new Error(`Failed to fetch cases: ${res.status}`);
        const data = await res.json();
        const allCases = (data.cases as unknown[]).map(mapApiCaseToItem);
        return allCases.filter((c) => caseIds.includes(c.id));
      },
    }),

  appointments: (caseId: string) =>
    queryOptions({
      queryKey: caseKeys.appointments(caseId),
      enabled: !!caseId && !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async () => {
        const res = await fetchWithAuth(
          `${env.VITE_APPOINTMENT_ATOM_URL}/api/appointments/${caseId}`,
          {},
          env.VITE_AUTH_URL,
        );
        if (!res.ok) throw new Error(`Failed to fetch appointments: ${res.status}`);
        return res.json();
      },
    }),
};
