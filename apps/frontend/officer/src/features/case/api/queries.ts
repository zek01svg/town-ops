import { queryOptions } from "@tanstack/react-query";

import { env } from "@/env";
import { fetchWithAuth } from "@/libr/auth-token";

import { mapApiCaseToItem } from "../lib/map-case";
import { caseKeys } from "./query-keys";

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
        const data = await res.json();
        return (data.cases as unknown[]).map(mapApiCaseToItem);
      },
    }),
};
