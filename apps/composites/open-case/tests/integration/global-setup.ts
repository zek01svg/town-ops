import { RabbitMQContainer } from "@testcontainers/rabbitmq";

export async function setup() {
  console.log(
    "[Pre-integration test setup - Open Case Composite] Starting RabbitMQ Testcontainer..."
  );
  const rabbitContainer = await new RabbitMQContainer(
    "rabbitmq:4.2.4-management-alpine"
  ).start();
  const amqpUrl = rabbitContainer.getAmqpUrl();
  console.log(
    `[Pre-integration test setup - Open Case Composite] RabbitMQ bound: ${rabbitContainer.getMappedPort(5672)}`
  );
  process.env.RABBITMQ_URL = amqpUrl;

  return async () => {
    console.log(
      "[Post-integration test cleanup - Open Case Composite] Stopping RabbitMQ Testcontainer..."
    );
    await rabbitContainer.stop();
  };
}
