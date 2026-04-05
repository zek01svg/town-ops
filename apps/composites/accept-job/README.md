# 🤝 Accept Job Composite

A backend microservice (Composite) dedicated to accepting a job by updating Assignment and Case statuses and creating an Appointment block. It acts as an orchestrator built with **Hono** and **Bun** with native OpenTelemetry instrumentation.

---

## 🚀 **Tech Stack**

- **Runtime**: [Bun](https://bun.sh/)
- **Framework**: [Hono](https://hono.dev/)
- **OpenAPI & Docs**: [hono-openapi](https://hono.dev/examples/hono-openapi) & [Scalar](https://hono.dev/examples/scalar)
- **Messaging**: [@cloudamqp/amqp-client](https://www.npmjs.com/package/@cloudamqp/amqp-client) (RabbitMQ)
- **Logging**: Pino via customized `@townops/shared-ts`
- **Testing**: [Vitest](https://vitest.dev/)

---

## 📖 **API Documentation**

The API documentation is fully automated via OpenAPI specifications.
Once the server is running, visit:

- **Dashboard (Scalar)**: `http://localhost:6003/scalar`
- **OpenAPI Spec (.json)**: `http://localhost:6003/openapi`

---

## 💻 **Development Commands**

| Command                | Description                                                                    |
| :--------------------- | :----------------------------------------------------------------------------- |
| `bun run dev`          | Starts server with `--hot` reloading addressing workspace filters.             |
| `bun run build`        | Bundles exact index payload into a standalone `build/index.js`.                |
| `bun run test`         | Executes isolated endpoints verification suite with coverage.                  |
| `bun run build:docker` | Chained script that bundles locally, then builds optimized single-liner image. |

---

## 🛠️ **Getting Started & Execution**

### 1. Environment Setup

Create a `.env` file in this directory with the following variables:

```env
PORT=6003
OTEL_EXPORTER_OTLP_ENDPOINT=your-otel-endpoint
APPOINTMENT_SERVICE_URL=http://localhost:5004
ASSIGNMENT_SERVICE_URL=http://localhost:5003
CASE_SERVICE_URL=http://localhost:5001
```

### 2. Run Locally

```bash
bun install
bun run dev
```

### 3. Run in Docker 🐳

To package and spin up the optimized docker image:

```bash
# 1. Build Single-Stage Image
bun run build:docker

# 2. Run container with port mapping
docker run --env-file .env -p 6003:6003 accept-job-composite
```
