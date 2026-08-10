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
  AppointmentDto,
  CancelCaseCommand,
  CaseDto,
  ReportNoAccessCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { immediateDerivedEffectActivities } from "./derived-effect-test-activities";

/**
 * Worker restart durability (PRS-152 AC8).
 *
 * Every scenario runs a Case on Worker A, stops that Worker, starts Worker B on
 * the same Task Queue with its own recorder, and asserts the Case reaches the
 * same outcome — with B's recorder proving which side of the process boundary
 * each Activity ran on.
 *
 * Two harness constraints, both measured rather than assumed:
 *
 * - `maxCachedWorkflows: 0` is load-bearing. With the default sticky cache the
 *   server keeps routing this Workflow to the dead Worker's sticky queue and
 *   the handover did not happen inside a 60s test at all; with the cache off
 *   there is no sticky queue and Worker B picks the Workflow up in ~250ms. It
 *   is not a substitute for the restart (see `acceptance-sla-breach` test 8 for
 *   that argument), it is what makes the restart observable here.
 * - Worker A never holds an Activity open across its own shutdown. `shutdown()`
 *   waits for in-flight Activities, so an Activity parked on a promise that
 *   never settles hangs the shutdown forever. Where a scenario needs work
 *   outstanding at the restart, Worker A's stub *fails* instead: Temporal's
 *   retry leaves the Saga step, the Update handler, or the derived effect
 *   genuinely unfinished, with nothing in flight to drain.
 */

const contractorId = "11111111-1111-4111-8111-111111111111";
const scheduledStart = "2030-01-01T09:00:00.000Z";
const scheduledEnd = "2030-01-01T10:00:00.000Z";

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

