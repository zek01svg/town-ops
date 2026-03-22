import { z } from "zod/v4";
export const getMetricSchema = z.object({ contractor_id: z.string().uuid() });
