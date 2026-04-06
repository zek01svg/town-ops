import type { AcceptJobCompositeType } from "@townops/accept-job-composite";
import type { AppointmentAtomType } from "@townops/appointment-atom";
import type { AssignmentAtomType } from "@townops/assignment-atom";
import type { CaseAtomType } from "@townops/case-atom";
import type { CloseCaseCompositeType } from "@townops/close-case-composite";
import type { HandleNoAccessCompositeType } from "@townops/handle-no-access-composite";
import type { RescheduleJobCompositeType } from "@townops/reschedule-job-composite";
import { hc } from "hono/client";

import { env } from "../env";

export const caseAtomClient = hc<CaseAtomType>(env.VITE_CASE_ATOM_URL);
export const assignmentAtomClient = hc<AssignmentAtomType>(
  env.VITE_ASSIGNMENT_ATOM_URL
);
export const appointmentAtomClient = hc<AppointmentAtomType>(
  env.VITE_APPOINTMENT_ATOM_URL
);
export const acceptJobClient = hc<AcceptJobCompositeType>(
  env.VITE_ACCEPT_JOB_URL
);
export const closeCaseClient = hc<CloseCaseCompositeType>(
  env.VITE_CLOSE_CASE_URL
);
export const handleNoAccessClient = hc<HandleNoAccessCompositeType>(
  env.VITE_HANDLE_NO_ACCESS_URL
);
export const rescheduleJobClient = hc<RescheduleJobCompositeType>(
  env.VITE_RESCHEDULE_JOB_URL
);
