export type TimelineEvent = {
  type: string;
  actor: string;
  timestamp: string;
  description: string;
};

/**
 * The structural shape a `TimelineEventDto` (from
 * `@townops/orchestration-contract`) satisfies. Taken structurally rather
 * than imported — `packages/ui` has no zod or contract dependency — so any
 * caller that shapes its data this way can reuse the mapping below.
 */
export type TimelineEventInput = {
  id: string;
  at: string;
  source: string;
  type: string;
  actorId: string | null;
  actorRole: string | null;
  reason: string | null;
  operationId: string | null;
  detail: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads one string field off an unknown `detail` blob, or `undefined`. */
function detailString(detail: unknown, key: string): string | undefined {
  if (!isRecord(detail)) return undefined;
  const value = detail[key];
  return typeof value === "string" ? value : undefined;
}

/** `PENDING_ACCEPTANCE` -> `Pending Acceptance`. */
function humanize(value: string): string {
  return value
    .split("_")
    .map((word) =>
      word.length === 0
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(" ");
}

function actorFor(dto: TimelineEventInput): string {
  return (
    dto.actorRole ?? (dto.actorId ? dto.actorId.slice(0, 8) : null) ?? "System"
  );
}

/**
 * One short sentence per source. `detail` is `unknown` by contract — every
 * read below goes through `detailString`, never a cast, and a source not in
 * this switch (an 8th one added later) falls through to `default` instead
 * of throwing.
 */
function describe(dto: TimelineEventInput): string {
  switch (dto.source) {
    case "CASE_HISTORY":
      return `Case status changed to ${humanize(dto.type)}.`;
    case "ALLOCATION_ATTEMPT": {
      const source = detailString(dto.detail, "source");
      return source
        ? `Allocation attempt ${humanize(dto.type).toLowerCase()} via ${humanize(source).toLowerCase()}.`
        : `Allocation attempt ${humanize(dto.type).toLowerCase()}.`;
    }
    case "ASSIGNMENT_STATUS": {
      const from = detailString(dto.detail, "fromStatus");
      return from
        ? `Assignment moved from ${humanize(from)} to ${humanize(dto.type)}.`
        : `Assignment status changed to ${humanize(dto.type)}.`;
    }
    case "APPOINTMENT": {
      const start = detailString(dto.detail, "startTime");
      return start
        ? `Appointment ${humanize(dto.type).toLowerCase()}, scheduled for ${new Date(start).toLocaleString()}.`
        : `Appointment ${humanize(dto.type).toLowerCase()}.`;
    }
    case "PROOF_ITEM": {
      const remarks = detailString(dto.detail, "remarks");
      return remarks
        ? `${humanize(dto.type)} proof uploaded: ${remarks}`
        : `${humanize(dto.type)} proof uploaded.`;
    }
    case "DERIVED_EFFECT": {
      const purpose = detailString(dto.detail, "purpose");
      return purpose
        ? `${humanize(dto.type)} effect queued for ${humanize(purpose).toLowerCase()}.`
        : `${humanize(dto.type)} effect recorded.`;
    }
    case "OFFICER_ATTENTION": {
      // The DTO's own `detail` field (nested inside this row's `detail`
      // blob) is the human-written attention message — the one field worth
      // surfacing here, distinct from this function's own `dto.detail`.
      const message = detailString(dto.detail, "detail");
      return message
        ? `Officer attention raised: ${message}`
        : `Officer attention raised (${humanize(dto.type)}).`;
    }
    default:
      return `${humanize(dto.type)} recorded.`;
  }
}

function withReason(description: string, dto: TimelineEventInput): string {
  return dto.reason ? `${description} Reason: ${dto.reason}` : description;
}

/**
 * Merges the Gateway's seven-source timeline rows (already sorted ascending
 * by `at`) into the flat shape the Case Audit Trail renders — order is
 * preserved, never re-sorted here.
 */
export function toTimelineEvents(dtos: TimelineEventInput[]): TimelineEvent[] {
  return dtos.map((dto) => ({
    type: humanize(dto.type),
    actor: actorFor(dto),
    timestamp: dto.at,
    description: withReason(describe(dto), dto),
  }));
}
