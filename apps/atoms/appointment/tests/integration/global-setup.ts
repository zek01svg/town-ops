import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

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

  console.log("[Integration Setup] Applying appointment migration...");

  try {
    execSync("bun run src/database/apply-slot-claim-constraint.ts", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    const pool = new Pool({ connectionString: dbUrl });
    const journal = await pool.query(
      "SELECT id FROM townops_migrations.appointment_atom"
    );
    await pool.end();
    const appliedIds = new Set(journal.rows.map((row) => row.id));
    if (
      !appliedIds.has("0000_prs_142_slot_claim_exclusion") ||
      !appliedIds.has("0001_prs_145_appointment_in_progress")
    ) {
      throw new Error("Appointment migration journal was not recorded");
    }
    console.log("[Integration Setup] Appointment migration completed.");
  } catch (error) {
    await container.stop();
    throw error;
  }

  return async () => {
    console.log("[Integration Setup] Stopping Postgres Testcontainer...");
    await container.stop();
  };
}
