import type { AssignmentAtomType } from "@townops/assignment-atom";
import type { MetricsAtomType } from "@townops/metrics-atom";
import { logger, rabbitmqClient } from "@townops/shared-ts";
import { hc } from "hono/client";

import { env } from "./env";

export interface ContractorSearchResult {
  ContractorUuid: string;
}

export interface ContractorDetail {
  Id: number;
  Name: string;
  ContactNum: string;
  Email: string;
  IsActive: boolean;
  ContractorUuid: string;
}

export interface ContractorMetrics {
  contractorId: string;
  totalJobs: number;
  totalScore: number;
}

/**
 * Search for eligible contractors via the OutSystems Contractor API.
 * (Stays as fetch since it is an external non-Hono service)
 */
export async function searchContractors(
  sectorCode: string,
  categoryCode: string
): Promise<ContractorSearchResult[]> {
  const url = new URL(`${env.CONTRACTOR_API_URL}/contractors/search`);
  url.searchParams.set("SectorCode", sectorCode);
  url.searchParams.set("CategoryCode", categoryCode);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Contractor search failed: HTTP ${res.status}`);
  }
  const results = (await res.json()) as ContractorSearchResult[];
  // dedupe and filter out stale pre-seed UUIDs
  const seen = new Set<string>();
  return results.filter((c) => {
    if (!c.ContractorUuid.startsWith("c0ffee01") || seen.has(c.ContractorUuid))
      return false;
    seen.add(c.ContractorUuid);
    return true;
  });
}

/**
 * Fetch full contractor details by UUID from the OutSystems Contractor API.
 */
export async function getContractorByUuid(
  uuid: string
): Promise<ContractorDetail> {
  const url = `${env.CONTRACTOR_API_URL}/contractors/by-uuid/${encodeURIComponent(uuid)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Contractor detail fetch failed for ${uuid}: HTTP ${res.status}`
    );
  }
  return res.json() as Promise<ContractorDetail>;
}

/**
 * Fetch aggregated metrics for a single contractor from the Metrics atom.
 */
export async function getContractorMetrics(
  contractorId: string
): Promise<ContractorMetrics> {
  const client = hc<MetricsAtomType>(env.METRICS_ATOM_URL);
  const res = await client.api.metrics[":contractor_id"].$get({
    param: { contractor_id: contractorId },
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!res.ok) {
    throw new Error(
      `Metrics fetch failed for contractor ${contractorId}: HTTP ${res.status}`
    );
  }

  const data = await res.json();
  const rows = data.metrics;
  return {
    contractorId,
    totalJobs: rows.length,
    totalScore: rows.reduce(
      (sum: number, m: { scoreDelta: number }) => sum + m.scoreDelta,
      0
    ),
  };
}

/**
 * Select the best contractor: fewest jobs first, then highest total score.
 */
export function selectBest(
  contractors: ContractorMetrics[]
): ContractorMetrics {
  const best = [...contractors].toSorted(
    (a, b) => a.totalJobs - b.totalJobs || b.totalScore - a.totalScore
  )[0];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!best) {
    throw new Error("Cannot select best from empty contractor list");
  }
  return best;
}

/**
 * Create a new assignment record in the Assignment atom.
 */
export async function createAssignment(
  caseId: string,
  contractorId: string
): Promise<{ id: string; caseId: string; contractorId: string }> {
  const responseDueAt = new Date(Date.now() + 60 * 1000).toISOString();
  const client = hc<AssignmentAtomType>(env.ASSIGNMENT_ATOM_URL);
  const res = await client.api.assignments.$post({
    json: {
      caseId,
      contractorId,
      source: "AUTO_ASSIGN",
      responseDueAt,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!res.ok) {
    throw new Error(`Assignment creation failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  const assignment = data.assignments;
  return assignment as { id: string; caseId: string; contractorId: string };
}

/**
 * Full orchestration: search → rank → assign → publish.
 */
export async function assignContractor(
  caseId: string,
  postalCode: string,
  categoryCode: string
): Promise<void> {
  const sectorCode = postalCode.slice(0, 2);

  logger.info(
    { caseId, sectorCode, categoryCode },
    "assign-job: searching contractors"
  );

  const contractors = await searchContractors(sectorCode, categoryCode);
  if (contractors.length === 0) {
    throw new Error(
      `No eligible contractors found for sector=${sectorCode} category=${categoryCode}`
    );
  }

  const metricsResults = await Promise.all(
    contractors.map((c) => getContractorMetrics(c.ContractorUuid))
  );

  const best = selectBest(metricsResults);
  logger.info(
    { caseId, contractorId: best.contractorId },
    "assign-job: selected best contractor"
  );

  const [assignment, contractorDetail] = await Promise.all([
    createAssignment(caseId, best.contractorId),
    getContractorByUuid(best.contractorId),
  ]);

  await rabbitmqClient.publishToQueue(
    "sla-timers-queue",
    {
      assignment_id: assignment.id,
      case_id: caseId,
      contractor_id: best.contractorId,
      postal_code: postalCode,
      category_code: categoryCode,
    },
    { expirationMs: 60_000 }
  );

  await rabbitmqClient.publish("townops.events", "job.assigned", {
    assignmentId: assignment.id,
    caseId,
    contractorId: best.contractorId,
    contractorName: contractorDetail.Name,
    contractorEmail: contractorDetail.Email,
    contractorContact: contractorDetail.ContactNum,
    status: "PENDING_ACCEPTANCE",
    email: contractorDetail.Email,
  });

  logger.info(
    { caseId, assignmentId: assignment.id },
    "assign-job: job.assigned published"
  );
}
