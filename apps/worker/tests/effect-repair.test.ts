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
  AllocationSnapshot,
  CaseDto,
  CommitAllocationInput,
  CommitAllocationResult,
  CreateCaseActivityInput,
  OpenCaseCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { immediateDerivedEffectActivities } from "./derived-effect-test-activities";

/**
 * Coverage for the Officer effect-repair path (retryEffect/waiveEffect
 * Updates) and the automatic backoff-governed retry loop (AC4, AC9). Every
 * test here opens one Case and lets automatic allocation commit it to one
 * Contractor, which queues exactly one EMAIL effect
 * (`${attemptId}/assignment-notification`) to repair or observe.
 */

const postalCode = "123456";
const contractorId = "11111111-1111-4111-8111-111111111111";

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
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function committedResult(input: CommitAllocationInput): CommitAllocationResult {
  const now = new Date().toISOString();
  const assignmentId = randomUUID();
  return {
    outcome: "COMMITTED",
    attempt: {
      id: randomUUID(),
      assignmentId,
      contractorId: input.contractorId,
      source: input.source,
      status: "PENDING_ACCEPTANCE",
      acceptanceSlaMs: input.acceptanceSlaMs,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      actorId: input.actorId,
      actorRole: input.actorRole,
      reason: null,
      operationId: input.operationId,
      createdAt: now,
    },
    assignment: {
      id: assignmentId,
      caseId: input.caseId,
      createdAt: now,
      updatedAt: now,
    },
    epoch: input.expectedEpoch + 1,
  };
}

/** A full DerivedEffectSummary, spelled out — the workflow reads `status`
 * and repair handlers echo the whole object back to the caller. */
