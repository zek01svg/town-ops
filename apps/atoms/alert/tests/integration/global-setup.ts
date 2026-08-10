import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function setup() {
  console.log("\n[Integration Setup] Starting Postgres Testcontainer...");

  const pgContainer = await new PostgreSqlContainer(
    "postgres:15-alpine"
  ).start();

  const dbUrl = pgContainer.getConnectionUri();

  console.log(
    `[Integration Setup] Postgres bound: ${pgContainer.getMappedPort(5432)}`
  );

  process.env.DATABASE_URL = dbUrl;

  console.log("[Integration Setup] Pushing schema with drizzle-kit...");
  try {
    execSync("bun drizzle-kit migrate", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    console.log("[Integration Setup] Schema setup completed.");
  } catch (error) {
    await pgContainer.stop();
    throw error;
  }

  return async () => {
    console.log("[Integration Setup] Stopping Containers...");
    await pgContainer.stop();
  };
}
