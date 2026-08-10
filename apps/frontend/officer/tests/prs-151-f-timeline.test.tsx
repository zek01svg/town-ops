// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CaseAuditTrail } from "../src/features/case/components/case-audit-trail";

vi.mock("../src/features/case/api/mutations", () => ({
  useCancelCaseMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useRepairEffectMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useReplaceAppointmentMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));

const caseId = "0ed5b7cc-b070-4e72-86b5-123456789abc";

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A benign 200 for whichever of the three Gateway routes isn't under test. */
function benignResponse(url: string): Response {
  if (url.includes("/effects")) return Response.json({ data: { items: [] } });
  if (url.endsWith(`/api/cases/${caseId}`)) {
    return Response.json({ data: { assignment: null } });
  }
  return Response.json({ data: { items: [], missingSources: [] } });
}

function renderTrail() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CaseAuditTrail caseId={caseId} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.setItem("jwt", "test-token");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

test("a 503 on the timeline read renders an error, not the empty-state copy", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = href(input);
    if (url.includes("/timeline")) {
      return Response.json(
        {
          error: {
            code: "TEMPORAL_UNAVAILABLE",
            message: "down",
            retryable: true,
          },
        },
        { status: 503 }
      );
    }
    return benignResponse(url);
  });

  renderTrail();

  // Regression this pins: F2 replaced `return []` on a failed timeline read
  // with a throw. If that suppressor is ever reinstated, the query resolves
  // to an empty array instead of erroring, and "No activity recorded yet."
  // would appear where "Could not load activity history." should — this
  // assertion fails either way that happens, not just on the positive half.
  // `findByText` itself throws if the node never appears, which is the
  // check; `queryByText` returns `null` rather than throwing, which is why
  // the negative half needs its own assertion.
  await screen.findByText("Could not load activity history.");
  expect(screen.queryByText("No activity recorded yet.")).toBeNull();
});

test("a populated missingSources renders the strip naming the actual sources (Officer role)", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = href(input);
    if (url.includes("/timeline")) {
      return Response.json({
        data: {
          items: [],
          missingSources: ["APPOINTMENT", "OFFICER_ATTENTION"],
        },
      });
    }
    return benignResponse(url);
  });

  renderTrail();

  // The Officer app is the one place `missingSources` names the actual
  // unreachable atoms rather than a generic line — a regression that swaps
  // this for the resident/contractor generic copy, or drops the strip
  // entirely, fails here.
  await screen.findByText("Could not load: APPOINTMENT, OFFICER_ATTENTION");
});
