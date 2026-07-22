# Tech Stack

TownOps is engineered for **high performance**, **type-safety**, and **developer experience**.

---

## **Runtime, language, and package manager**

| Technology            | Purpose           | Why?                                                                                                      |
| :-------------------- | :---------------- | :-------------------------------------------------------------------------------------------------------- |
| **TypeScript v7.0.2** | Language          | Industry-standard strict typing with advanced inference for zero-runtime errors + self-documenting code.  |
| **Bun v1.3.14**       | JS Runtime        | 3-4x faster startup than Node.js, native high-performance package management, and built-in hot reloading. |
| **PNPM v11.15.0**     | Workspace Manager | Efficient disk usage via content-addressable storage and robust monorepo support.                         |

---

## **Backend Architecture (Atoms, Gateway, and Worker)**

Our backend follows a service-oriented pattern with data-owning **Atoms**,
stateless **Composites**, and a Temporal-backed Gateway/Worker path for Case
orchestration.

- **Framework**: [Hono](https://hono.dev/) - The fastest, most ergonomic web framework with Zero-Overhead and built-in OpenAPI support.
- **Microservices**:
  - **Atoms**: Direct DB access (PostgreSQL + Drizzle), owning specific schemas.
  - **Composites**: Stateless HTTP/AMQP orchestrators for existing flows.
  - **Gateway and Worker**: Node services using the Temporal TypeScript SDK for durable Case Workflow execution.
- **Validation**: [Zod v4](https://zod.dev/) - Blazing fast schema validation that powers both API boundaries and DB type-safety.
- **Observability**: Native OpenTelemetry (OTLP) instrumentation integrated into every service for distributed tracing.

---

## **Modern Frontend**

Dashboards built for officers and contractors.

- **Core**: React 19 (using the latest compiler-optimized rendering).
- **Build Tool**: Vite 8 (Ultra-fast HMR and ESM-first bundling).
- **Styling**: TailwindCSS v4 - Zero-runtime CSS with a modern, design-first utility system.
- **State & Data**:
  - **TanStack Router**: Type-safe, high-performance client-side routing.
  - **TanStack Query (v5)**: Efficient server-state management with automatic caching/retries.
  - **TanStack Form/Table**: Headless, type-safe components for complex data manipulation.
- **UI System**: Custom-built on top of Radix UI primitives and hugeicons-react.

---

## **Auth & Security**

- **Authentication**: [better-auth](https://better-auth.com/) — session-based auth with JWT plugin (RS256). Contractor accounts carry an additional `contractor_id` field linking to OutSystems UUIDs.
- **JWT Validation**: Hono `jwk` middleware fetches JWKS from the auth atom to validate tokens on browser-facing routes.
- **Error Tracking**: Sentry for exception capture across all services.

## **Data & Messaging**

- **Database**: [PostgreSQL 15+](https://www.postgresql.org/).
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/) - A "thin, type-safe wrapper" that runs at raw SQL speeds with zero abstraction overhead.
- **Workflow engine**: [Temporal](https://temporal.io/) — Durable Case orchestration, retries, and Saga compensation.
- **Event Bus**: [CloudAMQP](https://www.cloudamqp.com/) (AMQP) — Existing composite, notification, and metrics flows.
- **File Storage**: Supabase Storage — used by the Proof atom for before/after photo uploads.

---

## **Developer Experience (DX) & CI/CD**

- **Monorepo Orchestration**: [Turborepo](https://turbo.build/repo) - Intelligent caching that ensures the same task is never run twice.
- **Linting**: [Oxlint](https://oxlint.dev/) - High-performance linter written in Rust, 50-100x faster than ESLint.
- **Formatting**: [Oxfmt](https://oxc.rs/docs/guide/usage/formatting.html) - High-performance formatter written in Rust, 30x faster than Prettier.
- **Testing**: [Vitest](https://vitest.dev/) - Vite-native testing with [Testcontainers](https://testcontainers.com/) for isolated, production-like integration tests.
- **E2E**: [Playwright](https://playwright.dev/) for cross-browser visual and functional verification.
- **Deployment**: Dockerized services using multi-stage builds and Bun's standalone binary bundling.
