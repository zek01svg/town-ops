import { queryOptions } from "@tanstack/react-query";
import {
  CaseDtoSchema,
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

const effectSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  status: z.enum(["PENDING", "SENT", "FAILED", "UNKNOWN", "WAIVED"]),
  attempts: z.number(),
  lastError: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  waiverReason: z.string().nullable(),
});
const effectsSchema = z.object({
  data: z.object({ items: z.array(effectSchema) }),
});
export type GatewayEffect = z.infer<typeof effectSchema>;

const gatewayCaseSchema = z.object({
  data: z
    .object({
      assignment: z
        .object({ appointment: gatewayAppointmentSchema.nullish() })
        .nullish(),
    })
    .nullish(),
});

const casesResponseSchema = z.object({
  data: z.object({ items: z.array(CaseDtoSchema) }),
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
        // dashboard derives stat cards, kanban buckets, map pins and the
        // detail sheet from this one array — real pagination needs a total
        // first.
        const body = await gatewayFetch(
          `${env.VITE_GATEWAY_URL}/api/cases?pageSize=100`,
          {},
          env.VITE_GATEWAY_URL
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
          env.VITE_GATEWAY_URL
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

  // The Case's live Appointment, as the Gateway projects it for an Officer.
  // It is the only read that names the Appointment id a Reschedule needs.
  gatewayAppointment: (caseId: string) =>
    queryOptions({
      queryKey: caseKeys.gatewayCase(caseId),
      enabled: !!caseId && !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async (): Promise<GatewayAppointment | null> => {
        const body = await gatewayFetch(
          `${env.VITE_GATEWAY_URL}/api/cases/${caseId}`,
          {},
          env.VITE_GATEWAY_URL
        );
        const parsed = gatewayCaseSchema.safeParse(body);
        if (!parsed.success) throw new Error("Invalid case response");
        return parsed.data.data?.assignment?.appointment ?? null;
      },
    }),

  effects: (caseId: string) =>
    queryOptions({
      queryKey: caseKeys.effects(caseId),
      enabled: !!caseId && !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async (): Promise<GatewayEffect[]> => {
        const body = await gatewayFetch(
          `${env.VITE_GATEWAY_URL}/api/cases/${caseId}/effects`,
          {},
          env.VITE_GATEWAY_URL
        );
        const parsed = effectsSchema.safeParse(body);
        if (!parsed.success) throw new Error("Invalid effects response");
        return parsed.data.data.items;
      },
    }),
};
