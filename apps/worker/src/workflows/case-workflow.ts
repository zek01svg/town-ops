import {
  condition,
  defineUpdate,
  log,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import {
  DEFAULT_ACCEPTANCE_SLA_MS,
  OpenCaseCommandSchema,
  postalSector,
  UPDATE_NAMES,
} from "@townops/orchestration-contract";
import type {
  AllocationCandidate,
  AllocationSnapshot,
  CaseDto,
  CommitAllocationInput,
  CommitAllocationResult,
  CreateCaseActivityInput,
  OpenCaseCommand,
  OpenCaseResult,
} from "@townops/orchestration-contract";

export const openCase = defineUpdate<OpenCaseResult, [OpenCaseCommand]>(
  UPDATE_NAMES.openCase
);

const activities = proxyActivities<{
  openCase(input: CreateCaseActivityInput): Promise<CaseDto>;
  fetchAllocationSnapshot(input: {
    category: string;
    postalSector: string;
  }): Promise<AllocationSnapshot>;
  commitAllocationAttempt(
    input: CommitAllocationInput
  ): Promise<CommitAllocationResult>;
  markCaseAssigned(input: {
    caseId: string;
    operationId: string;
    actorId: string;
    actorRole: string;
  }): Promise<void>;
}>({ startToCloseTimeout: "10 seconds" });

type Operation = {
  payloadHash: string;
  result?: OpenCaseResult;
  pending?: Promise<OpenCaseResult>;
};

type AllocationRequest = { category: string; postalCode: string };

/**
 * Outcome of the last allocation pass. `NO_CANDIDATE` and `FAILED` both leave
 * the Case PENDING but for different reasons, and PRS-141 acts on each
 * differently — so they must stay distinguishable rather than collapsing into
 * one silent nothing.
 */
type AllocationState =
  | { status: "IDLE" }
  | { status: "ALLOCATED"; contractorId: string }
  | { status: "NO_CANDIDATE" }
  | { status: "FAILED"; reason: string };

// Automatic allocation (PRS-139) acts on the Case's behalf, not a Resident
// or Officer — a fixed system identity keeps the actor fields non-null.
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
const SYSTEM_ACTOR_ROLE = "SYSTEM";
const MAX_ALLOCATION_ROUNDS = 5;

/**
 * Fewest active Assignments, then highest total score, then Contractor ID
 * ascending (plain string compare — locale-aware compare is not guaranteed
 * stable across replay). Excludes Contractors this Workflow already
 * attempted.
 */
function rankCandidates(
  candidates: AllocationCandidate[],
  excluded: Set<string>
) {
  return candidates
    .filter((candidate) => !excluded.has(candidate.contractorId))
    .toSorted((a, b) => {
      if (a.activeAssignments !== b.activeAssignments) {
        return a.activeAssignments - b.activeAssignments;
      }
      if (a.totalScore !== b.totalScore) {
        return b.totalScore - a.totalScore;
      }
      return a.contractorId < b.contractorId
        ? -1
        : a.contractorId > b.contractorId
          ? 1
          : 0;
    });
}

/**
 * Automatic Contractor allocation for a just-opened Case (PRS-139). Ranking
 * happens here, in the Workflow, so it stays deterministic and replayable —
 * the Activities above do I/O only.
 *
 * Returns the outcome rather than throwing it away, so a Case that could not
 * be allocated is distinguishable from one that never tried.
 */
async function runAllocation(
  caseId: string,
  category: string,
  postalCode: string,
  attemptedContractorIds: Set<string>
): Promise<AllocationState> {
  const sector = postalSector(postalCode);
  let snapshot = await activities.fetchAllocationSnapshot({
    category,
    postalSector: sector,
  });

  for (let round = 0; round < MAX_ALLOCATION_ROUNDS; round++) {
    const [candidate] = rankCandidates(
      snapshot.candidates,
      attemptedContractorIds
    );
    if (!candidate) {
      // No eligible Contractor was found. PRS-141 owns retry-polling and
      // Officer Attention for a Case stuck like this — leave it PENDING.
      return { status: "NO_CANDIDATE" };
    }

    const operationId = `${caseId}/allocate/${candidate.contractorId}/${snapshot.epoch}`;
    const result = await activities.commitAllocationAttempt({
      operationId,
      caseId,
      contractorId: candidate.contractorId,
      source: "AUTO_ASSIGN",
      expectedEpoch: snapshot.epoch,
      acceptanceSlaMs: DEFAULT_ACCEPTANCE_SLA_MS,
      actorId: SYSTEM_ACTOR_ID,
      actorRole: SYSTEM_ACTOR_ROLE,
    });

    if (
      result.outcome === "COMMITTED" ||
      result.outcome === "ALREADY_COMMITTED"
    ) {
      attemptedContractorIds.add(candidate.contractorId);
      await activities.markCaseAssigned({
        caseId,
        operationId,
        actorId: SYSTEM_ACTOR_ID,
        actorRole: SYSTEM_ACTOR_ROLE,
      });
      return { status: "ALLOCATED", contractorId: candidate.contractorId };
    }

    if (result.outcome === "ACTIVE_ATTEMPT_EXISTS") {
      // Another allocation already won the race for this Case.
      return {
        status: "ALLOCATED",
        contractorId: result.attempt.contractorId,
      };
    }

    // STALE_EPOCH — the epoch moved under us; refetch and rerank.
    snapshot = await activities.fetchAllocationSnapshot({
      category,
      postalSector: sector,
    });
  }

  // Every round lost its epoch race. Treated as unresolved rather than
  // successful, so PRS-141's polling can pick the Case back up.
  return {
    status: "FAILED",
    reason: `allocation lost the epoch race ${MAX_ALLOCATION_ROUNDS} times`,
  };
}

/**
 * Durable owner of the opening operation for one Case.
 *
 * The workflow remains open for later PRS-81 lifecycle updates. Its first
 * Update writes a Case through the Case atom exactly once per operation ID.
 */
export async function CaseWorkflow({ caseId }: { caseId: string }) {
  const operations = new Map<string, Operation>();
  // In-Workflow only — never exposed as a Query/read model. Tracks which
  // Contractors this Workflow already committed or attempted, across
  // allocation passes for this Case's whole lifetime.
  const attemptedContractorIds = new Set<string>();
  let pendingAllocation: AllocationRequest | undefined;
  let allocation: AllocationState = { status: "IDLE" };

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
    } catch (error) {
      operations.delete(command.idempotencyKey);
      throw error;
    } finally {
      delete operation.pending;
    }

    const result = operation.result;
    if (!result) {
      throw new Error("Open-case operation completed without a result");
    }

    if (result.kind === "SUCCESS") {
      // Record the intent only. The main body below runs allocation, so this
      // handler never spawns an untracked promise and returns as soon as the
      // Case is durably created.
      pendingAllocation = {
        category: result.data.category,
        postalCode: result.data.postalCode,
      };
    }

    return result;
  });

  // Allocation runs here, never inside an Update handler. PRS-141 extends this
  // loop with exponential polling for a Case left NO_CANDIDATE or FAILED, and
  // with the Officer Attention those outcomes deserve — extend it, do not
  // restructure it.
  while (true) {
    await condition(() => pendingAllocation !== undefined);
    const request = pendingAllocation;
    pendingAllocation = undefined;
    if (!request) continue;

    try {
      allocation = await runAllocation(
        caseId,
        request.category,
        request.postalCode,
        attemptedContractorIds
      );
    } catch (error) {
      // A permanent Activity failure leaves the Case PENDING with the reason
      // recorded. It must not fail the Workflow, which stays open to repair
      // the Case, and it must not vanish.
      allocation = {
        status: "FAILED",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    // Temporal's logger is replay-aware, so an unallocated Case is visible to
    // an operator without inventing a public read model for Workflow state.
    if (allocation.status !== "ALLOCATED") {
      log.warn("Case was not allocated", { caseId, allocation });
    }
  }
}
