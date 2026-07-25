import { fileURLToPath } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";
import { ORCHESTRATION_TASK_QUEUE } from "@townops/orchestration-contract";
import { z } from "zod/v4";

import { createAllocateContractorActivities } from "./activities/allocate-contractor.ts";
import { createAppointmentRecoveryActivities } from "./activities/appointment-recovery.ts";
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
    WORKER_SERVICE_TOKEN: z.string().min(32),
  })
  .parse(process.env);

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
  },
});

await worker.run();
