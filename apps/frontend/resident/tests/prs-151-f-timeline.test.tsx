// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ResidentCaseDesk } from "../src/features/case/components/resident-case-desk";

const caseRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  residentId: "33333333-3333-4333-8333-333333333333",
  category: "LE",
  priority: "HIGH" as const,
  status: "ASSIGNED" as const,
  description: "Broken street light",
  addressDetails: null,
  postalCode: "123456",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  getMe: vi.fn(),
  listCases: vi.fn(),
  getCase: vi.fn(),
  getTimeline: vi.fn(),
  openCase: vi.fn(),
  cancelCase: vi.fn(),
  replaceAppointment: vi.fn(),
}));

vi.mock("@/libr/gateway", () => mocks);

function renderDesk() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ResidentCaseDesk />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.getMe.mockResolvedValue({
    accountId: caseRecord.residentId,
    role: "RESIDENT",
    residentId: caseRecord.residentId,
    contractorId: null,
    provisioningState: "PROVISIONED",
    canOpenCases: true,
  });
  mocks.listCases.mockResolvedValue([caseRecord]);
  mocks.getCase.mockResolvedValue({ ...caseRecord, appointment: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Opens the one seeded Case from the list, mounting `OpenedCase`. */
async function openTheCase() {
  renderDesk();
  const caseButton = await screen.findByText(/LE · HIGH/);
  caseButton.click();
  await waitFor(() => expect(mocks.getCase).toHaveBeenCalled());
}

test("a 503 on the timeline read renders an error, not the empty-state copy", async () => {
  mocks.getTimeline.mockRejectedValue(
    Object.assign(new Error("Case workflow service is unavailable"), {
      code: "TEMPORAL_UNAVAILABLE",
      retryable: true,
      status: 503,
    })
  );

  await openTheCase();

  // Regression this pins: a suppressed timeline read used to resolve to `[]`
  // (rendered as "No activity recorded yet."), making a 503 indistinguishable
  // from a Case with no history.
  await screen.findByText("Could not load activity history.");
  expect(screen.queryByText("No activity recorded yet.")).toBeNull();
});

test("a populated missingSources renders the generic line, not a source name (Resident role)", async () => {
  mocks.getTimeline.mockResolvedValue({
    events: [],
    missingSources: ["APPOINTMENT", "OFFICER_ATTENTION"],
  });

  await openTheCase();

  // `missingSources` is role-blind at the Gateway — a Resident must never
  // see the raw source name (`OFFICER_ATTENTION` would disclose nothing
  // secret here, but it is still the wrong copy for this role).
  await screen.findByText("Some history could not be loaded.");
  expect(screen.queryByText(/OFFICER_ATTENTION/)).toBeNull();
});
