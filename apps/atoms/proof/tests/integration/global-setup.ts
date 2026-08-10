import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function setup() {
  console.log(
    "\n[Integration Setup] Starting Postgres Testcontainer for Proof Atom..."
  );
  const container = await new PostgreSqlContainer("postgres:15-alpine").start();
  const dbUrl = container.getConnectionUri();

  process.env.DATABASE_URL = dbUrl;
  process.env.PORT = "5005";
  process.env.JWKS_URI = "http://localhost:5001/.well-known/jwks.json";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_PUBLIC_URL = "http://localhost:9000/proofs";
  process.env.S3_ACCESS_KEY_ID = "test";
  process.env.S3_SECRET_ACCESS_KEY = "test";
  process.env.S3_BUCKET = "proofs";
  process.env.S3_REGION = "us-east-1";
  process.env.WORKER_SERVICE_TOKEN = "test-worker-token-000000000000000000";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";

  try {
    console.log("[Integration Setup] Applying migrations with drizzle-kit...");
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
