import type { StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import { RabbitMQContainer } from "@testcontainers/rabbitmq";

let container: StartedRabbitMQContainer;

export async function setup() {
  console.log("[Integration] Starting RabbitMQ Testcontainer...");
  container = await new RabbitMQContainer("rabbitmq:3.13-management-alpine")
    .withStartupTimeout(120_000)
    .start();

  process.env.RABBITMQ_URL = container.getAmqpUrl();
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.RESIDENT_ATOM_URL = "http://resident-atom";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.APPOINTMENT_ATOM_URL = "http://appointment-atom";
  process.env.PROOF_ATOM_URL = "http://proof-atom";
  process.env.METRICS_ATOM_URL = "http://metrics-atom";
  process.env.CONTRACTOR_API_URL = "http://contractor-api";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=test";

  console.log(
    `[Integration] RabbitMQ ready on port ${container.getMappedPort(5672)}`
  );
}

export async function teardown() {
  console.log("[Integration] Stopping RabbitMQ Testcontainer...");
  await container.stop();
}
