import type { AppointmentAtomType } from "@townops/appointment-atom";
import type { AssignmentAtomType } from "@townops/assignment-atom";
import type { CaseAtomType } from "@townops/case-atom";
import type { CloseCaseCompositeType } from "@townops/close-case-composite";
import { hc } from "hono/client";

import { env } from "../env";

export const caseAtomClient = hc<CaseAtomType>(env.VITE_CASE_ATOM_URL);
export const assignmentAtomClient = hc<AssignmentAtomType>(
  env.VITE_ASSIGNMENT_ATOM_URL
);
export const appointmentAtomClient = hc<AppointmentAtomType>(
  env.VITE_APPOINTMENT_ATOM_URL
);
export const closeCaseClient = hc<CloseCaseCompositeType>(
  env.VITE_CLOSE_CASE_URL
);
