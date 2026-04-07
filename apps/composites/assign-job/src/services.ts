import type { AssignmentAtomType } from "@townops/assignment-atom";
import type { ContractorAtomType } from "@townops/contractor-atom";
import type { MetricsAtomType } from "@townops/metrics-atom";
import { logger, rabbitmqClient } from "@townops/shared-ts";
import { hc } from "hono/client";

import { env } from "./env";

export interface ContractorMetrics {
  contractorId: string;
  totalJobs: number;
  totalScore: number;
}

/**
 * Search for eligible contractors via the Contractor atom.
 */
export async function searchContractors(
  sectorCode: string,
  categoryCode: string
): Promise<
  { id: string; name: string; email: string; contactNum: string | null }[]
> {
  const client = hc<ContractorAtomType>(env.CONTRACTOR_ATOM_URL);
  const res = await client.api.contractors.search.$get({
    query: { sectorCode, categoryCode },
  });
  if (!res.ok) {
    throw new Error(`Contractor search failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.contractors as {
    id: string;
    name: string;
    email: string;
    contactNum: string | null;
  }[];
}

/**
 * Fetch full contractor details by ID from the Contractor atom.
 */
export async function getContractorById(id: string): Promise<{
  id: string;
  name: string;
  email: string;
  contactNum: string | null;
}> {
  const client = hc<ContractorAtomType>(env.CONTRACTOR_ATOM_URL);
  const res = await client.api.contractors[":id"].$get({
    param: { id },
  });
  if (!res.ok) {
    throw new Error(`Contractor fetch failed for ${id}: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.contractor as {
    id: string;
    name: string;
    email: string;
    contactNum: string | null;
  };
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
    contractors.map((c) => getContractorMetrics(c.id))
  );

  const best = selectBest(metricsResults);
  logger.info(
    { caseId, contractorId: best.contractorId },
    "assign-job: selected best contractor"
  );

  const [assignment, contractorDetail] = await Promise.all([
    createAssignment(caseId, best.contractorId),
    getContractorById(best.contractorId),
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
    contractorName: contractorDetail.name,
    contractorEmail: contractorDetail.email,
    contractorContact: contractorDetail.contactNum,
    status: "PENDING_ACCEPTANCE",
    email: contractorDetail.email,
  });

  logger.info(
    { caseId, assignmentId: assignment.id },
    "assign-job: job.assigned published"
  );
}
