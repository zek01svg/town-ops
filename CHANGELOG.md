# Changelog

## [1.0.0] - 2026-07-21 to 2026-08-15

### Added

- Added the Temporal Case Workflow spine covering the full lifecycle: opening, automatic Contractor allocation, acceptance with Appointments, starting work, no-access rescheduling, missed-appointment recovery, completion with immutable proof, and cancellation before work starts.
- Added acceptance SLA breach enforcement with automatic Contractor replacement, and recovery from unavailable and concurrent allocation attempts.
- Added derived effect delivery and repair, so downstream effects retry and reconcile instead of failing silently.
- Added role-scoped Case views and timelines served through the Gateway, and secure Resident signup with durable profile provisioning.
- Added Workflow durability and safe-versioning coverage, including Continue-As-New and forced-replay tests.
- Added the GCP deployment pipeline: Terraform infrastructure, Workload Identity Federation, and a deployment workflow that builds, applies, promotes, and verifies.
- Added local Postgres infrastructure and an initialization script for the development stack.

### Changed

- Replaced RabbitMQ, AMQP, and DLX orchestration and the seven legacy Composite services with Temporal Workflows; the local stack now runs with no message broker. See `docs/adr/0001-temporal-orchestration.md`.
- Routed frontend authentication through the Gateway and privatized atom routes, so browser code reaches a single Gateway URL and never calls an atom directly.
- Migrated Proof storage from Supabase to S3-compatible MinIO.
- Moved atom migrations to drizzle-native generation and application, and removed the hand-rolled migration applier.
- Moved tooling configuration to the repository root, tightened the Oxlint ruleset, and folded the separate security-checks workflow into CI.
- Removed the legacy GCP infrastructure and moved the toolchain to `pnpm@12.0.0-rc.4`.

### Fixed

- Fixed Contractor Map hooks being called conditionally, and cleared the remaining Oxlint errors surfaced by the stricter ruleset.
- Resolved `pnpm audit` findings, including pinning `nanoid` to 3.3.18 across the vulnerable 3.x range (GHSA-2v37-7h3g-55p8) without disturbing the 5.x line a separate dependency requires.
- Fixed the environment examples, which documented wrong service ports, a dead database host, and omitted the required `WORKER_SERVICE_TOKEN` — following them could not bring the local stack up.

## [0.6.0] - 2026-04-06 to 2026-04-12

### Added

- Added the Handle No Access composite for cases that require resident rescheduling.
- Added complete role-specific officer, contractor, and resident frontends with authentication, case dashboards, maps, audit trails, forms, and resident rescheduling flows.
- Added end-to-end tests for authentication and all three documented case scenarios, plus contractor atom unit and integration tests.
- Added the Hono-based contractor atom with its schema, service layer, validation, Docker setup, and test harness.
- Added the shared UI package, Sentry instrumentation, Cloud Run/Terraform infrastructure, deployment automation, and security checks.

### Changed

- Split the former multi-role frontend into separate officer, contractor, and resident applications and updated Compose, Kong, workspace, and build configuration accordingly.
- Wired assignment and SLA-breach workflows to the contractor atom, added RabbitMQ publishing support, and expanded service documentation and maps.
- Reworked frontend server builds to use the generated build output and runtime `PORT` configuration, with path-filtered deployment jobs.
- Removed the old combined frontend layout and replaced the remaining placeholder frontend screens with role-specific case workflows.

### Fixed

- Corrected JWT algorithm configuration and removed JWK middleware from internal atom routes that do not receive user tokens.
- Fixed SLA-breach routing data, contractor lookup, escalation URLs, and the breach response window (15 seconds to 60 seconds).
- Fixed contractor identity propagation and officer audit-trail contractor-name resolution.
- Fixed Docker build dependencies, frontend image paths, CI environment/lockfile issues, and deployment repository expansion.

## [0.5.0] - 2026-03-30 to 2026-04-05

### Added

- Added TanStack Router, TanStack Query, developer tools, Hono static-build serving, and environment validation for the frontend stack.
- Added the shared Shadcn-based UI component package and Hono RPC type exports for the alert, appointment, metrics, and proof services.
- Added TypeScript/Hono implementations for the assignment atom and the accept-job, assign-job, close-case, handle-breach, and reschedule-job composites.

### Changed

- Migrated the listed atoms and composites from FastAPI/Python implementations to Bun/Hono services, including their Dockerfiles, environment configuration, validation, and tests.
- Moved database logic behind service layers, added package export metadata, and updated the local RabbitMQ image and service configuration.

### Fixed

- Fixed TypeScript import paths and trailing-slash handling in service routes.
- Fixed RabbitMQ test-environment compatibility by pinning the image to the working 3.13 release.

## [0.4.0] - 2026-03-23 to 2026-03-29

### Added

- Added the Open Case composite and its unit/integration test coverage.
- Added the assignment atom's explicit models, schemas, routes, Docker setup, API documentation, and integration coverage.
- Added shared HTTP client support for Python composites and type-safe RabbitMQ exchange, queue, and routing-key definitions.
- Added and completed workflow implementations for assignment, job acceptance, case closure, and SLA-breach handling.

### Changed

- Reworked assignment persistence and moved its shared database connection into the service boundary.
- Integrated assignment and composite branches into the development line and aligned the services with the current case lifecycle proposal.
- Renamed and flattened shared package paths, then removed the obsolete shared-types package.
- Updated composite documentation, environment examples, Docker configuration, and test layouts.

### Fixed

- Fixed schema casing so downstream atoms receive camelCase payloads.
- Fixed start/development scripts, test collection issues, and composite client/service bugs found while wiring the workflow.
- Fixed close-case and handle-breach test setup and added RabbitMQ testcontainer support.

## [0.3.0] - 2026-03-16 to 2026-03-22

### Added

- Added the case, auth, alert, appointment, assignment, resident, proof, and metrics atoms with database schemas, APIs, validation, and service-level tests.
- Added shared HTTP logging, RabbitMQ client support, event exchanges, queues, and routing keys.
- Added the initial reschedule-job composite implementation with unit and integration tests.
- Added Vitest configuration and broader TypeScript atom test coverage.

### Changed

- Converted the active atoms from the initial Python layout to TypeScript services using Drizzle and Hono-oriented shared packages.
- Moved Python shared utilities under the `townops_shared` namespace and removed the old shared database helper.
- Tightened Ruff and Vitest configuration and exposed a repository test script.

### Fixed

- No distinct user-facing bug fix was recorded in this week's diffs; the work was primarily additive and structural.

## [0.2.0] - 2026-03-09 to 2026-03-15

### Added

- Added the initial monorepo service layout with atom and composite packages, Dockerfiles, service READMEs, environment examples, infrastructure definitions, and placeholder frontend/tests.
- Added pnpm and uv workspaces, shared dependency management, centralized tooling, Husky hooks, and CI workflows.
- Added Python service tests plus shared logging, OpenTelemetry, and Pino/observability configuration.

### Changed

- Migrated Python services to SQLModel with direct database connectivity and pinned the project to Python 3.14.
- Replaced scattered formatter/linter setup with centralized tooling, shared dependency catalogs, CI caching, path filtering, and concurrency controls.
- Removed unused shared helpers and replaced the original build/test workflow with the consolidated CI pipeline.

### Fixed

- Fixed CI workspace collisions, ESLint path resolution, Ruff/Prettier formatting failures, pytest collection collisions, Drizzle dependency conflicts, and package-version mismatches.

## [0.1.0] - 2026-02-02 to 2026-02-08

### Added

- Added the initial repository structure and baseline `.gitignore`.
