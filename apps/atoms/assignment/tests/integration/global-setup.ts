import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function setup() {
  console.log(
    "\n[Assignment Atom Integration Test Setup] Starting Postgres Testcontainer..."
  );
  const container = await new PostgreSqlContainer("postgres:15-alpine").start();
  const dbUrl = container.getConnectionUri();

  console.log(
    `[Integration Setup] Port bound: ${container.getMappedPort(5432)}`
  );

  // Mock Env variables to satisfy @t3-oss/env-core validation in src/env.ts
  process.env.PORT = "5000";
  process.env.WORKER_SERVICE_TOKEN = "a".repeat(32);
  process.env.DATABASE_URL = dbUrl;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";

  console.log(
    "[Assignment Atom Integration Test Setup] Pushing schema with drizzle-kit..."
  );

  try {
    execSync("bun drizzle-kit migrate", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    console.log(
      "[Assignment Atom Integration Test Setup] Schema setup completed."
    );
  } catch (error) {
    await container.stop();
    throw error;
  }

  return async () => {
    console.log(
      "[Assignment Atom Integration Test Setup] Tearing down Postgres Testcontainer..."
    );
    await container.stop();
  };
}
