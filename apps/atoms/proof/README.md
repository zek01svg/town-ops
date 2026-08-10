# Proof atom

The Proof atom owns Proof Items and their configured S3-compatible object storage. It owns its persistence and does not orchestrate workflows or call
other atoms. Private routes require `WORKER_SERVICE_TOKEN` from trusted
orchestration services.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5007/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/proof-atom db:migrate
pnpm --filter @townops/proof-atom dev
pnpm --filter @townops/proof-atom test
pnpm --filter @townops/proof-atom build
```
