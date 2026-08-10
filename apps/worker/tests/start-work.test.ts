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
  MarkAssignmentInProgressInput,
  MarkAssignmentInProgressResult,
  MarkCaseInProgressInput,
  MarkCaseInProgressResult,
  OfficerAttentionKind,
  StartWorkAppointmentInput,
  StartWorkAppointmentResult,
  StartWorkCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { immediateDerivedEffectActivities } from "./derived-effect-test-activities";

/**
 * The startWork Update handler (PRS-145). Every `it` below is one of the 10
 * scenarios enumerated in the PRS-145 plan's Verification section.
 *
 * Like acceptance-sla-breach.test.ts, this uses short *real* windows plus
 * real-clock waits rather than the environment's automatic time-skipping —
 * the window gate here is a plain `Date.now()` comparison inside the Update
 * handler, not a Workflow timer, so there is nothing for auto-skip to
 * fast-forward to.
 */

const contractorId = "11111111-1111-4111-8111-111111111111";

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

function startWorkCommand(params: {
  caseId: string;
  assignmentId: string;
  appointmentId: string;
  startOffsetMs: number;
  endOffsetMs: number;
  idempotencyKey?: string;
  payloadHash?: string;
  contractorId?: string;
}): StartWorkCommand {
  const idempotencyKey = params.idempotencyKey ?? randomUUID();
  const payloadHash = params.payloadHash ?? "a".repeat(64);
  return {
    idempotencyKey,
    payloadHash,
    operationId: `${idempotencyKey}.${payloadHash}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId: params.contractorId ?? contractorId,
    caseId: params.caseId,
    assignmentId: params.assignmentId,
    appointmentId: params.appointmentId,
    startTime: futureIso(params.startOffsetMs),
    endTime: futureIso(params.endOffsetMs),
  };
}

/** Every fake Activity a startWork Saga needs, recording every call it sees. */
type Recorded = {
  appointmentCalls: StartWorkAppointmentInput[];
  assignmentCalls: MarkAssignmentInProgressInput[];
  caseCalls: MarkCaseInProgressInput[];
  attentions: { caseId: string; kind: OfficerAttentionKind; detail: string }[];
  callOrder: string[];
};

function newRecorder(): Recorded {
  return {
    appointmentCalls: [],
    assignmentCalls: [],
    caseCalls: [],
    attentions: [],
    callOrder: [],
  };
}

type ActivityConfig = {
  recorded: Recorded;
  startWorkAppointment?: (
    input: StartWorkAppointmentInput
  ) => Promise<StartWorkAppointmentResult> | StartWorkAppointmentResult;
  markAssignmentInProgress?: (
    input: MarkAssignmentInProgressInput
  ) => Promise<MarkAssignmentInProgressResult> | MarkAssignmentInProgressResult;
  markCaseInProgress?: (
    input: MarkCaseInProgressInput
  ) => Promise<MarkCaseInProgressResult> | MarkCaseInProgressResult;
};

/** Builds the fake Activities map shared by every scenario in this file. */
function makeActivities(config: ActivityConfig) {
  const { recorded } = config;
  return {
    startWorkAppointment: async (input: StartWorkAppointmentInput) => {
      recorded.appointmentCalls.push(input);
      recorded.callOrder.push("appointment");
      if (config.startWorkAppointment) {
        return config.startWorkAppointment(input);
      }
      const now = new Date().toISOString();
      return {
        outcome: "STARTED" as const,
        appointment: {
          id: input.appointmentId,
          caseId: randomUUID(),
          assignmentId: randomUUID(),
          attemptId: randomUUID(),
          contractorId: input.contractorId,
          startTime: "2030-01-01T09:00:00.000Z",
          endTime: "2030-01-01T10:00:00.000Z",
          status: "IN_PROGRESS" as const,
          operationId: input.operationId,
          createdAt: now,
        },
      };
    },
    markAssignmentInProgress: async (input: MarkAssignmentInProgressInput) => {
      recorded.assignmentCalls.push(input);
      recorded.callOrder.push("assignment");
      if (config.markAssignmentInProgress) {
        return config.markAssignmentInProgress(input);
      }
      const now = new Date().toISOString();
      return {
        outcome: "IN_PROGRESS" as const,
        assignment: {
          id: input.assignmentId,
          caseId: randomUUID(),
          createdAt: now,
          updatedAt: now,
        },
      };
    },
    markCaseInProgress: async (input: MarkCaseInProgressInput) => {
      recorded.caseCalls.push(input);
      recorded.callOrder.push("case");
      if (config.markCaseInProgress) {
        return config.markCaseInProgress(input);
      }
      const now = new Date().toISOString();
      return {
        outcome: "IN_PROGRESS" as const,
        case: {
          id: input.caseId,
          residentId: randomUUID(),
          category: "LE" as const,
          priority: "HIGH" as const,
          status: "IN_PROGRESS" as const,
          description: "Broken street light",
          addressDetails: null,
          postalCode: "123456",
          createdAt: now,
          updatedAt: now,
        },
      };
    },
    raiseOfficerAttention: async (input: {
      caseId: string;
      kind: OfficerAttentionKind;
      detail: string;
    }) => {
      recorded.attentions.push(input);
      return undefined;
    },
    ...immediateDerivedEffectActivities(),
  };
}

function startWorkflowAndCall(
  client: Client,
  workflowId: string,
  taskQueue: string,
  caseId: string,
  command: StartWorkCommand
) {
  return client.workflow.executeUpdateWithStart(UPDATE_NAMES.startWork, {
    args: [command],
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

describe("Start work during the Appointment (PRS-145)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  async function createCaseWorker(
    activities: ReturnType<typeof makeActivities>,
    options?: { maxCachedWorkflows?: number }
  ) {
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities,
      ...options,
    });
    return { worker, taskQueue };
  }

  it("1. inside the window succeeds and calls all three atoms once, in order", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({ recorded })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );

      expect(result).toMatchObject({ kind: "SUCCESS" });
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.assignmentCalls).toHaveLength(1);
      expect(recorded.caseCalls).toHaveLength(1);
      expect(recorded.callOrder).toEqual(["appointment", "assignment", "case"]);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("1a. a caseId that does not match this Workflow is rejected as CASE_MISMATCH without running the Saga", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({ recorded })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId: randomUUID(), // deliberately different from the Workflow's caseId
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );

      expect(result).toEqual({ kind: "CASE_MISMATCH" });
      expect(recorded.appointmentCalls).toHaveLength(0);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("1b. the same idempotencyKey with a different payloadHash returns IDEMPOTENCY_KEY_REUSED without a second Saga run", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({ recorded })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const first = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );
      expect(first).toMatchObject({ kind: "SUCCESS" });

      const changed = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.startWork, {
          args: [
            {
              ...command,
              payloadHash: "b".repeat(64),
              operationId: `${command.idempotencyKey}.${"b".repeat(64)}`,
            },
          ],
          updateId: randomUUID(),
        });

      expect(changed).toEqual({ kind: "IDEMPOTENCY_KEY_REUSED" });
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.assignmentCalls).toHaveLength(1);
      expect(recorded.caseCalls).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("2. before startTime is rejected without calling any atom, and a same-key retry after the window opens succeeds", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({ recorded })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        // Comfortable headroom above the first-workflow-task cold-start —
        // this races to arrive *before* startTime, unlike the acceptance
        // test's "wait for a deadline to elapse" pattern, so it needs a
        // wide margin rather than a tight one.
        startOffsetMs: 3_000,
        endOffsetMs: 10_000,
      });
      const early = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );
      expect(early).toEqual({ kind: "NOT_IN_WINDOW" });
      expect(recorded.appointmentCalls).toHaveLength(0);

      // Same idempotencyKey/payloadHash — proves the before-window rejection
      // above was never cached.
      await waitUntil(() => Date.now() >= Date.parse(command.startTime) + 20);
      const retried = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.startWork, {
          args: [command],
          updateId: randomUUID(),
        });

      expect(retried).toMatchObject({ kind: "SUCCESS" });
      expect(recorded.appointmentCalls).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("3. at/after endTime is rejected without calling any atom", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({ recorded })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -5_000,
        endOffsetMs: -100,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );

      expect(result).toEqual({ kind: "NOT_IN_WINDOW" });
      expect(recorded.appointmentCalls).toHaveLength(0);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("4. a duplicate command after SUCCESS replays the cached result, atoms called once total", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({ recorded })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const first = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );
      expect(first).toMatchObject({ kind: "SUCCESS" });

      const duplicate = await client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.startWork, {
          args: [command],
          updateId: randomUUID(),
        });

      expect(duplicate).toEqual(first);
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.assignmentCalls).toHaveLength(1);
      expect(recorded.caseCalls).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("5. a same-key retry while the first call is still in flight reattaches to one Saga", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        startWorkAppointment: async (input) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const now = new Date().toISOString();
          return {
            outcome: "STARTED" as const,
            appointment: {
              id: input.appointmentId,
              caseId: randomUUID(),
              assignmentId: randomUUID(),
              attemptId: randomUUID(),
              contractorId: input.contractorId,
              startTime: "2030-01-01T09:00:00.000Z",
              endTime: "2030-01-01T10:00:00.000Z",
              status: "IN_PROGRESS" as const,
              reason: null,
              operationId: input.operationId,
              createdAt: now,
            },
          };
        },
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });

      const [firstResult, secondResult] = await Promise.all([
        startWorkflowAndCall(client, workflowId, taskQueue, caseId, command),
        waitUntil(() => recorded.appointmentCalls.length > 0).then(() =>
          client.workflow
            .getHandle(workflowId)
            .executeUpdate(UPDATE_NAMES.startWork, {
              args: [command],
              updateId: randomUUID(),
            })
        ),
      ]);

      expect(firstResult).toMatchObject({ kind: "SUCCESS" });
      expect(secondResult).toEqual(firstResult);
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.assignmentCalls).toHaveLength(1);
      expect(recorded.caseCalls).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("6. wrong Contractor is rejected without mutating the Assignment or Case", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        startWorkAppointment: async () => ({ outcome: "WRONG_CONTRACTOR" }),
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );

      expect(result).toEqual({ kind: "WRONG_CONTRACTOR" });
      expect(recorded.assignmentCalls).toHaveLength(0);
      expect(recorded.caseCalls).toHaveLength(0);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("7. an already-started Appointment still proceeds through Assignment and Case, idempotently", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        startWorkAppointment: async (input) => {
          const now = new Date().toISOString();
          return {
            outcome: "ALREADY_STARTED" as const,
            appointment: {
              id: input.appointmentId,
              caseId: randomUUID(),
              assignmentId: randomUUID(),
              attemptId: randomUUID(),
              contractorId: input.contractorId,
              startTime: "2030-01-01T09:00:00.000Z",
              endTime: "2030-01-01T10:00:00.000Z",
              status: "IN_PROGRESS" as const,
              reason: null,
              operationId: input.operationId,
              createdAt: now,
            },
          };
        },
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );

      expect(result).toMatchObject({ kind: "SUCCESS" });
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.assignmentCalls).toHaveLength(1);
      expect(recorded.caseCalls).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("8. the Saga survives a forced full replay (Worker cache eviction) idempotently", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    // Every single Workflow Task is a full replay from history — no sticky
    // cache survives between them, the same "no continuity" property a
    // genuine Worker process restart between atom writes has (see the
    // equivalent control test in acceptance-sla-breach.test.ts for why a
    // literal two-process restart could not be made reliable in this
    // sandbox).
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({ recorded }),
      { maxCachedWorkflows: 0 }
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );

      expect(result).toMatchObject({ kind: "SUCCESS" });
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.assignmentCalls).toHaveLength(1);
      expect(recorded.caseCalls).toHaveLength(1);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("9a. a permanent Assignment failure after the Appointment committed raises WORK_START_FAILED, without touching the Case", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        markAssignmentInProgress: async () => ({ outcome: "NOT_ACCEPTED" }),
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );

      expect(result).toEqual({ kind: "WORK_START_FAILED" });
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.caseCalls).toHaveLength(0);
      expect(recorded.attentions).toHaveLength(1);
      expect(recorded.attentions[0]).toMatchObject({
        caseId,
        kind: "WORK_START_FAILED",
      });

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("9b. a permanent Case failure after the Appointment and Assignment committed raises WORK_START_FAILED", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({
        recorded,
        markCaseInProgress: async () => ({ outcome: "CASE_TERMINAL" }),
      })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );

      expect(result).toEqual({ kind: "WORK_START_FAILED" });
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.assignmentCalls).toHaveLength(1);
      expect(recorded.attentions).toHaveLength(1);
      expect(recorded.attentions[0]).toMatchObject({
        caseId,
        kind: "WORK_START_FAILED",
      });

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);

  it("10. past endTime after a successful start touches nothing further — no timer, no revert", async () => {
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createCaseWorker(
      makeActivities({ recorded })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = startWorkCommand({
        caseId,
        assignmentId,
        appointmentId,
        // Comfortable headroom so the initial start reliably lands inside
        // the window despite a cold first workflow task, then a 3s real
        // wait comfortably clears endTime.
        startOffsetMs: -1_000,
        endOffsetMs: 2_500,
      });
      const result = await startWorkflowAndCall(
        client,
        workflowId,
        taskQueue,
        caseId,
        command
      );
      expect(result).toMatchObject({ kind: "SUCCESS" });

      // Wait past endTime; nothing spontaneous should happen — start-work
      // adds no timer and the main allocation loop is untouched.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(recorded.appointmentCalls).toHaveLength(1);
      expect(recorded.assignmentCalls).toHaveLength(1);
      expect(recorded.caseCalls).toHaveLength(1);
      expect(recorded.attentions).toHaveLength(0);

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);
});
