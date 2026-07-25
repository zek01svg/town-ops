import { queryOptions } from "@tanstack/react-query";
import { z } from "zod/v4";

import { env } from "@/env";
import { fetchWithAuth } from "@/libr/auth-token";

import { mapApiCaseToItem } from "../lib/map-case";
import { caseKeys } from "./query-keys";

// Tolerant schema — status stays `z.string()` so a terminal Appointment still
// parses; the UI only ever compares it against literals.
const gatewayAppointmentSchema = z.object({
  id: z.string(),
  status: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  reason: z.string().nullish(),
});

export type GatewayAppointment = z.infer<typeof gatewayAppointmentSchema>;

const gatewayCaseSchema = z.object({
  data: z
    .object({
      assignment: z
        .object({ appointment: gatewayAppointmentSchema.nullish() })
        .nullish(),
    })
    .nullish(),
});

export const caseQueries = {
  all: () =>
    queryOptions({
      queryKey: caseKeys.all,
      enabled: !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async () => {
        const res = await fetchWithAuth(
          `${env.VITE_CASE_ATOM_URL}/api/cases`,
          {},
          env.VITE_AUTH_URL
        );
        if (!res.ok) throw new Error(`Failed to fetch cases: ${res.status}`);
        const data: unknown = await res.json();
        if (
          !data ||
          typeof data !== "object" ||
          !("cases" in data) ||
          !Array.isArray(data.cases)
        ) {
          throw new Error("Invalid cases response");
        }
        return data.cases.map(mapApiCaseToItem);
      },
    }),

  // The Case's live Appointment, as the Gateway projects it for an Officer.
  // It is the only read that names the Appointment id a Reschedule needs.
  gatewayAppointment: (caseId: string) =>
    queryOptions({
      queryKey: caseKeys.gatewayCase(caseId),
      enabled: !!caseId && !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async (): Promise<GatewayAppointment | null> => {
        const res = await fetchWithAuth(
          `${env.VITE_GATEWAY_URL}/api/cases/${caseId}`,
          {},
          env.VITE_AUTH_URL
        );
        if (!res.ok) return null;
        const parsed = gatewayCaseSchema.safeParse(await res.json());
        return parsed.success
          ? (parsed.data.data?.assignment?.appointment ?? null)
          : null;
      },
    }),
};
