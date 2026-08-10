# Auth atom

The Auth atom owns authentication identities and issues JWTs and JWKS. Its
public browser routes are exposed only by Gateway at `/api/auth/*`.

## Local development

Copy this directory's `.env.example` to a local `.env`; never commit it.
The service health endpoint is `http://localhost:5001/health`.

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/auth-atom db:migrate
pnpm --filter @townops/auth-atom dev
pnpm --filter @townops/auth-atom test
pnpm --filter @townops/auth-atom build
```

Use `pnpm --filter @townops/auth-atom auth:generate` only when changing the
Better Auth configuration that requires regenerated code.
