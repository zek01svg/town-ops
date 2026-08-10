# @townops/shared-ts

Shared service utilities for TownOps atoms and frontends.

- OpenTelemetry setup and Sentry error capture
- Structured Pino logging and Hono request logging
- CORS origin helpers
- `workerAuth` middleware for private atom routes

Use it from a workspace dependency:

```json
"dependencies": {
  "@townops/shared-ts": "workspace:*"
}
```
