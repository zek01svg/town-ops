// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { CloseJobSheet } from "../src/features/case/components/close-job-sheet";

const mocks = vi.hoisted(() => ({
  getReadyProofItems: vi.fn(),
  uploadProofFile: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("../src/features/case/api/mutations", () => ({
  getReadyProofItems: mocks.getReadyProofItems,
  uploadProofFile: mocks.uploadProofFile,
  useCompleteCaseMutation: () => ({ mutate: mocks.complete, isPending: false }),
}));

const caseId = "0ed5b7cc-b070-4e72-86b5-123456789abc";
const beforeId = "11111111-1111-4111-8111-111111111111";
const afterId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.complete.mockReset();
  mocks.getReadyProofItems.mockReset();
  mocks.uploadProofFile.mockReset();
});

test("loads ready proof, requires both types, and keeps the completion key stable for an unchanged payload", async () => {
  mocks.getReadyProofItems.mockResolvedValue([
    { id: beforeId, type: "BEFORE", mediaUrl: "https://proof.example/before" },
    { id: afterId, type: "AFTER", mediaUrl: "https://proof.example/after" },
  ]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <CloseJobSheet open onOpenChange={vi.fn()} caseId={caseId} canComplete />
    </QueryClientProvider>
  );

  const before = await screen.findByAltText("before proof");
  const after = await screen.findByAltText("after proof");
  const beforeButton = before.closest("button");
  const afterButton = after.closest("button");
  expect(beforeButton).not.toBeNull();
  expect(afterButton).not.toBeNull();
  if (!beforeButton || !afterButton)
    throw new Error("Proof buttons are missing");
  expect(mocks.getReadyProofItems).toHaveBeenCalledWith(caseId);
  expect(screen.getByRole("button", { name: "Complete Job" })).toHaveProperty(
    "disabled",
    true
  );

  fireEvent.click(beforeButton);
  fireEvent.click(afterButton);
  fireEvent.change(screen.getByPlaceholderText(/describe the work/i), {
    target: { value: "  Work completed.  " },
  });

  const submit = screen.getByRole("button", { name: "Complete Job" });
  await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  fireEvent.click(submit);
  fireEvent.click(submit);

  expect(mocks.complete).toHaveBeenCalledTimes(2);
  expect(mocks.complete.mock.calls[0]?.[0]).toMatchObject({
    caseId,
    report: "Work completed.",
    proofItemIds: [beforeId, afterId],
  });
  expect(mocks.complete.mock.calls[1]?.[0]?.idempotencyKey).toBe(
    mocks.complete.mock.calls[0]?.[0]?.idempotencyKey
  );
});

test("retries an upload with the same generated Proof Item UUID", async () => {
  mocks.getReadyProofItems.mockResolvedValue([]);
  mocks.uploadProofFile
    .mockRejectedValueOnce(new Error("temporary upload failure"))
    .mockResolvedValueOnce({
      id: beforeId,
      type: "BEFORE",
      mediaUrl: "https://proof.example/before",
    });
  const createObjectUrl = vi.fn(() => "blob:proof-preview");
  vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectUrl });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <CloseJobSheet open onOpenChange={vi.fn()} caseId={caseId} canComplete />
    </QueryClientProvider>
  );

  await screen.findByText("Before Photos");
  const file = new File(["before"], "before.png", { type: "image/png" });
  const [beforeInput] =
    document.querySelectorAll<HTMLInputElement>('input[type="file"]');
  expect(beforeInput).toBeDefined();
  if (!beforeInput) throw new Error("Before proof input is missing");
  fireEvent.change(beforeInput, { target: { files: [file] } });

  await screen.findByText("Retry");
  fireEvent.click(screen.getByRole("button", { name: /retry upload/i }));
  await waitFor(() => expect(mocks.uploadProofFile).toHaveBeenCalledTimes(2));
  expect(mocks.uploadProofFile.mock.calls[1]?.[3]).toBe(
    mocks.uploadProofFile.mock.calls[0]?.[3]
  );
});
