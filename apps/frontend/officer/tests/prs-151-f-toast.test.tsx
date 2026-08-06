// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { getQueryClient } from "@townops/ui/providers/get-query-client";
import { afterEach, beforeAll, expect, test } from "vitest";

import { Toaster } from "@/components/ui/sonner";

// Mocking the `sonner` package itself from here doesn't work: it's a phantom
// dependency of this app (only `@townops/ui` declares it), so `vi.mock`
// can't resolve a specifier to intercept and silently no-ops, while
// `get-query-client.ts`'s own import of `sonner` resolves fine from
// `packages/ui`'s own node_modules. Rendering the real `<Toaster/>` sidesteps
// the whole hazard — it's the same file `main.tsx` already mounts, and it
// resolves the same way `main.tsx` does (proven by that file's `tsc`/`vite
// build` passing clean).
beforeAll(() => {
  // sonner reaches for `matchMedia` (mobile/theme detection); jsdom has none
  // — TypeScript's DOM lib types it as always-present, so the assignment
  // below is unconditional rather than a `??=` the type checker would flag
  // as pointless against its own (wrong, for jsdom) types.
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
});

afterEach(() => cleanup());

/** A Gateway error shaped the way `gatewayFetch` throws one for a dead service. */
const outage = () =>
  Object.assign(new Error("Case workflow service is unavailable"), {
    code: "TEMPORAL_UNAVAILABLE",
    retryable: true,
    status: 503,
  });

/**
 * PRS-151-F, F3: `get-query-client.ts` fires from one shared `QueryCache`/
 * `MutationCache` `onError`, and it must branch on `code` before `status` —
 * the Gateway's `repairEffect` answers a genuine Temporal outage with
 * `status: 503` *and* `code: "WORKFLOW_UPDATE_PENDING"` at once, so checking
 * `status === 503` first would show the wrong toast for that route. This is
 * the exact collision that regressed once already during this change.
 */
test("a WORKFLOW_UPDATE_PENDING error (even at status 503) shows the auto-dismissing toast, not the persistent service-unavailable one", async () => {
  const client = getQueryClient();
  render(
    <QueryClientProvider client={client}>
      <Toaster />
    </QueryClientProvider>
  );
  const error = Object.assign(
    new Error("Effect repair is still being processed"),
    { code: "WORKFLOW_UPDATE_PENDING", retryable: true, status: 503 }
  );

  void client
    .fetchQuery({
      queryKey: ["prs-151-f-toast", "still-processing"],
      queryFn: () => Promise.reject(error),
      retry: false,
    })
    .catch(() => undefined);

  await screen.findByText("Still processing — refresh before retrying.");
  expect(
    screen.queryByText(
      "Service temporarily unavailable — some actions may fail."
    )
  ).toBeNull();
});

/**
 * The other half of the branch, and the half AC9 actually turns on: a service
 * that is *down* must say so, and keep saying so. Deliberately declared after
 * the test above — this one raises a `duration: Infinity` toast, and sonner
 * keeps its toast store at module scope, so a persistent toast raised first
 * would survive `cleanup()`'s unmount and break that test's absence assertion.
 */
test("a 503 service-down error raises the persistent toast, and repeats dedupe into one", async () => {
  const client = getQueryClient();
  render(
    <QueryClientProvider client={client}>
      <Toaster />
    </QueryClientProvider>
  );
  // Two independent failing queries, as a real outage produces — the whole
  // point of the stable toast `id` is that the user gets one banner, not one
  // per in-flight request. Without that `id` this second assertion sees 2.
  for (const key of ["outage-a", "outage-b"]) {
    void client
      .fetchQuery({
        queryKey: ["prs-151-f-toast", key],
        queryFn: () => Promise.reject(outage()),
        retry: false,
      })
      .catch(() => undefined);
  }

  await screen.findByText(
    "Service temporarily unavailable — some actions may fail."
  );
  expect(
    screen.getAllByText(
      "Service temporarily unavailable — some actions may fail."
    )
  ).toHaveLength(1);
});

/**
 * `duration: Infinity` is the single line that makes the outage notice
 * *persistent*, and AC9 is about a sustained outage. sonner's default
 * `TOAST_LIFETIME` is 4000ms, so every assertion that checks immediately after
 * firing passes whether or not that option is set — this waits past the
 * default window, which is the only way to tell the two apart.
 *
 * Real timers on purpose: sonner drives dismissal with its own `setTimeout`,
 * and fake timers fight testing-library's async flushing here.
 */
test("the service-down toast survives past sonner's default 4s lifetime", async () => {
  const client = getQueryClient();
  render(
    <QueryClientProvider client={client}>
      <Toaster />
    </QueryClientProvider>
  );

  void client
    .fetchQuery({
      queryKey: ["prs-151-f-toast", "sustained"],
      queryFn: () => Promise.reject(outage()),
      retry: false,
    })
    .catch(() => undefined);

  await screen.findByText(
    "Service temporarily unavailable — some actions may fail."
  );
  await new Promise((resolve) => setTimeout(resolve, 4500));

  expect(
    screen.getByText("Service temporarily unavailable — some actions may fail.")
  ).toBeDefined();
}, 10_000);
