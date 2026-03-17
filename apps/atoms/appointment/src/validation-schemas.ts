import { z } from "zod/v4";
export const getAppointmentSchema = z.object({ case_id: z.string().uuid() });
