import { desc, eq, sql } from "drizzle-orm";

import db from "./database/db";
import { alerts, derivedEffects } from "./database/schema";

export type EffectPurpose =
  | "ATTEMPT_ASSIGNMENT_NOTIFICATION"
  | "ATTEMPT_BREACH_NOTIFICATION"
  | "ATTEMPT_BREACH_PERFORMANCE"
  | "APPOINTMENT_NO_ACCESS_NOTIFICATION"
  | "APPOINTMENT_RESCHEDULE_RESIDENT_NOTIFICATION"
  | "APPOINTMENT_RESCHEDULE_CONTRACTOR_NOTIFICATION"
  | "ASSIGNMENT_COMPLETION_NOTIFICATION"
  | "ASSIGNMENT_COMPLETION_PERFORMANCE";

export type EffectPayload =
  | { type: "EMAIL"; to: string; subject: string; html: string }
  | {
      type: "PERFORMANCE_ENTRY";
      contractorId: string;
      scoreDelta: number;
      reason: string;
    };

export type EffectStatus = "PENDING" | "SENT" | "FAILED" | "UNKNOWN" | "WAIVED";

export class ImmutableEffectConflictError extends Error {
  constructor() {
    super("immutable effect reservation conflict");
    this.name = "ImmutableEffectConflictError";
  }
}

export class EffectUnknownNotEligibleError extends Error {
  constructor() {
    super("effect is not eligible for unknown status");
    this.name = "EffectUnknownNotEligibleError";
  }
}

export type EffectSummary = Omit<typeof derivedEffects.$inferSelect, "payload">;

function now() {
  return new Date().toISOString();
}

export function toEffectSummary(
  row: typeof derivedEffects.$inferSelect
): EffectSummary {
  const { payload: _payload, ...value } = row;
  return value;
}

function samePayload(left: EffectPayload, right: EffectPayload) {
  if (left.type !== right.type) return false;
  if (left.type === "EMAIL" && right.type === "EMAIL") {
    return (
      left.to === right.to &&
      left.subject === right.subject &&
      left.html === right.html
    );
  }
  if (left.type === "PERFORMANCE_ENTRY" && right.type === "PERFORMANCE_ENTRY") {
    return (
      left.contractorId === right.contractorId &&
      left.scoreDelta === right.scoreDelta &&
      left.reason === right.reason
    );
  }
  return false;
}

// lint: this file's `no-unnecessary-condition` warnings on `const [x] = await
// db.select()...` results (here and below) are false positives —
// noUncheckedIndexedAccess is off, so TypeScript types a destructured
// zero-or-one-row select as always-defined. At runtime the array is empty
// whenever no row matches, so every `?? null` / `if (!x)` guard on one of
// these is load-bearing; deleting one on the strength of the warning alone
// introduces a null-deref.
async function effectForUpdate(
  database: Pick<typeof db, "select">,
  id: string
) {
  const [effect] = await database
    .select()
    .from(derivedEffects)
    .where(eq(derivedEffects.id, id))
    .for("update");
  return effect ?? null;
}

/** Inserts one immutable effect payload, or returns the original reservation. */
export async function reserveEffect(input: {
  id: string;
  caseId: string;
  type: "EMAIL" | "PERFORMANCE_ENTRY";
  purpose: EffectPurpose;
  payload: EffectPayload;
}) {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(derivedEffects)
      .values({
        ...input,
        providerIdempotencyKey: input.id,
        payload: input.payload,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return toEffectSummary(inserted);

    const [existing] = await tx
      .select()
      .from(derivedEffects)
      .where(eq(derivedEffects.id, input.id));
    if (!existing)
      throw new Error("Effect was not found after reservation race");
    if (
      existing.caseId !== input.caseId ||
      existing.type !== input.type ||
      existing.purpose !== input.purpose ||
      !samePayload(existing.payload, input.payload)
    ) {
      throw new ImmutableEffectConflictError();
    }
    return toEffectSummary(existing);
  });
}

export async function getEffect(id: string) {
  const [effect] = await db
    .select()
    .from(derivedEffects)
    .where(eq(derivedEffects.id, id));
  return effect ?? null;
}

export async function listEffectSummaries(caseId: string) {
  const effects = await db
    .select()
    .from(derivedEffects)
    .where(eq(derivedEffects.caseId, caseId))
    .orderBy(desc(derivedEffects.createdAt));
  return effects.map(toEffectSummary);
}

