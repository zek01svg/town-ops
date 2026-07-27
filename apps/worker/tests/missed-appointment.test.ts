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
  MarkAppointmentMissedInput,
  MarkAppointmentMissedResult,
  ReplaceAppointmentCommand,
  ReportNoAccessCommand,
  StartWorkCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const contractorId = "11111111-1111-4111-8111-111111111111";
let clockSkewMs = 0;

function isoAt(offsetMs: number) {
  return new Date(Date.now() + clockSkewMs + offsetMs).toISOString();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function appointment(
  caseId: string,
  appointmentId: string,
  startTime: string,
  endTime: string,
  status: "SCHEDULED" | "IN_PROGRESS" | "NO_ACCESS" | "MISSED",
  operationId: string
) {
  return {
    id: appointmentId,
    caseId,
    assignmentId: randomUUID(),
    attemptId: randomUUID(),
    contractorId,
    startTime,
    endTime,
    status,
    reason: null,
    operationId,
    createdAt: new Date().toISOString(),
  };
}

function startWorkCommand(
  accepted: AcceptAllocationCommand,
  appointmentId: string
): StartWorkCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "b".repeat(64),
    operationId: `start/${idempotencyKey}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId: accepted.caseId,
    assignmentId: accepted.assignmentId,
    appointmentId,
    startTime: accepted.input.startTime,
    endTime: accepted.input.endTime,
  };
}

function noAccessCommand(
  accepted: AcceptAllocationCommand,
  appointmentId: string
): ReportNoAccessCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "c".repeat(64),
    operationId: `no-access/${idempotencyKey}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId: accepted.caseId,
    appointmentId,
    startTime: accepted.input.startTime,
    endTime: accepted.input.endTime,
  };
}

function replaceCommand(
  accepted: AcceptAllocationCommand,
  appointmentId: string,
  previousStatus: "SCHEDULED" | "MISSED",
  startOffsetMs: number,
  endOffsetMs: number
): ReplaceAppointmentCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "d".repeat(64),
    operationId: `replace/${idempotencyKey}`,
    actorId: randomUUID(),
    actorRole: "RESIDENT",
    caseId: accepted.caseId,
    appointmentId,
    input: {
      startTime: isoAt(startOffsetMs),
      endTime: isoAt(endOffsetMs),
      reason: "Resident requested a replacement Appointment.",
    },
    previousStartTime: accepted.input.startTime,
    previousStatus,
  };
}

