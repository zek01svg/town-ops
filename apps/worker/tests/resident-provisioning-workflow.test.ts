import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Client, WorkflowIdConflictPolicy } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  ORCHESTRATION_TASK_QUEUE,
  residentProvisioningWorkflowId,
} from "@townops/orchestration-contract";
import type {
  ProvisionResidentInput,
  ResidentProfileDto,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ResidentProvisioningWorkflow } from "../src/workflows/resident-provisioning-workflow";

function input(accountId = randomUUID()): ProvisionResidentInput {
  return {
    accountId,
    fullName: "Rae Resident",
    email: "rae@example.com",
  };
}

describe("ResidentProvisioningWorkflow", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  it("starting twice with USE_EXISTING while the first run is genuinely in flight collapses onto the same run", async () => {
    const calls: ProvisionResidentInput[] = [];
    let releaseActivity: (() => void) | undefined;
    const activityGate = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL(
          "../src/workflows/resident-provisioning-workflow.ts",
          import.meta.url
        )
      ),
      activities: {
        provisionResidentProfile: async (
          command: ProvisionResidentInput
        ): Promise<ResidentProfileDto> => {
          calls.push(command);
          // Holds the Activity -- and therefore the whole run -- open so
          // the second `start` below genuinely observes an in-flight
          // (not yet completed) Workflow Execution.
          await activityGate;
          return {
            id: command.accountId,
            fullName: command.fullName,
            email: command.email,
          };
        },
      },
    });
    const client = new Client({ connection: env.nativeConnection });
    const command = input();
    const workflowId = residentProvisioningWorkflowId(command.accountId);

    await worker.runUntil(async () => {
      const startOptions = {
        workflowId,
        taskQueue,
        // Annotated as a tuple: storing the options in a variable would
        // otherwise widen `args` to an array and stop matching the Workflow's
        // single-parameter signature.
        args: [command] as [ProvisionResidentInput],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      };

      const first = await client.workflow.start(
        ResidentProvisioningWorkflow,
        startOptions
      );
      // `first` only resolves once the server has accepted the Start call,
      // so the run is now genuinely Running -- and stays Running because
      // its Activity is blocked on `activityGate`. This second `start`
      // therefore arrives while the first run is still in flight.
      const second = await client.workflow.start(
        ResidentProvisioningWorkflow,
        startOptions
      );

      // The Run ID the server assigns each Start call is the direct proof
      // of dedupe: WorkflowIdConflictPolicy.USE_EXISTING must return the
      // *same* already-running Run ID for the second call rather than
      // starting a second run. Checked before the gate is released, so this
      // cannot be satisfied by both runs merely finishing with equal output.
      expect(second.firstExecutionRunId).toBe(first.firstExecutionRunId);

      releaseActivity?.();

      const expected = {
        id: command.accountId,
        fullName: command.fullName,
        email: command.email,
      };
      const [firstResult, secondResult] = await Promise.all([
        first.result(),
        second.result(),
      ]);
      expect(firstResult).toEqual(expected);
      expect(secondResult).toEqual(expected);
      // A genuine second run would have invoked the Activity a second time;
      // it did not, over the whole lifetime of the test.
      expect(calls).toHaveLength(1);
    });
  }, 15_000);

  it("resumes after a transient Activity failure and still provisions exactly once", async () => {
    let attempts = 0;
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL(
          "../src/workflows/resident-provisioning-workflow.ts",
          import.meta.url
        )
      ),
      activities: {
        provisionResidentProfile: async (
          command: ProvisionResidentInput
        ): Promise<ResidentProfileDto> => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("transient resident atom failure");
          }
          return {
            id: command.accountId,
            fullName: command.fullName,
            email: command.email,
          };
        },
      },
    });
    const client = new Client({ connection: env.nativeConnection });
    const command = input();
    const workflowId = residentProvisioningWorkflowId(command.accountId);

    await worker.runUntil(async () => {
      const result = await client.workflow.execute(
        ResidentProvisioningWorkflow,
        {
          workflowId,
          taskQueue,
          args: [command],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }
      );

      expect(result).toEqual({
        id: command.accountId,
        fullName: command.fullName,
        email: command.email,
      });
      expect(attempts).toBe(2);
    });
  }, 15_000);
});
