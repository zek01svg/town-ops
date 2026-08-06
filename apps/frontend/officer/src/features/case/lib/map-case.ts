import type { CaseDto } from "@townops/orchestration-contract";

import type { CaseItem, CaseStatus, Urgency } from "../types";

// Exhaustive by construction — Record requires every CaseDto status/priority
// key, so the Gateway's contract growing a value fails this file to compile
// instead of silently zeroing a kanban bucket or stat-card filter.
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
 * The Gateway's `CaseDto` (camelCase, UPPERCASE enums) into this app's own
 * `CaseItem` (lowercase `CaseStatus`/`Urgency`). Every terminal-state check,
 * kanban bucket, and stat-card filter downstream compares against the
 * lowercase union in `types.ts` — skipping this boundary silently zeroes
 * every one of them.
 */
export function mapApiCaseToItem(data: CaseDto): CaseItem {
  return {
    id: data.id,
    residentId: data.residentId,
    address: data.addressDetails ?? data.postalCode,
    category: data.category.toLowerCase(),
    priority: PRIORITY[data.priority],
    status: STATUS[data.status],
    description: data.description || undefined,
    // ponytail: createdAt/updatedAt are nullable on the DTO for legacy rows;
    // "" degrades a render to "Invalid Date" instead of throwing.
    createdAt: data.createdAt ?? "",
    updatedAt: data.updatedAt ?? "",
  };
}
