import { queryOptions } from "@tanstack/react-query";
import {
  CaseDtoSchema,
  HistoricalContractorCaseDtoSchema,
  TimelineEventDtoSchema,
} from "@townops/orchestration-contract";
import { gatewayFetch } from "@townops/ui/libr/gateway";
import type { TimelineEvent } from "@townops/ui/libr/timeline";
import { toTimelineEvents } from "@townops/ui/libr/timeline";
import { z } from "zod/v4";

import { env } from "@/env";

import { mapApiCaseToItem } from "../lib/map-case";
import { caseKeys } from "./query-keys";

export type { TimelineEvent };

// No `participation` discriminator on the item, so this is a plain union,
// not a discriminated one. Safe either way round: the two schemas' required
// fields are disjoint (CaseDto needs residentId/addressDetails/postalCode,
// which the Gateway strips off a historical row; Historical needs
// postalSector, which a current row never carries), so exactly one branch
// ever parses clean and zod returns the first with zero issues. CaseDto
// first only because CURRENT is the common case.
const contractorCaseSchema = z.union([
  CaseDtoSchema,
  HistoricalContractorCaseDtoSchema,
]);

const casesResponseSchema = z.object({
  data: z.object({ items: z.array(contractorCaseSchema) }),
});

const timelineResponseSchema = z.object({
  data: z.object({
    items: z.array(TimelineEventDtoSchema),
    missingSources: z.array(z.string()),
  }),
});

export const caseQueries = {
  all: () =>
    queryOptions({
      queryKey: caseKeys.all,
      enabled: !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async () => {
        // ponytail: one page of 100. The Gateway returns no total, and the
        // job list derives every kanban bucket and detail sheet from this
        // one array — real pagination needs a total first.
        const body = await gatewayFetch(
          `${env.VITE_GATEWAY_URL}/api/cases?pageSize=100`,
          {},
          env.VITE_AUTH_URL
        );
        const parsed = casesResponseSchema.safeParse(body);
        if (!parsed.success) throw new Error("Invalid cases response");
        return parsed.data.data.items.map(mapApiCaseToItem);
      },
    }),

  // The Case's full timeline, merged and sorted ascending by the Gateway
  // across all seven atom sources. `missingSources` names which of them
  // were unreachable, so the caller can render a degraded-history strip
  // instead of a silently shorter timeline.
  timeline: (caseId: string) =>
    queryOptions({
      queryKey: caseKeys.timeline(caseId),
      enabled: !!caseId && !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async (): Promise<{
        events: TimelineEvent[];
        missingSources: string[];
      }> => {
        const body = await gatewayFetch(
          `${env.VITE_GATEWAY_URL}/api/cases/${caseId}/timeline`,
          {},
          env.VITE_AUTH_URL
        );
        const parsed = timelineResponseSchema.safeParse(body);
        if (!parsed.success) throw new Error("Invalid timeline response");
        // `detail: z.unknown()` makes the key optional on the inferred DTO
        // type (undefined is a valid `unknown`) — this re-asserts it present
        // so the structural `TimelineEventInput` (`detail: unknown`,
        // required) that `toTimelineEvents` is pinned to still matches.
        return {
          events: toTimelineEvents(
            parsed.data.data.items.map((event) => ({
              ...event,
              detail: event.detail,
            }))
          ),
          missingSources: parsed.data.data.missingSources,
        };
      },
    }),
};
