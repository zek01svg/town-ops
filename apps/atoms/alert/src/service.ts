import { eq } from "drizzle-orm";

import db from "./database/db";
import { alerts } from "./database/schema";

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
