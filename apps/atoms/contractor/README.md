# Contractor Atom

A backend microservice (Atom) dedicated to managing contractor data — companies and individuals who perform municipal maintenance work. Owns contractor profiles, their service categories, and geographic sector coverage. Serves as the authoritative source for contractor search used by the assignment pipeline.

---

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **Framework**: [Hono](https://hono.dev/)
- **OpenAPI & Docs**: [hono-openapi](https://hono.dev/examples/hono-openapi) & [Scalar](https://hono.dev/examples/scalar)
- **Database ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Logging**: Pino via `@townops/shared-ts`
- **Testing**: [Vitest](https://vitest.dev/) with **Testcontainers**

---

## API Documentation

Once the server is running:

- **Scalar UI**: `http://localhost:5009/scalar`
- **OpenAPI JSON**: `http://localhost:5009/openapi`

---

## Endpoints

| Method | Path                                                    | Description                                      |
| ------ | ------------------------------------------------------- | ------------------------------------------------ |
| GET    | `/health`                                               | Health check                                     |
| GET    | `/api/contractors`                                      | List all contractors (with categories + sectors) |
| GET    | `/api/contractors/search?sectorCode=XX&categoryCode=YY` | Find active contractors for a sector + category  |
| GET    | `/api/contractors/:id`                                  | Get contractor by ID                             |
| POST   | `/api/contractors`                                      | Create contractor                                |
| PUT    | `/api/contractors/:id`                                  | Update contractor details                        |
| DELETE | `/api/contractors/:id`                                  | Deactivate contractor (soft delete)              |
| GET    | `/api/contractors/:id/categories`                       | List contractor's categories                     |
| POST   | `/api/contractors/:id/categories`                       | Add category                                     |
| DELETE | `/api/contractors/:id/categories/:code`                 | Remove category                                  |
| GET    | `/api/contractors/:id/sectors`                          | List contractor's sectors                        |
| POST   | `/api/contractors/:id/sectors`                          | Add sector                                       |
| DELETE | `/api/contractors/:id/sectors/:code`                    | Remove sector                                    |

### Category Codes

| Code | Description           |
| ---- | --------------------- |
| LE   | Electrical            |
| PL   | Plumbing              |
| LF   | Lift / Escalator      |
| LS   | Landscaping           |
| CL   | Cleaning              |
| PC   | Pest Control          |
| PG   | Playgrounds           |
| ID   | Interior / Decoration |
| PT   | Painting              |
| CW   | Civil Works           |
| FS   | Fire Safety           |
| RC   | Repairs / Restoration |
| SC   | Structural / Facade   |
| GN   | General / Multi-trade |

---

## Development Commands

| Command                | Description                             |
| ---------------------- | --------------------------------------- |
| `bun run dev`          | Start server with hot reload            |
| `bun run build`        | Bundle to `build/index.js`              |
| `bun run build:docker` | Build + create Docker image             |
| `bun run db:push`      | Push schema to database                 |
| `bun run test`         | Run integration tests (requires Docker) |

---

## Environment Setup

```env
DATABASE_URL=postgresql://townops:townops@localhost:5432/townops
PORT=5009
```

## Run Locally

```bash
bun install
bun run db:push
bun misc/seed-contractor-atom.ts   # seed the 18 initial contractors
bun run dev
```

## Run in Docker

```bash
bun run build:docker
docker run --env-file .env -p 5009:5009 contractor-atom
```
