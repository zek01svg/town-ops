// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CaseAuditTrail } from "../src/features/case/components/case-audit-trail";

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../src/libr/auth", () => ({
  auth: { getSession: mocks.getSession },
}));

vi.mock("../src/libr/auth-token", () => ({
  fetchWithAuth: mocks.fetchWithAuth,
}));

vi.mock("../src/features/case/api/audit-queries", () => ({
  auditQueries: {
    timeline: (caseId: string) => ({
      queryKey: ["audit", caseId],
      queryFn: async () => [],
    }),
  },
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
  CloseJobSheet: ({ canComplete }: { canComplete: boolean }) => (
    <output data-testid="completion-gate">{String(canComplete)}</output>
  ),
}));

const caseId = "0ed5b7cc-b070-4e72-86b5-123456789abc";
const contractorId = "11111111-1111-4111-8111-111111111111";
const otherContractorId = "22222222-2222-4222-8222-222222222222";

function renderTrail(
  caseStatus: "in_progress" | "completed",
  appointmentStatus: "IN_PROGRESS" | "SCHEDULED",
  appointmentContractorId = contractorId
) {
  mocks.fetchWithAuth.mockResolvedValue(
    Response.json({
      data: {
        assignment: {
          id: "33333333-3333-4333-8333-333333333333",
          currentAttempt: {
            id: "44444444-4444-4444-8444-444444444444",
            status: "ACCEPTED",
            deadlineAt: "2030-01-01T00:00:00.000Z",
          },
          appointment: {
            id: "55555555-5555-4555-8555-555555555555",
            contractorId: appointmentContractorId,
            status: appointmentStatus,
            startTime: "2030-01-01T09:00:00.000Z",
            endTime: "2030-01-01T10:00:00.000Z",
          },
        },
      },
    })
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CaseAuditTrail
        caseId={caseId}
        caseData={{
          id: caseId,
          residentId: "resident-1",
          address: "1 Test Street",
          category: "Lighting",
          priority: "high",
          status: caseStatus,
          description: "Replace lamp",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        }}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.setItem("jwt", "test-token");
  mocks.getSession.mockResolvedValue({
    data: { user: { contractorId } },
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.fetchWithAuth.mockReset();
  mocks.getSession.mockReset();
});

const completionGateCases: Array<{
  reason: string;
  caseStatus: Parameters<typeof renderTrail>[0];
  appointmentStatus: Parameters<typeof renderTrail>[1];
  appointmentContractorId: string;
  expected: boolean;
}> = [
  {
    reason: "the Case and owned Appointment are both in progress",
    caseStatus: "in_progress",
    appointmentStatus: "IN_PROGRESS",
    appointmentContractorId: contractorId,
    expected: true,
  },
  {
    reason: "the Case is completed",
    caseStatus: "completed",
    appointmentStatus: "IN_PROGRESS",
    appointmentContractorId: contractorId,
    expected: false,
  },
  {
    reason: "the Appointment is not in progress",
    caseStatus: "in_progress",
    appointmentStatus: "SCHEDULED",
    appointmentContractorId: contractorId,
    expected: false,
  },
  {
    reason: "the Appointment belongs to another Contractor",
    caseStatus: "in_progress",
    appointmentStatus: "IN_PROGRESS",
    appointmentContractorId: otherContractorId,
    expected: false,
  },
];

test.each(completionGateCases)(
  "enables completion only when $reason",
  async ({
    caseStatus,
    appointmentStatus,
    appointmentContractorId,
    expected,
  }) => {
    renderTrail(caseStatus, appointmentStatus, appointmentContractorId);

    await waitFor(() => {
      expect(screen.getByTestId("completion-gate").textContent).toBe(
        String(expected)
      );
    });
  }
);
