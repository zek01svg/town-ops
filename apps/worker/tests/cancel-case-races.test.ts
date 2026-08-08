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
  AppointmentDto,
  CancelCaseCommand,
  CaseDto,
  CommitAllocationResult,
  ManualAllocationCommand,
  ReplaceAppointmentCommand,
  ReportNoAccessCommand,
  StartWorkCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { immediateDerivedEffectActivities } from "./derived-effect-test-activities";

const contractorId = "11111111-1111-4111-8111-111111111111";
const scheduledStart = "2030-01-01T09:00:00.000Z";
const scheduledEnd = "2030-01-01T10:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function caseDto(
  caseId: string,
  status: CaseDto["status"] = "CANCELLED"
): CaseDto {
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
  appointmentEndTime = scheduledEnd
): AcceptAllocationResult {
  const now = "2030-01-01T00:00:00.000Z";
  const attempt: AllocationAttemptDto = {
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
  };
  return {
    kind: "SUCCESS",
    data: {
      assignment: { id: assignmentId, caseId, createdAt: now, updatedAt: now },
      attempt,
      appointment: appointmentDto(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        "SCHEDULED",
        appointmentEndTime
      ),
    },
  };
}

function committedManualAllocationResult(
  caseId: string,
  assignmentId: string,
  attemptId: string
): CommitAllocationResult {
  const now = "2030-01-01T00:00:00.000Z";
  return {
    outcome: "COMMITTED",
    assignment: { id: assignmentId, caseId, createdAt: now, updatedAt: now },
    attempt: {
      id: attemptId,
      assignmentId,
      contractorId,
      source: "MANUAL_ASSIGN",
      status: "PENDING_ACCEPTANCE",
      acceptanceSlaMs: 60_000,
      deadlineAt: "2030-01-01T08:00:00.000Z",
      actorId: "00000000-0000-0000-0000-000000000000",
      actorRole: "SYSTEM",
      reason: null,
      operationId: `allocate/${attemptId}`,
      createdAt: now,
    },
    epoch: 1,
  };
}

