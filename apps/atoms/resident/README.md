# Resident atom

The Resident atom owns Resident profiles and property mapping. It owns its persistence and does not orchestrate workflows or call
other atoms. Private routes require `WORKER_SERVICE_TOKEN` from trusted
orchestration services.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5008/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/resident-atom db:migrate
pnpm --filter @townops/resident-atom dev
pnpm --filter @townops/resident-atom test
pnpm --filter @townops/resident-atom build
```
