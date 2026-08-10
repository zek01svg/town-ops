# Temporal Workflow versioning

A Worker built with a real `BUILD_ID` — the git SHA of its image — runs as part
of the single named Worker Deployment `townops-orchestration`, with
`defaultVersioningBehavior: "AUTO_UPGRADE"`. Local development leaves
`BUILD_ID` at `dev` and runs unversioned. `apps/worker/src/index.ts` is
authoritative for both.

`AUTO_UPGRADE` means an in-flight Workflow Execution moves to the newest
version on its next Workflow Task. A Workflow that started on the previous
build finishes on the new code, replaying a history the new code did not
write. That is exactly why patch markers are mandatory here.

## When a change needs a patch marker

Patch any change that **adds, removes, or reorders commands** in a history an
in-flight Workflow may already hold: Activity calls, timers, Signals awaited,
child Workflows, and Continue-As-New. Replay compares the new code's commands
against the recorded history in order; a mismatch is a nondeterminism error and
the Workflow Task fails.

Safe without a patch:

- Activity implementations — Activity code is not replayed.
- Anything outside the Workflow file: Gateway routes, atom HTTP handlers,
  Activity option changes that do not add or drop a call.
- A new Workflow type, or a new branch reachable only by Executions that start
  after the deploy.

If it is not clearly on that list, patch it.

## What enforces this

`apps/worker/tests/replay.test.ts` replays the frozen histories in
`apps/worker/tests/histories/` — one per Case lifecycle branch, plus Resident
provisioning — against the current Workflow code on every `pnpm test`. It needs
no Temporal server. An unpatched command change reds it with a nondeterminism
error naming the fixture.

Regenerate with `pnpm --filter @townops/worker capture-histories`, which does
need the ephemeral server. Do that only when adding a branch: recapturing to
clear a failure discards the evidence that in-flight Executions would break,
which is the one thing this suite exists to tell you.

## Naming

`prs-<issue-number>-<slug>`. The live example is
`prs-152-continue-as-new`, guarding the Continue-As-New gate in
`apps/worker/src/workflows/case-workflow.ts`.

## Removing a patch

Three stages. Each one is a separate deploy, and you only advance when no
Workflow Execution remains that took the old path.

1. **`patched(id)`** — new code on the true branch, old code on the false
   branch. Ships with the change.
2. **`deprecatePatch(id)`** — delete the old branch and replace `patched(id)`
   with `deprecatePatch(id)`. New Executions record the patch so they stay
   compatible; Executions still on the old branch fail loudly instead of
   silently taking new code.
3. **Delete the call** — remove `deprecatePatch(id)` entirely.

Before advancing to stage 2 and again before stage 3, confirm no Executions
predate the patch. In the Temporal UI, or:

```bash
temporal workflow list --query 'WorkflowType="CaseWorkflow" AND ExecutionStatus="Running"'
```

Check the oldest remaining start time against the deploy that introduced the
stage. Case Workflows live as long as their Case, so give this real headroom —
weeks, not hours.

Skipping a stage, or advancing while an old Execution is still running, turns
the patch into the nondeterminism error it existed to prevent.
