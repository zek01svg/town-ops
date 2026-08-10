import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  Client,
  WithStartWorkflowOperation,
  WorkflowIdConflictPolicy,
} from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  ORCHESTRATION_TASK_QUEUE,
  UPDATE_NAMES,
  WORKFLOW_NAMES,
} from "@townops/orchestration-contract";
import type {
  AcceptAllocationCommand,
  AcceptAllocationResult,
  AllocationAttemptDto,
  AllocationSnapshot,
  BreachAllocationAttemptInput,
  CaseDto,
  CommitAllocationInput,
  CommitAllocationResult,
  CreateCaseActivityInput,
  OfficerAttentionKind,
  OpenCaseCommand,
  RetryEffectCommand,
  WaiveEffectCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { immediateDerivedEffectActivities } from "./derived-effect-test-activities";

/**
 * Continue-As-New for CaseWorkflow (PRS-152).
 *
 * The server only sets `continueAsNewSuggested` at thousands of events, which
 * no test can drive in reasonable time, so every scenario here starts the
 * Workflow with the optional `continueAsNewAfterEvents` override and then
 * grows history with no-op Updates (a retryEffect for an effect ID this Case
 * never had — it returns EFFECT_NOT_FOUND without touching state, so it never
 * wakes the main loop).
 *
 * Timing follows the same real-clock convention as acceptance-sla-breach.ts:
 * the time-skipping environment is only used for its ephemeral server, the
 * plain `Client` never unlocks time skipping, so Workflow time tracks real
 * time and short real deadlines are the control surface.
 */

const contractorA = "11111111-1111-4111-8111-111111111111";
const postalCode = "123456";
const scheduledStart = "2030-01-01T09:00:00.000Z";
const scheduledEnd = "2030-01-01T10:00:00.000Z";
const CONTINUE_AS_NEW_AFTER_EVENTS = 120;
const HISTORY_DRIVER_UPDATES = 30;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function futureIso(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function openCommand(): OpenCaseCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "a".repeat(64),
    operationId: `${idempotencyKey}.${"a".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "OFFICER",
    input: {
      residentId: randomUUID(),
      category: "LE",
      priority: "HIGH",
      description: "Broken street light",
      postalCode,
    },
  };
}

/** A retryEffect for an effect this Case never had: pure history, no state. */
function noopCommand(caseId: string): RetryEffectCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "b".repeat(64),
    operationId: `${idempotencyKey}.${"b".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "OFFICER",
    caseId,
    effectId: `${randomUUID()}/never-queued`,
    input: { acknowledgeDuplicateRisk: false },
  };
}

function acceptCommand(
  caseId: string,
  assignmentId: string,
  attemptId: string
): AcceptAllocationCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "d".repeat(64),
    operationId: `${idempotencyKey}.${"d".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId: contractorA,
    caseId,
    assignmentId,
    attemptId,
    input: { startTime: scheduledStart, endTime: scheduledEnd },
  };
}

function waiveCommand(caseId: string, effectId: string): WaiveEffectCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "c".repeat(64),
    operationId: `${idempotencyKey}.${"c".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "OFFICER",
    caseId,
    effectId,
    input: { reason: "Officer waived the notification" },
  };
}

