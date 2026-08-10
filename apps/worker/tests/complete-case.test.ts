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
  CaseDto,
  CompleteCaseCommand,
  OfficerAttentionKind,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const contractorId = "11111111-1111-4111-8111-111111111111";

type Validation = "READY" | "APPOINTMENT_MISMATCH" | "ALREADY_COMPLETED";

type Recorded = {
  calls: string[];
  attentions: { caseId: string; kind: OfficerAttentionKind }[];
  effectIds: string[];
  effects: {
    reservations: { id: string; type: "EMAIL" | "PERFORMANCE_ENTRY" }[];
    dispatched: string[];
  };
  derivedEffectAttentions: string[];
};

function caseDto(caseId: string, status: "IN_PROGRESS" | "COMPLETED"): CaseDto {
  const now = "2030-01-01T00:00:00.000Z";
  return {
    id: caseId,
    residentId: randomUUID(),
    category: "LE",
    priority: "HIGH",
    status,
    description: "Broken street light",
    addressDetails: null,
    postalCode: "123456",
    createdAt: now,
    updatedAt: now,
  };
}

function command(caseId: string): CompleteCaseCommand {
  const assignmentId = randomUUID();
  const appointmentId = randomUUID();
  const beforeId = randomUUID();
  const afterId = randomUUID();
  const idempotencyKey = randomUUID();
  const payloadHash = "a".repeat(64);
  return {
    idempotencyKey,
    payloadHash,
    operationId: `${idempotencyKey}.${payloadHash}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId,
    assignmentId,
    appointmentId,
    input: { report: "Work completed.", proofItemIds: [afterId, beforeId] },
  };
}

function activities(
  recorded: Recorded,
  validation: Validation,
  completedCase: CaseDto,
  options: {
    effectGate?: Promise<void>;
    effectCreatedAt?: string;
    emailReservationFails?: boolean;
    performanceReservationFails?: boolean;
    resolveDerivedEffectAttentionFails?: boolean;
  } = {}
) {
  const effect = (
    input: {
      id: string;
      caseId: string;
      type: "EMAIL" | "PERFORMANCE_ENTRY";
      purpose: string;
    },
    status: "PENDING" | "SENT" | "FAILED" | "UNKNOWN" | "WAIVED"
  ) => ({
    id: input.id,
    caseId: input.caseId,
    type: input.type,
    purpose: input.purpose,
    status,
    providerId: null,
    providerIdempotencyKey: input.id,
    attempts: 1,
    lastError: status === "FAILED" ? "Metrics atom unavailable" : null,
    nextRetryAt:
      status === "FAILED"
        ? new Date(Date.now() + 60 * 60_000).toISOString()
        : null,
    waiverActorId: null,
    waiverReason: null,
    createdAt: options.effectCreatedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return {
    validateCompletion: async () => {
      recorded.calls.push("validate");
      if (validation === "APPOINTMENT_MISMATCH") {
        return { outcome: "APPOINTMENT_MISMATCH" as const };
      }
      if (validation === "ALREADY_COMPLETED") {
        return { outcome: "ALREADY_COMPLETED" as const, case: completedCase };
      }
      return { outcome: "READY" as const };
    },
    completeAppointment: async (input: {
      operationId: string;
      appointmentId: string;
      contractorId: string;
    }) => {
      recorded.calls.push("appointment");
      return {
        outcome:
          validation === "ALREADY_COMPLETED"
            ? ("ALREADY_COMPLETED" as const)
            : ("COMPLETED" as const),
        appointment: {
          id: input.appointmentId,
          caseId: completedCase.id,
          assignmentId: "aaaaaaaa-1111-4111-8111-111111111111",
          attemptId: "bbbbbbbb-1111-4111-8111-111111111111",
          contractorId: input.contractorId,
          startTime: "2030-01-01T09:00:00.000Z",
          endTime: "2030-01-01T10:00:00.000Z",
          status: "COMPLETED" as const,
          reason: null,
          operationId: input.operationId,
          createdAt: "2030-01-01T00:00:00.000Z",
        },
      };
    },
    completeAssignment: async (input: { assignmentId: string }) => {
      recorded.calls.push("assignment");
      return {
        outcome:
          validation === "ALREADY_COMPLETED"
            ? ("ALREADY_COMPLETED" as const)
            : ("COMPLETED" as const),
        assignment: {
          id: input.assignmentId,
          caseId: completedCase.id,
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
      };
    },
    completeCase: async () => {
      recorded.calls.push("case");
      return {
        outcome:
          validation === "ALREADY_COMPLETED"
            ? ("ALREADY_COMPLETED" as const)
            : ("COMPLETED" as const),
        case: completedCase,
      };
    },
    reserveEffect: async (input: {
      id: string;
      caseId: string;
      type: "EMAIL" | "PERFORMANCE_ENTRY";
      purpose: string;
    }) => {
      recorded.effects.reservations.push({ id: input.id, type: input.type });
      return effect(
        input,
        (input.type === "EMAIL" && options.emailReservationFails) ||
          (input.type === "PERFORMANCE_ENTRY" &&
            options.performanceReservationFails)
          ? "FAILED"
          : "PENDING"
      );
    },
    dispatchEmailEffect: async (input: { id: string }) => {
      recorded.effects.dispatched.push(input.id);
      await options.effectGate;
      return effect(
        {
          id: input.id,
          caseId: completedCase.id,
          type: "EMAIL",
          purpose: "ASSIGNMENT_COMPLETION_NOTIFICATION",
        },
        "SENT"
      );
    },
    dispatchPerformanceEffect: async (input: { id: string }) => {
      recorded.effects.dispatched.push(input.id);
      await options.effectGate;
      recorded.effectIds.push(input.id);
      return effect(
        {
          id: input.id,
          caseId: completedCase.id,
          type: "PERFORMANCE_ENTRY",
          purpose: "ASSIGNMENT_COMPLETION_PERFORMANCE",
        },
        "SENT"
      );
    },
    markEffectUnknown: async (id: string) =>
      effect(
        {
          id,
          caseId: completedCase.id,
          type: "EMAIL",
          purpose: "ASSIGNMENT_COMPLETION_NOTIFICATION",
        },
        "UNKNOWN"
      ),
    retryEffect: async (input: { id: string }) =>
      options.emailReservationFails
        ? {
            kind: "SUCCESS" as const,
            effect: effect(
              {
                id: input.id,
                caseId: completedCase.id,
                type: "EMAIL",
                purpose: "ASSIGNMENT_COMPLETION_NOTIFICATION",
              },
              "PENDING"
            ),
          }
        : { kind: "NOT_REPAIRABLE" as const },
    waiveEffect: async (input: { id: string }) => {
      // Echo back the effect actually requested — completeCase queues both
      // an EMAIL notification and a PERFORMANCE_ENTRY effect, and a stub
      // that always answers as the performance one would silently mismatch
      // a test waiving the notification effect.
      const isNotification = input.id.endsWith("/completion-notification");
      return effect(
        {
          id: input.id,
          caseId: completedCase.id,
          type: isNotification ? "EMAIL" : "PERFORMANCE_ENTRY",
          purpose: isNotification
            ? "ASSIGNMENT_COMPLETION_NOTIFICATION"
            : "ASSIGNMENT_COMPLETION_PERFORMANCE",
        },
        "WAIVED"
      );
    },
    raiseDerivedEffectAttention: async (input: { effectId: string }) => {
      recorded.derivedEffectAttentions.push(input.effectId);
    },
    resolveDerivedEffectAttention: async () => {
      if (options.resolveDerivedEffectAttentionFails) {
        throw new Error("Case atom unavailable");
      }
    },
    raiseOfficerAttention: async (input: {
      caseId: string;
      kind: OfficerAttentionKind;
    }) => {
      recorded.attentions.push(input);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("Case completion workflow (PRS-147)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  async function run(
    commandValue: CompleteCaseCommand,
    validation: Validation,
    options?: {
      effectGate?: Promise<void>;
      performanceReservationFails?: boolean;
    }
  ) {
    const recorded: Recorded = {
      calls: [],
      attentions: [],
      effectIds: [],
      effects: { reservations: [], dispatched: [] },
      derivedEffectAttentions: [],
    };
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    // Gate the derived effects unless the caller supplied their own, so the
    // sample below is taken at a deterministic point. Released before the
    // `runUntil` callback returns -- shutdown waits forever on an Activity
    // parked on a promise that never settles.
    let releaseEffects: (() => void) | undefined;
    const effectGate =
      options?.effectGate ??
      new Promise<void>((resolve) => {
        releaseEffects = resolve;
      });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: activities(
        recorded,
        validation,
        caseDto(
          commandValue.caseId,
          validation === "ALREADY_COMPLETED" ? "COMPLETED" : "IN_PROGRESS"
        ),
        { ...options, effectGate }
      ),
    });
    const client = new Client({ connection: env.nativeConnection });
    const workflowId = `case/${commandValue.caseId}`;
    let result: unknown;
    // Sampled inside `runUntil` while the effects are still gated, so an
    // assertion on it cannot race Worker shutdown. Reading `recorded.effectIds`
    // after `runUntil` returns is that race: `dispatchPerformanceEffect`
    // records the moment it is invoked, and shutdown drains in-flight
    // Activities rather than dropping them, so the assertion held only when
    // shutdown happened to win.
    let effectIdsDuringRun: string[] = [];

    await worker.runUntil(async () => {
      result = await client.workflow.executeUpdateWithStart(
        UPDATE_NAMES.completeCase,
        {
          args: [commandValue],
          updateId: commandValue.operationId,
          startWorkflowOperation: new WithStartWorkflowOperation(
            WORKFLOW_NAMES.case,
            {
              workflowId,
              taskQueue,
              args: [{ caseId: commandValue.caseId }],
              workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            }
          ),
        }
      );
      effectIdsDuringRun = [...recorded.effectIds];
      releaseEffects?.();
    });
    return { recorded, result, effectIdsDuringRun };
  }

  it("rejects a preflight Appointment mismatch before any completion mutation", async () => {
    const result = await run(command(randomUUID()), "APPOINTMENT_MISMATCH");

    expect(result.result).toEqual({ kind: "APPOINTMENT_MISMATCH" });
    expect(result.recorded.calls).toEqual(["validate"]);
    expect(result.recorded.attentions).toEqual([]);
  }, 30_000);

  it("keeps a terminal Case workflow open until its completion effects are sent", async () => {
    const commandValue = command(randomUUID());
    const recorded: Recorded = {
      calls: [],
      attentions: [],
      effectIds: [],
      effects: { reservations: [], dispatched: [] },
      derivedEffectAttentions: [],
    };
    let releaseEffects: (() => void) | undefined;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffects = resolve;
    });
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const workflowId = `case/${commandValue.caseId}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: activities(
        recorded,
        "READY",
        caseDto(commandValue.caseId, "IN_PROGRESS"),
        { effectGate }
      ),
    });
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const result = await client.workflow.executeUpdateWithStart(
        UPDATE_NAMES.completeCase,
        {
          args: [commandValue],
          updateId: commandValue.operationId,
          startWorkflowOperation: new WithStartWorkflowOperation(
            WORKFLOW_NAMES.case,
            {
              workflowId,
              taskQueue,
              args: [{ caseId: commandValue.caseId }],
              workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            }
          ),
        }
      );
      expect(result).toMatchObject({ kind: "SUCCESS" });
      expect(await waitFor(() => recorded.effects.dispatched.length > 0)).toBe(
        true
      );

      const completion = client.workflow.getHandle(workflowId).result();
      const closedBeforeEffects = await Promise.race([
        completion.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(closedBeforeEffects).toBe(false);

      releaseEffects?.();
      await expect(completion).resolves.toBeUndefined();
    });

    // Order-insensitive: Task 1 (PRS-150) starts every ready effect at once,
    // so these two independent, idempotent ledger effects race as concurrent
    // Activity round-trips — only that both dispatched is guaranteed.
    expect(recorded.effects.dispatched).toHaveLength(2);
    expect(recorded.effects.dispatched).toEqual(
      expect.arrayContaining([
        `${commandValue.assignmentId}/completion-notification`,
        `${commandValue.assignmentId}/completion`,
      ])
    );
  }, 30_000);

  it("marks an email UNKNOWN after the provider window and closes only after an Officer waiver", async () => {
    const commandValue = command(randomUUID());
    const recorded: Recorded = {
      calls: [],
      attentions: [],
      effectIds: [],
      effects: { reservations: [], dispatched: [] },
      derivedEffectAttentions: [],
    };
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const workflowId = `case/${commandValue.caseId}`;
    const effectId = `${commandValue.assignmentId}/completion-notification`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: activities(
        recorded,
        "READY",
        caseDto(commandValue.caseId, "IN_PROGRESS"),
        {
          emailReservationFails: true,
          effectCreatedAt: new Date(
            Date.now() - 24 * 60 * 60_000 - 1
          ).toISOString(),
        }
      ),
    });
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const completed = await client.workflow.executeUpdateWithStart(
        UPDATE_NAMES.completeCase,
        {
          args: [commandValue],
          updateId: commandValue.operationId,
          startWorkflowOperation: new WithStartWorkflowOperation(
            WORKFLOW_NAMES.case,
            {
              workflowId,
              taskQueue,
              args: [{ caseId: commandValue.caseId }],
              workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            }
          ),
        }
      );
      expect(completed).toMatchObject({ kind: "SUCCESS" });
      expect(
        await waitFor(() => recorded.derivedEffectAttentions.includes(effectId))
      ).toBe(true);

      const handle = client.workflow.getHandle(workflowId);
      const workflowResult = handle.result();
      const closedBeforeWaiver = await Promise.race([
        workflowResult.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(closedBeforeWaiver).toBe(false);

      const waiverKey = randomUUID();
      const waived = await handle.executeUpdate(UPDATE_NAMES.waiveEffect, {
        args: [
          {
            idempotencyKey: waiverKey,
            payloadHash: "b".repeat(64),
            operationId: `${waiverKey}.${"b".repeat(64)}`,
            actorId: randomUUID(),
            actorRole: "OFFICER",
            caseId: commandValue.caseId,
            effectId,
            input: { reason: "Provider confirmation unavailable" },
          },
        ],
        updateId: randomUUID(),
      });
      expect(waived).toMatchObject({
        kind: "SUCCESS",
        effect: { id: effectId, type: "EMAIL", status: "WAIVED" },
      });
      await expect(workflowResult).resolves.toBeUndefined();
    });
  }, 30_000);

  it("still settles the waiver and closes the terminal Workflow when resolving the Attention fails (regression: Attention bookkeeping must not corrupt delivery state)", async () => {
    const commandValue = command(randomUUID());
    const recorded: Recorded = {
      calls: [],
      attentions: [],
      effectIds: [],
      effects: { reservations: [], dispatched: [] },
      derivedEffectAttentions: [],
    };
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const workflowId = `case/${commandValue.caseId}`;
    const effectId = `${commandValue.assignmentId}/completion-notification`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: activities(
        recorded,
        "READY",
        caseDto(commandValue.caseId, "IN_PROGRESS"),
        {
          emailReservationFails: true,
          effectCreatedAt: new Date(
            Date.now() - 24 * 60 * 60_000 - 1
          ).toISOString(),
          resolveDerivedEffectAttentionFails: true,
        }
      ),
    });
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const completed = await client.workflow.executeUpdateWithStart(
        UPDATE_NAMES.completeCase,
        {
          args: [commandValue],
          updateId: commandValue.operationId,
          startWorkflowOperation: new WithStartWorkflowOperation(
            WORKFLOW_NAMES.case,
            {
              workflowId,
              taskQueue,
              args: [{ caseId: commandValue.caseId }],
              workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            }
          ),
        }
      );
      expect(completed).toMatchObject({ kind: "SUCCESS" });
      expect(
        await waitFor(() => recorded.derivedEffectAttentions.includes(effectId))
      ).toBe(true);

      const handle = client.workflow.getHandle(workflowId);
      const workflowResult = handle.result();

      const waiverKey = randomUUID();
      // Every resolveDerivedEffectAttention call fails here. That is
      // bookkeeping, not delivery — the atom durably recorded WAIVED — so the
      // Update must still report SUCCESS, and the Workflow's own effect.status
      // must not lag that durable commit. Two things would each hang a terminal
      // Workflow forever if the ordering or the tolerance regressed: a waive
      // whose local status is never set, and a SENT Performance Entry demoted
      // back to FAILED by the same failing resolve. The accepted trade-off is
      // an orphaned open Attention row.
      const waived = await handle.executeUpdate(UPDATE_NAMES.waiveEffect, {
        args: [
          {
            idempotencyKey: waiverKey,
            payloadHash: "b".repeat(64),
            operationId: `${waiverKey}.${"b".repeat(64)}`,
            actorId: randomUUID(),
            actorRole: "OFFICER",
            caseId: commandValue.caseId,
            effectId,
            input: { reason: "Provider confirmation unavailable" },
          },
        ],
        updateId: randomUUID(),
      });

      expect(waived).toMatchObject({ kind: "SUCCESS" });
      await expect(workflowResult).resolves.toBeUndefined();
    });
  }, 30_000);

  it("runs the terminal chain once in order and reconstructs success from an already-completed operation", async () => {
    const firstCommand = command(randomUUID());
    const first = await run(firstCommand, "READY");

    expect(first.result).toMatchObject({ kind: "SUCCESS" });
    expect(first.recorded.calls).toEqual([
      "validate",
      "appointment",
      "assignment",
      "case",
    ]);
    expect(first.effectIdsDuringRun).toEqual([]);

    const replay = await run(firstCommand, "ALREADY_COMPLETED");

    expect(replay.result).toMatchObject({ kind: "SUCCESS" });
    expect(replay.recorded.calls).toEqual([]);
    expect(replay.effectIdsDuringRun).toEqual([]);
  }, 30_000);

  it("returns core success when the post-commit performance effect cannot be reserved", async () => {
    const commandValue = command(randomUUID());
    const result = await run(commandValue, "READY", {
      performanceReservationFails: true,
    });

    expect(result.result).toMatchObject({ kind: "SUCCESS" });
    expect(result.recorded.calls).toEqual([
      "validate",
      "appointment",
      "assignment",
      "case",
    ]);
    expect(result.recorded.attentions).toEqual([]);
  }, 30_000);

  it("returns the cached core completion for a new Temporal delivery ID", async () => {
    const commandValue = command(randomUUID());
    const recorded: Recorded = {
      calls: [],
      attentions: [],
      effectIds: [],
      effects: { reservations: [], dispatched: [] },
      derivedEffectAttentions: [],
    };
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const workflowId = `case/${commandValue.caseId}`;
    // Held for the whole run below. Without it, whether the completion's
    // derived effects land before `runUntil` shuts the Worker down is a race —
    // `dispatchPerformanceEffect` records the moment it is invoked, and Worker
    // shutdown drains in-flight Activities rather than dropping them. It is
    // released before the callback returns: shutdown waits forever on an
    // Activity parked on a promise that never settles.
    let releaseEffects: (() => void) | undefined;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffects = resolve;
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: activities(
        recorded,
        "READY",
        caseDto(commandValue.caseId, "IN_PROGRESS"),
        { effectGate }
      ),
    });
    const client = new Client({ connection: env.nativeConnection });
    const firstDeliveryId = `${commandValue.operationId}/delivery/first`;
    const repairedDeliveryId = `${commandValue.operationId}/delivery/repaired`;
    let firstResult: unknown;
    let repairedResult: unknown;

    await worker.runUntil(async () => {
      firstResult = await client.workflow.executeUpdateWithStart(
        UPDATE_NAMES.completeCase,
        {
          args: [commandValue],
          updateId: firstDeliveryId,
          startWorkflowOperation: new WithStartWorkflowOperation(
            WORKFLOW_NAMES.case,
            {
              workflowId,
              taskQueue,
              args: [{ caseId: commandValue.caseId }],
              workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            }
          ),
        }
      );

      repairedResult = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.completeCase, {
          args: [commandValue],
          updateId: repairedDeliveryId,
        });

      // Both deliveries returned their core completion while every derived
      // effect is still held: neither waited on one, and neither recorded one.
      expect(recorded.effectIds).toEqual([]);
      releaseEffects?.();
    });

    expect(firstDeliveryId).not.toBe(repairedDeliveryId);
    expect(firstResult).toMatchObject({ kind: "SUCCESS" });
    expect(repairedResult).toMatchObject({ kind: "SUCCESS" });
    expect(recorded.calls).toEqual([
      "validate",
      "appointment",
      "assignment",
      "case",
    ]);
    expect(recorded.attentions).toEqual([]);
  }, 30_000);
});
