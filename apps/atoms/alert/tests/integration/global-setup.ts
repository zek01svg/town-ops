import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RabbitMQContainer } from "@testcontainers/rabbitmq";
import { Pool } from "pg";

export async function setup() {
  console.log(
    "\n[Integration Setup] Starting Containers (Postgres + RabbitMQ)..."
  );

  const [pgContainer, rabbitContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:15-alpine").start(),
    new RabbitMQContainer("rabbitmq:3.13-management-alpine")
      .withStartupTimeout(120_000)
      .start(),
  ]);

  const dbUrl = pgContainer.getConnectionUri();
  const amqpUrl = rabbitContainer.getAmqpUrl();

  console.log(
    `[Integration Setup] Postgres bound: ${pgContainer.getMappedPort(5432)}`
  );
  console.log(
    `[Integration Setup] RabbitMQ bound: ${rabbitContainer.getMappedPort(5672)}`
  );

  process.env.DATABASE_URL = dbUrl;
  process.env.RABBITMQ_URL = amqpUrl;

  const pool = new Pool({ connectionString: dbUrl });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    console.log("[Integration Setup] Installed 'uuid-ossp' extension.");
  } catch (err) {
    console.warn("[Integration Setup] Failed to install extension:", err);
  } finally {
    await pool.end();
  }

  console.log("[Integration Setup] Pushing schema with drizzle-kit...");
  try {
    execSync("bun drizzle-kit push", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    console.log("[Integration Setup] Schema setup completed.");
  } catch (error: any) {
    await Promise.all([pgContainer.stop(), rabbitContainer.stop()]);
    throw error;
  }

  return async () => {
    console.log("[Integration Setup] Stopping Containers...");
    await Promise.all([pgContainer.stop(), rabbitContainer.stop()]);
  };
}
