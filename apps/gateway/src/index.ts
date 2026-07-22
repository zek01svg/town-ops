import { serve } from "@hono/node-server";
import { Client, Connection } from "@temporalio/client";
import { jwk } from "hono/jwk";
import { z } from "zod/v4";

import { createGatewayApp } from "./app.ts";

const config = z
  .object({
    PORT: z.coerce.number().int().positive().default(6010),
    TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
    TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
    JWKS_URI: z.url(),
    CASE_ATOM_URL: z.url().default("http://localhost:5005"),
    RESIDENT_ATOM_URL: z.url().default("http://localhost:5008"),
    AUTH_ATOM_URL: z.url().default("http://localhost:5001"),
    ASSIGNMENT_ATOM_URL: z.url().default("http://localhost:5004"),
    APPOINTMENT_ATOM_URL: z.url().default("http://localhost:5003"),
  })
  .parse(process.env);

let temporalWorkflowClient: Client["workflow"] | undefined;

async function getTemporalWorkflowClient() {
  if (!temporalWorkflowClient) {
    const connection = await Connection.connect({
      address: config.TEMPORAL_ADDRESS,
    });
    temporalWorkflowClient = new Client({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
    }).workflow;
  }

  return temporalWorkflowClient;
}

const app = createGatewayApp({
  workflowClient: {
    executeUpdateWithStart: async (updateName, options) =>
      (await getTemporalWorkflowClient()).executeUpdateWithStart(
        updateName,
        options
      ),
    start: async (workflowType, options) =>
      (await getTemporalWorkflowClient()).start(workflowType, options),
  },
  caseAtomUrl: config.CASE_ATOM_URL,
  residentAtomUrl: config.RESIDENT_ATOM_URL,
  authAtomUrl: config.AUTH_ATOM_URL,
  assignmentAtomUrl: config.ASSIGNMENT_ATOM_URL,
  appointmentAtomUrl: config.APPOINTMENT_ATOM_URL,
  authenticate: jwk({ jwks_uri: config.JWKS_URI, alg: ["EdDSA"] }),
});

serve({ fetch: app.fetch, port: config.PORT });