export async function beginEffect(id: string) {
  return db.transaction(async (tx) => {
    const effect = await effectForUpdate(tx, id);
    if (!effect) return null;
    if (effect.status !== "PENDING") return effect;
    const [updated] = await tx
      .update(derivedEffects)
      .set({
        attempts: sql`${derivedEffects.attempts} + 1`,
        nextRetryAt: null,
        updatedAt: now(),
      })
      .where(eq(derivedEffects.id, id))
      .returning();
    return updated ?? effect;
  });
}

export async function succeedEffect(id: string, providerId?: string) {
  return db.transaction(async (tx) => {
    const effect = await effectForUpdate(tx, id);
    if (!effect) return null;
    if (effect.status !== "PENDING") return effect;
    const [updated] = await tx
      .update(derivedEffects)
      .set({
        status: "SENT",
        providerId: providerId ?? effect.providerId,
        lastError: null,
        nextRetryAt: null,
        updatedAt: now(),
      })
      .where(eq(derivedEffects.id, id))
      .returning();
    return updated ?? effect;
  });
}

export async function failEffect(
  id: string,
  error: string,
  nextRetryAt: string
) {
  return db.transaction(async (tx) => {
    const effect = await effectForUpdate(tx, id);
    if (!effect) return null;
    if (effect.status !== "PENDING") return effect;
    const [updated] = await tx
      .update(derivedEffects)
      .set({
        status: "FAILED",
        lastError: error.slice(0, 10_000),
        nextRetryAt,
        updatedAt: now(),
      })
      .where(eq(derivedEffects.id, id))
      .returning();
    return updated ?? effect;
  });
}

export async function markEffectUnknown(id: string) {
  return db.transaction(async (tx) => {
    const effect = await effectForUpdate(tx, id);
    if (!effect) return null;
    if (
      effect.type !== "EMAIL" ||
      (effect.status !== "PENDING" && effect.status !== "FAILED") ||
      effect.attempts === 0 ||
      Date.now() - Date.parse(effect.createdAt) < 24 * 60 * 60_000
    ) {
      throw new EffectUnknownNotEligibleError();
    }
    const [updated] = await tx
      .update(derivedEffects)
      .set({ status: "UNKNOWN", nextRetryAt: null, updatedAt: now() })
      .where(eq(derivedEffects.id, id))
      .returning();
    return updated ?? effect;
  });
}

export async function retryEffect(
  id: string,
  acknowledgeDuplicateRisk: boolean
) {
  return db.transaction(async (tx) => {
    const effect = await effectForUpdate(tx, id);
    if (!effect) return { kind: "NOT_FOUND" as const };
    if (effect.status === "UNKNOWN" && !acknowledgeDuplicateRisk) {
      return { kind: "ACK_REQUIRED" as const };
    }
    if (effect.status !== "UNKNOWN" && effect.status !== "FAILED") {
      return { kind: "NOT_REPAIRABLE" as const };
    }
    const [updated] = await tx
      .update(derivedEffects)
      .set({
        status: "PENDING",
        lastError: null,
        nextRetryAt: null,
        updatedAt: now(),
      })
      .where(eq(derivedEffects.id, id))
      .returning();
    return { kind: "SUCCESS" as const, effect: updated ?? effect };
  });
}

export async function waiveEffect(input: {
  id: string;
  actorId: string;
  reason: string;
}) {
  return db.transaction(async (tx) => {
    const effect = await effectForUpdate(tx, input.id);
    if (!effect) return null;
    if (effect.status === "SENT" || effect.status === "WAIVED") return effect;
    const [updated] = await tx
      .update(derivedEffects)
      .set({
        status: "WAIVED",
        nextRetryAt: null,
        waiverActorId: input.actorId,
        waiverReason: input.reason,
        updatedAt: now(),
      })
      .where(eq(derivedEffects.id, input.id))
      .returning();
    return updated ?? effect;
  });
}

/**
 * Retrieve all alerts from the database.
 */
export async function getAllAlerts() {
  return db.select().from(alerts);
}

/**
 * Retrieve alerts associated with a specific Case ID.
 * @param caseId The UUID of the case.
 */
export async function getAlertsByCaseId(caseId: string) {
  return db.select().from(alerts).where(eq(alerts.caseId, caseId));
}

/**
 * Retrieve alerts associated with a specific Recipient ID.
 * @param recipientId The UUID of the recipient.
 */
export async function getAlertsByRecipientId(recipientId: string) {
  return db.select().from(alerts).where(eq(alerts.recipientId, recipientId));
}
