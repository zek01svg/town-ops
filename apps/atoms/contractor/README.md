# Contractor atom

The Contractor atom owns Contractor profiles, capabilities, and eligibility data. It owns its persistence and does not orchestrate workflows or call
other atoms. Private routes require `WORKER_SERVICE_TOKEN` from trusted
orchestration services.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5009/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/contractor-atom db:migrate
pnpm --filter @townops/contractor-atom dev
pnpm --filter @townops/contractor-atom test
pnpm --filter @townops/contractor-atom build
```
