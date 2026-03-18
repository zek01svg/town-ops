# 📁 Metrics Atom

A backend microservice (Atom) dedicated strictly to creating, updating, and querying contractor performance metrics. It acts as a raw data backplane layer constructed using **Hono**, **Bun**, and **Drizzle ORM** with native OpenTelemetry instrumentation.

---

## 🚀 **Tech Stack**

- **Runtime**: [Bun](https://bun.sh/)
- **Framework**: [Hono](https://hono.dev/)
- **OpenAPI & Docs**: [hono-openapi](https://hono.dev/examples/hono-openapi) & [Scalar](https://hono.dev/examples/scalar)
- **Database ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Logging**: Pino via customized `@townops/shared-observability-ts`
- **Testing**: [Vitest](https://vitest.dev/) with **Testcontainers** 🐳

---

## 📖 **API Documentation**

The API documentation is fully automated via OpenAPI specifications.
Once the server is running, visit:

- **Dashboard (Scalar)**: `http://localhost:5000/scalar`
- **OpenAPI Spec (.json)**: `http://localhost:5000/openapi`

---

## 💻 **Development Commands**

| Command                | Description                                                                    |
| :--------------------- | :----------------------------------------------------------------------------- |
| `bun run dev`          | Starts server with `--hot` reloading addressing workspace filters.             |
| `bun run build`        | Bundles exact index payload into a standalone `build/index.js`.                |
| `bun run test`         | Executes Unit and Integration test suite (via Testcontainers).                 |
| `bun run db:push`      | Pushes schema updates directly to the connected PostgreSQL instance.           |
| `bun run build:docker` | Chained script that bundles locally, then builds optimized single-liner image. |

---

## 🛠️ **Getting Started & Execution**

### 1. Environment Setup

Create a `.env` file in this directory with the following variables:

```env
DATABASE_URL=postgres://user:password@localhost:5432/townops
PORT=5000
JWKS_URI=http://localhost:5001/.well-known/jwks.json
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### 2. Database Migrations

Provision/Update your database layout with:

```bash
bun run db:push
```

### 3. Run Locally

```bash
bun install
bun run dev
```

### 4. Run Tests 🧪

**Testcontainers** is used for isolated integration tests. Make sure you have **Docker running**:

```bash
bun vitest run tests
```

### 5. Run in Docker 🐳

To package and spin up the optimized docker runtime:

```bash
# 1. Build Single-Stage Image
bun run build:docker

# 2. Run Container with absolute reference port mapping
docker run --env-file .env -p 5000:5000 metrics-atom
```