function caseDto(caseId: string, status: CaseDto["status"]): CaseDto {
  const now = "2030-01-01T00:00:00.000Z";
  return {
    id: caseId,
    residentId: "22222222-2222-4222-8222-222222222222",
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

function appointmentDto(
  caseId: string,
  assignmentId: string,
  attemptId: string,
  appointmentId: string,
  status: AppointmentDto["status"],
  endTime = scheduledEnd
): AppointmentDto {
  return {
    id: appointmentId,
    caseId,
    assignmentId,
    attemptId,
    contractorId,
    startTime: scheduledStart,
    endTime,
    status,
    reason: null,
    operationId: `appointment/${appointmentId}`,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

function acceptedResult(
  caseId: string,
  assignmentId: string,
  attemptId: string,
  appointmentId: string,
  endTime = scheduledEnd
): AcceptAllocationResult {
  const now = "2030-01-01T00:00:00.000Z";
  return {
    kind: "SUCCESS",
    data: {
      assignment: { id: assignmentId, caseId, createdAt: now, updatedAt: now },
      attempt: {
        id: attemptId,
        assignmentId,
        contractorId,
        source: "AUTO_ASSIGN",
        status: "ACCEPTED",
        acceptanceSlaMs: 60_000,
        deadlineAt: "2030-01-01T08:00:00.000Z",
        actorId: "00000000-0000-0000-0000-000000000000",
        actorRole: "SYSTEM",
        reason: null,
        operationId: `accept/${attemptId}`,
        createdAt: now,
      },
      appointment: appointmentDto(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        "SCHEDULED",
        endTime
      ),
    },
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
    payloadHash: "b".repeat(64),
    operationId: `${idempotencyKey}.${"b".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId,
    assignmentId,
    attemptId,
    input: { startTime: scheduledStart, endTime: scheduledEnd },
  };
}

function cancelCommand(caseId: string): CancelCaseCommand {
  const idempotencyKey = randomUUID();
  const payloadHash = "a".repeat(64);
  return {
    idempotencyKey,
    payloadHash,
    operationId: `${idempotencyKey}.${payloadHash}`,
    actorId: randomUUID(),
    actorRole: "RESIDENT",
    caseId,
    input: { reason: "No longer needed" },
  };
}

function noAccessCommand(
  caseId: string,
  appointmentId: string
): ReportNoAccessCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "e".repeat(64),
    operationId: `${idempotencyKey}.${"e".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId,
    appointmentId,
    startTime: futureIso(-60_000),
    endTime: futureIso(60_000),
  };
}

function acceptOperation(
  client: Client,
  taskQueue: string,
  caseId: string,
  command: AcceptAllocationCommand
) {
  return client.workflow.executeUpdateWithStart(UPDATE_NAMES.acceptAllocation, {
    args: [command],
    updateId: randomUUID(),
    startWorkflowOperation: new WithStartWorkflowOperation(
      WORKFLOW_NAMES.case,
      {
        workflowId: `case/${caseId}`,
        taskQueue,
        args: [{ caseId }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }
    ),
  });
}

describe("Worker restart durability (PRS-152 AC8)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  /** Starts a Worker and returns the function that stops that process. */
  async function startWorker(
    taskQueue: string,
    activities: Record<string, unknown>
  ) {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities,
      maxCachedWorkflows: 0,
    });
    const running = worker.run();
    return async () => {
      worker.shutdown();
      await running;
    };
  }

  function cancellationStubs(
    caseId: string,
    assignmentId: string,
    attemptId: string,
    appointmentId: string,
    calls: string[]
  ) {
    return {
      cancelScheduledAppointment: async () => {
        calls.push("cancel-appointment");
        return {
          outcome: "CANCELLED" as const,
          appointment: appointmentDto(
            caseId,
            assignmentId,
            attemptId,
            appointmentId,
            "CANCELLED"
          ),
        };
      },
      cancelAssignmentForCase: async () => {
        calls.push("cancel-assignment");
        return { outcome: "CANCELLED" as const };
      },
      cancelCase: async () => {
        calls.push("cancel-case");
        return {
          outcome: "CANCELLED" as const,
          case: caseDto(caseId, "CANCELLED"),
        };
      },
    };
  }

  it("runs a Saga issued after the restart entirely on the new Worker", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const callsA: string[] = [];
    const callsB: string[] = [];
    const client = new Client({ connection: env.nativeConnection });

    const stopA = await startWorker(taskQueue, {
      acceptAllocation: async () => {
        callsA.push("accept");
        return acceptedResult(caseId, assignmentId, attemptId, appointmentId);
      },
      ...cancellationStubs(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        callsA
      ),
      ...immediateDerivedEffectActivities(),
    });
    try {
      await expect(
        acceptOperation(
          client,
          taskQueue,
          caseId,
          acceptCommand(caseId, assignmentId, attemptId)
        )
      ).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { appointment: { id: appointmentId } },
      });
    } finally {
      await stopA();
    }

    const stopB = await startWorker(taskQueue, {
      acceptAllocation: async () => {
        callsB.push("accept");
        return acceptedResult(caseId, assignmentId, attemptId, appointmentId);
      },
      ...cancellationStubs(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        callsB
      ),
      ...immediateDerivedEffectActivities(),
    });
    try {
      await expect(
        client.workflow
          .getHandle(`case/${caseId}`)
          .executeUpdate(UPDATE_NAMES.cancelCase, {
            args: [cancelCommand(caseId)],
            updateId: randomUUID(),
          })
      ).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { case: { status: "CANCELLED" } },
      });
    } finally {
      await stopB();
    }

    // The Appointment the Saga cancels was only ever committed on Worker A, and
    // the whole Saga ran on Worker B — including reading back that Appointment.
    expect(callsA).toEqual(["accept"]);
    expect(callsB).toEqual([
      "cancel-appointment",
      "cancel-assignment",
      "cancel-case",
    ]);
  }, 60_000);

  it("resumes a Saga at the step after the one that already committed", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const callsA: string[] = [];
    const callsB: string[] = [];
    const client = new Client({ connection: env.nativeConnection });

    const stopA = await startWorker(taskQueue, {
      acceptAllocation: async () =>
        acceptedResult(caseId, assignmentId, attemptId, appointmentId),
      ...cancellationStubs(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        callsA
      ),
      // Step 2 never succeeds on Worker A, so the Saga is stopped between its
      // committed first step and its unstarted second one — Temporal's retry
      // keeps it outstanding with nothing in flight to drain at shutdown.
      cancelAssignmentForCase: async () => {
        callsA.push("cancel-assignment-failed");
        throw new Error("Assignment atom unavailable on Worker A");
      },
      ...immediateDerivedEffectActivities(),
    });
    let cancellation: Promise<unknown>;
    try {
      await acceptOperation(
        client,
        taskQueue,
        caseId,
        acceptCommand(caseId, assignmentId, attemptId)
      );
      cancellation = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        });
      expect(
        await waitUntil(() => callsA.includes("cancel-assignment-failed"))
      ).toBe(true);
    } finally {
      await stopA();
    }

    const stopB = await startWorker(taskQueue, {
      acceptAllocation: async () =>
        acceptedResult(caseId, assignmentId, attemptId, appointmentId),
      ...cancellationStubs(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        callsB
      ),
      ...immediateDerivedEffectActivities(),
    });
    try {
      await expect(cancellation).resolves.toMatchObject({ kind: "SUCCESS" });
    } finally {
      await stopB();
    }

    expect(callsA[0]).toBe("cancel-appointment");
    // The committed Appointment cancellation is never replayed as a second
    // call: Worker B picks the Saga back up at step 2.
    expect(callsB).toEqual(["cancel-assignment", "cancel-case"]);
  }, 60_000);

  it("fires an armed timer on the new Worker after a restart during the wait", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const missedA: string[] = [];
    const missedB: string[] = [];
    const attentionsB: string[] = [];
    const client = new Client({ connection: env.nativeConnection });
    // Far enough out that the restart lands well inside the wait, short enough
    // that the new Worker is polling long before it comes due.
    const appointmentEndsAt = futureIso(8_000);

    const missedStub = (recorder: string[]) => ({
      markAppointmentMissed: async (input: { appointmentId: string }) => {
        recorder.push(input.appointmentId);
        return {
          outcome: "MISSED" as const,
          appointment: appointmentDto(
            caseId,
            assignmentId,
            attemptId,
            input.appointmentId,
            "MISSED",
            appointmentEndsAt
          ),
        };
      },
    });

    const stopA = await startWorker(taskQueue, {
      acceptAllocation: async () =>
        acceptedResult(
          caseId,
          assignmentId,
          attemptId,
          appointmentId,
          appointmentEndsAt
        ),
      ...missedStub(missedA),
      raiseOfficerAttention: async () => undefined,
      ...immediateDerivedEffectActivities(),
    });
    try {
      await expect(
        acceptOperation(
          client,
          taskQueue,
          caseId,
          acceptCommand(caseId, assignmentId, attemptId)
        )
      ).resolves.toMatchObject({ kind: "SUCCESS" });
    } finally {
      await stopA();
    }
    // The timer this test is about must still be pending when Worker A goes.
    expect(Date.now()).toBeLessThan(Date.parse(appointmentEndsAt));
    expect(missedA).toEqual([]);

    const stopB = await startWorker(taskQueue, {
      acceptAllocation: async () =>
        acceptedResult(
          caseId,
          assignmentId,
          attemptId,
          appointmentId,
          appointmentEndsAt
        ),
      ...missedStub(missedB),
      raiseOfficerAttention: async (input: { kind: string }) => {
        attentionsB.push(input.kind);
        return undefined;
      },
      ...immediateDerivedEffectActivities(),
    });
    try {
      expect(await waitUntil(() => missedB.length > 0)).toBe(true);
      expect(await waitUntil(() => attentionsB.length > 0)).toBe(true);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    } finally {
      await stopB();
    }

    expect(missedA).toEqual([]);
    expect(missedB).toEqual([appointmentId]);
    expect(attentionsB).toEqual(["MISSED_APPOINTMENT"]);
  }, 60_000);

  it("completes an Update whose handler was still running when the Worker went", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const client = new Client({ connection: env.nativeConnection });
    let attemptsOnA = 0;
    let attemptsOnB = 0;

    const stopA = await startWorker(taskQueue, {
      // The handler is inside `await activities.acceptAllocation(...)` for the
      // whole life of Worker A: the Activity keeps failing and being retried,
      // so the Update is accepted, unfinished, and holding no in-flight work.
      acceptAllocation: async () => {
        attemptsOnA++;
        throw new Error("Assignment atom unavailable on Worker A");
      },
      ...immediateDerivedEffectActivities(),
    });
    let acceptance: Promise<unknown>;
    try {
      acceptance = acceptOperation(
        client,
        taskQueue,
        caseId,
        acceptCommand(caseId, assignmentId, attemptId)
      );
      expect(await waitUntil(() => attemptsOnA > 0)).toBe(true);
    } finally {
      await stopA();
    }

    const stopB = await startWorker(taskQueue, {
      acceptAllocation: async () => {
        attemptsOnB++;
        return acceptedResult(caseId, assignmentId, attemptId, appointmentId);
      },
      ...immediateDerivedEffectActivities(),
    });
    try {
      // The client has been waiting on this Update since before the restart.
      await expect(acceptance).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { appointment: { id: appointmentId, status: "SCHEDULED" } },
      });
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    } finally {
      await stopB();
    }

    expect(attemptsOnA).toBeGreaterThan(0);
    expect(attemptsOnB).toBe(1);
  }, 60_000);

  it("delivers a derived effect left outstanding by the old Worker", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const effectId = `${appointmentId}/no-access-notification`;
    const dispatchesA: string[] = [];
    const deliveriesB: string[] = [];
    const client = new Client({ connection: env.nativeConnection });

    const noAccessStubs = {
      acceptAllocation: async () =>
        acceptedResult(caseId, assignmentId, attemptId, appointmentId),
      reportNoAccessAppointment: async () => ({
        outcome: "NO_ACCESS" as const,
        appointment: appointmentDto(
          caseId,
          assignmentId,
          attemptId,
          appointmentId,
          "NO_ACCESS"
        ),
      }),
      markCaseNoAccess: async () => ({
        outcome: "PENDING_RESIDENT_INPUT" as const,
        case: caseDto(caseId, "PENDING_RESIDENT_INPUT"),
      }),
    };

    const stopA = await startWorker(taskQueue, {
      ...noAccessStubs,
      ...immediateDerivedEffectActivities(),
      // Reservation succeeds, delivery does not: the effect is left FAILED with
      // its own retry armed, which is the outstanding state under test.
      dispatchEmailEffect: async (input: { id: string }) => {
        dispatchesA.push(input.id);
        throw new Error("Email provider unavailable on Worker A");
      },
    });
    try {
      await acceptOperation(
        client,
        taskQueue,
        caseId,
        acceptCommand(caseId, assignmentId, attemptId)
      );
      await expect(
        client.workflow
          .getHandle(`case/${caseId}`)
          .executeUpdate(UPDATE_NAMES.reportNoAccess, {
            args: [noAccessCommand(caseId, appointmentId)],
            updateId: randomUUID(),
          })
      ).resolves.toMatchObject({ kind: "SUCCESS" });
      expect(await waitUntil(() => dispatchesA.includes(effectId))).toBe(true);
    } finally {
      await stopA();
    }

    const effectsB = immediateDerivedEffectActivities();
    const stopB = await startWorker(taskQueue, {
      ...noAccessStubs,
      ...effectsB,
      dispatchEmailEffect: async (input: { id: string }) => {
        const delivered = await effectsB.dispatchEmailEffect(input);
        deliveriesB.push(input.id);
        return delivered;
      },
    });
    try {
      expect(await waitUntil(() => deliveriesB.includes(effectId))).toBe(true);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    } finally {
      await stopB();
    }

    expect(dispatchesA).toContain(effectId);
    expect(deliveriesB).toEqual([effectId]);
  }, 60_000);
});
