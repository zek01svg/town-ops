import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  Client,
  WorkflowIdConflictPolicy,
  WithStartWorkflowOperation,
} from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  ORCHESTRATION_TASK_QUEUE,
  WORKFLOW_NAMES,
} from "@townops/orchestration-contract";
import type {
  CaseDto,
  CreateCaseActivityInput,
  OpenCaseCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openCase } from "../src/workflows/case-workflow";

const residentId = "a3d4d1c2-5555-4e66-8e77-123456789abc";

function command(idempotencyKey = randomUUID()): OpenCaseCommand {
  return {
    idempotencyKey,
    payloadHash: "a".repeat(64),
    operationId: `${idempotencyKey}.${"a".repeat(64)}`,
    actorId: "4b0a6c4d-3a9b-4d6b-aebe-123456789abc",
    actorRole: "OFFICER",
    input: {
      residentId,
      category: "LE",
      priority: "HIGH",
      description: "Broken street light",
      postalCode: "123456",
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
    addressDetails: input.input.addressDetails ?? null,
    postalCode: input.input.postalCode,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

describe("CaseWorkflow", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  it("creates once, reattaches the same key, and rejects changed payloads", async () => {
    const calls: CreateCaseActivityInput[] = [];
    const caseId = randomUUID();
    const workflowId = `case/${caseId}`;
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: {
        openCase: async (input: CreateCaseActivityInput) => {
          calls.push(input);
          return createdCase(input);
        },
        // Allocation runs on the Workflow's main body after a Case opens.
        // Stubbed to "no eligible Contractor" so this test stays about
        // Case-opening idempotency without leaving the loop calling
        // unregistered Activities.
        fetchAllocationSnapshot: async () => ({ epoch: 0, candidates: [] }),
        commitAllocationAttempt: async () => {
          throw new Error("allocation must not commit without a candidate");
        },
        markCaseAssigned: async () => undefined,
      },
    });
    const client = new Client({ connection: env.nativeConnection });
    const firstCommand = command();

    await worker.runUntil(async () => {
      const operation = new WithStartWorkflowOperation(WORKFLOW_NAMES.case, {
        workflowId,
        taskQueue,
        args: [{ caseId }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      });
      const first = await client.workflow.executeUpdateWithStart(openCase, {
        args: [firstCommand],
        updateId: firstCommand.operationId,
        startWorkflowOperation: operation,
      });
      const second = await client.workflow.executeUpdateWithStart(openCase, {
        args: [firstCommand],
        updateId: firstCommand.operationId,
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
      const changed = await client.workflow.executeUpdateWithStart(openCase, {
        args: [
          {
            ...firstCommand,
            payloadHash: "b".repeat(64),
            operationId: `${firstCommand.idempotencyKey}.${"b".repeat(64)}`,
          },
        ],
        updateId: `${firstCommand.idempotencyKey}.${"b".repeat(64)}`,
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

      expect(first.kind).toBe("SUCCESS");
      expect(second).toEqual(first);
      expect(changed).toEqual({ kind: "IDEMPOTENCY_KEY_REUSED" });
      expect(calls).toHaveLength(1);
      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 15_000);
});
