import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function setup() {
  console.log(
    "\n[Integration Setup] Starting Postgres Testcontainer for Contractor Atom..."
  );
  const container = await new PostgreSqlContainer("postgres:15-alpine").start();
  const dbUrl = container.getConnectionUri();

  process.env.DATABASE_URL = dbUrl;
  process.env.PORT = "5009";
  process.env.WORKER_SERVICE_TOKEN = "a".repeat(32);
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";

  try {
    console.log("[Integration Setup] Pushing schema with drizzle-kit...");
    execSync("bun drizzle-kit migrate", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    console.log("[Integration Setup] Schema setup completed.");
  } catch (error) {
    await container.stop();
    throw error;
  }

  return async () => {
    console.log("[Integration Setup] Stopping Postgres Testcontainer...");
    await container.stop();
  };
}
