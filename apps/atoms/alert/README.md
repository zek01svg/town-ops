# Alert atom

The Alert atom owns the Effect Ledger and records delivery attempts for Derived Effects. It owns its persistence and does not orchestrate workflows or call
other atoms. Private routes require `WORKER_SERVICE_TOKEN` from trusted
orchestration services.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5002/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/alert-atom db:migrate
pnpm --filter @townops/alert-atom dev
pnpm --filter @townops/alert-atom test
pnpm --filter @townops/alert-atom build
```
