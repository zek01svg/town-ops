import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";

/**
 * Replays every history captured by `scripts/capture-histories.ts` against the
 * current Workflow code (PRS-152 AC7).
 *
 * These are the only *frozen* histories this repo replays. Three tests do
 * force full replay with `maxCachedWorkflows: 0` — `acceptance-sla-breach`,
 * `missed-appointment`, `start-work` — but each replays a history the same
 * code just wrote, so none of them can catch cross-version divergence, which
 * is the whole failure mode `AUTO_UPGRADE` exposes (docs/temporal-versioning.md).
 * A change that emits a different command sequence — dropping a carried timer,
 * adding an Activity call, altering the Continue-As-New gate — is caught here
 * and nowhere else.
 *
 * `case-continue-as-new-first-run.json` carries the `prs-152-continue-as-new`
 * marker immediately before its `WorkflowExecutionContinuedAsNew`, so for it to
 * replay at all, every operand ahead of `patched()` in that gate must evaluate
 * identically at that exact Workflow Task.
 *
 * Needs no Temporal server, so it runs in CI under the ordinary `test` script.
 *
 * A failure means the current Workflow code is not replay-compatible with a
 * committed history. `pnpm --filter @townops/worker capture-histories`
 * recaptures them and makes it green again, and is almost always the wrong
 * fix: real Workflows in flight carry exactly these histories. Gate the change
 * behind `patched()` instead — docs/temporal-versioning.md.
 */

const historiesDir = fileURLToPath(new URL("./histories", import.meta.url));

describe("Workflow history replay (PRS-152 AC7)", () => {
  it("replays every captured history against the current Workflow code", async () => {
    const files = readdirSync(historiesDir).filter((file) =>
      file.endsWith(".json")
    );
    // Spelled out rather than counted: a deleted or renamed fixture must fail
    // here rather than silently shrink the coverage this suite claims. The two
    // carried-timer fixtures in particular are each the only thing that catches
    // one dropped Continue-As-New restore.
    expect(files.toSorted()).toEqual([
      "case-acceptance-sla-breach-reassign.json",
      "case-appointment-replacement-after-missed.json",
      "case-appointment-replacement-after-no-access.json",
      "case-appointment-replacement.json",
      "case-cancellation.json",
      "case-continue-as-new-carried-appointment-timer.json",
      "case-continue-as-new-carried-retry-timer.json",
      "case-continue-as-new-first-run.json",
      "case-continue-as-new-second-run.json",
      "case-effect-repair-retry.json",
      "case-effect-repair-waive.json",
      "case-manual-allocation.json",
      "case-missed-appointment.json",
      "case-no-access.json",
      "case-open-accept-start-complete.json",
      "resident-provisioning.json",
    ]);

    const results = Worker.runReplayHistories(
      {
        workflowsPath: fileURLToPath(
          new URL("../src/workflows/index.ts", import.meta.url)
        ),
        replayName: "prs-152-ac7",
      },
      files.map((file) => ({
        // The Workflow ID is only a label during replay; the fixture name is
        // what a CI failure needs to name.
        workflowId: file.replace(/\.json$/, ""),
        history: JSON.parse(readFileSync(`${historiesDir}/${file}`, "utf8")),
      }))
    );

    const replayed: string[] = [];
    const failures: string[] = [];
    for await (const { workflowId, error } of results) {
      replayed.push(workflowId);
      if (error) failures.push(`${workflowId}: ${error.message}`);
    }

    expect(failures).toEqual([]);
    expect(replayed).toEqual(files.map((file) => file.replace(/\.json$/, "")));
  }, 180_000);
});
