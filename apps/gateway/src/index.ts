import { serve } from "@hono/node-server";
import { Client, Connection } from "@temporalio/client";
import { withServerlessAuth } from "@townops/orchestration-contract";
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
    PROOF_ATOM_URL: z.url().default("http://localhost:5007"),
    ALERT_ATOM_URL: z.url().default("http://localhost:5002"),
    WORKER_SERVICE_TOKEN: z.string().min(32),
    GATEWAY_UPDATE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(20_000),
    // "off" for Docker Compose / local dev — see gcp-identity.ts. Any other
    // value (including unset, on a real Cloud Run deployment) mints an ID
    // token for the private auth atom's JWKS endpoint.
    METADATA_SERVER: z.string().optional(),
    // Comma-separated browser origins CORS accepts on `/api/*`. Unset or
    // empty falls back to createGatewayApp's own localhost dev-port default.
    GATEWAY_ALLOWED_ORIGINS: z.string().optional(),
  })
  .parse(process.env);

// `undefined` (unset) and `""` (set-but-empty) both fall back to
// createGatewayApp's own localhost default — an empty array would instead
// reject every browser origin.
const parsedOrigins = config.GATEWAY_ALLOWED_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const browserOrigins = parsedOrigins?.length ? parsedOrigins : undefined;

const jwksResponseSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

/**
 * Cloud Run IAM protects the auth atom, so the JWKS fetch needs the same ID
 * token every other atom call carries — `jwk()`'s own `jwks_uri` option uses
 * bare `fetch` and would 403 there. `keys` runs on every authenticated
 * request (hono/jwk's `jwk2` middleware), so the parsed key set is cached for
 * a few minutes rather than re-fetched per request.
 * ponytail: fixed 5-minute TTL, not a Cache-Control-driven one; raise this if
 * the auth atom ever rotates its signing key faster than that.
 */
const JWKS_CACHE_TTL_MS = 5 * 60_000;
let cachedJwks: { keys: JsonWebKey[]; fetchedAtMs: number } | undefined;

async function fetchJwks(): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (cachedJwks && now - cachedJwks.fetchedAtMs < JWKS_CACHE_TTL_MS) {
    return cachedJwks.keys;
  }
  const response = await withServerlessAuth(fetch)(config.JWKS_URI);
  if (!response.ok) {
    throw new Error(`JWKS fetch failed with ${response.status}`);
  }
  // The key material itself is opaque to us — Hono's own JWT verification is
  // what interprets it — so it is validated only as "an array of objects",
  // not field-by-field against the JWK spec.
  const body = jwksResponseSchema.parse(await response.json());
  cachedJwks = { keys: body.keys, fetchedAtMs: now };
  return cachedJwks.keys;
}

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
  proofAtomUrl: config.PROOF_ATOM_URL,
  alertAtomUrl: config.ALERT_ATOM_URL,
  workerServiceToken: config.WORKER_SERVICE_TOKEN,
  authenticate:
    config.METADATA_SERVER === "off"
      ? jwk({ jwks_uri: config.JWKS_URI, alg: ["EdDSA"] })
      : jwk({ keys: fetchJwks, alg: ["EdDSA"] }),
  browserOrigins,
  updateTimeoutMs: config.GATEWAY_UPDATE_TIMEOUT_MS,
});

serve({ fetch: app.fetch, port: config.PORT });
