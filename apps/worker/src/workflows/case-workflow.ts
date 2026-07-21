import {
  condition,
  defineUpdate,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import {
  OpenCaseCommandSchema,
  UPDATE_NAMES,
} from "@townops/orchestration-contract";
import type {
  CaseDto,
  CreateCaseActivityInput,
  OpenCaseCommand,
  OpenCaseResult,
} from "@townops/orchestration-contract";

export const openCase = defineUpdate<OpenCaseResult, [OpenCaseCommand]>(
  UPDATE_NAMES.openCase
);

const activities = proxyActivities<{
  openCase(input: CreateCaseActivityInput): Promise<CaseDto>;
}>({ startToCloseTimeout: "10 seconds" });

type Operation = {
  payloadHash: string;
  result?: OpenCaseResult;
  pending?: Promise<OpenCaseResult>;
};

/**
 * Durable owner of the opening operation for one Case.
 *
 * The workflow remains open for later PRS-81 lifecycle updates. Its first
 * Update writes a Case through the Case atom exactly once per operation ID.
 */
export async function CaseWorkflow({ caseId }: { caseId: string }) {
  const operations = new Map<string, Operation>();

  setHandler(openCase, async (unparsedCommand) => {
    const command = OpenCaseCommandSchema.parse(unparsedCommand);
    const existing = operations.get(command.idempotencyKey);

    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        return { kind: "IDEMPOTENCY_KEY_REUSED" };
      }

      if (existing.result) return existing.result;
      if (existing.pending) return await existing.pending;
      throw new Error("Open-case operation has no result or pending activity");
    }

    const operation: Operation = { payloadHash: command.payloadHash };
    operations.set(command.idempotencyKey, operation);
    operation.pending = activities
      .openCase({
        caseId,
        operationId: command.operationId,
        actorId: command.actorId,
        actorRole: command.actorRole,
        input: command.input,
      })
      .then((data) => ({ kind: "SUCCESS", data }));

    try {
      operation.result = await operation.pending;
      return operation.result;
    } catch (error) {
      operations.delete(command.idempotencyKey);
      throw error;
    } finally {
      delete operation.pending;
    }
  });

  await condition(() => false);
}
