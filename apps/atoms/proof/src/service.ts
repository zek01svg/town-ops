import { and, eq, isNotNull } from "drizzle-orm";

import db from "./database/db";
import type { proofType } from "./database/schema";
import { proofItems } from "./database/schema";

type ProofType = (typeof proofType.enumValues)[number];

type ClaimedProofUpload = {
  proofItemId: string;
  caseId: string;
  contractorId: string;
  type: ProofType;
  remarks?: string;
  payloadHash: string;
  checksum: string;
};

/**
 * Claims an immutable proof row before its object is written. A failed object
 * write intentionally leaves the claim not-ready so the same request can
 * resume; a ready row is never overwritten.
 */
export async function claimProofUpload(input: ClaimedProofUpload) {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(proofItems)
      .values({
        id: input.proofItemId,
        caseId: input.caseId,
        uploaderId: input.contractorId,
        contractorId: input.contractorId,
        operationId: input.proofItemId,
        payloadHash: input.payloadHash,
        mediaUrl: "",
        type: input.type,
        remarks: input.remarks,
        checksum: input.checksum,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { kind: "CLAIMED" as const, proof: inserted };

    const [existing] = await tx
      .select()
      .from(proofItems)
      .where(eq(proofItems.operationId, input.proofItemId))
      .for("update");
    if (!existing) {
      throw new Error("Proof item was not found after an idempotency conflict");
    }
    if (existing.payloadHash !== input.payloadHash) {
      return { kind: "IDEMPOTENCY_KEY_REUSED" as const };
    }
    if (existing.checksum !== input.checksum) {
      return { kind: "PROOF_CONTENT_MISMATCH" as const };
    }
    return { kind: "RESUME" as const, proof: existing };
  });
}

export async function markProofReady(input: {
  proofItemId: string;
  mediaUrl: string;
}) {
  const [proof] = await db
    .update(proofItems)
    .set({ mediaUrl: input.mediaUrl, readyAt: new Date().toISOString() })
    .where(eq(proofItems.id, input.proofItemId))
    .returning();
  if (!proof) throw new Error("Proof item was not found to mark ready");
  return proof;
}

export async function listReadyProofItems(input: {
  caseId: string;
  contractorId?: string;
}) {
  return db
    .select()
    .from(proofItems)
    .where(
      and(
        eq(proofItems.caseId, input.caseId),
        input.contractorId
          ? eq(proofItems.contractorId, input.contractorId)
          : undefined,
        isNotNull(proofItems.readyAt)
      )
    );
}

export async function resolveReadyProofItem(input: {
  proofItemId: string;
  caseId: string;
  contractorId: string;
}) {
  const [proof] = await db
    .select()
    .from(proofItems)
    .where(
      and(
        eq(proofItems.id, input.proofItemId),
        eq(proofItems.caseId, input.caseId),
        eq(proofItems.contractorId, input.contractorId),
        isNotNull(proofItems.readyAt)
      )
    );
  return proof;
}
