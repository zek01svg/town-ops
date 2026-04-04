import { eq } from "drizzle-orm";

import db from "./database/db";
import { appointments } from "./database/schema";

/**
 * Get all appointments for a given Case ID.
 * @param caseId The UUID of the case.
 */
export async function getAppointmentsByCaseId(caseId: string) {
  return db.select().from(appointments).where(eq(appointments.caseId, caseId));
}

/**
 * Create a new appointment.
 * @param values The appointment data.
 */
export async function createAppointment(values: any) {
  const rows = await db.insert(appointments).values(values).returning();
  return rows[0];
}
