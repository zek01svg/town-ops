# Appointment atom

The Appointment atom owns Appointments and Contractor slot claims. It owns its persistence and does not orchestrate workflows or call
other atoms. Private routes require `WORKER_SERVICE_TOKEN` from trusted
orchestration services.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5003/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/appointment-atom db:migrate
pnpm --filter @townops/appointment-atom dev
pnpm --filter @townops/appointment-atom test
pnpm --filter @townops/appointment-atom build
```
