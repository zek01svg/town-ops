# Tech stack

| Area                   | Technology                                                  |
| :--------------------- | :---------------------------------------------------------- |
| Language and workspace | TypeScript, pnpm workspaces, Turborepo                      |
| Service runtime        | Bun for atoms; Node for Gateway and Temporal Worker         |
| HTTP and validation    | Hono and Zod                                                |
| Persistence            | PostgreSQL and Drizzle ORM                                  |
| Orchestration          | Temporal TypeScript SDK                                     |
| Frontends              | React, Vite, TanStack Router/Query/Form/Table, Tailwind CSS |
| Shared UI              | Radix primitives, `@townops/ui`, hugeicons-react            |
| Observability          | OpenTelemetry, Pino, and Sentry                             |
| Testing                | Vitest, Testcontainers, and Playwright                      |
| Delivery               | Docker Compose and Docker images                            |

Atoms retain data ownership. Gateway and Worker use Temporal for durable Case
orchestration; see [ADR 0001](./adr/0001-temporal-orchestration.md).
