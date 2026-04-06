# 🚀 Deployment & Local Setup

## Prerequisites

- [Bun](https://bun.sh/) >= 1.3
- [pnpm](https://pnpm.io/) >= 10
- PostgreSQL (via Supabase or local)
- RabbitMQ (via CloudAMQP or local)

## 1. Install Dependencies

```bash
pnpm install
```

## 2. ⚙️ Environment Variables

Each service has its own `.env` file. Copy from `.env.example` if present, or create from scratch.

### Atoms

| Variable       | Description                                     |
| :------------- | :---------------------------------------------- |
| `PORT`         | Port to listen on (see service map)             |
| `DATABASE_URL` | PostgreSQL connection string                    |
| `RABBITMQ_URL` | AMQP URL (e.g. `amqps://...@cloudamqp.com/...`) |
| `JWKS_URI`     | `http://localhost:5008/api/auth/jwks`           |

Alert atom additionally requires:

- `RESEND_API_KEY` — API key for email sending

Auth atom additionally requires:

- `BETTER_AUTH_SECRET` — secret for signing sessions
- `BETTER_AUTH_URL` — base URL of the auth service

### Composites

| Variable               | Description                                                                  |
| :--------------------- | :--------------------------------------------------------------------------- |
| `PORT`                 | Port to listen on                                                            |
| `RABBITMQ_URL`         | AMQP URL                                                                     |
| `CASE_ATOM_URL`        | `http://localhost:5001`                                                      |
| `ASSIGNMENT_ATOM_URL`  | `http://localhost:5003`                                                      |
| `APPOINTMENT_ATOM_URL` | `http://localhost:5004`                                                      |
| `PROOF_ATOM_URL`       | `http://localhost:5005`                                                      |
| `METRICS_ATOM_URL`     | `http://localhost:5007`                                                      |
| `RESIDENT_ATOM_URL`    | `http://localhost:5002`                                                      |
| `CONTRACTOR_API_URL`   | OutSystems Contractor API base URL                                           |
| `JWKS_URI`             | `http://localhost:5008/api/auth/jwks` _(only for browser-facing composites)_ |

### Frontends

| Variable                    | Description             |
| :-------------------------- | :---------------------- |
| `VITE_AUTH_URL`             | `http://localhost:5008` |
| `VITE_CASE_ATOM_URL`        | `http://localhost:5001` |
| `VITE_ASSIGNMENT_ATOM_URL`  | `http://localhost:5003` |
| `VITE_APPOINTMENT_ATOM_URL` | `http://localhost:5004` |
| `VITE_PROOF_ATOM_URL`       | `http://localhost:5005` |
| `VITE_ACCEPT_JOB_URL`       | `http://localhost:6003` |
| `VITE_CLOSE_CASE_URL`       | `http://localhost:6004` |
| `VITE_RESCHEDULE_JOB_URL`   | `http://localhost:6006` |
| `VITE_GOOGLE_MAPS_API_KEY`  | Google Maps API key     |

## 3. 🗄️ Database Setup

Run schema push for each atom (use `--force` to reset if needed):

```bash
pnpm --filter @townops/case-atom db:push
pnpm --filter @townops/resident-atom db:push
pnpm --filter @townops/assignment-atom db:push
pnpm --filter @townops/appointment-atom db:push
pnpm --filter @townops/proof-atom db:push
pnpm --filter @townops/alert-atom db:push
pnpm --filter @townops/metrics-atom db:push
pnpm --filter @townops/auth-atom db:push
```

Auth atom schema also requires pushing the better-auth schema:

```bash
pnpm --filter @townops/auth-atom auth:push
```

## 4. 🌱 Seed Users

Use the PowerShell scripts in `misc/` to create test accounts:

```powershell
# Create all 18 contractor accounts
powershell -File misc/signup-all-contractors.ps1

# Create officer account
powershell -File misc/signup-officer.ps1
```

Default credentials:

- Contractors: `<slug>@townops.dev` / `Contractor@123`
- Officer: `amk@townops.dev` / `Officer@123`

## 5. Start Services

```bash
# Start all services in development mode concurrently
pnpm run dev

# Or start individually
pnpm --filter @townops/case-atom dev
pnpm --filter @townops/open-case-composite dev
```

## 6. ✅ Verify

- Auth JWKS: `GET http://localhost:5008/api/auth/jwks` → `{ keys: [...] }`
- Service health: `GET http://localhost:<port>/health` → `{ status: "healthy" }`
- API explorer: `http://localhost:<port>/scalar`

## CI/CD

GitHub Actions workflows are in `.github/workflows/`:

- `deploy.yml` — production deployment
- `security-checks.yml` — dependency audits and secret scanning
