import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

export async function setup() {
  console.log(
    "\n[Integration Setup] Starting Postgres Testcontainer for Case Atom..."
  );
  const container = await new PostgreSqlContainer("postgres:15-alpine").start();
  const dbUrl = container.getConnectionUri();

  process.env.DATABASE_URL = dbUrl;
  process.env.PORT = "5008";
  process.env.JWKS_URI = "http://localhost:5001/.well-known/jwks.json";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";

  const pool = new Pool({ connectionString: dbUrl });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    console.log("[Integration Setup] Installed 'uuid-ossp' extension.");
  } catch (err) {
    console.warn("[Integration Setup] Failed to install extension:", err);
  } finally {
    await pool.end();
  }

  try {
    console.log("[Integration Setup] Pushing schema with drizzle-kit...");
    try {
      execSync("bun drizzle-kit push --force", {
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "pipe",
      });
      console.log("[Integration Setup] Schema setup completed.");
    } catch (pushError: any) {
      console.warn(
        `[Integration Setup] drizzle-kit push warning/error: ${pushError}`
      );
    }
  } catch (error) {
    await container.stop();
    throw error;
  }

  return async () => {
    console.log("[Integration Setup] Stopping Postgres Testcontainer...");
    await container.stop();
  };
}
