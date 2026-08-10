import { fileURLToPath } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";
import { ORCHESTRATION_TASK_QUEUE } from "@townops/orchestration-contract";
import { z } from "zod/v4";

import { createAllocateContractorActivities } from "./activities/allocate-contractor.ts";
import { createAppointmentRecoveryActivities } from "./activities/appointment-recovery.ts";
import { createCancelCaseActivities } from "./activities/cancel-case.ts";
import { createCompleteCaseActivities } from "./activities/complete-case.ts";
import { createDerivedEffectActivities } from "./activities/derived-effects.ts";
import { createOpenCaseActivity } from "./activities/open-case.ts";
import { createProvisionResidentActivity } from "./activities/provision-resident.ts";
import { createStartWorkActivities } from "./activities/start-work.ts";

const config = z
  .object({
    TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
    TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
    RESIDENT_ATOM_URL: z.url().default("http://localhost:5008"),
    CASE_ATOM_URL: z.url().default("http://localhost:5005"),
    CONTRACTOR_ATOM_URL: z.url().default("http://localhost:5009"),
    METRICS_ATOM_URL: z.url().default("http://localhost:5006"),
    ASSIGNMENT_ATOM_URL: z.url().default("http://localhost:5004"),
    APPOINTMENT_ATOM_URL: z.url().default("http://localhost:5003"),
    PROOF_ATOM_URL: z.url().default("http://localhost:5007"),
    ALERT_ATOM_URL: z.url().default("http://localhost:5002"),
    WORKER_SERVICE_TOKEN: z.string().min(32),
    // Immutable build identity: a deployed image carries its git SHA, and a new
    // SHA is a new image. `dev` keeps `pnpm dev` working.
    BUILD_ID: z.string().min(1).default("dev"),
  })
  .parse(process.env);

// ponytail: local dev runs unversioned. A versioned Worker never polls the
// unversioned pool and nothing here promotes a deployment's current version, so
// versioning on `dev` would leave `pnpm dev` draining nothing. Upgrade path:
// set a real BUILD_ID and promote that version for the deployment.
const versioned = config.BUILD_ID !== "dev";

const connection = await NativeConnection.connect({
  address: config.TEMPORAL_ADDRESS,
});
const worker = await Worker.create({
  connection,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: ORCHESTRATION_TASK_QUEUE,
  workflowsPath: fileURLToPath(
    new URL("./workflows/index.ts", import.meta.url)
  ),
  ...(versioned && {
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: {
        deploymentName: "townops-orchestration",
        buildId: config.BUILD_ID,
      },
      defaultVersioningBehavior: "AUTO_UPGRADE",
    } as const,
  }),
  activities: {
    openCase: createOpenCaseActivity({
      residentAtomUrl: config.RESIDENT_ATOM_URL,
      caseAtomUrl: config.CASE_ATOM_URL,
      workerServiceToken: config.WORKER_SERVICE_TOKEN,
    }),
    provisionResidentProfile: createProvisionResidentActivity({
      residentAtomUrl: config.RESIDENT_ATOM_URL,
      workerServiceToken: config.WORKER_SERVICE_TOKEN,
    }),
    ...createAllocateContractorActivities({
      contractorAtomUrl: config.CONTRACTOR_ATOM_URL,
      metricsAtomUrl: config.METRICS_ATOM_URL,
      assignmentAtomUrl: config.ASSIGNMENT_ATOM_URL,
      caseAtomUrl: config.CASE_ATOM_URL,
      appointmentAtomUrl: config.APPOINTMENT_ATOM_URL,
      workerServiceToken: config.WORKER_SERVICE_TOKEN,
    }),
    ...createStartWorkActivities({
      appointmentAtomUrl: config.APPOINTMENT_ATOM_URL,
      assignmentAtomUrl: config.ASSIGNMENT_ATOM_URL,
      caseAtomUrl: config.CASE_ATOM_URL,
      workerServiceToken: config.WORKER_SERVICE_TOKEN,
    }),
    ...createAppointmentRecoveryActivities({
      appointmentAtomUrl: config.APPOINTMENT_ATOM_URL,
      caseAtomUrl: config.CASE_ATOM_URL,
      workerServiceToken: config.WORKER_SERVICE_TOKEN,
    }),
    ...createCompleteCaseActivities({
      proofAtomUrl: config.PROOF_ATOM_URL,
      appointmentAtomUrl: config.APPOINTMENT_ATOM_URL,
      assignmentAtomUrl: config.ASSIGNMENT_ATOM_URL,
      caseAtomUrl: config.CASE_ATOM_URL,
      metricsAtomUrl: config.METRICS_ATOM_URL,
      workerServiceToken: config.WORKER_SERVICE_TOKEN,
    }),
    ...createCancelCaseActivities({
      appointmentAtomUrl: config.APPOINTMENT_ATOM_URL,
      assignmentAtomUrl: config.ASSIGNMENT_ATOM_URL,
      caseAtomUrl: config.CASE_ATOM_URL,
      workerServiceToken: config.WORKER_SERVICE_TOKEN,
    }),
    ...createDerivedEffectActivities({
      alertAtomUrl: config.ALERT_ATOM_URL,
      residentAtomUrl: config.RESIDENT_ATOM_URL,
      contractorAtomUrl: config.CONTRACTOR_ATOM_URL,
      metricsAtomUrl: config.METRICS_ATOM_URL,
      caseAtomUrl: config.CASE_ATOM_URL,
      workerServiceToken: config.WORKER_SERVICE_TOKEN,
    }),
  },
});

// The Worker carries no logger or Sentry (unlike the atoms' shared-ts logger) —
// PRS-152 deliberately does not add that dependency here. This turns a fatal run
// failure into a logged non-zero exit instead of an unhandled top-level
// rejection. Nothing is swallowed or retried. A determinism violation fails its
// Workflow Task and the server retries it, so it surfaces on the Execution in
// the Temporal UI rather than here — see docs/deployment.md.
try {
  await worker.run();
} catch (error) {
  // Log the error itself, not a flattened message/stack: Temporal errors are
  // cause-chained and the chain is what makes a fatal failure diagnosable.
  // `exitCode` rather than `exit()` so the async stderr pipe still flushes.
  console.error("[worker] worker run failed", {
    buildId: config.BUILD_ID,
    versioned,
    error,
  });
  process.exitCode = 1;
}
