// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CaseAuditTrail } from "../src/features/case/components/case-audit-trail";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { useQuery, repairMutate } = vi.hoisted(() => ({
  useQuery: vi.fn(),
  repairMutate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery }));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("lucide-react", () => ({
  CalendarClock: () => null,
  Clock: () => null,
  History: () => null,
  User: () => null,
}));

// Real queryKey shapes (matching caseKeys.timeline / caseKeys.gatewayCase /
// caseKeys.effects) so the useQuery mock below can route by key instead of
// by call order.
vi.mock("../src/features/case/api/queries", () => ({
  caseQueries: {
    timeline: (caseId: string) => ({ queryKey: ["audit", "timeline", caseId] }),
    gatewayAppointment: (caseId: string) => ({
      queryKey: ["gateway-case", caseId],
    }),
    effects: (caseId: string) => ({ queryKey: ["case-effects", caseId] }),
  },
}));

vi.mock("../src/features/case/api/mutations", () => ({
  useCancelCaseMutation: () => ({ isPending: false, isError: false }),
  useReplaceAppointmentMutation: () => ({ isPending: false, isError: false }),
  useRepairEffectMutation: () => ({
    isPending: false,
    isError: false,
    mutate: repairMutate,
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useQuery.mockReset();
  repairMutate.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/**
 * Renders CaseAuditTrail with the given derived effects in the Effect Repair
 * section. Routes each useQuery call by its queryKey rather than call order,
 * so it isn't coupled to how many times the component renders — typing into
 * a waiver-reason textarea is a real setState that re-invokes every hook
 * again, and a call-order queue would run dry and fail for the wrong reason.
 */
function renderEffects(effects: Record<string, unknown>[]) {
  useQuery.mockImplementation((options: { queryKey: readonly unknown[] }) => {
    const [key] = options.queryKey;
    if (key === "audit") return { data: [], isLoading: false };
    if (key === "gateway-case") return { data: undefined };
    if (key === "case-effects") return { data: effects };
    throw new Error(`Unexpected queryKey: ${String(key)}`);
  });

  act(() => root.render(<CaseAuditTrail caseId="case-1" />));
}

function renderEffect(effect: Record<string, unknown>) {
  renderEffects([effect]);
}

function findButton(text: string, within: ParentNode = container) {
  const button = [...within.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text
  );
  if (!button) throw new Error(`Expected a "${text}" button`);
  return button;
}

/** Scopes queries to one effect's own card, so a multi-effect render can
 * assert on each card independently instead of matching the first one. */
function findEffectCard(effectId: string) {
  const marker = [...container.querySelectorAll("p")].find(
    (p) => p.textContent === effectId
  );
  const card = marker?.closest("div");
  if (!card) throw new Error(`Expected a card for effect "${effectId}"`);
  return card;
}

/** Simulates typing by going through the textarea's native value setter, so
 * React's controlled-input value tracker sees a real change and fires
 * onChange — a plain `el.value = x` assignment is swallowed silently. */
function typeInto(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set?.call(textarea, value);
  act(() => {
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function renderUnknownEffect() {
  renderEffect({
    id: "effect-unknown",
    status: "UNKNOWN",
    attempts: 5,
    lastError: "Provider outcome could not be confirmed",
  });
  return findButton("Retry (duplicate risk)");
}

test("does not retry an UNKNOWN effect when the Officer declines the duplicate-risk warning", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

  const retry = renderUnknownEffect();
  act(() => retry.click());

  expect(confirm).toHaveBeenCalledOnce();
  expect(repairMutate).not.toHaveBeenCalled();
});

test("retries an UNKNOWN effect only with duplicate-risk acknowledgement after confirmation", () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);

  const retry = renderUnknownEffect();
  act(() => retry.click());

  expect(repairMutate).toHaveBeenCalledWith({
    caseId: "case-1",
    effectId: "effect-unknown",
    action: "retry",
    acknowledgeDuplicateRisk: true,
  });
});

test("retries a FAILED effect with a plain Retry button, no duplicate-risk prompt", () => {
  const confirm = vi.spyOn(window, "confirm");

  renderEffect({
    id: "effect-failed",
    status: "FAILED",
    attempts: 2,
    lastError: "SMTP timeout",
  });
  const retry = findButton("Retry");
  act(() => retry.click());

  expect(confirm).not.toHaveBeenCalled();
  expect(repairMutate).toHaveBeenCalledWith({
    caseId: "case-1",
    effectId: "effect-failed",
    action: "retry",
    acknowledgeDuplicateRisk: false,
  });
});

test("disables Waive while the waiver reason is empty or whitespace-only", () => {
  renderEffect({
    id: "effect-failed",
    status: "FAILED",
    attempts: 1,
    lastError: "SMTP timeout",
  });
  const waive = findButton("Waive");
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Expected the waiver reason textarea");

  expect(waive.disabled).toBe(true);

  typeInto(textarea, "   ");
  expect(waive.disabled).toBe(true);

  typeInto(textarea, "Resident confirmed by phone");
  expect(waive.disabled).toBe(false);
});

test("waives an effect with the entered reason", () => {
  renderEffect({
    id: "effect-failed",
    status: "FAILED",
    attempts: 1,
    lastError: "SMTP timeout",
  });
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Expected the waiver reason textarea");
  typeInto(textarea, "Resident confirmed by phone");

  const waive = findButton("Waive");
  act(() => waive.click());

  expect(repairMutate).toHaveBeenCalledWith({
    caseId: "case-1",
    effectId: "effect-failed",
    action: "waive",
    reason: "Resident confirmed by phone",
  });
});

test("keeps each effect's waiver reason isolated when more than one is open", () => {
  renderEffects([
    {
      id: "effect-one",
      status: "FAILED",
      attempts: 1,
      lastError: "SMTP timeout",
    },
    {
      id: "effect-two",
      status: "FAILED",
      attempts: 1,
      lastError: "SMTP timeout",
    },
  ]);

  const cardOne = findEffectCard("effect-one");
  const cardTwo = findEffectCard("effect-two");
  const textareaOne = cardOne.querySelector("textarea");
  const textareaTwo = cardTwo.querySelector("textarea");
  if (!textareaOne || !textareaTwo) {
    throw new Error("Expected a waiver reason textarea per effect");
  }
  const waiveTwo = findButton("Waive", cardTwo);

  typeInto(textareaOne, "Resident confirmed by phone");

  expect(textareaTwo.value).toBe("");
  expect(waiveTwo.disabled).toBe(true);
});
