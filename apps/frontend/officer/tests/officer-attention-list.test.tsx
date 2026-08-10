// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { OfficerAttentionList } from "../src/features/attention/officer-attention-list";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery,
  // `attentionQueries.list` (unmocked, real module) calls this to build its
  // options object — a passthrough is enough since `useQuery` above is what
  // actually supplies the rendered data in this test.
  queryOptions: (options: unknown) => options,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useQuery.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(items: unknown[], isLoading = false) {
  useQuery.mockReturnValue({ data: items, isLoading });
  act(() => root.render(<OfficerAttentionList />));
}

// Spec (PRS-151, 151-E): `GET /api/officer-attention` had zero frontend
// callers before this change — this is the view that closes that gap.
// These are the obvious edge cases at that new trust boundary: nothing
// rendered, a loading state, and the two states the Gateway can hand back
// for one item (open vs resolved).

test("shows the loading state instead of the empty state while the query is in flight", () => {
  render([], true);
  expect(container.textContent).toContain("Loading attention items");
  expect(container.textContent).not.toContain("No open attention items");
});

test("shows the empty state when there are no open attention items", () => {
  render([]);
  expect(container.textContent).toContain("No open attention items.");
});

test("renders an open item with a humanized kind and an Open badge", () => {
  render([
    {
      id: "attn-1",
      kind: "NO_ELIGIBLE_CONTRACTOR",
      detail: "No contractor accepted after 3 attempts.",
      createdAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
    },
  ]);

  expect(container.textContent).toContain("No Eligible Contractor");
  expect(container.textContent).toContain(
    "No contractor accepted after 3 attempts."
  );
  expect(container.textContent).toContain("Open");
  expect(container.textContent).not.toContain("Resolved");
});

test("renders a resolved item with a Resolved badge instead of Open", () => {
  render([
    {
      id: "attn-2",
      kind: "MISSED_APPOINTMENT",
      detail: "Contractor no-showed.",
      createdAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-02T00:00:00.000Z",
    },
  ]);

  expect(container.textContent).toContain("Resolved");
  // The mirror of the open-item test above: without this, a regression that
  // rendered BOTH badges would still satisfy the assertion above.
  expect(container.textContent).not.toContain("Open");
  expect(container.textContent).not.toContain("No open attention items");
});
