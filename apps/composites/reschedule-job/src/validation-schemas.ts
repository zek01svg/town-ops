import { z } from "zod/v4";

export const rescheduleJobSchema = z.object({
  appointmentId: z.string().uuid().optional(),
  residentId: z.string().uuid(),
  caseId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  newStartTime: z.string().datetime({ offset: true }),
  newEndTime: z.string().datetime({ offset: true }),
});

export type RescheduleJobInput = z.infer<typeof rescheduleJobSchema>;
