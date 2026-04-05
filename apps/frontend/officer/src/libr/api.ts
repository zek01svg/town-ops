import type { AssignmentAtomType } from "@townops/assignment-atom";
import type { CaseAtomType } from "@townops/case-atom";
import type { HandleBreachCompositeType } from "@townops/handle-breach-composite";
import type { OpenCaseCompositeType } from "@townops/open-case-composite";
import { hc } from "hono/client";

import { env } from "../env";

export const caseAtomClient = hc<CaseAtomType>(env.VITE_CASE_ATOM_URL);
export const assignmentAtomClient = hc<AssignmentAtomType>(
  env.VITE_ASSIGNMENT_ATOM_URL
);
export const openCaseClient = hc<OpenCaseCompositeType>(env.VITE_OPEN_CASE_URL);
export const handleBreachClient = hc<HandleBreachCompositeType>(
  env.VITE_HANDLE_BREACH_URL
);