function replacementAppointmentDto(
  caseId: string,
  assignmentId: string,
  attemptId: string,
  appointmentId: string
): AppointmentDto {
  return {
    ...appointmentDto(
      caseId,
      assignmentId,
      attemptId,
      appointmentId,
      "SCHEDULED"
    ),
    startTime: "2030-01-02T09:00:00.000Z",
    endTime: "2030-01-02T10:00:00.000Z",
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

function manualAllocationCommand(caseId: string): ManualAllocationCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "c".repeat(64),
    operationId: `${idempotencyKey}.${"c".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "OFFICER",
    caseId,
    category: "LE",
    postalCode: "123456",
    input: { contractorId },
  };
}

function startWorkCommand(
  caseId: string,
  assignmentId: string,
  appointmentId: string
): StartWorkCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "d".repeat(64),
    operationId: `${idempotencyKey}.${"d".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId,
    assignmentId,
    appointmentId,
    startTime: new Date(Date.now() - 60_000).toISOString(),
    endTime: new Date(Date.now() + 60_000).toISOString(),
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
    startTime: new Date(Date.now() - 60_000).toISOString(),
    endTime: new Date(Date.now() + 60_000).toISOString(),
  };
}

function replacementCommand(
  caseId: string,
  appointmentId: string
): ReplaceAppointmentCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "f".repeat(64),
    operationId: `${idempotencyKey}.${"f".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "RESIDENT",
    caseId,
    appointmentId,
    previousStatus: "SCHEDULED",
    previousStartTime: scheduledStart,
    input: {
      startTime: "2030-01-02T09:00:00.000Z",
      endTime: "2030-01-02T10:00:00.000Z",
      reason: "Resident requested a different day",
    },
  };
}

function cancellationActivities(
  caseId: string,
  assignmentId: string,
  attemptId: string,
  appointmentId: string,
  calls: string[],
  appointmentOutcome:
    | "CANCELLED"
    | "IN_PROGRESS"
    | "NO_SCHEDULED_APPOINTMENT" = "CANCELLED"
) {
  return {
    cancelScheduledAppointment: async (input: { caseId: string }) => {
      calls.push(`cancel-appointment:${appointmentOutcome}`);
      expect(input.caseId).toBe(caseId);
      if (appointmentOutcome === "IN_PROGRESS")
        return { outcome: "IN_PROGRESS" as const };
      if (appointmentOutcome === "NO_SCHEDULED_APPOINTMENT") {
        return { outcome: "NO_SCHEDULED_APPOINTMENT" as const };
      }
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
    cancelAssignmentForCase: async (input: { reason: string }) => {
      calls.push("cancel-assignment");
      expect(input.reason).toBe("No longer needed");
      return { outcome: "CANCELLED" as const };
    },
    cancelCase: async (input: { reason: string }) => {
      calls.push("cancel-case");
      expect(input.reason).toBe("No longer needed");
      return { outcome: "CANCELLED" as const, case: caseDto(caseId) };
    },
    ...immediateDerivedEffectActivities(),
  };
}

function startOperation(
  client: Client,
  taskQueue: string,
  caseId: string,
  updateName: string,
  command: unknown
) {
  return client.workflow.executeUpdateWithStart(updateName, {
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

function committedAttempt(
  assignmentId: string,
  attemptId: string,
  deadlineAt: string
): AllocationAttemptDto {
  return {
    id: attemptId,
    assignmentId,
    contractorId,
    source: "MANUAL_ASSIGN",
    status: "PENDING_ACCEPTANCE",
    acceptanceSlaMs: 60_000,
    deadlineAt,
    actorId: "00000000-0000-0000-0000-000000000000",
    actorRole: "SYSTEM",
    reason: null,
    operationId: `allocate/${attemptId}`,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("Case lifecycle races (PRS-148 cancellation, PRS-152 AC9)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  async function createWorker(activities: Record<string, unknown>) {
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

  async function establishScheduledAppointment(
    client: Client,
    taskQueue: string,
    caseId: string,
    assignmentId: string,
    attemptId: string,
    appointmentId: string
  ) {
    const result = await startOperation(
      client,
      taskQueue,
      caseId,
      UPDATE_NAMES.acceptAllocation,
      acceptCommand(caseId, assignmentId, attemptId)
    );
    expect(result).toMatchObject({
      kind: "SUCCESS",
      data: { appointment: { id: appointmentId } },
    });
  }

  it("cancels an accepted scheduled Appointment before the Assignment and Case", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const calls: string[] = [];
    const { worker, taskQueue, client } = await createWorker({
      acceptAllocation: async () => {
        calls.push("accept");
        return acceptedResult(caseId, assignmentId, attemptId, appointmentId);
      },
      ...cancellationActivities(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        calls
      ),
    });

    await worker.runUntil(async () => {
      await establishScheduledAppointment(
        client,
        taskQueue,
        caseId,
        assignmentId,
        attemptId,
        appointmentId
      );
      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        });

      expect(result).toMatchObject({
        kind: "SUCCESS",
        data: { case: { status: "CANCELLED" } },
      });
      expect(calls).toEqual([
        "accept",
        "cancel-appointment:CANCELLED",
        "cancel-assignment",
        "cancel-case",
      ]);
    });
  }, 30_000);

  it("cancels a successfully committed allocation after its Attempt is recorded", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const allocationGate = deferred<CommitAllocationResult>();
    const calls: string[] = [];
    const { worker, taskQueue, client } = await createWorker({
      isCaseTerminal: async () => {
        calls.push("allocation-check");
        return false;
      },
      fetchAllocationSnapshot: async () => {
        calls.push("allocation-snapshot");
        return {
          epoch: 0,
          candidates: [{ contractorId, activeAssignments: 0, totalScore: 0 }],
        };
      },
      commitAllocationAttempt: async () => {
        calls.push("allocation-commit-began");
        const result = await allocationGate.promise;
        calls.push("allocation-committed");
        return result;
      },
      markCaseAssigned: async () => {
        calls.push("allocation-case-assigned");
        return "ASSIGNED" as const;
      },
      ...cancellationActivities(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        calls,
        "NO_SCHEDULED_APPOINTMENT"
      ),
    });
    const allocation = manualAllocationCommand(caseId);

    await worker.runUntil(async () => {
      const allocationPending = startOperation(
        client,
        taskQueue,
        caseId,
        UPDATE_NAMES.allocateContractor,
        allocation
      );
      expect(
        await waitUntil(() => calls.includes("allocation-commit-began"))
      ).toBe(true);
      allocationGate.resolve(
        committedManualAllocationResult(caseId, assignmentId, attemptId)
      );

      await expect(allocationPending).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { assignment: { id: assignmentId }, attempt: { id: attemptId } },
      });
      expect(calls).toEqual([
        "allocation-check",
        "allocation-snapshot",
        "allocation-commit-began",
        "allocation-committed",
        "allocation-case-assigned",
      ]);

      const cancellation = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        });

      expect(cancellation).toMatchObject({ kind: "SUCCESS" });
      expect(calls).toEqual([
        "allocation-check",
        "allocation-snapshot",
        "allocation-commit-began",
        "allocation-committed",
        "allocation-case-assigned",
        "cancel-appointment:NO_SCHEDULED_APPOINTMENT",
        "cancel-assignment",
        "cancel-case",
      ]);
    });
  }, 30_000);

  it("cancels a held acceptance only after it commits a scheduled Appointment", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const acceptanceGate = deferred<AcceptAllocationResult>();
    const calls: string[] = [];
    const { worker, taskQueue, client } = await createWorker({
      acceptAllocation: async () => {
        calls.push("accept-began");
        const result = await acceptanceGate.promise;
        calls.push("accept-committed");
        return result;
      },
      ...cancellationActivities(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        calls
      ),
    });

    await worker.runUntil(async () => {
      const acceptancePending = startOperation(
        client,
        taskQueue,
        caseId,
        UPDATE_NAMES.acceptAllocation,
        acceptCommand(caseId, assignmentId, attemptId)
      );
      expect(await waitUntil(() => calls.includes("accept-began"))).toBe(true);
      acceptanceGate.resolve(
        acceptedResult(caseId, assignmentId, attemptId, appointmentId)
      );

      await expect(acceptancePending).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { appointment: { id: appointmentId, status: "SCHEDULED" } },
      });
      expect(calls).toEqual(["accept-began", "accept-committed"]);

      const cancellation = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        });

      expect(cancellation).toMatchObject({ kind: "SUCCESS" });
      expect(calls).toEqual([
        "accept-began",
        "accept-committed",
        "cancel-appointment:CANCELLED",
        "cancel-assignment",
        "cancel-case",
      ]);
    });
  }, 30_000);

  it("rejects cancellation when concurrent start work reaches IN_PROGRESS", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const startGate = deferred<AppointmentDto>();
    const calls: string[] = [];
    const { worker, taskQueue, client } = await createWorker({
      acceptAllocation: async () =>
        acceptedResult(caseId, assignmentId, attemptId, appointmentId),
      startWorkAppointment: async () => {
        calls.push("start-work-appointment");
        return {
          outcome: "STARTED" as const,
          appointment: await startGate.promise,
        };
      },
      markAssignmentInProgress: async () => {
        calls.push("start-work-assignment");
        return {
          outcome: "IN_PROGRESS" as const,
          assignment: {
            id: assignmentId,
            caseId,
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
          },
        };
      },
      markCaseInProgress: async () => {
        calls.push("start-work-case");
        return {
          outcome: "IN_PROGRESS" as const,
          case: caseDto(caseId, "IN_PROGRESS"),
        };
      },
      ...cancellationActivities(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        calls,
        "IN_PROGRESS"
      ),
    });

    await worker.runUntil(async () => {
      await establishScheduledAppointment(
        client,
        taskQueue,
        caseId,
        assignmentId,
        attemptId,
        appointmentId
      );
      const startPending = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.startWork, {
          args: [startWorkCommand(caseId, assignmentId, appointmentId)],
          updateId: randomUUID(),
        });
      expect(
        await waitUntil(() => calls.includes("start-work-appointment"))
      ).toBe(true);
      const cancellationPending = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        });
      startGate.resolve(
        appointmentDto(
          caseId,
          assignmentId,
          attemptId,
          appointmentId,
          "IN_PROGRESS"
        )
      );

      await expect(startPending).resolves.toMatchObject({ kind: "SUCCESS" });
      await expect(cancellationPending).resolves.toEqual({
        kind: "NOT_CANCELLABLE",
      });
      expect(calls).toEqual([
        "start-work-appointment",
        "start-work-assignment",
        "start-work-case",
        "cancel-appointment:IN_PROGRESS",
      ]);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  it("cancels after a held No Access transition commits without rewriting that history", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const noAccessGate = deferred<AppointmentDto>();
    const calls: string[] = [];
    const { worker, taskQueue, client } = await createWorker({
      acceptAllocation: async () =>
        acceptedResult(caseId, assignmentId, attemptId, appointmentId),
      reportNoAccessAppointment: async () => {
        calls.push("no-access-appointment-began");
        const appointment = await noAccessGate.promise;
        calls.push("no-access-appointment-committed");
        return { outcome: "NO_ACCESS" as const, appointment };
      },
      markCaseNoAccess: async () => {
        calls.push("no-access-case-committed");
        return {
          outcome: "PENDING_RESIDENT_INPUT" as const,
          case: caseDto(caseId, "PENDING_RESIDENT_INPUT"),
        };
      },
      ...cancellationActivities(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        calls,
        "NO_SCHEDULED_APPOINTMENT"
      ),
    });

    await worker.runUntil(async () => {
      await establishScheduledAppointment(
        client,
        taskQueue,
        caseId,
        assignmentId,
        attemptId,
        appointmentId
      );
      const noAccessPending = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.reportNoAccess, {
          args: [noAccessCommand(caseId, appointmentId)],
          updateId: randomUUID(),
        });
      expect(
        await waitUntil(() => calls.includes("no-access-appointment-began"))
      ).toBe(true);
      noAccessGate.resolve(
        appointmentDto(
          caseId,
          assignmentId,
          attemptId,
          appointmentId,
          "NO_ACCESS"
        )
      );

      await expect(noAccessPending).resolves.toMatchObject({
        kind: "SUCCESS",
        data: {
          appointment: { id: appointmentId, status: "NO_ACCESS" },
          case: { status: "PENDING_RESIDENT_INPUT" },
        },
      });
      expect(calls).toEqual([
        "no-access-appointment-began",
        "no-access-appointment-committed",
        "no-access-case-committed",
      ]);

      const cancellation = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        });

      expect(cancellation).toMatchObject({ kind: "SUCCESS" });
      expect(calls).toEqual([
        "no-access-appointment-began",
        "no-access-appointment-committed",
        "no-access-case-committed",
        "cancel-appointment:NO_SCHEDULED_APPOINTMENT",
        "cancel-assignment",
        "cancel-case",
      ]);
    });
  }, 30_000);

  it("cancels the new scheduled Appointment after a held replacement commits", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const replacementAppointmentId = randomUUID();
    const replacementGate = deferred<AppointmentDto>();
    const calls: string[] = [];
    const { worker, taskQueue, client } = await createWorker({
      acceptAllocation: async () =>
        acceptedResult(caseId, assignmentId, attemptId, appointmentId),
      replaceAppointmentSlot: async (input: { appointmentId: string }) => {
        calls.push(`replacement-slot:${input.appointmentId}`);
        const appointment = await replacementGate.promise;
        calls.push(`replacement-committed:${appointment.id}`);
        return { outcome: "REPLACED" as const, appointment };
      },
      markCaseAppointmentReplaced: async () => {
        calls.push("replacement-case-committed");
        return {
          outcome: "REPLACED" as const,
          case: caseDto(caseId, "ASSIGNED"),
        };
      },
      ...cancellationActivities(
        caseId,
        assignmentId,
        attemptId,
        replacementAppointmentId,
        calls
      ),
      cancelScheduledAppointment: async () => {
        calls.push(`cancel-appointment:${replacementAppointmentId}:CANCELLED`);
        return {
          outcome: "CANCELLED" as const,
          appointment: appointmentDto(
            caseId,
            assignmentId,
            attemptId,
            replacementAppointmentId,
            "CANCELLED"
          ),
        };
      },
    });

    await worker.runUntil(async () => {
      await establishScheduledAppointment(
        client,
        taskQueue,
        caseId,
        assignmentId,
        attemptId,
        appointmentId
      );
      const replacementPending = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.replaceAppointment, {
          args: [replacementCommand(caseId, appointmentId)],
          updateId: randomUUID(),
        });
      expect(
        await waitUntil(() =>
          calls.includes(`replacement-slot:${appointmentId}`)
        )
      ).toBe(true);
      replacementGate.resolve(
        replacementAppointmentDto(
          caseId,
          assignmentId,
          attemptId,
          replacementAppointmentId
        )
      );

      await expect(replacementPending).resolves.toMatchObject({
        kind: "SUCCESS",
        data: {
          appointment: { id: replacementAppointmentId, status: "SCHEDULED" },
        },
      });
      expect(calls).toEqual([
        `replacement-slot:${appointmentId}`,
        `replacement-committed:${replacementAppointmentId}`,
        "replacement-case-committed",
      ]);

      const cancellation = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        });

      expect(cancellation).toMatchObject({ kind: "SUCCESS" });
      expect(calls).toEqual([
        `replacement-slot:${appointmentId}`,
        `replacement-committed:${replacementAppointmentId}`,
        "replacement-case-committed",
        `cancel-appointment:${replacementAppointmentId}:CANCELLED`,
        "cancel-assignment",
        "cancel-case",
      ]);
    });
  }, 30_000);

  it("rejects lifecycle mutations begun after cancellation starts without invoking them", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const cancellationGate = deferred<void>();
    const calls: string[] = [];
    let initialAcceptance = true;
    const unexpectedMutation = (name: string) => async () => {
      calls.push(name);
      throw new Error(`${name} must not run after cancellation starts`);
    };
    const { worker, taskQueue, client } = await createWorker({
      isCaseTerminal: unexpectedMutation("allocation-check"),
      fetchAllocationSnapshot: unexpectedMutation("allocation-snapshot"),
      commitAllocationAttempt: unexpectedMutation("allocation-commit"),
      acceptAllocation: async () => {
        if (initialAcceptance) {
          calls.push("initial-accept");
          return acceptedResult(caseId, assignmentId, attemptId, appointmentId);
        }
        return unexpectedMutation("post-cancellation-accept")();
      },
      startWorkAppointment: unexpectedMutation("start-work-appointment"),
      reportNoAccessAppointment: unexpectedMutation("no-access-appointment"),
      replaceAppointmentSlot: unexpectedMutation("replacement-slot"),
      ...cancellationActivities(
        caseId,
        assignmentId,
        attemptId,
        appointmentId,
        calls
      ),
      cancelScheduledAppointment: async () => {
        calls.push("cancel-appointment-began");
        await cancellationGate.promise;
        calls.push("cancel-appointment-committed");
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
    });

    await worker.runUntil(async () => {
      await establishScheduledAppointment(
        client,
        taskQueue,
        caseId,
        assignmentId,
        attemptId,
        appointmentId
      );
      initialAcceptance = false;
      const handle = client.workflow.getHandle(`case/${caseId}`);
      const cancellationPending = handle.executeUpdate(
        UPDATE_NAMES.cancelCase,
        {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        }
      );
      expect(
        await waitUntil(() => calls.includes("cancel-appointment-began"))
      ).toBe(true);

      await expect(
        handle.executeUpdate(UPDATE_NAMES.allocateContractor, {
          args: [manualAllocationCommand(caseId)],
          updateId: randomUUID(),
        })
      ).resolves.toEqual({ kind: "CASE_TERMINAL" });
      await expect(
        handle.executeUpdate(UPDATE_NAMES.acceptAllocation, {
          args: [acceptCommand(caseId, assignmentId, randomUUID())],
          updateId: randomUUID(),
        })
      ).resolves.toEqual({ kind: "ATTEMPT_NOT_PENDING" });
      await expect(
        handle.executeUpdate(UPDATE_NAMES.startWork, {
          args: [startWorkCommand(caseId, assignmentId, appointmentId)],
          updateId: randomUUID(),
        })
      ).resolves.toEqual({ kind: "CASE_TERMINAL" });
      await expect(
        handle.executeUpdate(UPDATE_NAMES.reportNoAccess, {
          args: [noAccessCommand(caseId, appointmentId)],
          updateId: randomUUID(),
        })
      ).resolves.toEqual({ kind: "CASE_TERMINAL" });
      await expect(
        handle.executeUpdate(UPDATE_NAMES.replaceAppointment, {
          args: [replacementCommand(caseId, appointmentId)],
          updateId: randomUUID(),
        })
      ).resolves.toEqual({ kind: "CASE_TERMINAL" });
      expect(calls).toEqual(["initial-accept", "cancel-appointment-began"]);

      cancellationGate.resolve();
      await expect(cancellationPending).resolves.toMatchObject({
        kind: "SUCCESS",
      });
      expect(calls).toEqual([
        "initial-accept",
        "cancel-appointment-began",
        "cancel-appointment-committed",
        "cancel-assignment",
        "cancel-case",
      ]);
    });
  }, 30_000);

  /**
   * AC9, allocation timer versus Officer command. The Officer's allocation is
   * held mid-commit until the *previous* Attempt's acceptance deadline has
   * elapsed, so the two come due at once. The Workflow runs allocation on its
   * main loop, which is what makes them mutually exclusive: the superseded
   * Attempt is never breached, exactly one Attempt is committed per command,
   * and the deadline re-arms on the Attempt the Officer just committed.
   */
  it("supersedes an elapsed acceptance deadline with a concurrent Officer allocation, then breaches only the new Attempt", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const firstAttemptId = randomUUID();
    const secondAttemptId = randomUUID();
    const commitGate = deferred<void>();
    const breaches: string[] = [];
    const attentions: string[] = [];
    let commits = 0;
    let firstDeadlineAt = Number.POSITIVE_INFINITY;
    const { worker, taskQueue, client } = await createWorker({
      isCaseTerminal: async () => false,
      fetchAllocationSnapshot: async () => ({
        epoch: 0,
        candidates: [{ contractorId, activeAssignments: 0, totalScore: 0 }],
      }),
      commitAllocationAttempt: async (input: {
        expectedEpoch: number;
      }): Promise<CommitAllocationResult> => {
        commits++;
        const isFirst = commits === 1;
        if (!isFirst) await commitGate.promise;
        const now = "2030-01-01T00:00:00.000Z";
        const deadlineAt = new Date(Date.now() + (isFirst ? 3_000 : 2_000));
        if (isFirst) firstDeadlineAt = deadlineAt.getTime();
        return {
          outcome: "COMMITTED",
          assignment: {
            id: assignmentId,
            caseId,
            createdAt: now,
            updatedAt: now,
          },
          attempt: committedAttempt(
            assignmentId,
            isFirst ? firstAttemptId : secondAttemptId,
            deadlineAt.toISOString()
          ),
          epoch: input.expectedEpoch + 1,
        };
      },
      markCaseAssigned: async () => "ASSIGNED" as const,
      breachAllocationAttempt: async (input: { attemptId: string }) => {
        breaches.push(input.attemptId);
        return { outcome: "BREACHED" as const };
      },
      markCaseBreached: async () => "PENDING" as const,
      raiseOfficerAttention: async (input: { kind: string }) => {
        attentions.push(input.kind);
        return undefined;
      },
      ...immediateDerivedEffectActivities(),
    });

    await worker.runUntil(async () => {
      await expect(
        startOperation(
          client,
          taskQueue,
          caseId,
          UPDATE_NAMES.allocateContractor,
          manualAllocationCommand(caseId)
        )
      ).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { attempt: { id: firstAttemptId } },
      });

      const officerPending = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.allocateContractor, {
          args: [manualAllocationCommand(caseId)],
          updateId: randomUUID(),
        });
      expect(await waitUntil(() => commits > 1)).toBe(true);
      // The first Attempt's deadline passes while the Officer's allocation is
      // mid-commit — the race this test exists for.
      expect(await waitUntil(() => Date.now() >= firstDeadlineAt)).toBe(true);
      commitGate.resolve();

      await expect(officerPending).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { attempt: { id: secondAttemptId } },
      });
      expect(breaches).toEqual([]);

      expect(await waitUntil(() => breaches.length > 0)).toBe(true);
      expect(breaches).toEqual([secondAttemptId]);
      expect(commits).toBe(2);
      expect(await waitUntil(() => attentions.length > 0)).toBe(true);
      expect(attentions).toEqual(["NO_ELIGIBLE_CONTRACTOR"]);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  /**
   * AC9, Appointment end versus No Access. The report is admitted inside the
   * window and then held past the Appointment's own end, so expiry comes due
   * with the handler still running. `appointmentLifecycleGuard` is what makes
   * the admitted report own the outcome — expiry must never mark this
   * Appointment MISSED behind it.
   */
  it("lets a No Access report admitted before the Appointment end win the expiry race", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const noAccessGate = deferred<void>();
    // Anchored to the moment the Appointment is actually established, not to
    // the top of the test: the open -> allocate -> accept setup is itself
    // several round trips, and a window measured from test start has to cover
    // all of them. Under full-suite load that overran, expiry won before the
    // report was ever admitted, and the test flaked. Measured from here the
    // budget covers one Update admission, which is what the race is about.
    let appointmentEndsAt = "";
    const calls: string[] = [];
    const { worker, taskQueue, client } = await createWorker({
      acceptAllocation: async () => {
        appointmentEndsAt = new Date(Date.now() + 5_000).toISOString();
        return acceptedResult(
          caseId,
          assignmentId,
          attemptId,
          appointmentId,
          appointmentEndsAt
        );
      },
      reportNoAccessAppointment: async () => {
        calls.push("no-access-began");
        await noAccessGate.promise;
        calls.push("no-access-committed");
        return {
          outcome: "NO_ACCESS" as const,
          appointment: appointmentDto(
            caseId,
            assignmentId,
            attemptId,
            appointmentId,
            "NO_ACCESS"
          ),
        };
      },
      markCaseNoAccess: async () => {
        calls.push("no-access-case");
        return {
          outcome: "PENDING_RESIDENT_INPUT" as const,
          case: caseDto(caseId, "PENDING_RESIDENT_INPUT"),
        };
      },
      markAppointmentMissed: async () => {
        calls.push("missed");
        return {
          outcome: "MISSED" as const,
          appointment: appointmentDto(
            caseId,
            assignmentId,
            attemptId,
            appointmentId,
            "MISSED"
          ),
        };
      },
      raiseOfficerAttention: async () => {
        calls.push("attention");
        return undefined;
      },
      ...immediateDerivedEffectActivities(),
    });

    await worker.runUntil(async () => {
      await establishScheduledAppointment(
        client,
        taskQueue,
        caseId,
        assignmentId,
        attemptId,
        appointmentId
      );
      const noAccessPending = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.reportNoAccess, {
          args: [noAccessCommand(caseId, appointmentId)],
          updateId: randomUUID(),
        });
      expect(await waitUntil(() => calls.includes("no-access-began"))).toBe(
        true
      );
      expect(
        await waitUntil(() => Date.now() >= Date.parse(appointmentEndsAt))
      ).toBe(true);
      expect(calls).toEqual(["no-access-began"]);
      noAccessGate.resolve();

      await expect(noAccessPending).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { appointment: { id: appointmentId, status: "NO_ACCESS" } },
      });
      expect(await waitUntil(() => calls.includes("missed"), 500)).toBe(false);
      expect(calls).toEqual([
        "no-access-began",
        "no-access-committed",
        "no-access-case",
      ]);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);

  /**
   * AC9, replacement versus cancellation. Unlike the sequential scenario above,
   * the cancellation arrives while the replacement Activity is still in flight.
   * It must wait for that handler rather than releasing the slot underneath it,
   * so the Appointment it ultimately cancels is the replacement.
   */
  it("holds a cancellation issued mid-replacement until the new slot is booked", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const appointmentId = randomUUID();
    const replacementAppointmentId = randomUUID();
    const replacementGate = deferred<AppointmentDto>();
    const calls: string[] = [];
    const { worker, taskQueue, client } = await createWorker({
      acceptAllocation: async () =>
        acceptedResult(caseId, assignmentId, attemptId, appointmentId),
      replaceAppointmentSlot: async (input: { appointmentId: string }) => {
        calls.push(`replacement-slot:${input.appointmentId}`);
        const appointment = await replacementGate.promise;
        calls.push(`replacement-committed:${appointment.id}`);
        return { outcome: "REPLACED" as const, appointment };
      },
      markCaseAppointmentReplaced: async () => {
        calls.push("replacement-case-committed");
        return {
          outcome: "REPLACED" as const,
          case: caseDto(caseId, "ASSIGNED"),
        };
      },
      ...cancellationActivities(
        caseId,
        assignmentId,
        attemptId,
        replacementAppointmentId,
        calls
      ),
    });

    await worker.runUntil(async () => {
      await establishScheduledAppointment(
        client,
        taskQueue,
        caseId,
        assignmentId,
        attemptId,
        appointmentId
      );
      const replacementPending = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.replaceAppointment, {
          args: [replacementCommand(caseId, appointmentId)],
          updateId: randomUUID(),
        });
      expect(
        await waitUntil(() =>
          calls.includes(`replacement-slot:${appointmentId}`)
        )
      ).toBe(true);

      const cancellationPending = client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [cancelCommand(caseId)],
          updateId: randomUUID(),
        });
      try {
        // Nothing of the cancellation Saga may run while the replacement holds
        // the Appointment: releasing the old slot here would cancel an
        // Appointment the atom is about to retire anyway, and leave the
        // replacement booked behind a CANCELLED Case.
        expect(
          await waitUntil(
            () => calls.includes("cancel-appointment:CANCELLED"),
            500
          )
        ).toBe(false);
        expect(calls).toEqual([`replacement-slot:${appointmentId}`]);
      } finally {
        // Released even when the assertions above fail: `runUntil` shuts the
        // Worker down on the way out and waits for in-flight Activities, so a
        // still-held gate would turn an assertion failure into a test timeout.
        replacementGate.resolve(
          replacementAppointmentDto(
            caseId,
            assignmentId,
            attemptId,
            replacementAppointmentId
          )
        );
      }
      await expect(replacementPending).resolves.toMatchObject({
        kind: "SUCCESS",
        data: {
          appointment: { id: replacementAppointmentId, status: "SCHEDULED" },
        },
      });
      await expect(cancellationPending).resolves.toMatchObject({
        kind: "SUCCESS",
        data: { case: { status: "CANCELLED" } },
      });
      expect(calls).toEqual([
        `replacement-slot:${appointmentId}`,
        `replacement-committed:${replacementAppointmentId}`,
        "replacement-case-committed",
        "cancel-appointment:CANCELLED",
        "cancel-assignment",
        "cancel-case",
      ]);
    });
  }, 30_000);
});
