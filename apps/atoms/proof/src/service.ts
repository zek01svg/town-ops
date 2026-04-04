import { eq } from "drizzle-orm";

import db from "./database/db";
import { proofItems } from "./database/schema";

/**
 * Get proof items for a specific case.
 */
export async function getProofByCaseId(caseId: string) {
  return db.select().from(proofItems).where(eq(proofItems.caseId, caseId));
}

/**
 * Store multiple proof items.
 */
export async function storeProofItems(
  caseId: string,
  uploaderId: string,
  items: any[]
) {
  return db
    .insert(proofItems)
    .values(
      items.map((item: any) => ({
        caseId,
        uploaderId,
        mediaUrl: item.mediaUrl,
        type: item.type,
        remarks: item.remarks,
      }))
    )
    .returning();
}

/**
 * Store a single proof item.
 */
export async function storeSingleProofItem(data: {
  caseId: string;
  uploaderId: string;
  mediaUrl: string;
  type: string;
  remarks?: string;
}) {
  const rows = await db
    .insert(proofItems)
    .values({
      caseId: data.caseId,
      uploaderId: data.uploaderId,
      mediaUrl: data.mediaUrl,
      type: data.type as any,
      remarks: data.remarks,
    })
    .returning();
  return rows[0];
}
