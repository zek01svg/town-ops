import { z } from "zod/v4";

export const getResidentByIDSchema = z.object({ id: z.string().uuid() });
