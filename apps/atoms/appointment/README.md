# 📁 Appointment Atom

A backend microservice (Atom) dedicated to managing citizen appointments and scheduling. It acts as a raw data backplane layer constructed using **Hono**, **Bun**, and **Drizzle ORM** with native OpenTelemetry instrumentation.

---

## 🚀 **Tech Stack**

- **Runtime**: [Bun](https://bun.sh/)
- **Framework**: [Hono](https://hono.dev/)
- **OpenAPI & Docs**: [hono-openapi](https://hono.dev/examples/hono-openapi) & [Scalar](https://hono.dev/examples/scalar)
- **Database ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Logging**: Pino via customized `@townops/shared-observability-ts`
- **Testing**: [Vitest](https://vitest.dev/)

---

## 📖 **API Documentation**

The API documentation is fully automated via OpenAPI specifications.
Once the server is running, visit:

- **Dashboard (Scalar)**: `http://localhost:5003/scalar`
- **OpenAPI Spec (.json)**: `http://localhost:5003/openapi`

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
DATABASE_URL=postgres://user:password@localhost:5432/townops
PORT=5003
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
RABBITMQ_URL=amqp://guest:guest@localhost:5672
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
docker run --env-file .env -p 5003:5003 appointment-atom
```
