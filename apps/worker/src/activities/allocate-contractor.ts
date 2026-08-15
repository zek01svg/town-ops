import { ApplicationFailure } from "@temporalio/activity";
import {
  AcceptAllocationAttemptResultSchema,
  AcceptAllocationCommandSchema,
  AcceptAllocationResultSchema,
  AllocationSnapshotSchema,
  AppointmentDtoSchema,
  AppointmentSlotClaimDtoSchema,
  BreachAllocationAttemptInputSchema,
  BreachAllocationAttemptResultSchema,
  CommitAllocationInputSchema,
  CommitAllocationResultSchema,
  MarkCaseAssignedResultSchema,
  MarkCaseBreachedInputSchema,
  MarkCaseBreachedResultSchema,
  OfficerAttentionDtoSchema,
  PerformanceEntryDtoSchema,
  RaiseOfficerAttentionInputSchema,
  RecordPerformanceEntryInputSchema,
  withServerlessAuth,
} from "@townops/orchestration-contract";
import type {
  AcceptAllocationCommand,
  AcceptAllocationResult,
  AllocationSnapshot,
  BreachAllocationAttemptInput,
  BreachAllocationAttemptResult,
  CommitAllocationInput,
  CommitAllocationResult,
  MarkCaseAssignedResult,
  MarkCaseBreachedInput,
  MarkCaseBreachedResult,
  OfficerAttentionDto,
  PerformanceEntryDto,
  RaiseOfficerAttentionInput,
  RecordPerformanceEntryInput,
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
  appointmentAtomUrl: string;
  workerServiceToken: string;
  fetchImpl?: typeof fetch;
  // Mints the Cloud Run IAM ID token `withServerlessAuth` attaches to every
  // atom call (PRS-140 Phase 5). Defaults to the real metadata-server minter.
  mintIdentityToken?: (audience: string) => Promise<string | undefined>;
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
  appointmentAtomUrl,
  workerServiceToken,
  fetchImpl: injectedFetch = fetch,
  mintIdentityToken,
}: AllocateContractorActivityDependencies) {
  const fetchImpl = withServerlessAuth(injectedFetch, mintIdentityToken);
  async function isCaseTerminal(input: { caseId: string }): Promise<boolean> {
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${input.caseId}`,
      {
        headers: authHeaders(workerServiceToken),
      }
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
          {
            headers: authHeaders(workerServiceToken),
          }
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

  async function releaseAppointmentSlot(claimId: string, operationId: string) {
    const response = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/releases`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ claimId, operationId }),
      }
    );
    if (!response.ok) {
      throw new Error(
        `Appointment release request failed with ${response.status}`
      );
    }
  }

  async function acceptAllocation(
    input: AcceptAllocationCommand
  ): Promise<AcceptAllocationResult> {
    const command = AcceptAllocationCommandSchema.parse(input);
    const reservation = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/reservations`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operationId: `${command.operationId}/reserve`,
          caseId: command.caseId,
          assignmentId: command.assignmentId,
          attemptId: command.attemptId,
          contractorId: command.contractorId,
          startTime: command.input.startTime,
          endTime: command.input.endTime,
        }),
      }
    );
    if (reservation.status === 409) return { kind: "APPOINTMENT_CONFLICT" };
    if (reservation.status === 400) return { kind: "APPOINTMENT_NOT_FUTURE" };
    if (reservation.status >= 400 && reservation.status < 500) {
      throw nonRetryable(
        "Appointment atom rejected the requested slot",
        "APPOINTMENT_SLOT_REJECTED"
      );
    }
    if (!reservation.ok) {
      throw new Error(
        `Appointment reservation request failed with ${reservation.status}`
      );
    }
    const { claim } = z
      .object({ claim: AppointmentSlotClaimDtoSchema })
      .parse(await reservation.json());

    const acceptance = await fetchImpl(
      `${assignmentAtomUrl}/internal/assignments/allocation-attempts/acceptance`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operationId: command.operationId,
          caseId: command.caseId,
          assignmentId: command.assignmentId,
          attemptId: command.attemptId,
          contractorId: command.contractorId,
        }),
      }
    );
    if (!acceptance.ok && acceptance.status >= 500) {
      throw new Error(
        `Allocation acceptance request failed with ${acceptance.status}`
      );
    }
    const accepted = AcceptAllocationAttemptResultSchema.parse(
      await acceptance.json()
    );
    if (
      accepted.outcome === "ASSIGNMENT_NOT_PENDING" ||
      accepted.outcome === "ATTEMPT_NOT_PENDING" ||
      accepted.outcome === "ATTEMPT_NOT_OWNED" ||
      accepted.outcome === "CASE_MISMATCH"
    ) {
      await releaseAppointmentSlot(claim.id, `${command.operationId}/release`);
      return { kind: accepted.outcome };
    }

    const confirmation = await fetchImpl(
      `${appointmentAtomUrl}/internal/appointment-slots/confirmations`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          claimId: claim.id,
          operationId: `${command.operationId}/confirm`,
        }),
      }
    );
    if (!confirmation.ok) {
      throw new Error(
        `Appointment confirmation request failed with ${confirmation.status}`
      );
    }
    const { appointment } = z
      .object({ appointment: AppointmentDtoSchema })
      .parse(await confirmation.json());

    const history = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}/allocation-acceptance`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          caseId: command.caseId,
          operationId: command.operationId,
          actorId: command.actorId,
          actorRole: command.actorRole,
        }),
      }
    );
    if (!history.ok) {
      throw new Error(`Case history request failed with ${history.status}`);
    }

    return AcceptAllocationResultSchema.parse({
      kind: "SUCCESS",
      data: {
        assignment: accepted.assignment,
        attempt: accepted.attempt,
        appointment,
      },
    });
  }

  /**
   * Breach one Attempt (PRS-144). The Workflow owns the acceptance-SLA
   * timer and only ever calls this after its own deadline has passed —
   * ponytail: no server-side "is the deadline actually past?" recheck here,
   * a DB/Workflow clock-skew check would only produce spurious NOT_DUE
   * retries; upgrade if a non-Workflow caller of this route ever appears.
   */
  async function breachAllocationAttempt(
    input: BreachAllocationAttemptInput
  ): Promise<BreachAllocationAttemptResult> {
    const command = BreachAllocationAttemptInputSchema.parse(input);
    const response = await fetchImpl(
      `${assignmentAtomUrl}/internal/assignments/allocation-attempts/breach`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    if (response.ok) {
      return BreachAllocationAttemptResultSchema.parse(await response.json());
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Assignment atom rejected the breach",
        "BREACH_REJECTED"
      );
    }
    throw new Error(`Assignment atom request failed with ${response.status}`);
  }

  /**
   * Record one Contractor performance entry, exactly once per effect ID
   * (PRS-144's -10 acceptance SLA breach penalty).
   */
  async function recordPerformanceEntry(
    input: RecordPerformanceEntryInput
  ): Promise<PerformanceEntryDto> {
    const command = RecordPerformanceEntryInputSchema.parse(input);
    const response = await fetchImpl(
      `${metricsAtomUrl}/internal/performance/entries`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    if (response.ok) {
      const body = await response.json();
      return PerformanceEntryDtoSchema.parse(body.entry);
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Metrics atom rejected the performance entry",
        "PERFORMANCE_ENTRY_REJECTED"
      );
    }
    throw new Error(`Metrics atom request failed with ${response.status}`);
  }

  /** Return a Case to PENDING and raise its acceptance SLA breach attention. */
  async function markCaseBreached(
    input: MarkCaseBreachedInput
  ): Promise<MarkCaseBreachedResult["outcome"]> {
    const command = MarkCaseBreachedInputSchema.parse(input);
    const response = await fetchImpl(
      `${caseAtomUrl}/internal/cases/${command.caseId}/allocation-breach`,
      {
        method: "POST",
        headers: {
          ...authHeaders(workerServiceToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    if (response.ok) {
      return MarkCaseBreachedResultSchema.parse(await response.json()).outcome;
    }
    if (response.status >= 400 && response.status < 500) {
      throw nonRetryable(
        "Case atom rejected the breach operation",
        "CASE_BREACH_REJECTED"
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
    acceptAllocation,
    markCaseAssigned,
    raiseOfficerAttention,
    breachAllocationAttempt,
    recordPerformanceEntry,
    markCaseBreached,
  };
}
