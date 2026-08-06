import {
  defaultShouldDehydrateQuery,
  MutationCache,
  QueryCache,
  QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { isGatewayError } from "../libr/gateway";

/**
 * Fired from this one place so every query and mutation in all three
 * frontends gets degraded-service signalling for free (PRS-151-F). Branches
 * on `code`, not `retryable` alone — `WORKFLOW_UPDATE_PENDING` is also
 * `retryable: true`, but means "your request may still land", not "the
 * service is down".
 */
function onGatewayError(error: unknown) {
  if (!isGatewayError(error)) return;
  // Checked first and exclusively: the Gateway's effect-repair route folds a
  // genuine Temporal outage into this code with a 503 alongside it (same
  // status a real `*_ATOM_UNAVAILABLE` uses), so `code` must win over
  // `status` here or that route could never show the milder message.
  if (error.code === "WORKFLOW_UPDATE_PENDING") {
    toast("Still processing — refresh before retrying.");
    return;
  }
  const isServiceDown =
    error.status === 503 ||
    error.code === "TEMPORAL_UNAVAILABLE" ||
    (error.code?.endsWith("_ATOM_UNAVAILABLE") ?? false);
  if (isServiceDown) {
    // Stable `id` dedupes repeat failures into one toast; `duration:
    // Infinity` is load-bearing — a sustained outage must stay visible.
    toast.error("Service temporarily unavailable — some actions may fail.", {
      id: "service-unavailable",
      duration: Infinity,
    });
  }
}

function makeQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onGatewayError }),
    mutationCache: new MutationCache({ onError: onGatewayError }),
    defaultOptions: {
      queries: {
        staleTime: 1 * 60 * 1000, // 1 minute
      },
      dehydrate: {
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === "pending",
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined = undefined;

export function getQueryClient() {
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}
