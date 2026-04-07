# 🤝 Handle Breach Composite

A backend microservice (Composite) dedicated to handling SLA breaches — consumes `sla.breached` events from RabbitMQ, reassigns the job to a backup contractor, escalates the Case status to `escalated`, records a penalty score against the original contractor, and publishes an alert. Built with **Hono** and **Bun** with native OpenTelemetry instrumentation.

---

## 🚀 **Tech Stack**

- **Runtime**: [Bun](https://bun.sh/)
- **Framework**: [Hono](https://hono.dev/)
- **OpenAPI & Docs**: [hono-openapi](https://hono.dev/examples/hono-openapi) & [Scalar](https://hono.dev/examples/scalar)
- **Messaging**: RabbitMQ via `@townops/shared-ts`
- **Logging**: Pino via customized `@townops/shared-ts`
- **Testing**: [Vitest](https://vitest.dev/)

---

## 📖 **API Documentation**

The API documentation is fully automated via OpenAPI specifications.
Once the server is running, visit:

- **Dashboard (Scalar)**: `http://localhost:6005/scalar`
- **OpenAPI Spec (.json)**: `http://localhost:6005/openapi`

---

## 💻 **Development Commands**

| Command                | Description                                                                    |
| :--------------------- | :----------------------------------------------------------------------------- |
| `bun run dev`          | Starts server with `--hot` reloading addressing workspace filters.             |
| `bun run build`        | Bundles exact index payload into a standalone `build/index.js`.                |
| `bun test`             | Executes isolated endpoints verification suite with coverage.                  |
| `bun run build:docker` | Chained script that bundles locally, then builds optimized single-liner image. |

---

## 🛠️ **Getting Started & Execution**

### 1. Environment Setup

Create a `.env` file in this directory with the following variables:

```env
PORT=6005
RABBITMQ_URL=amqp://guest:guest@localhost:5672
CASE_ATOM_URL=http://localhost:5005
ASSIGNMENT_ATOM_URL=http://localhost:5004
METRICS_ATOM_URL=http://localhost:5006
CONTRACTOR_API_URL=https://your-outsystems-contractor-api.example.com
JWKS_URI=http://localhost:5001/api/auth/jwks
```

### 2. Run Locally

```bash
bun install
bun run dev
```

### 3. Run in Docker 🐳

To package and spin up the optimized docker runtime:

```bash
# 1. Build Single-Stage Image
bun run build:docker

# 2. Run Container with absolute reference port mapping
docker run --env-file .env -p 6005:6005 handle-breach-composite
```
