# TownOps

TownOps is a monorepo for resident-owned estate maintenance Cases. It uses pnpm workspaces and Turborepo, Bun and Hono for services, and React and Vite for the role-specific frontends.

## Repository guide

### Architecture boundaries

- `apps/atoms/` are data owners: each owns its persistence and must not orchestrate workflows or call other TownOps atoms.
- `apps/composites/` are stateless business orchestrators that coordinate atoms over HTTP and publish or consume AMQP events.
- `apps/frontend/` contains the Officer, Contractor, and Resident applications.
- `packages/` contains shared TypeScript utilities and UI. Reuse `@townops/shared-ts` and `@townops/ui` before adding app-local duplicates.
- Do not apply user JWT middleware to internal routes invoked by AMQP consumers.

### Sources of truth

- Use the exact domain vocabulary in `CONTEXT.md`.
- Read only the task-relevant architecture, service-map, event-flow, lifecycle, deployment, and ADR documentation under `docs/`.
- For versions, ports, scripts, and current behavior, source code, manifests, and service configuration override prose documentation.
- Never commit or expose `.env` files or secrets; use `.env.example` for variable names.

### Commands

- Install: `pnpm install --frozen-lockfile`
- Develop all workspaces: `pnpm dev`
- Format check: `pnpm format:check`
- Lint: `pnpm lint:js`
- Workspace tests: `pnpm test`
- Build: `pnpm build`
- Scoped work: `pnpm --filter <workspace-package> <script>`
- Integration tests: `pnpm test:integration` (requires Docker for Testcontainers)
- End-to-end tests: `pnpm test:e2e` (requires the stack running and root `.env`; scenarios run sequentially because they share state)

## Agent skills

### Issue tracker

Issues live in Linear's `town-ops` project in the `Personal` team via the connected Linear MCP. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default five triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` and relevant entries in `docs/adr/` when that directory exists. See `docs/agents/domain.md`.

## Workflow Orchestration

### 1. Plan Mode Default

- Ask the user to toggle to/enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy

- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution
- For new features/requirements, run the `builder` → `tester` → `reviewer` subagent pipeline

### 3. Self-Improvement Loop

- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done

- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to the plan
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
