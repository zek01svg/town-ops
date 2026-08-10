import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function setup() {
  console.log("\n[Integration Setup] Starting Postgres Testcontainer...");
  const container = await new PostgreSqlContainer("postgres:15-alpine").start();
  const dbUrl = container.getConnectionUri();

  console.log(
    `[Integration Setup] Port bound: ${container.getMappedPort(5432)}`
  );

  // Mock Env variables to satisfy @t3-oss/env-core validation in src/env.ts
  process.env.PORT = "5000";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.DATABASE_URL = dbUrl;
  process.env.WORKER_SERVICE_TOKEN =
    "test-worker-service-token-at-least-32-chars";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";

  console.log("[Integration Setup] Applying appointment migrations...");

  try {
    // drizzle-kit migrate, not push: the initial migration hand-adds the
    // btree_gist extension and the slot-claim exclusion constraint, neither of
    // which lives in schema.ts, so a push would silently omit them.
    execSync("bun drizzle-kit migrate", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    console.log("[Integration Setup] Appointment migrations completed.");
  } catch (error) {
    await container.stop();
    throw error;
  }

  return async () => {
    console.log("[Integration Setup] Stopping Postgres Testcontainer...");
    await container.stop();
  };
}