function effectDto(
  id: string,
  status: "PENDING" | "SENT" | "FAILED" | "UNKNOWN" | "WAIVED"
) {
  return {
    id,
    caseId: "00000000-0000-0000-0000-000000000000",
    type: "EMAIL" as const,
    purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION",
    status,
    providerId: null,
    providerIdempotencyKey: id,
    attempts: 1,
    lastError: status === "FAILED" ? "SMTP timeout" : null,
    nextRetryAt: null,
    waiverActorId: null,
    waiverReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function retryCommand(overrides: {
  caseId: string;
  effectId: string;
  idempotencyKey?: string;
  payloadHash?: string;
  acknowledgeDuplicateRisk?: boolean;
}) {
  const idempotencyKey = overrides.idempotencyKey ?? randomUUID();
  const payloadHash = overrides.payloadHash ?? "a".repeat(64);
  return {
    idempotencyKey,
    payloadHash,
    operationId: `${idempotencyKey}.${payloadHash}`,
    actorId: randomUUID(),
    actorRole: "OFFICER" as const,
    caseId: overrides.caseId,
    effectId: overrides.effectId,
    input: {
      acknowledgeDuplicateRisk: overrides.acknowledgeDuplicateRisk ?? false,
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("Effect repair and automatic retry (AC4, AC9)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  /** Every allocation/case Activity a Case needs to open and auto-assign,
   * plus the effect Activities (defaulted to no-op, overridable per test). */
  async function createWorker(effectActivities: Record<string, unknown> = {}) {
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    let attemptId: string | undefined;
    const reservedEffectIds = new Set<string>();
    const baseEffectActivities = immediateDerivedEffectActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: {
        openCase: async (input: CreateCaseActivityInput) => createdCase(input),
        isCaseTerminal: async () => false,
        fetchAllocationSnapshot: async (): Promise<AllocationSnapshot> => ({
          epoch: 0,
          candidates: [{ contractorId, activeAssignments: 0, totalScore: 0 }],
        }),
        commitAllocationAttempt: async (input: CommitAllocationInput) => {
          const result = committedResult(input);
          if (result.outcome === "COMMITTED") attemptId = result.attempt.id;
          return result;
        },
        markCaseAssigned: async () => "ASSIGNED" as const,
        raiseOfficerAttention: async () => undefined,
        ...baseEffectActivities,
        // Tracks every reservation so a caller can wait for proof the
        // Workflow's own `effects` map actually contains the queued
        // assignment-notification effect, not just that the allocation
        // Activity that queues it was called — the two are separated by a
        // real Activity-result round trip, and racing ahead of it is what
        // let the repair Updates below intermittently see EFFECT_NOT_FOUND.
        reserveEffect: async (
          intent: Parameters<typeof baseEffectActivities.reserveEffect>[0]
        ) => {
          reservedEffectIds.add(intent.id);
          return baseEffectActivities.reserveEffect(intent);
        },
        ...effectActivities,
      },
    });
    return {
      worker,
      taskQueue,
      getAttemptId: () => attemptId,
      hasReserved: (id: string) => reservedEffectIds.has(id),
    };
  }

  /** Opens one Case, waits for automatic allocation to commit it and for
   * the Workflow to have actually queued (and started reserving) the
   * resulting assignment-notification effect, and returns its id. */
  async function openAndAssign(
    client: Client,
    taskQueue: string,
    getAttemptId: () => string | undefined,
    hasReserved: (id: string) => boolean
  ) {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    await client.workflow.executeUpdateWithStart(UPDATE_NAMES.openCase, {
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
    expect(await waitUntil(() => getAttemptId() !== undefined)).toBe(true);
    const attemptId = getAttemptId();
    if (!attemptId) throw new Error("Expected an allocation Attempt to commit");
    const effectId = `${attemptId}/assignment-notification`;
    expect(await waitUntil(() => hasReserved(effectId))).toBe(true);
    return { caseId, workflowId, effectId };
  }

  it("retries automatically on the backoff schedule and eventually reaches SENT (AC4)", async () => {
    let dispatchAttempts = 0;
    const resolved: string[] = [];
    const { worker, taskQueue, getAttemptId, hasReserved } = await createWorker(
      {
        // Reservation always succeeds; only dispatch fails, twice, so the
        // 1s/2s backoff (1_000 * 2 ** (attempts-1)) has to actually re-arm the
        // main loop's timer twice before the third attempt is allowed to run.
        dispatchEmailEffect: async (input: { id: string }) => {
          dispatchAttempts++;
          if (dispatchAttempts <= 2) {
            throw new Error("simulated transient SMTP failure");
          }
          return effectDto(input.id, "SENT");
        },
        resolveDerivedEffectAttention: async (input: { effectId: string }) => {
          resolved.push(input.effectId);
        },
      }
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const { effectId, workflowId } = await openAndAssign(
        client,
        taskQueue,
        getAttemptId,
        hasReserved
      );

      // finishEffect only resolves attention once status reaches SENT, so
      // this is observable proof the effect actually settled — not just
      // that dispatch was called a few times.
      expect(await waitUntil(() => resolved.includes(effectId), 15_000)).toBe(
        true
      );
      expect(dispatchAttempts).toBe(3);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("lets an Officer retry a FAILED effect and succeed (AC9)", async () => {
    const dispatched: string[] = [];
    const acknowledgements: boolean[] = [];
    const { worker, taskQueue, getAttemptId, hasReserved } = await createWorker(
      {
        // Permanently fails dispatch so the effect genuinely lands in
        // FAILED before the Officer repairs it — retrying an id the
        // Workflow has only just queued (and never attempted) would not
        // exercise the real Officer path this test is proving.
        dispatchEmailEffect: async (input: { id: string }) => {
          dispatched.push(input.id);
          throw new Error("simulated permanent SMTP failure");
        },
        retryEffect: async (input: {
          id: string;
          acknowledgeDuplicateRisk: boolean;
        }) => {
          acknowledgements.push(input.acknowledgeDuplicateRisk);
          return {
            kind: "SUCCESS" as const,
            effect: effectDto(input.id, "PENDING"),
          };
        },
      }
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const { effectId, workflowId, caseId } = await openAndAssign(
        client,
        taskQueue,
        getAttemptId,
        hasReserved
      );
      expect(await waitUntil(() => dispatched.includes(effectId))).toBe(true);

      const command = retryCommand({ caseId, effectId });
      const result = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.retryEffect, {
          args: [command],
          updateId: command.operationId,
        });

      expect(result).toMatchObject({
        kind: "SUCCESS",
        effect: { status: "PENDING" },
      });
      expect(acknowledgements).toEqual([false]);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("requires duplicate-risk acknowledgement before retrying an UNKNOWN effect (AC9)", async () => {
    const { worker, taskQueue, getAttemptId, hasReserved } = await createWorker(
      {
        retryEffect: async () => ({ kind: "ACK_REQUIRED" as const }),
      }
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const { effectId, workflowId, caseId } = await openAndAssign(
        client,
        taskQueue,
        getAttemptId,
        hasReserved
      );
      const command = retryCommand({
        caseId,
        effectId,
        acknowledgeDuplicateRisk: false,
      });

      const result = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.retryEffect, {
          args: [command],
          updateId: command.operationId,
        });

      expect(result).toEqual({
        kind: "DUPLICATE_RISK_ACKNOWLEDGEMENT_REQUIRED",
      });

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("collapses a concurrent retryEffect Update sharing an idempotencyKey but a different payload hash", async () => {
    let retryCalls = 0;
    let releaseRetry: (() => void) | undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const { worker, taskQueue, getAttemptId, hasReserved } = await createWorker(
      {
        retryEffect: async (input: { id: string }) => {
          retryCalls++;
          await retryGate;
          return {
            kind: "SUCCESS" as const,
            effect: effectDto(input.id, "PENDING"),
          };
        },
      }
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const { effectId, workflowId, caseId } = await openAndAssign(
        client,
        taskQueue,
        getAttemptId,
        hasReserved
      );
      const handle = client.workflow.getHandle(workflowId);
      const idempotencyKey = randomUUID();
      const first = retryCommand({
        caseId,
        effectId,
        idempotencyKey,
        payloadHash: "a".repeat(64),
      });

      const firstPending = handle.executeUpdate(UPDATE_NAMES.retryEffect, {
        args: [first],
        updateId: first.operationId,
      });
      // Waits for the first Update to have eagerly registered its operation
      // and reached the (gated) Activity call before firing the second —
      // this is the exact race the eager `pending` registration closes.
      expect(await waitUntil(() => retryCalls === 1)).toBe(true);

      const second = retryCommand({
        caseId,
        effectId,
        idempotencyKey,
        payloadHash: "b".repeat(64),
      });
      const secondResult = await handle.executeUpdate(
        UPDATE_NAMES.retryEffect,
        { args: [second], updateId: second.operationId }
      );
      expect(secondResult).toEqual({ kind: "IDEMPOTENCY_KEY_REUSED" });

      releaseRetry?.();
      const firstResult = await firstPending;
      expect(firstResult).toMatchObject({ kind: "SUCCESS" });
      // The atom-level retry Activity never ran twice — the second Update
      // never reached it.
      expect(retryCalls).toBe(1);

      await handle.terminate();
    });
  }, 30_000);
});
