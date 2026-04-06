# ⚡ TownOps Tech Stack

TownOps is engineered for **ultra-high performance**, **type-safety**, and **developer experience**.

---

## 🚀 **Core Runtimes & Languages**

| Technology            | Purpose           | Why?                                                                                                      |
| :-------------------- | :---------------- | :-------------------------------------------------------------------------------------------------------- |
| **TypeScript v6.0.2** | Language          | Industry-standard strict typing with advanced inference for zero-runtime errors + self-documenting code.  |
| **Bun v1.3.3**        | JS Runtime        | 3-4x faster startup than Node.js, native high-performance package management, and built-in hot reloading. |
| **PNPM v10.33.0**     | Workspace Manager | Efficient disk usage via content-addressable storage and robust monorepo support.                         |

---

## 🏗️ **Backend Architecture (Atoms & Composites)**

Our backend follows the **SOA (Service-Oriented Architecture)** pattern, split into data-owning **Atoms** and orchestrating **Composites**.

- **Framework**: [Hono](https://hono.dev/) - The fastest, most ergonomic web framework with Zero-Overhead and built-in OpenAPI support.
- **Microservices**:
  - **Atoms**: Direct DB access (PostgreSQL + Drizzle), owning specific schemas.
  - **Composites**: Pure business logic orchestrators, communicating via typed Hono RPC clients (`hc<T>`).
- **Validation**: [Zod v4](https://zod.dev/) - Blazing fast schema validation that powers both API boundaries and DB type-safety.
- **Observability**: Native OpenTelemetry (OTLP) instrumentation integrated into every service for distributed tracing.

---

## 🎨 **Modern Frontend**

A premium, interactive dashboard built for officers and contractors.

- **Core**: React 19 (using the latest compiler-optimized rendering).
- **Build Tool**: Vite 8 (Ultra-fast HMR and ESM-first bundling).
- **Styling**: TailwindCSS v4 - Zero-runtime CSS with a modern, design-first utility system.
- **State & Data**:
  - **TanStack Router**: Type-safe, high-performance client-side routing.
  - **TanStack Query (v5)**: Efficient server-state management with automatic caching/retries.
  - **TanStack Form/Table**: Headless, type-safe components for complex data manipulation.
- **UI System**: Custom-built on top of Radix UI primitives and hugeicons-react.

---

## 🔐 **Auth & Security**

- **Authentication**: [better-auth](https://better-auth.com/) — session-based auth with JWT plugin (RS256). Contractor accounts carry an additional `contractor_id` field linking to OutSystems UUIDs.
- **JWT Validation**: Hono `jwk` middleware fetches JWKS from the auth atom to validate tokens on browser-facing routes.
- **Error Tracking**: Sentry for exception capture across all services.

## 💾 **Data & Messaging**

- **Database**: [PostgreSQL 15+](https://www.postgresql.org/).
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/) - A "thin, type-safe wrapper" that runs at raw SQL speeds with zero abstraction overhead.
- **Event Bus**: [CloudAMQP](https://www.cloudamqp.com/) (AMQP) — Handles asynchronous orchestration: SLA breach detection (DLX/TTL), contractor notifications, and metrics recording.
- **File Storage**: Supabase Storage — used by the Proof atom for before/after photo uploads.

---

## 🛠️ **Developer Experience (DX) & CI/CD**

We prioritize speed at every step of the development lifecycle.

- **Monorepo Orchestration**: [Turborepo](https://turbo.build/repo) - Intelligent caching that ensures the same task is never run twice.
- **Linting**: [Oxlint](https://oxlint.dev/) - An ultra-fast linter written in Rust, 50-100x faster than ESLint.
- **Formatting**: [Oxfmt](https://oxc.rs/docs/guide/usage/formatting.html) - Blazing fast code formatting.
- **Testing**: [Vitest](https://vitest.dev/) - Vite-native testing with [Testcontainers](https://testcontainers.com/) for isolated, production-like integration tests.
- **E2E**: [Playwright](https://playwright.dev/) for cross-browser visual and functional verification.
- **Deployment**: Dockerized services using multi-stage builds and Bun's standalone binary bundling.
