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
  BreachAllocationAttemptResult,
  CaseDto,
  CommitAllocationInput,
  CommitAllocationResult,
  CreateCaseActivityInput,
  ManualAllocationCommand,
  MarkCaseBreachedInput,
  OfficerAttentionKind,
  OpenCaseCommand,
  PerformanceEntryDto,
  RecordPerformanceEntryInput,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The workflow-owned acceptance SLA timer (PRS-144). Every `it` below is one
 * of the 8 scenarios enumerated in the PRS-144 plan's Verification section.
 *
 * Timing uses short *real* deadlines plus real-clock polling — the same
 * pattern already used by case-allocation.test.ts and
 * manual-allocation.test.ts — rather than Temporal's automatic
 * time-skipping. Auto time-skip pauses while an Activity is in-flight (the
 * server can't know a fake Activity resolves instantly), so it cannot
 * deterministically race a handler that must still be running when a
 * deadline elapses (scenarios 3 and 4 below).
 */

const postalCode = "123456";
const contractorA = "11111111-1111-4111-8111-111111111111";
const contractorB = "22222222-2222-4222-8222-222222222222";

function futureIso(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
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
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function candidate(contractorId: string) {
  return { contractorId, activeAssignments: 0, totalScore: 0 };
}

function attemptDto(
  overrides: Partial<AllocationAttemptDto> & {
    assignmentId: string;
    contractorId: string;
  }
): AllocationAttemptDto {
  return {
    id: randomUUID(),
    source: "AUTO_ASSIGN",
    status: "PENDING_ACCEPTANCE",
    acceptanceSlaMs: 60_000,
    deadlineAt: futureIso(60_000),
    actorId: "00000000-0000-0000-0000-000000000000",
    actorRole: "SYSTEM",
    reason: null,
    operationId: `allocate/${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function acceptSuccessResult(
  caseId: string,
  assignmentId: string,
  attemptId: string,
  contractorId: string
): AcceptAllocationResult {
  const now = new Date().toISOString();
  return {
    kind: "SUCCESS",
    data: {
      assignment: { id: assignmentId, caseId, createdAt: now, updatedAt: now },
      attempt: attemptDto({
        id: attemptId,
        assignmentId,
        contractorId,
        status: "ACCEPTED",
      }),
      appointment: {
        id: randomUUID(),
        caseId,
        assignmentId,
        attemptId,
        contractorId,
        startTime: "2030-01-01T09:00:00.000Z",
        endTime: "2030-01-01T10:00:00.000Z",
        status: "SCHEDULED",
        operationId: `confirm/${randomUUID()}`,
        createdAt: now,
      },
    },
  };
}

function acceptCommand(
  caseId: string,
  assignmentId: string,
  attemptId: string,
  contractorId: string
): AcceptAllocationCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "b".repeat(64),
    operationId: `accept/${idempotencyKey}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId,
    assignmentId,
    attemptId,
    input: {
      startTime: "2030-01-01T09:00:00.000Z",
      endTime: "2030-01-01T10:00:00.000Z",
    },
  };
}

/** Every fake Activity a CaseWorkflow needs, recording every call it sees. */
type Recorded = {
  commits: CommitAllocationInput[];
  committedAttempts: AllocationAttemptDto[];
  assigned: string[];
  breaches: BreachAllocationAttemptInput[];
  performanceEntries: RecordPerformanceEntryInput[];
  caseBreaches: MarkCaseBreachedInput[];
  attentions: { caseId: string; kind: OfficerAttentionKind }[];
  acceptCalls: number;
};

function newRecorder(): Recorded {
  return {
    commits: [],
    committedAttempts: [],
    assigned: [],
    breaches: [],
    performanceEntries: [],
    caseBreaches: [],
    attentions: [],
    acceptCalls: 0,
  };
}

type ActivityConfig = {
  recorded: Recorded;
  assignmentId: string;
  snapshot: () => AllocationSnapshot;
  /** ms until a freshly committed Attempt's deadline, from commit time. */
  deadlineOffsetMs?: number;
  acceptAllocation?: (
    input: AcceptAllocationCommand
  ) => Promise<AcceptAllocationResult>;
  breachAllocationAttempt?: (
    input: BreachAllocationAttemptInput
  ) => Promise<BreachAllocationAttemptResult>;
  /** Overrides the default COMMITTED outcome, e.g. for AC6's override guard. */
  commitAllocationAttempt?: (
    input: CommitAllocationInput
  ) => CommitAllocationResult | undefined;
};

/** Builds the fake Activities map shared by every scenario in this file. */
function makeActivities(config: ActivityConfig) {
  const { recorded } = config;
  return {
    isCaseTerminal: async () => false,
    openCase: async (input: CreateCaseActivityInput) => createdCase(input),
    fetchAllocationSnapshot: async (): Promise<AllocationSnapshot> =>
      config.snapshot(),
    commitAllocationAttempt: async (
      input: CommitAllocationInput
    ): Promise<CommitAllocationResult> => {
      recorded.commits.push(input);
      const custom = config.commitAllocationAttempt?.(input);
      if (custom) {
        if (custom.outcome === "COMMITTED") {
          recorded.committedAttempts.push(custom.attempt);
        }
        return custom;
      }
      const now = new Date().toISOString();
      const attempt = attemptDto({
        assignmentId: config.assignmentId,
        contractorId: input.contractorId,
        source: input.source,
        deadlineAt: futureIso(config.deadlineOffsetMs ?? 60_000),
      });
      recorded.committedAttempts.push(attempt);
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
    markCaseAssigned: async (input: { caseId: string }) => {
      recorded.assigned.push(input.caseId);
      return "ASSIGNED" as const;
    },
    raiseOfficerAttention: async (input: {
      caseId: string;
      kind: OfficerAttentionKind;
    }) => {
      recorded.attentions.push({ caseId: input.caseId, kind: input.kind });
      return undefined;
    },
    acceptAllocation: async (
      input: AcceptAllocationCommand
    ): Promise<AcceptAllocationResult> => {
      recorded.acceptCalls += 1;
      if (config.acceptAllocation) return config.acceptAllocation(input);
      return acceptSuccessResult(
        input.caseId,
        input.assignmentId,
        input.attemptId,
        input.contractorId
      );
    },
    breachAllocationAttempt: async (
      input: BreachAllocationAttemptInput
    ): Promise<BreachAllocationAttemptResult> => {
      recorded.breaches.push(input);
      if (config.breachAllocationAttempt) {
        return config.breachAllocationAttempt(input);
      }
      return { outcome: "BREACHED" };
    },
    recordPerformanceEntry: async (
      input: RecordPerformanceEntryInput
    ): Promise<PerformanceEntryDto> => {
      recorded.performanceEntries.push(input);
      return {
        id: randomUUID(),
        contractorId: input.contractorId,
        scoreDelta: input.scoreDelta,
        reason: input.reason,
        effectId: input.effectId,
        createdAt: new Date().toISOString(),
      };
    },
    markCaseBreached: async (input: MarkCaseBreachedInput) => {
      recorded.caseBreaches.push(input);
      return "PENDING" as const;
    },
  };
}

describe("Acceptance SLA breach and replacement (PRS-144)", () => {
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
    return { worker, taskQueue };
  }

  async function openCase(
    client: Client,
    workflowId: string,
    taskQueue: string,
    caseId: string
  ) {
    return client.workflow.executeUpdateWithStart(UPDATE_NAMES.openCase, {
      args: [openCommand()],
      updateId: randomUUID(),
      startWorkflowOperation: new WithStartWorkflowOperation(
        WORKFLOW_NAMES.case,
        {
          workflowId,
          taskQueue,
          args: [{ caseId }],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }
      ),
    });
  }

  it("1. acceptance just before the deadline succeeds and the breach Activity is never called", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 600,
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);
      await waitUntil(() => recorded.committedAttempts.length > 0);
      const attempt = recorded.committedAttempts[0];

      const accepted = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.acceptAllocation, {
          args: [acceptCommand(caseId, assignmentId, attempt.id, contractorA)],
          updateId: randomUUID(),
        });

      expect(accepted).toMatchObject({ kind: "SUCCESS" });
      expect(recorded.acceptCalls).toBe(1);

      // Wait past the deadline; the breach must never fire for an
      // already-accepted Attempt.
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(recorded.breaches).toHaveLength(0);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("2. acceptance just after the deadline is rejected without calling the atom, and the breach still happens once", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 300,
        // Widen the window between "deadline elapsed" and "runBreach fully
        // clears currentAttempt", so the late acceptance below reliably
        // observes the Attempt as still tracked.
        breachAllocationAttempt: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { outcome: "BREACHED" };
        },
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);
      await waitUntil(() => recorded.committedAttempts.length > 0);
      const attempt = recorded.committedAttempts[0];

      const deadlineMs = Date.parse(attempt.deadlineAt);
      await waitUntil(() => Date.now() > deadlineMs + 30, 5_000);

      const late = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.acceptAllocation, {
          args: [acceptCommand(caseId, assignmentId, attempt.id, contractorA)],
          updateId: randomUUID(),
        });

      expect(late).toEqual({ kind: "ATTEMPT_NOT_PENDING" });
      expect(recorded.acceptCalls).toBe(0);

      // Wait for the whole sequence to settle, not merely for the breach
      // call — each Activity is recorded on invocation, before its result
      // settles and the sequence continues to the next step.
      const settled = await waitUntil(() => recorded.caseBreaches.length > 0);
      expect(settled).toBe(true);
      expect(recorded.breaches).toHaveLength(1);
      expect(recorded.breaches[0]).toMatchObject({
        attemptId: attempt.id,
        assignmentId,
        operationId: `${caseId}/breach/${attempt.id}`,
        actorId: "00000000-0000-0000-0000-000000000000",
        actorRole: "SYSTEM",
      });
      expect(recorded.performanceEntries).toHaveLength(1);
      expect(recorded.performanceEntries[0]).toMatchObject({
        contractorId: contractorA,
        scoreDelta: -10,
        effectId: `${attempt.id}/acceptance-sla-breach`,
      });

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("3. an accept handler armed before the deadline that resolves SUCCESS after it blocks the breach", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 300,
        acceptAllocation: async (input) => {
          // Still running when the deadline elapses.
          await new Promise((resolve) => setTimeout(resolve, 600));
          return acceptSuccessResult(
            input.caseId,
            input.assignmentId,
            input.attemptId,
            input.contractorId
          );
        },
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);
      await waitUntil(() => recorded.committedAttempts.length > 0);
      const attempt = recorded.committedAttempts[0];

      // Armed well before the deadline (300ms).
      const acceptPromise = client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.acceptAllocation, {
          args: [acceptCommand(caseId, assignmentId, attempt.id, contractorA)],
          updateId: randomUUID(),
        });

      // Confirm the deadline has elapsed while the handler is still running.
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(recorded.breaches).toHaveLength(0);

      const result = await acceptPromise;
      expect(result).toMatchObject({ kind: "SUCCESS" });

      // Give the main loop a further window; it must still never breach.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recorded.breaches).toHaveLength(0);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("4. an accept handler armed before the deadline that ends in a conflict after it still breaches", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 300,
        acceptAllocation: async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return { kind: "APPOINTMENT_CONFLICT" };
        },
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);
      await waitUntil(() => recorded.committedAttempts.length > 0);
      const attempt = recorded.committedAttempts[0];

      const result = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.acceptAllocation, {
          args: [acceptCommand(caseId, assignmentId, attempt.id, contractorA)],
          updateId: randomUUID(),
        });

      expect(result).toEqual({ kind: "APPOINTMENT_CONFLICT" });

      const breached = await waitUntil(() => recorded.breaches.length > 0);
      expect(breached).toBe(true);
      expect(recorded.breaches).toHaveLength(1);
      expect(recorded.breaches[0]?.attemptId).toBe(attempt.id);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("5. a breach Activity returning ALREADY_BREACHED still records the -10 penalty once", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        // Only ever the same Contractor, so no replacement can commit —
        // isolates this test to the penalty-on-ALREADY_BREACHED behaviour.
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 300,
        breachAllocationAttempt: async () => ({
          outcome: "ALREADY_BREACHED",
        }),
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);
      await waitUntil(() => recorded.committedAttempts.length > 0);
      const attempt = recorded.committedAttempts[0];

      const settled = await waitUntil(() => recorded.caseBreaches.length > 0);
      expect(settled).toBe(true);
      expect(recorded.breaches).toHaveLength(1);
      expect(recorded.performanceEntries).toHaveLength(1);
      expect(recorded.performanceEntries[0]).toMatchObject({
        contractorId: contractorA,
        scoreDelta: -10,
        reason: "ACCEPTANCE_SLA_BREACH",
        effectId: `${attempt.id}/acceptance-sla-breach`,
      });
      expect(recorded.caseBreaches).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("6a. a replacement Attempt commits on the same Assignment, source BREACH_REASSIGN, never the breached Contractor", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        snapshot: () => ({
          epoch: 0,
          candidates: [candidate(contractorA), candidate(contractorB)],
        }),
        deadlineOffsetMs: 300,
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);
      await waitUntil(() => recorded.committedAttempts.length > 0);
      expect(recorded.commits[0]).toMatchObject({
        contractorId: contractorA,
        source: "AUTO_ASSIGN",
      });

      const replaced = await waitUntil(
        () => recorded.committedAttempts.length > 1,
        6_000
      );
      expect(replaced).toBe(true);
      expect(recorded.commits[1]).toMatchObject({
        contractorId: contractorB,
        source: "BREACH_REASSIGN",
      });
      expect(recorded.committedAttempts[1]?.assignmentId).toBe(assignmentId);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("6b. no eligible replacement Contractor raises NO_ELIGIBLE_CONTRACTOR attention", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        // Only the Contractor who will breach is ever eligible.
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 300,
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);
      await waitUntil(() => recorded.committedAttempts.length > 0);

      const attentioned = await waitUntil(
        () => recorded.attentions.length > 0,
        6_000
      );
      expect(attentioned).toBe(true);
      expect(recorded.attentions[0]).toMatchObject({
        caseId,
        kind: "NO_ELIGIBLE_CONTRACTOR",
      });
      // No second commit — the excluded Contractor is the only candidate.
      expect(recorded.commits).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("7. manual reuse of a breached Contractor requires a reason (AC6)", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        assignmentId,
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        commitAllocationAttempt: (input) => {
          if (input.source === "MANUAL_ASSIGN" && !input.reason) {
            return { outcome: "OVERRIDE_REASON_REQUIRED" };
          }
          if (input.source === "MANUAL_ASSIGN") {
            const now = new Date().toISOString();
            const attempt = attemptDto({
              assignmentId,
              contractorId: input.contractorId,
              source: input.source,
              reason: input.reason ?? null,
            });
            return {
              outcome: "COMMITTED",
              attempt,
              assignment: {
                id: assignmentId,
                caseId: input.caseId,
                createdAt: now,
                updatedAt: now,
              },
              epoch: input.expectedEpoch + 1,
            };
          }
          return undefined;
        },
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);
      await waitUntil(() => recorded.committedAttempts.length > 0);

      const withoutReasonKey = randomUUID();
      const withoutReason: ManualAllocationCommand = {
        idempotencyKey: withoutReasonKey,
        payloadHash: "c".repeat(64),
        operationId: `${withoutReasonKey}.${"c".repeat(64)}`,
        actorId: randomUUID(),
        actorRole: "OFFICER",
        caseId,
        category: "LE",
        postalCode,
        input: { contractorId: contractorA },
      };
      const rejected = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.allocateContractor, {
          args: [withoutReason],
          updateId: randomUUID(),
        });
      expect(rejected).toEqual({ kind: "OVERRIDE_REASON_REQUIRED" });

      const withReasonKey = randomUUID();
      const withReason: ManualAllocationCommand = {
        idempotencyKey: withReasonKey,
        payloadHash: "d".repeat(64),
        operationId: `${withReasonKey}.${"d".repeat(64)}`,
        actorId: randomUUID(),
        actorRole: "OFFICER",
        caseId,
        category: "LE",
        postalCode,
        input: { contractorId: contractorA, reason: "Officer override" },
      };
      const committed = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.allocateContractor, {
          args: [withReason],
          updateId: randomUUID(),
        });
      expect(committed).toMatchObject({ kind: "SUCCESS" });

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  /**
   * 8. Worker restart still breaches the pending Attempt.
   *
   * A literal "stop Worker A, wait past the deadline with zero pollers on
   * the Task Queue, start Worker B" was attempted first, per the plan's
   * "second Worker instance" wording. It could not be made to pass in this
   * sandbox: with no Worker polling, `TestWorkflowEnvironment`'s
   * time-skipping server never redelivers the fired timer's Workflow Task
   * to the newly-started Worker — confirmed even with the sticky-queue
   * fallback shortened to 1s, a 30s `env.sleep()` inside Worker B, and a
   * dedicated isolated env (own file, own beforeAll) to rule out
   * interference from this file's other scenarios. That looks like a
   * harness/test-server limitation of this SDK version, not a Workflow bug:
   * a control test with `maxCachedWorkflows: 0` (forcing a *full replay*
   * from history on every single Workflow Task — the same "no local state
   * survives" property an actual process restart has) breaches correctly.
   * That control is reproduced here as the substitute for a literal second
   * process, since it is the part of "restart" that is this ticket's
   * concern: does the Workflow's `currentAttempt`/`accepted` state and the
   * armed deadline reconstruct correctly with no continuity from before?
   */
  it("8. the breach timer survives a forced full replay (Worker cache eviction)", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const recorded = newRecorder();
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      // Every single Workflow Task is a full replay from history — no
      // sticky cache survives between them, the same "no continuity"
      // property a genuine process restart has.
      maxCachedWorkflows: 0,
      activities: makeActivities({
        recorded,
        assignmentId,
        snapshot: () => ({ epoch: 0, candidates: [candidate(contractorA)] }),
        deadlineOffsetMs: 400,
      }),
    });
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await openCase(client, workflowId, taskQueue, caseId);

      // Wait for the sequence to settle, not merely for the breach call —
      // it is recorded on invocation, before the rest of the sequence runs.
      const settled = await waitUntil(() => recorded.caseBreaches.length > 0);
      expect(settled).toBe(true);
      expect(recorded.breaches).toHaveLength(1);
      expect(recorded.performanceEntries).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);
});
