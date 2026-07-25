import { execSync } from "child_process";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RabbitMQContainer } from "@testcontainers/rabbitmq";

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

  console.log("[Integration Setup] Pushing schema with drizzle-kit...");
  try {
    execSync("bun drizzle-kit migrate", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    console.log("[Integration Setup] Schema setup completed.");
  } catch (error) {
    await Promise.all([pgContainer.stop(), rabbitContainer.stop()]);
    throw error;
  }

  return async () => {
    console.log("[Integration Setup] Stopping Containers...");
    await Promise.all([pgContainer.stop(), rabbitContainer.stop()]);
  };
}