function acceptCommand(
  caseId: string,
  appointmentId: string,
  startOffsetMs: number,
  endOffsetMs: number
): AcceptAllocationCommand {
  const assignmentId = randomUUID();
  const attemptId = randomUUID();
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "a".repeat(64),
    operationId: `accept/${idempotencyKey}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId,
    assignmentId,
    attemptId,
    input: {
      startTime: isoAt(startOffsetMs),
      endTime: isoAt(endOffsetMs),
    },
  };
}

type Recorded = {
  missed: MarkAppointmentMissedInput[];
  attentions: {
    caseId: string;
    kind: string;
    detail: string;
    operationId: string;
  }[];
  startWorkAppointments: string[];
  assignmentInProgress: string[];
  caseInProgress: string[];
  noAccessAppointments: string[];
  caseNoAccess: string[];
  replacementSlots: string[];
  caseReplacements: string[];
  unexpectedMutations: string[];
  callOrder: string[];
};

function newRecorder(): Recorded {
  return {
    missed: [],
    attentions: [],
    startWorkAppointments: [],
    assignmentInProgress: [],
    caseInProgress: [],
    noAccessAppointments: [],
    caseNoAccess: [],
    replacementSlots: [],
    caseReplacements: [],
    unexpectedMutations: [],
    callOrder: [],
  };
}

function caseRecord(
  caseId: string,
  status: "IN_PROGRESS" | "PENDING_RESIDENT_INPUT" | "ASSIGNED"
) {
  return {
    id: caseId,
    residentId: randomUUID(),
    category: "LE" as const,
    priority: "HIGH" as const,
    status,
    description: "",
    addressDetails: null,
    postalCode: "123456",
    createdAt: null,
    updatedAt: null,
  };
}

type ActivityConfig = {
  missed?: (input: MarkAppointmentMissedInput) => MarkAppointmentMissedResult;
  appointmentId?: string;
  replacementAppointmentId?: string;
  assignmentOutcome?: "ASSIGNMENT_NOT_FOUND";
  noAccessCaseTerminal?: boolean;
  replacementCaseTerminal?: boolean;
  raiseAttention?: (input: {
    caseId: string;
    kind: string;
    detail: string;
    operationId: string;
  }) => Promise<void> | void;
};

function activities(recorded: Recorded, config: ActivityConfig = {}) {
  const unexpectedMutation = (name: string): never => {
    recorded.unexpectedMutations.push(name);
    throw new Error(`Unexpected expiry mutation: ${name}`);
  };

  return {
    acceptAllocation: async (
      input: AcceptAllocationCommand
    ): Promise<AcceptAllocationResult> => ({
      kind: "SUCCESS",
      data: {
        assignment: {
          id: input.assignmentId,
          caseId: input.caseId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        attempt: {
          id: input.attemptId,
          assignmentId: input.assignmentId,
          contractorId: input.contractorId,
          source: "AUTO_ASSIGN",
          status: "ACCEPTED",
          acceptanceSlaMs: 60_000,
          deadlineAt: isoAt(60_000),
          actorId: input.actorId,
          actorRole: input.actorRole,
          reason: null,
          operationId: input.operationId,
          createdAt: new Date().toISOString(),
        },
        appointment: appointment(
          input.caseId,
          config.appointmentId ?? randomUUID(),
          input.input.startTime,
          input.input.endTime,
          "SCHEDULED",
          `${input.operationId}/appointment`
        ),
      },
    }),
    markAppointmentMissed: async (input: MarkAppointmentMissedInput) => {
      recorded.missed.push(input);
      recorded.callOrder.push("missed");
      return (
        config.missed?.(input) ?? {
          outcome: "MISSED" as const,
          appointment: appointment(
            input.operationId.split("/")[0] ?? randomUUID(),
            input.appointmentId,
            "2030-01-01T09:00:00.000Z",
            "2030-01-01T10:00:00.000Z",
            "MISSED",
            input.operationId
          ),
        }
      );
    },
    raiseOfficerAttention: async (input: {
      caseId: string;
      kind: string;
      detail: string;
      operationId: string;
    }) => {
      recorded.attentions.push(input);
      recorded.callOrder.push("attention");
      await config.raiseAttention?.(input);
    },
    startWorkAppointment: async (input: { appointmentId: string }) => {
      recorded.startWorkAppointments.push(input.appointmentId);
      return {
        outcome: "STARTED" as const,
        appointment: appointment(
          randomUUID(),
          input.appointmentId,
          isoAt(-1_000),
          isoAt(60_000),
          "IN_PROGRESS",
          "start"
        ),
      };
    },
    markAssignmentInProgress: async (input: { assignmentId: string }) => {
      recorded.assignmentInProgress.push(input.assignmentId);
      if (config.assignmentOutcome)
        return { outcome: config.assignmentOutcome };
      return {
        outcome: "IN_PROGRESS" as const,
        assignment: {
          id: input.assignmentId,
          caseId: randomUUID(),
          createdAt: "",
          updatedAt: "",
        },
      };
    },
    markCaseInProgress: async (input: { caseId: string }) => {
      recorded.caseInProgress.push(input.caseId);
      return {
        outcome: "IN_PROGRESS" as const,
        case: caseRecord(input.caseId, "IN_PROGRESS"),
      };
    },
    reportNoAccessAppointment: async (input: { appointmentId: string }) => {
      recorded.noAccessAppointments.push(input.appointmentId);
      return {
        outcome: "NO_ACCESS" as const,
        appointment: appointment(
          randomUUID(),
          input.appointmentId,
          isoAt(-1_000),
          isoAt(60_000),
          "NO_ACCESS",
          "no-access"
        ),
      };
    },
    markCaseNoAccess: async (input: { caseId: string }) => {
      recorded.caseNoAccess.push(input.caseId);
      if (config.noAccessCaseTerminal)
        return { outcome: "CASE_TERMINAL" as const };
      return {
        outcome: "PENDING_RESIDENT_INPUT" as const,
        case: caseRecord(input.caseId, "PENDING_RESIDENT_INPUT"),
      };
    },
    replaceAppointmentSlot: async (input: {
      caseId: string;
      appointmentId: string;
      startTime: string;
      endTime: string;
    }) => {
      recorded.replacementSlots.push(input.appointmentId);
      recorded.callOrder.push("replace");
      return {
        outcome: "REPLACED" as const,
        appointment: appointment(
          input.caseId,
          config.replacementAppointmentId ?? randomUUID(),
          input.startTime,
          input.endTime,
          "SCHEDULED",
          "replace"
        ),
      };
    },
    markCaseAppointmentReplaced: async (input: { caseId: string }) => {
      recorded.caseReplacements.push(input.caseId);
      if (config.replacementCaseTerminal)
        return { outcome: "CASE_TERMINAL" as const };
      return {
        outcome: "REPLACED" as const,
        case: caseRecord(input.caseId, "ASSIGNED"),
      };
    },
    commitAllocationAttempt: async () =>
      unexpectedMutation("commitAllocationAttempt"),
    markCaseAssigned: async () => unexpectedMutation("markCaseAssigned"),
    breachAllocationAttempt: async () =>
      unexpectedMutation("breachAllocationAttempt"),
    recordPerformanceEntry: async () =>
      unexpectedMutation("recordPerformanceEntry"),
    markCaseBreached: async () => unexpectedMutation("markCaseBreached"),
  };
}

async function accept(
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

describe("Missed Appointment timer (PRS-149)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  beforeEach(async () => {
    clockSkewMs = (await env.currentTimeMs()) - Date.now();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  async function createWorker(
    activityMap: ReturnType<typeof activities>,
    maxCachedWorkflows?: number
  ) {
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: activityMap,
      maxCachedWorkflows,
    });
    return { worker, taskQueue };
  }

  it("marks an unattended Appointment MISSED once, raises attention, and leaves Case, Assignment, performance, and allocation untouched", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, { appointmentId })
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const command = acceptCommand(caseId, appointmentId, -500, 500);
      await accept(client, taskQueue, caseId, command);
      expect(await waitUntil(() => recorded.missed.length === 1)).toBe(true);
      expect(recorded.missed[0]).toMatchObject({
        appointmentId,
        operationId: `${caseId}/missed-appointment/${appointmentId}`,
      });
      expect(await waitUntil(() => recorded.attentions.length === 1)).toBe(
        true
      );
      expect(recorded.attentions).toHaveLength(1);
      expect(recorded.attentions[0]).toMatchObject({
        kind: "MISSED_APPOINTMENT",
        operationId: `${caseId}/missed-appointment/${appointmentId}`,
      });
      expect(recorded.attentions[0]?.detail).toContain(appointmentId);
      expect(recorded.attentions[0]?.detail).toContain(command.input.endTime);
      expect(recorded.assignmentInProgress).toEqual([]);
      expect(recorded.caseInProgress).toEqual([]);
      expect(recorded.noAccessAppointments).toEqual([]);
      expect(recorded.caseNoAccess).toEqual([]);
      expect(recorded.replacementSlots).toEqual([]);
      expect(recorded.caseReplacements).toEqual([]);
      expect(recorded.unexpectedMutations).toEqual([]);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("treats cancelled and completed Appointment rows as NOT_SCHEDULED without attention", async () => {
    for (const outcome of ["cancelled", "completed"]) {
      const caseId = randomUUID();
      const recorded = newRecorder();
      const { worker, taskQueue } = await createWorker(
        activities(recorded, {
          appointmentId: randomUUID(),
          missed: () => ({ outcome: "NOT_SCHEDULED" }),
        })
      );
      const client = new Client({ connection: env.nativeConnection });
      await worker.runUntil(async () => {
        await accept(
          client,
          taskQueue,
          caseId,
          acceptCommand(caseId, randomUUID(), -500, 500)
        );
        expect(
          await waitUntil(() => recorded.missed.length === 1),
          outcome
        ).toBe(true);
        expect(recorded.attentions).toEqual([]);
        await client.workflow.getHandle(`case/${caseId}`).terminate();
      });
    }
  }, 30_000);

  it("clears expiry when work start is admitted before the Appointment ends", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, { appointmentId })
    );
    const client = new Client({ connection: env.nativeConnection });
    const accepted = acceptCommand(caseId, appointmentId, -5_000, 60_000);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, accepted);
      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.startWork, {
          args: [startWorkCommand(accepted, appointmentId)],
          updateId: randomUUID(),
        });

      expect(result).toMatchObject({ kind: "SUCCESS" });
      expect(recorded.startWorkAppointments).toEqual([appointmentId]);
      expect(recorded.assignmentInProgress).toEqual([accepted.assignmentId]);
      expect(recorded.caseInProgress).toEqual([caseId]);
      expect(await waitUntil(() => recorded.missed.length > 0, 500)).toBe(
        false
      );
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("clears expiry when No Access is admitted before the Appointment ends", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, { appointmentId })
    );
    const client = new Client({ connection: env.nativeConnection });
    const accepted = acceptCommand(caseId, appointmentId, -5_000, 60_000);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, accepted);
      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.reportNoAccess, {
          args: [noAccessCommand(accepted, appointmentId)],
          updateId: randomUUID(),
        });

      expect(result).toMatchObject({ kind: "SUCCESS" });
      expect(recorded.noAccessAppointments).toEqual([appointmentId]);
      expect(recorded.caseNoAccess).toEqual([caseId]);
      expect(await waitUntil(() => recorded.missed.length > 0, 500)).toBe(
        false
      );
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("supersedes the old timer and expires an earlier replacement Appointment", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const replacementAppointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, { appointmentId, replacementAppointmentId })
    );
    const client = new Client({ connection: env.nativeConnection });
    const accepted = acceptCommand(caseId, appointmentId, 60_000, 120_000);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, accepted);
      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.replaceAppointment, {
          args: [
            replaceCommand(accepted, appointmentId, "SCHEDULED", 1_000, 2_000),
          ],
          updateId: randomUUID(),
        });

      expect(result).toMatchObject({ kind: "SUCCESS" });
      expect(recorded.replacementSlots).toEqual([appointmentId]);
      expect(await waitUntil(() => recorded.missed.length === 1)).toBe(true);
      expect(recorded.missed[0]?.appointmentId).toBe(replacementAppointmentId);
      expect(recorded.missed).toHaveLength(1);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("raises one idempotent attention when the missed transition replays as ALREADY_MISSED", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, {
        appointmentId,
        missed: (input) => ({
          outcome: "ALREADY_MISSED",
          appointment: appointment(
            caseId,
            input.appointmentId,
            isoAt(-1_000),
            isoAt(0),
            "MISSED",
            input.operationId
          ),
        }),
      }),
      0
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await accept(
        client,
        taskQueue,
        caseId,
        acceptCommand(caseId, appointmentId, -500, 500)
      );
      expect(await waitUntil(() => recorded.attentions.length === 1)).toBe(
        true
      );
      expect(recorded.missed).toHaveLength(1);
      expect(recorded.attentions).toHaveLength(1);
      expect(recorded.callOrder).toEqual(["missed", "attention"]);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("raises invariant attention when expiry cannot find its Appointment", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, {
        appointmentId,
        missed: () => ({ outcome: "APPOINTMENT_NOT_FOUND" }),
      })
    );
    const client = new Client({ connection: env.nativeConnection });
    const accepted = acceptCommand(caseId, appointmentId, -500, 500);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, accepted);
      expect(await waitUntil(() => recorded.attentions.length === 1)).toBe(
        true
      );
      expect(recorded.attentions[0]).toMatchObject({
        kind: "MISSED_APPOINTMENT",
      });
      expect(recorded.attentions[0]?.detail).toContain(appointmentId);
      expect(recorded.attentions[0]?.detail).toContain(accepted.input.endTime);
      expect(recorded.unexpectedMutations).toEqual([]);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("does not recover a MISSED Appointment before its attention write completes", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    let releaseAttention: (() => void) | undefined;
    const attentionPending = new Promise<void>((resolve) => {
      releaseAttention = resolve;
    });
    const { worker, taskQueue } = await createWorker(
      activities(recorded, {
        appointmentId,
        raiseAttention: () => attentionPending,
      })
    );
    const client = new Client({ connection: env.nativeConnection });
    const accepted = acceptCommand(caseId, appointmentId, -500, 500);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, accepted);
      expect(await waitUntil(() => recorded.attentions.length === 1)).toBe(
        true
      );
      const recovery = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.replaceAppointment, {
          args: [
            replaceCommand(accepted, appointmentId, "MISSED", 60_000, 120_000),
          ],
          updateId: randomUUID(),
        });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(recorded.replacementSlots).toEqual([]);
      releaseAttention?.();
      await expect(recovery).resolves.toMatchObject({ kind: "SUCCESS" });
      expect(recorded.replacementSlots).toEqual([appointmentId]);
      expect(recorded.caseReplacements).toEqual([caseId]);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("at the end boundary rejects a new start-work Update and lets expiry own the outcome", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, { appointmentId })
    );
    const client = new Client({ connection: env.nativeConnection });
    const command = acceptCommand(caseId, appointmentId, -1_000, -1);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, command);
      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.startWork, {
          args: [
            {
              idempotencyKey: randomUUID(),
              payloadHash: "b".repeat(64),
              operationId: `start/${randomUUID()}`,
              actorId: randomUUID(),
              actorRole: "CONTRACTOR",
              contractorId,
              caseId,
              assignmentId: command.assignmentId,
              appointmentId,
              startTime: command.input.startTime,
              endTime: command.input.endTime,
            } satisfies StartWorkCommand,
          ],
          updateId: randomUUID(),
        });
      expect(result).toEqual({ kind: "NOT_IN_WINDOW" });
      expect(recorded.startWorkAppointments).toEqual([]);
      expect(await waitUntil(() => recorded.missed.length === 1)).toBe(true);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("clears expiry after an Appointment started but Assignment start failed", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, {
        appointmentId,
        assignmentOutcome: "ASSIGNMENT_NOT_FOUND",
      })
    );
    const client = new Client({ connection: env.nativeConnection });
    const accepted = acceptCommand(caseId, appointmentId, -5_000, 60_000);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, accepted);
      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.startWork, {
          args: [startWorkCommand(accepted, appointmentId)],
          updateId: randomUUID(),
        });

      expect(result).toEqual({ kind: "WORK_START_FAILED" });
      expect(recorded.startWorkAppointments).toEqual([appointmentId]);
      expect(recorded.assignmentInProgress).toEqual([accepted.assignmentId]);
      expect(recorded.caseInProgress).toEqual([]);
      expect(await waitUntil(() => recorded.missed.length > 0, 500)).toBe(
        false
      );
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("clears expiry after No Access changed the Appointment but the Case was terminal", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, { appointmentId, noAccessCaseTerminal: true })
    );
    const client = new Client({ connection: env.nativeConnection });
    const accepted = acceptCommand(caseId, appointmentId, -5_000, 60_000);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, accepted);
      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.reportNoAccess, {
          args: [noAccessCommand(accepted, appointmentId)],
          updateId: randomUUID(),
        });

      expect(result).toEqual({ kind: "CASE_TERMINAL" });
      expect(recorded.noAccessAppointments).toEqual([appointmentId]);
      expect(recorded.caseNoAccess).toEqual([caseId]);
      expect(await waitUntil(() => recorded.missed.length > 0, 500)).toBe(
        false
      );
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("clears the old timer after replacement booked a slot but the Case was terminal", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, { appointmentId, replacementCaseTerminal: true })
    );
    const client = new Client({ connection: env.nativeConnection });
    const accepted = acceptCommand(caseId, appointmentId, 60_000, 120_000);

    await worker.runUntil(async () => {
      await accept(client, taskQueue, caseId, accepted);
      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.replaceAppointment, {
          args: [
            replaceCommand(
              accepted,
              appointmentId,
              "SCHEDULED",
              60_000,
              120_000
            ),
          ],
          updateId: randomUUID(),
        });

      expect(result).toEqual({ kind: "CASE_TERMINAL" });
      expect(recorded.replacementSlots).toEqual([appointmentId]);
      expect(recorded.caseReplacements).toEqual([caseId]);
      expect(await waitUntil(() => recorded.missed.length > 0, 500)).toBe(
        false
      );
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("survives a forced full replay while preserving the single expiry Saga", async () => {
    const caseId = randomUUID();
    const appointmentId = randomUUID();
    const recorded = newRecorder();
    const { worker, taskQueue } = await createWorker(
      activities(recorded, { appointmentId }),
      0
    );
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await accept(
        client,
        taskQueue,
        caseId,
        acceptCommand(caseId, appointmentId, -500, 500)
      );
      expect(await waitUntil(() => recorded.missed.length === 1)).toBe(true);
      expect(await waitUntil(() => recorded.attentions.length === 1)).toBe(
        true
      );
      expect(recorded.attentions).toHaveLength(1);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);
});
