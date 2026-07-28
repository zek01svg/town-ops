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
  CancelCaseCommand,
  CaseDto,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function command(caseId: string): CancelCaseCommand {
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

function cancelledCase(caseId: string): CaseDto {
  const now = "2030-01-01T00:00:00.000Z";
  return {
    id: caseId,
    residentId: randomUUID(),
    category: "LE",
    priority: "HIGH",
    status: "CANCELLED",
    description: "Broken street light",
    addressDetails: null,
    postalCode: "123456",
    createdAt: now,
    updatedAt: now,
  };
}

describe("Case cancellation workflow (PRS-148)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("runs the terminal Saga once in order for concurrent deliveries of one operation", async () => {
    const caseId = randomUUID();
    const commandValue = command(caseId);
    const calls: string[] = [];
    let releaseAppointment: (() => void) | undefined;
    const appointmentStarted = new Promise<void>((resolve) => {
      releaseAppointment = resolve;
    });
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const workflowId = `case/${caseId}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: {
        cancelScheduledAppointment: async () => {
          calls.push("appointment");
          await appointmentStarted;
          return { outcome: "NO_SCHEDULED_APPOINTMENT" as const };
        },
        cancelAssignmentForCase: async (input: { reason: string }) => {
          calls.push("assignment");
          expect(input.reason).toBe(commandValue.input.reason);
          return { outcome: "CANCELLED" as const };
        },
        cancelCase: async (input: { reason: string }) => {
          calls.push("case");
          expect(input.reason).toBe(commandValue.input.reason);
          return { outcome: "CANCELLED" as const, case: cancelledCase(caseId) };
        },
      },
    });
    const client = new Client({ connection: env.nativeConnection });
    const start = new WithStartWorkflowOperation(WORKFLOW_NAMES.case, {
      workflowId,
      taskQueue,
      args: [{ caseId }],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
    let first: unknown;
    let retry: unknown;

    await worker.runUntil(async () => {
      const firstPending = client.workflow.executeUpdateWithStart(
        UPDATE_NAMES.cancelCase,
        {
          args: [commandValue],
          updateId: `${commandValue.operationId}/delivery/first`,
          startWorkflowOperation: start,
        }
      );
      await new Promise<void>((resolve) => {
        const check = () => {
          if (calls.includes("appointment")) resolve();
          else setTimeout(check, 1);
        };
        check();
      });
      const retryPending = client.workflow
        .getHandle(workflowId)
        .executeUpdate(UPDATE_NAMES.cancelCase, {
          args: [commandValue],
          updateId: `${commandValue.operationId}/delivery/retry`,
        });
      releaseAppointment?.();
      [first, retry] = await Promise.all([firstPending, retryPending]);
    });

    expect(first).toMatchObject({ kind: "SUCCESS" });
    expect(retry).toEqual(first);
    expect(calls).toEqual(["appointment", "assignment", "case"]);
  }, 30_000);

  it("stops before Assignment and Case when the Appointment reports work in progress", async () => {
    const caseId = randomUUID();
    const commandValue = command(caseId);
    const calls: string[] = [];
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: {
        cancelScheduledAppointment: async () => {
          calls.push("appointment");
          return { outcome: "IN_PROGRESS" as const };
        },
        cancelAssignmentForCase: async () => {
          calls.push("assignment");
          return { outcome: "CANCELLED" as const };
        },
        cancelCase: async () => {
          calls.push("case");
          return { outcome: "CANCELLED" as const, case: cancelledCase(caseId) };
        },
      },
    });
    const client = new Client({ connection: env.nativeConnection });
    let result: unknown;

    await worker.runUntil(async () => {
      result = await client.workflow.executeUpdateWithStart(
        UPDATE_NAMES.cancelCase,
        {
          args: [commandValue],
          updateId: commandValue.operationId,
          startWorkflowOperation: new WithStartWorkflowOperation(
            WORKFLOW_NAMES.case,
            {
              workflowId: `case/${caseId}`,
              taskQueue,
              args: [{ caseId }],
              workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            }
          ),
        }
      );
    });

    expect(result).toEqual({ kind: "NOT_CANCELLABLE" });
    expect(calls).toEqual(["appointment"]);
  }, 30_000);

  it("retries a transient Assignment failure before cancelling the Case", async () => {
    const caseId = randomUUID();
    const commandValue = command(caseId);
    const calls: string[] = [];
    let assignmentAttempts = 0;
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: {
        cancelScheduledAppointment: async () => {
          calls.push("appointment");
          return { outcome: "NO_SCHEDULED_APPOINTMENT" as const };
        },
        cancelAssignmentForCase: async () => {
          calls.push("assignment");
          assignmentAttempts++;
          if (assignmentAttempts === 1)
            throw new Error("Assignment atom temporarily unavailable");
          return { outcome: "CANCELLED" as const };
        },
        cancelCase: async () => {
          calls.push("case");
          return { outcome: "CANCELLED" as const, case: cancelledCase(caseId) };
        },
      },
    });
    const client = new Client({ connection: env.nativeConnection });
    let result: unknown;

    await worker.runUntil(async () => {
      result = await client.workflow.executeUpdateWithStart(
        UPDATE_NAMES.cancelCase,
        {
          args: [commandValue],
          updateId: commandValue.operationId,
          startWorkflowOperation: new WithStartWorkflowOperation(
            WORKFLOW_NAMES.case,
            {
              workflowId: `case/${caseId}`,
              taskQueue,
              args: [{ caseId }],
              workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            }
          ),
        }
      );
    });

    expect(result).toMatchObject({ kind: "SUCCESS" });
    expect(calls).toEqual(["appointment", "assignment", "assignment", "case"]);
  }, 30_000);
});
