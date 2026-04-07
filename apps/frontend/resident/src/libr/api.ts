import type { RescheduleJobCompositeType } from "@townops/reschedule-job-composite";
import { hc } from "hono/client";

import { env } from "../env";

export const rescheduleJobClient = hc<RescheduleJobCompositeType>(
  env.VITE_RESCHEDULE_JOB_URL
);
