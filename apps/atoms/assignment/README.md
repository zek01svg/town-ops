# Assignment atom

The Assignment atom owns stable Assignments and their Allocation Attempts. It owns its persistence and does not orchestrate workflows or call
other atoms. Private routes require `WORKER_SERVICE_TOKEN` from trusted
orchestration services.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5004/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/assignment-atom db:migrate
pnpm --filter @townops/assignment-atom dev
pnpm --filter @townops/assignment-atom test
pnpm --filter @townops/assignment-atom build
```
