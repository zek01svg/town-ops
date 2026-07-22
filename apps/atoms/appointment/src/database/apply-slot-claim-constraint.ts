import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { env } from "../env";

const migration = await readFile(
  process.env.APPOINTMENT_MIGRATION_FILE ??
    new URL(
      "../../drizzle/0000_prs_142_slot_claim_exclusion.sql",
      import.meta.url
    ),
  "utf8"
);
const pool = new Pool({ connectionString: env.DATABASE_URL });
const client = await pool.connect();
const migrationId = "0000_prs_142_slot_claim_exclusion";

try {
  await client.query("BEGIN");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('appointment-atom-prs-142'))"
  );
  await client.query("CREATE SCHEMA IF NOT EXISTS townops_migrations");
  await client.query(`
    CREATE TABLE IF NOT EXISTS townops_migrations.appointment_atom (
      id text PRIMARY KEY,
      applied_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  const applied = await client.query(
    "SELECT 1 FROM townops_migrations.appointment_atom WHERE id = $1",
    [migrationId]
  );
  if (applied.rowCount === 0) {
    await client.query(migration);
    await client.query(
      "INSERT INTO townops_migrations.appointment_atom (id) VALUES ($1)",
      [migrationId]
    );
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
