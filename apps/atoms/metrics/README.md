# Performance Entry atom

The Performance Entry domain capability is implemented by the `metrics-atom` package; it owns Contractor performance data. It owns its persistence and does not orchestrate workflows or call
other atoms. Private routes require `WORKER_SERVICE_TOKEN` from trusted
orchestration services.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5006/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/metrics-atom db:migrate
pnpm --filter @townops/metrics-atom dev
pnpm --filter @townops/metrics-atom test
pnpm --filter @townops/metrics-atom build
```
