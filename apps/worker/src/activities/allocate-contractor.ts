import { ApplicationFailure } from "@temporalio/activity";
import {
  AllocationSnapshotSchema,
  CommitAllocationInputSchema,
  CommitAllocationResultSchema,
  MarkCaseAssignedResultSchema,
  OfficerAttentionDtoSchema,
  RaiseOfficerAttentionInputSchema,
} from "@townops/orchestration-contract";
import type {
  AllocationSnapshot,
  CommitAllocationInput,
  CommitAllocationResult,
  MarkCaseAssignedResult,
  OfficerAttentionDto,
  RaiseOfficerAttentionInput,
} from "@townops/orchestration-contract";
import { z } from "zod/v4";

const eligibleContractorsResponseSchema = z.object({
  contractors: z.array(
    z.object({ id: z.uuid(), name: z.string(), isActive: z.boolean() })
  ),
});
const performanceTotalsResponseSchema = z.object({
  totals: z.array(z.object({ contractorId: z.uuid(), totalScore: z.int() })),
});
const allocationSnapshotResponseSchema = z.object({
  epoch: z.int().nonnegative(),
  activeAssignmentCounts: z.array(
    z.object({ contractorId: z.uuid(), activeCount: z.int().nonnegative() })
  ),
});
const caseStatusResponseSchema = z.object({
  case: z.object({ status: z.string() }),
});

type AllocateContractorActivityDependencies = {
  contractorAtomUrl: string;
  metricsAtomUrl: string;
  assignmentAtomUrl: string;
  caseAtomUrl: string;
  workerServiceToken: string;
  fetchImpl?: typeof fetch;
};

function nonRetryable(message: string, type: string) {
  return ApplicationFailure.nonRetryable(message, type);
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Automatic Contractor allocation I/O for PRS-139. Ranking is deliberately
 * NOT done here — it lives in the Workflow so it stays deterministic and
 * replayable. These Activities only fetch and commit.
 */
export function createAllocateContractorActivities({
  contractorAtomUrl,
  metricsAtomUrl,
  assignmentAtomUrl,
  caseAtomUrl,
  workerServiceToken,
  fetchImpl = fetch,
}: AllocateContractorActivityDependencies) {
  async function isCaseTerminal(input: { caseId: string }): Promise<boolean> {
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${input.caseId}`,
      { headers: authHeaders(workerServiceToken) }
    );
    if (response.status === 404) {
      throw nonRetryable("Case does not exist", "CASE_NOT_FOUND");
    }
    if (!response.ok) {
      throw new Error(`Case atom request failed with ${response.status}`);
    }

    const { case: caseRecord } = caseStatusResponseSchema.parse(
      await response.json()
    );
    return (
      caseRecord.status === "completed" || caseRecord.status === "cancelled"
    );
  }

  async function fetchAllocationSnapshot(input: {
    category: string;
    postalSector: string;
  }): Promise<AllocationSnapshot> {
    const eligibleUrl =
      `${contractorAtomUrl}/internal/contractors/eligible` +
      `?category=${encodeURIComponent(input.category)}` +
      `&sector=${encodeURIComponent(input.postalSector)}`;

    const [eligibleResponse, totalsResponse, snapshotResponse] =
      await Promise.all([
        fetchImpl(eligibleUrl, { headers: authHeaders(workerServiceToken) }),
        fetchImpl(`${metricsAtomUrl}/internal/performance/totals`, {
          headers: authHeaders(workerServiceToken),
        }),
        fetchImpl(
          `${assignmentAtomUrl}/internal/assignments/allocation-snapshot`,
          { headers: authHeaders(workerServiceToken) }
        ),
      ]);

    if (!eligibleResponse.ok || !totalsResponse.ok || !snapshotResponse.ok) {
      throw new Error("Allocation snapshot lookup failed");
    }

    const eligible = eligibleContractorsResponseSchema.parse(
      await eligibleResponse.json()
    );
    const totals = performanceTotalsResponseSchema.parse(
      await totalsResponse.json()
    );
    const snapshot = allocationSnapshotResponseSchema.parse(
      await snapshotResponse.json()
    );

    const scoreByContractor = new Map(
      totals.totals.map((row) => [row.contractorId, row.totalScore])
    );
    const activeByContractor = new Map(
      snapshot.activeAssignmentCounts.map((row) => [
        row.contractorId,
        row.activeCount,
      ])
    );

    return AllocationSnapshotSchema.parse({
      epoch: snapshot.epoch,
      candidates: eligible.contractors.map((contractor) => ({
        contractorId: contractor.id,
        activeAssignments: activeByContractor.get(contractor.id) ?? 0,
        totalScore: scoreByContractor.get(contractor.id) ?? 0,
      })),
    });
  }

  async function commitAllocationAttempt(
    input: CommitAllocationInput
  ): Promise<CommitAllocationResult> {
    const command = CommitAllocationInputSchema.parse(input);
    const response = await fetchImpl(
      `${assignmentAtomUrl}/internal/assignments/allocation-attempts`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    // A 409 with a known outcome (STALE_EPOCH / ACTIVE_ATTEMPT_EXISTS) is a
    // normal result, not an error — the Workflow decides what to do next.
    if (response.ok || response.status === 409) {
      return CommitAllocationResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Assignment atom rejected the allocation attempt",
        "ALLOCATION_ATTEMPT_REJECTED"
      );
    }
    throw new Error(`Assignment atom request failed with ${response.status}`);
  }

  async function markCaseAssigned(input: {
    caseId: string;
    operationId: string;
    actorId: string;
    actorRole: string;
  }): Promise<MarkCaseAssignedResult["outcome"]> {
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${input.caseId}/assign`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operationId: input.operationId,
          actorId: input.actorId,
          actorRole: input.actorRole,
        }),
      }
    );

    if (response.ok) {
      return MarkCaseAssignedResultSchema.parse(await response.json()).outcome;
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Case atom rejected the assignment operation",
        "CASE_ASSIGN_REJECTED"
      );
    }
    throw new Error(`Case atom request failed with ${response.status}`);
  }

  async function raiseOfficerAttention(
    input: RaiseOfficerAttentionInput
  ): Promise<OfficerAttentionDto> {
    const command = RaiseOfficerAttentionInputSchema.parse(input);
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}/officer-attention`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: command.kind,
          detail: command.detail,
          operationId: command.operationId,
        }),
      }
    );

    if (response.ok) {
      const body = await response.json();
      return OfficerAttentionDtoSchema.parse(body.attention);
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Case atom rejected Officer Attention",
        "OFFICER_ATTENTION_REJECTED"
      );
    }
    throw new Error(`Case atom request failed with ${response.status}`);
  }

  return {
    isCaseTerminal,
    fetchAllocationSnapshot,
    commitAllocationAttempt,
    markCaseAssigned,
    raiseOfficerAttention,
  };
}
