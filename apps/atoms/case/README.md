# Case atom

The Case atom owns Cases, Case history, and Officer Attention. It owns its persistence and does not orchestrate workflows or call
other atoms. Private routes require `WORKER_SERVICE_TOKEN` from trusted
orchestration services.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5005/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/case-atom db:migrate
pnpm --filter @townops/case-atom dev
pnpm --filter @townops/case-atom test
pnpm --filter @townops/case-atom build
```
