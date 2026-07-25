import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { env } from "../env";

// Ledger-applied raw migrations, in order. Each entry's `file` can be
// overridden by its own env var — `bun build` bundles this script, which
// breaks the `import.meta.url`-relative default path, so the Dockerfile CMD
// passes the built location explicitly (same reason the original PRS-142
// override existed).
const migrations = [
  {
    id: "0000_prs_142_slot_claim_exclusion",
    file:
      process.env.APPOINTMENT_MIGRATION_FILE ??
      new URL(
        "../../drizzle/0000_prs_142_slot_claim_exclusion.sql",
        import.meta.url
      ),
  },
  {
    id: "0001_prs_145_appointment_in_progress",
    file:
      process.env.APPOINTMENT_MIGRATION_FILE_0001 ??
      new URL(
        "../../drizzle/0001_prs_145_appointment_in_progress.sql",
        import.meta.url
      ),
  },
  {
    id: "0002_prs_146_appointment_no_access",
    file:
      process.env.APPOINTMENT_MIGRATION_FILE_0002 ??
      new URL(
        "../../drizzle/0002_prs_146_appointment_no_access.sql",
        import.meta.url
      ),
  },
  {
    id: "0003_prs_146_one_live_appointment_per_attempt",
    file:
      process.env.APPOINTMENT_MIGRATION_FILE_0003 ??
      new URL(
        "../../drizzle/0003_prs_146_one_live_appointment_per_attempt.sql",
        import.meta.url
      ),
  },
  {
    id: "0004_prs_146_appointment_reason",
    file:
      process.env.APPOINTMENT_MIGRATION_FILE_0004 ??
      new URL(
        "../../drizzle/0004_prs_146_appointment_reason.sql",
        import.meta.url
      ),
  },
];

const pool = new Pool({ connectionString: env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query(
    "SELECT pg_advisory_lock(hashtext('appointment-atom-prs-142'))"
  );
  await client.query("CREATE SCHEMA IF NOT EXISTS townops_migrations");
  await client.query(`
    CREATE TABLE IF NOT EXISTS townops_migrations.appointment_atom (
      id text PRIMARY KEY,
      applied_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  for (const { id, file } of migrations) {
    await client.query("BEGIN");
    try {
      const applied = await client.query(
        "SELECT 1 FROM townops_migrations.appointment_atom WHERE id = $1",
        [id]
      );
      if (applied.rowCount === 0) {
        const migration = await readFile(file, "utf8");
        await client.query(migration);
        await client.query(
          "INSERT INTO townops_migrations.appointment_atom (id) VALUES ($1)",
          [id]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
} finally {
  await client
    .query("SELECT pg_advisory_unlock(hashtext('appointment-atom-prs-142'))")
    .catch(() => undefined);
  client.release();
  await pool.end();
}
