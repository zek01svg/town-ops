import { RabbitMQContainer } from "@testcontainers/rabbitmq";

export async function setup() {
  console.log(
    "[Pre-integration test setup - Accept Job Composite] Starting RabbitMQ Testcontainer..."
  );

  const rabbitContainer = await new RabbitMQContainer(
    "rabbitmq:3.13-management-alpine"
  )
    .withStartupTimeout(120_000)
    .start();

  const amqpUrl = rabbitContainer.getAmqpUrl();
  console.log(
    `[Pre-integration test setup - Accept Job Composite] RabbitMQ bound: ${rabbitContainer.getMappedPort(5672)}`
  );

  process.env.RABBITMQ_URL = amqpUrl;

  return async () => {
    console.log(
      "[Post-integration test cleanup - Accept Job Composite] Tearing down RabbitMQ Testcontainer..."
    );
    await rabbitContainer.stop();
  };
}
