# @townops/shared-ts

Core telemetry and structured logging utilities tailored for TypeScript microservices and atoms within the TownOps workspace backplane.

---

## 🛠️ **Contents**

### 🩺 **1. OpenTelemetry Traces** (`src/otel.ts`)

Hooks up standard Node API instrumentation pipelines targeting OTEL Collector integrations.

- **Usage**: `setupTracingTS('service-name')`

### 🪵 **2. Structured Logging** (`src/logger.ts`)

Configured **Pino** output stream tailored for high-cardinality JSON ingestion (Grafana Loki ready).

- **Usage**: `logger.info({ route }, "Message")`

### ⏱️ **3. Hono Access Logging Middleware** (`src/hono-logger.ts`)

Global router wrapper measuring server response times with automated payload auditing.

- **Usage**: `app.use('*', honoLogger())`

### 🐇 **4. RabbitMQ Client** (`src/rabbitmq.ts`)

Shared RabbitMQ client for publishing and consuming messages.

- **Usage**: `const rabbitmqClient = new RabbitMQClient(env.RABBITMQ_URL)`

---

## 🚀 **Usage in Atoms**

To consume this package in any app workspace, reference it inside your local workspace dependencies:

```json
"dependencies": {
  "@townops/shared-ts": "workspace:*"
}
```
