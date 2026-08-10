import type {
  CaseDto,
  HistoricalContractorCaseDto,
} from "@townops/orchestration-contract";

import type { CaseItem, CaseStatus, Urgency } from "../types";

// Exhaustive by construction — Record requires every CaseDto status/priority
// key, so the Gateway's contract growing a value fails this file to compile
// instead of silently zeroing a kanban bucket or a gating check.
const STATUS: Record<CaseDto["status"], CaseStatus> = {
  PENDING: "pending",
  ASSIGNED: "assigned",
  IN_PROGRESS: "in_progress",
  PENDING_RESIDENT_INPUT: "pending_resident_input",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const PRIORITY: Record<CaseDto["priority"], Urgency> = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  EMERGENCY: "emergency",
};

/**
 * The Gateway's `CaseDto`/`HistoricalContractorCaseDto` (camelCase,
 * UPPERCASE enums) into this app's own `CaseItem` (lowercase `CaseStatus`/
 * `Urgency`). `case-audit-trail.tsx`'s Accept / Start Work / Complete gates
 * compare `status` against those lowercase literals — skipping this
 * boundary silently zeroes every one of them.
 *
 * The contractor list mixes both DTOs with no discriminator field: a
 * HISTORICAL row (a replaced Attempt, PRS-151 AC6) carries no `residentId` —
 * `in` narrows the union per field instead of a cast.
 */
export function mapApiCaseToItem(
  data: CaseDto | HistoricalContractorCaseDto
): CaseItem {
  return {
    id: data.id,
    residentId: "residentId" in data ? data.residentId : "",
    address:
      ("addressDetails" in data ? data.addressDetails : null) ??
      ("postalCode" in data ? data.postalCode : null) ??
      ("postalSector" in data ? data.postalSector : null) ??
      "",
    category: data.category.toLowerCase(),
    priority: PRIORITY[data.priority],
    status: STATUS[data.status],
    description: data.description,
    // ponytail: createdAt/updatedAt are nullable on the DTO for legacy rows;
    // "" degrades a render to "Invalid Date" instead of throwing.
    createdAt: data.createdAt ?? "",
    updatedAt: data.updatedAt ?? "",
  };
}
