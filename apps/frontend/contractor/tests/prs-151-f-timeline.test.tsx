// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CaseAuditTrail } from "../src/features/case/components/case-audit-trail";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../src/libr/auth", () => ({
  auth: { getSession: mocks.getSession },
}));

vi.mock("../src/features/case/api/mutations", () => ({
  useAcceptJobMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useNoAccessMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useStartWorkMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));

vi.mock("../src/features/case/components/close-job-sheet", () => ({
  CloseJobSheet: () => null,
}));

const caseId = "0ed5b7cc-b070-4e72-86b5-123456789abc";
const contractorId = "11111111-1111-4111-8111-111111111111";

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A benign 200 for the case/assignment envelope route (`useGatewayAssignment`). */
function benignResponse(): Response {
  return Response.json({ data: { assignment: null } });
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
  mocks.getSession.mockResolvedValue({ data: { user: { contractorId } } });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.getSession.mockReset();
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
    return benignResponse();
  });

  renderTrail();

  // Regression this pins: F2 replaced `return []` on a failed timeline read
  // with a throw. `queryByText` (not `findByText`) is required for the
  // negative half — it returns `null` on a miss instead of throwing.
  await screen.findByText("Could not load activity history.");
  expect(screen.queryByText("No activity recorded yet.")).toBeNull();
});

test("a populated missingSources renders the generic line, not a source name (Contractor role)", async () => {
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
    return benignResponse();
  });

  renderTrail();

  // `missingSources` is role-blind — a Contractor must never see the raw
  // source name (`OFFICER_ATTENTION` here would be confusing, not a leak,
  // but still wrong copy for this role) — only the generic warning.
  await screen.findByText("Some history could not be loaded.");
  expect(screen.queryByText(/OFFICER_ATTENTION/)).toBeNull();
});
