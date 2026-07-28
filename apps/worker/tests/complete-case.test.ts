import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/activity";
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
  options: { metricsFails?: boolean; metricsFailuresRemaining?: number } = {}
) {
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
    recordCompletionPerformance: async (input: { effectId: string }) => {
      recorded.calls.push("metrics");
      if (options.metricsFails || (options.metricsFailuresRemaining ?? 0) > 0) {
        if (options.metricsFailuresRemaining)
          options.metricsFailuresRemaining--;
        throw ApplicationFailure.nonRetryable(
          "Metrics atom rejected completion reward",
          "PERFORMANCE_ENTRY_REJECTED"
        );
      }
      recorded.effectIds.push(input.effectId);
      return {
        id: randomUUID(),
        contractorId,
        scoreDelta: 10,
        reason: "ASSIGNMENT_COMPLETED",
        effectId: input.effectId,
        createdAt: "2030-01-01T00:00:00.000Z",
      };
    },
    raiseOfficerAttention: async (input: {
      caseId: string;
      kind: OfficerAttentionKind;
    }) => {
      recorded.attentions.push(input);
    },
  };
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
    options?: { metricsFails?: boolean; metricsFailuresRemaining?: number }
  ) {
    const recorded: Recorded = { calls: [], attentions: [], effectIds: [] };
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
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
        options
      ),
    });
    const client = new Client({ connection: env.nativeConnection });
    const workflowId = `case/${commandValue.caseId}`;
    let result: unknown;

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
    });
    return { recorded, result };
  }

  it("rejects a preflight Appointment mismatch before any completion mutation", async () => {
    const result = await run(command(randomUUID()), "APPOINTMENT_MISMATCH");

    expect(result.result).toEqual({ kind: "APPOINTMENT_MISMATCH" });
    expect(result.recorded.calls).toEqual(["validate"]);
    expect(result.recorded.attentions).toEqual([]);
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
      "metrics",
    ]);
    expect(first.recorded.effectIds).toEqual([
      `${firstCommand.assignmentId}/completion`,
    ]);

    const replay = await run(firstCommand, "ALREADY_COMPLETED");

    expect(replay.result).toMatchObject({ kind: "SUCCESS" });
    expect(replay.recorded.calls).toEqual([
      "validate",
      "appointment",
      "assignment",
      "case",
      "metrics",
    ]);
    expect(replay.recorded.effectIds).toEqual([
      `${firstCommand.assignmentId}/completion`,
    ]);
  }, 30_000);

  it("raises COMPLETION_FAILED when a permanent Metrics failure follows the terminal mutations", async () => {
    const commandValue = command(randomUUID());
    const result = await run(commandValue, "READY", { metricsFails: true });

    expect(result.result).toEqual({ kind: "COMPLETION_FAILED" });
    expect(result.recorded.calls).toEqual([
      "validate",
      "appointment",
      "assignment",
      "case",
      "metrics",
    ]);
    expect(result.recorded.attentions).toEqual([
      expect.objectContaining({
        caseId: commandValue.caseId,
        kind: "COMPLETION_FAILED",
      }),
    ]);
  }, 30_000);

  it("re-enters a repaired completion with the same domain operation under a new Temporal delivery ID", async () => {
    const commandValue = command(randomUUID());
    const recorded: Recorded = { calls: [], attentions: [], effectIds: [] };
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const workflowId = `case/${commandValue.caseId}`;
    const repairedMetrics = { metricsFailuresRemaining: 1 };
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
        repairedMetrics
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
    });

    expect(firstDeliveryId).not.toBe(repairedDeliveryId);
    expect(firstResult).toEqual({ kind: "COMPLETION_FAILED" });
    expect(repairedResult).toMatchObject({ kind: "SUCCESS" });
    expect(recorded.calls).toEqual([
      "validate",
      "appointment",
      "assignment",
      "case",
      "metrics",
      "validate",
      "appointment",
      "assignment",
      "case",
      "metrics",
    ]);
    expect(recorded.effectIds).toEqual([
      `${commandValue.assignmentId}/completion`,
    ]);
    expect(recorded.attentions).toEqual([
      expect.objectContaining({
        caseId: commandValue.caseId,
        kind: "COMPLETION_FAILED",
      }),
    ]);
  }, 30_000);
});