function createdCase(input: CreateCaseActivityInput): CaseDto {
  return {
    id: input.caseId,
    residentId: input.input.residentId,
    category: input.input.category,
    priority: input.input.priority,
    status: "PENDING",
    description: input.input.description,
    addressDetails: null,
    postalCode: input.input.postalCode,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

function candidate(contractorId: string) {
  return { contractorId, activeAssignments: 0, totalScore: 0 };
}

function isAssignmentNotification(effectId: string) {
  return effectId.endsWith("/assignment-notification");
}

type Recorded = {
  openCalls: number;
  commits: CommitAllocationInput[];
  committedAttempts: AllocationAttemptDto[];
  /** The latest Attempt committed for each Case, for multi-Case scenarios. */
  attemptByCase: Map<string, AllocationAttemptDto>;
  breaches: BreachAllocationAttemptInput[];
  attentions: OfficerAttentionKind[];
  emailDispatches: string[];
  emailDeliveries: string[];
};

function newRecorder(): Recorded {
  return {
    openCalls: 0,
    commits: [],
    committedAttempts: [],
    attemptByCase: new Map(),
    breaches: [],
    attentions: [],
    emailDispatches: [],
    emailDeliveries: [],
  };
}

type ActivityConfig = {
  recorded: Recorded;
  assignmentId: string;
  snapshot: () => AllocationSnapshot;
  /** ms until a freshly committed Attempt's deadline, from commit time. */
  deadlineOffsetMs?: number;
  /** Called before every email dispatch; throwing fails that delivery. */
  onEmailDispatch?: (id: string) => Promise<void>;
  /** Called before every effect waiver, to hold the Update handler open. */
  onWaiveEffect?: () => Promise<void>;
};

function makeActivities(config: ActivityConfig) {
  const { recorded } = config;
  const derivedEffects = immediateDerivedEffectActivities();
  return {
    isCaseTerminal: async () => false,
    openCase: async (input: CreateCaseActivityInput) => {
      recorded.openCalls += 1;
      return createdCase(input);
    },
    fetchAllocationSnapshot: async (): Promise<AllocationSnapshot> =>
      config.snapshot(),
    commitAllocationAttempt: async (
      input: CommitAllocationInput
    ): Promise<CommitAllocationResult> => {
      recorded.commits.push(input);
      const now = new Date().toISOString();
      const attempt: AllocationAttemptDto = {
        id: randomUUID(),
        assignmentId: config.assignmentId,
        contractorId: input.contractorId,
        source: input.source,
        status: "PENDING_ACCEPTANCE",
        acceptanceSlaMs: 60_000,
        deadlineAt: futureIso(config.deadlineOffsetMs ?? 60_000),
        actorId: input.actorId,
        actorRole: input.actorRole,
        reason: input.reason ?? null,
        operationId: input.operationId,
        createdAt: now,
      };
      recorded.committedAttempts.push(attempt);
      recorded.attemptByCase.set(input.caseId, attempt);
      return {
        outcome: "COMMITTED",
        attempt,
        assignment: {
          id: config.assignmentId,
          caseId: input.caseId,
          createdAt: now,
          updatedAt: now,
        },
        epoch: input.expectedEpoch + 1,
      };
    },
    markCaseAssigned: async () => "ASSIGNED" as const,
    acceptAllocation: async (
      input: AcceptAllocationCommand
    ): Promise<AcceptAllocationResult> => {
      const now = new Date().toISOString();
      return {
        kind: "SUCCESS",
        data: {
          assignment: {
            id: input.assignmentId,
            caseId: input.caseId,
            createdAt: now,
            updatedAt: now,
          },
          attempt: {
            id: input.attemptId,
            assignmentId: input.assignmentId,
            contractorId: input.contractorId,
            source: "AUTO_ASSIGN",
            status: "ACCEPTED",
            acceptanceSlaMs: 60_000,
            deadlineAt: now,
            actorId: input.actorId,
            actorRole: input.actorRole,
            reason: null,
            operationId: input.operationId,
            createdAt: now,
          },
          appointment: {
            id: randomUUID(),
            caseId: input.caseId,
            assignmentId: input.assignmentId,
            attemptId: input.attemptId,
            contractorId: input.contractorId,
            startTime: input.input.startTime,
            endTime: input.input.endTime,
            status: "SCHEDULED",
            reason: null,
            operationId: `confirm/${input.operationId}`,
            createdAt: now,
          },
        },
      };
    },
    raiseOfficerAttention: async (input: { kind: OfficerAttentionKind }) => {
      recorded.attentions.push(input.kind);
      return undefined;
    },
    breachAllocationAttempt: async (input: BreachAllocationAttemptInput) => {
      recorded.breaches.push(input);
      return { outcome: "BREACHED" as const };
    },
    markCaseBreached: async () => "PENDING" as const,
    ...derivedEffects,
    dispatchEmailEffect: async (input: { id: string }) => {
      recorded.emailDispatches.push(input.id);
      await config.onEmailDispatch?.(input.id);
      recorded.emailDeliveries.push(input.id);
      return derivedEffects.dispatchEmailEffect(input);
    },
    waiveEffect: async (input: { id: string }) => {
      await config.onWaiveEffect?.();
      return derivedEffects.waiveEffect(input);
    },
  };
}

async function runHistory(client: Client, workflowId: string, runId?: string) {
  const handle = runId
    ? client.workflow.getHandle(workflowId, runId)
    : client.workflow.getHandle(workflowId);
  const history = await handle.fetchHistory();
  return history.events ?? [];
}

function scheduledActivityNames(
  events: Awaited<ReturnType<typeof runHistory>>
) {
  return events.flatMap(
    (event) =>
      event.activityTaskScheduledEventAttributes?.activityType?.name ?? []
  );
}

async function currentRunId(client: Client, workflowId: string) {
  return (await client.workflow.getHandle(workflowId).describe()).runId;
}

/** Polls one run's history until `predicate` holds. */
async function waitForHistory(
  client: Client,
  workflowId: string,
  runId: string,
  predicate: (events: Awaited<ReturnType<typeof runHistory>>) => boolean,
  timeoutMs = 8_000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(await runHistory(client, workflowId, runId))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Polls until the Workflow ID resolves to a different (Continued-As-New) run. */
async function waitForNewRun(
  client: Client,
  workflowId: string,
  previousRunId: string,
  timeoutMs = 20_000
) {
  const deadline = Date.now() + timeoutMs;
  let runId = previousRunId;
  while (runId === previousRunId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    runId = await currentRunId(client, workflowId);
  }
  return runId;
}

describe("Continue-As-New for CaseWorkflow (PRS-152)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  async function createCaseWorker(
    activities: ReturnType<typeof makeActivities>
  ) {
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities,
    });
    return {
      worker,
      taskQueue,
      client: new Client({ connection: env.nativeConnection }),
    };
  }

  function openCase(
    client: Client,
    taskQueue: string,
    caseId: string,
    command = openCommand()
  ) {
    return client.workflow.executeUpdateWithStart(UPDATE_NAMES.openCase, {
      args: [command],
      updateId: randomUUID(),
      startWorkflowOperation: new WithStartWorkflowOperation(
        WORKFLOW_NAMES.case,
        {
          workflowId: `case/${caseId}`,
          taskQueue,
          args: [
            { caseId, continueAsNewAfterEvents: CONTINUE_AS_NEW_AFTER_EVENTS },
          ],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }
      ),
    });
  }

  /** Grows history past the Continue-As-New threshold without waking the loop. */
  async function growHistory(client: Client, caseId: string) {
    const handle = client.workflow.getHandle(`case/${caseId}`);
    for (let i = 0; i < HISTORY_DRIVER_UPDATES; i++) {
      const result = await handle.executeUpdate(UPDATE_NAMES.retryEffect, {
        args: [noopCommand(caseId)],
        updateId: randomUUID(),
      });
      expect(result).toEqual({ kind: "EFFECT_NOT_FOUND" });
    }
  }

  it("keeps the Workflow ID, carries the armed acceptance deadline, and breaches in the new run", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    // Held open so no effect can be mid-delivery — and so no Continue-As-New
    // can happen — until the history driver below has finished.
    const dispatchGate = deferred<void>();
    const { worker, taskQueue, client } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 10_000,
        onEmailDispatch: async () => {
          if (recorded.emailDispatches.length > 1) return;
          await dispatchGate.promise;
          throw new Error("email delivery failed");
        },
      })
    );

    await worker.runUntil(async () => {
      await openCase(client, taskQueue, caseId);
      expect(
        await waitUntil(
          () =>
            recorded.committedAttempts.length > 0 &&
            recorded.emailDispatches.length > 0
        )
      ).toBe(true);
      const attempt = recorded.committedAttempts[0];
      const firstRunId = await currentRunId(client, workflowId);

      // The threshold must not already be crossed by setup, or the assertions
      // below would be about a Continue-As-New nobody controlled.
      expect(
        (await runHistory(client, workflowId, firstRunId)).length
      ).toBeLessThan(CONTINUE_AS_NEW_AFTER_EVENTS);
      await growHistory(client, caseId);
      expect(
        (await runHistory(client, workflowId, firstRunId)).length
      ).toBeGreaterThanOrEqual(CONTINUE_AS_NEW_AFTER_EVENTS);
      expect(recorded.breaches).toHaveLength(0);

      // Releasing the delivery fails it, which arms the effect's own ~1s
      // retry timer — the next wake of the main loop, and the first one that
      // can reach the Continue-As-New gate.
      dispatchGate.resolve();
      const secondRunId = await waitForNewRun(client, workflowId, firstRunId);
      expect(secondRunId).not.toBe(firstRunId);
      expect(
        (await client.workflow.getHandle(workflowId).describe()).workflowId
      ).toBe(workflowId);

      const firstRunEvents = await runHistory(client, workflowId, firstRunId);
      expect(
        firstRunEvents.at(-1)?.workflowExecutionContinuedAsNewEventAttributes
          ?.newExecutionRunId
      ).toBe(secondRunId);
      // The acceptance deadline had not elapsed when the first run ended, so
      // every breach below is proof the carried timer re-armed in the new run.
      expect(scheduledActivityNames(firstRunEvents)).not.toContain(
        "breachAllocationAttempt"
      );

      expect(await waitUntil(() => recorded.breaches.length > 0)).toBe(true);
      expect(recorded.breaches).toHaveLength(1);
      expect(recorded.breaches[0]).toMatchObject({
        attemptId: attempt.id,
        assignmentId,
      });

      // Carried `attemptedContractorIds` plus `allocationContext`: the new run
      // runs a BREACH_REASSIGN pass, and the only candidate is the Contractor
      // the first run already attempted, so it commits nothing.
      expect(await waitUntil(() => recorded.attentions.length > 0)).toBe(true);
      expect(recorded.attentions).toEqual(["NO_ELIGIBLE_CONTRACTOR"]);
      expect(recorded.commits).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 60_000);

  it("replays a repeated command's outcome across Continue-As-New, and still conflicts on a reused key", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const recorded = newRecorder();
    const dispatchGate = deferred<void>();
    const { worker, taskQueue, client } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId: randomUUID(),
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        onEmailDispatch: async () => {
          if (recorded.emailDispatches.length > 1) return;
          await dispatchGate.promise;
          throw new Error("email delivery failed");
        },
      })
    );
    const command = openCommand();
    const sameKeyOtherPayload = { ...command, payloadHash: "9".repeat(64) };

    await worker.runUntil(async () => {
      const first = await openCase(client, taskQueue, caseId, command);
      expect(first).toMatchObject({ kind: "SUCCESS", data: { id: caseId } });
      expect(recorded.openCalls).toBe(1);

      // Before Continue-As-New.
      expect(await openCase(client, taskQueue, caseId, command)).toEqual(first);
      expect(
        await openCase(client, taskQueue, caseId, sameKeyOtherPayload)
      ).toEqual({ kind: "IDEMPOTENCY_KEY_REUSED" });
      expect(recorded.openCalls).toBe(1);

      expect(await waitUntil(() => recorded.emailDispatches.length > 0)).toBe(
        true
      );
      const firstRunId = await currentRunId(client, workflowId);
      expect(
        (await runHistory(client, workflowId, firstRunId)).length
      ).toBeLessThan(CONTINUE_AS_NEW_AFTER_EVENTS);
      await growHistory(client, caseId);
      dispatchGate.resolve();
      const secondRunId = await waitForNewRun(client, workflowId, firstRunId);
      expect(secondRunId).not.toBe(firstRunId);

      // After Continue-As-New: the same key and payload replays the carried
      // result without touching the Case atom again, and the same key with a
      // different payload is still a conflict.
      expect(await openCase(client, taskQueue, caseId, command)).toEqual(first);
      expect(recorded.openCalls).toBe(1);
      expect(
        await openCase(client, taskQueue, caseId, sameKeyOtherPayload)
      ).toEqual({ kind: "IDEMPOTENCY_KEY_REUSED" });
      expect(recorded.openCalls).toBe(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 60_000);

  it("waits for an in-flight Update handler, which completes normally", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const recorded = newRecorder();
    const dispatchGate = deferred<void>();
    const waiveGate = deferred<void>();
    const { worker, taskQueue, client } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId: randomUUID(),
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 8_000,
        onEmailDispatch: async () => {
          if (recorded.emailDispatches.length > 1) return;
          await dispatchGate.promise;
          throw new Error("email delivery failed");
        },
        onWaiveEffect: () => waiveGate.promise,
      })
    );

    await worker.runUntil(async () => {
      await openCase(client, taskQueue, caseId);
      expect(
        await waitUntil(
          () =>
            recorded.committedAttempts.length > 0 &&
            recorded.emailDispatches.length > 0
        )
      ).toBe(true);
      const attempt = recorded.committedAttempts[0];
      const firstRunId = await currentRunId(client, workflowId);
      expect(
        (await runHistory(client, workflowId, firstRunId)).length
      ).toBeLessThan(CONTINUE_AS_NEW_AFTER_EVENTS);
      await growHistory(client, caseId);

      // An Update handler held open across the moment Continue-As-New comes
      // due. Nothing else is outstanding: releasing the delivery below fails
      // it, so no effect is in flight when the retry timer wakes the loop.
      const waiving = client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.waiveEffect, {
          args: [waiveCommand(caseId, `${attempt.id}/assignment-notification`)],
          updateId: randomUUID(),
        });
      dispatchGate.resolve();

      // A second dispatch is proof the loop woke, reached the top of the loop,
      // evaluated the gate, declined, and carried on to startReadyEffects —
      // rather than never having run at all.
      expect(await waitUntil(() => recorded.emailDispatches.length > 1)).toBe(
        true
      );
      expect(await currentRunId(client, workflowId)).toBe(firstRunId);

      waiveGate.resolve();
      expect(await waiving).toMatchObject({ kind: "SUCCESS" });

      // With the handler finished, the next wake of the loop may continue as
      // new — the Update above was never failed by it.
      expect(await waitForNewRun(client, workflowId, firstRunId)).not.toBe(
        firstRunId
      );

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 60_000);

  /**
   * The two timers `CaseCarryOverSchema` marks optional, so dropping either
   * from the snapshot is not a type error. Each Case below arms exactly one of
   * them and nothing else, so the new run has a deadline to wait on only if
   * that timer carried: lose it and the loop parks in the untimed `condition`
   * with no timer at all, and the Appointment expiry or the automatic
   * allocation retry never fires again for the life of the Case.
   */
  it("re-arms the carried Appointment and automatic-retry timers in the new run", async () => {
    const acceptedCase = randomUUID();
    const pendingCase = randomUUID();
    const recorded = newRecorder();
    const dispatchGate = deferred<void>();
    const { worker, taskQueue, client } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId: randomUUID(),
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 4_000,
        // Each Case's assignment notification is held in flight — no
        // Continue-As-New can happen while it is — and then *delivered*, which
        // wakes the loop and leaves every effect settled. A failed delivery
        // would arm its own retry deadline in the new run and stand in for the
        // carried timer these assertions are about.
        onEmailDispatch: async (id) => {
          if (isAssignmentNotification(id)) await dispatchGate.promise;
        },
      })
    );

    await worker.runUntil(async () => {
      await openCase(client, taskQueue, acceptedCase);
      await openCase(client, taskQueue, pendingCase);
      expect(await waitUntil(() => recorded.attemptByCase.size === 2)).toBe(
        true
      );

      // Accepting arms `currentAppointment` and clears `currentAttempt`, so
      // this Case's only deadline is the Appointment's end.
      const attempt = recorded.attemptByCase.get(acceptedCase);
      expect(
        await client.workflow
          .getHandle(`case/${acceptedCase}`)
          .executeUpdate(UPDATE_NAMES.acceptAllocation, {
            args: [
              acceptCommand(
                acceptedCase,
                attempt?.assignmentId ?? "",
                attempt?.id ?? ""
              ),
            ],
            updateId: randomUUID(),
          })
      ).toMatchObject({ kind: "SUCCESS" });

      await growHistory(client, acceptedCase);
      await growHistory(client, pendingCase);

      // The other Case's Attempt breaches with no replacement candidate left,
      // which arms `automaticRetryAt` and leaves automatic allocation idle —
      // its only deadline.
      expect(await waitUntil(() => recorded.attentions.length > 0)).toBe(true);
      expect(recorded.attentions).toEqual(["NO_ELIGIBLE_CONTRACTOR"]);

      const firstRuns = {
        accepted: await currentRunId(client, `case/${acceptedCase}`),
        pending: await currentRunId(client, `case/${pendingCase}`),
      };
      dispatchGate.resolve();

      for (const [caseId, firstRunId] of [
        [acceptedCase, firstRuns.accepted],
        [pendingCase, firstRuns.pending],
      ] as const) {
        const workflowId = `case/${caseId}`;
        const secondRunId = await waitForNewRun(client, workflowId, firstRunId);
        expect(secondRunId).not.toBe(firstRunId);
        expect(
          await waitForHistory(client, workflowId, secondRunId, (events) =>
            events.some((event) => event.timerStartedEventAttributes)
          )
        ).toBe(true);
        await client.workflow.getHandle(workflowId).terminate();
      }
    });
  }, 60_000);

  it("never continues as new over an in-flight effect, and retries the carried one in the new run", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const recorded = newRecorder();
    const dispatchGate = deferred<void>();
    const { worker, taskQueue, client } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId: randomUUID(),
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 4_000,
        onEmailDispatch: async (id) => {
          if (!isAssignmentNotification(id)) return;
          const attemptNumber = recorded.emailDispatches.filter((dispatched) =>
            isAssignmentNotification(dispatched)
          ).length;
          // Held in flight across the acceptance SLA breach below, then failed
          // once, so the effect is outstanding but idle when the loop next
          // wakes on its retry timer.
          if (attemptNumber === 1) await dispatchGate.promise;
          if (attemptNumber <= 1) throw new Error("email delivery failed");
        },
      })
    );

    await worker.runUntil(async () => {
      await openCase(client, taskQueue, caseId);
      expect(
        await waitUntil(
          () =>
            recorded.committedAttempts.length > 0 &&
            recorded.emailDispatches.length > 0
        )
      ).toBe(true);
      const effectId = `${recorded.committedAttempts[0].id}/assignment-notification`;
      const firstRunId = await currentRunId(client, workflowId);
      expect(
        (await runHistory(client, workflowId, firstRunId)).length
      ).toBeLessThan(CONTINUE_AS_NEW_AFTER_EVENTS);
      await growHistory(client, caseId);

      // The breach wakes the loop and brings it back round to the top with the
      // threshold crossed and no handler running. The one thing left holding
      // the gate is the in-flight delivery — and the effects the breach queued
      // only start once the loop has passed that gate, so their dispatch is
      // the signal that it is safe to let the delivery finish.
      expect(await waitUntil(() => recorded.breaches.length > 0)).toBe(true);
      expect(
        await waitUntil(() =>
          recorded.emailDispatches.some((id) =>
            id.endsWith("/acceptance-sla-breach-notification")
          )
        )
      ).toBe(true);

      dispatchGate.resolve();
      const secondRunId = await waitForNewRun(client, workflowId, firstRunId);
      expect(secondRunId).not.toBe(firstRunId);
      const firstRunActivities = scheduledActivityNames(
        await runHistory(client, workflowId, firstRunId)
      );
      // The breach queues two effects and the loop starts them immediately
      // after passing the gate. Their dispatch belongs to the first run, so
      // the gate held there rather than continuing as new over the delivery
      // that was still in flight.
      expect(firstRunActivities).toContain("breachAllocationAttempt");
      expect(firstRunActivities).toContain("dispatchPerformanceEffect");

      // Never abandoned: the failed delivery carried over and the new run
      // dispatched the very same effect, which then succeeded.
      expect(
        await waitUntil(() => recorded.emailDeliveries.includes(effectId))
      ).toBe(true);
      expect(
        recorded.emailDispatches.filter((id) => id === effectId).length
      ).toBeGreaterThanOrEqual(2);
      expect(
        scheduledActivityNames(
          await runHistory(client, workflowId, secondRunId)
        )
      ).toContain("dispatchEmailEffect");

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 60_000);
});
