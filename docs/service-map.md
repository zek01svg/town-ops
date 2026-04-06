# 🗺️ Service Map

Detailed list of all services in the TownOps ecosystem.

## ⚛️ Atomic Services (Port Range: 5001–5008)

| Service         | Port     | Responsibility                                   | Core Entity       | Path                     |
| :-------------- | :------- | :----------------------------------------------- | :---------------- | :----------------------- |
| **Case**        | 5001     | Maintenance case records and status transitions  | `cases`           | `apps/atoms/case`        |
| **Resident**    | 5002     | Citizen data and property mapping                | `residents`       | `apps/atoms/resident`    |
| **Assignment**  | 5003     | Contractor-to-case allocation                    | `assignments`     | `apps/atoms/assignment`  |
| **Appointment** | 5004     | Schedule management                              | `appointments`    | `apps/atoms/appointment` |
| **Proof**       | 5005     | Completion evidence (photos, signatures)         | `media`           | `apps/atoms/proof`       |
| **Alert**       | 5006     | Outgoing email/SMS notifications via Resend      | `alerts`          | `apps/atoms/alert`       |
| **Metrics**     | 5007     | SLA compliance and contractor performance scores | `metrics_log`     | `apps/atoms/metrics`     |
| **Auth**        | 5008     | User authentication, JWT issuance (better-auth)  | `user`, `session` | `apps/atoms/auth`        |
| **Contractor**  | External | Vendor profiles and service coverage             | External          | OutSystems Cloud         |

### Key Routes (Atoms)

| Atom        | Notable Routes                                                                                               |
| :---------- | :----------------------------------------------------------------------------------------------------------- |
| Case        | `GET /api/cases`, `POST /api/cases`, `PUT /api/cases/update-case-status`, `GET /api/cases/:id`               |
| Assignment  | `POST /api/assignments`, `PUT /api/assignments/:id/status`, `GET /api/assignments/contractor/:contractor_id` |
| Appointment | `POST /api/appointments`, `GET /api/appointments/:case_id`                                                   |
| Proof       | `POST /api/proof` (multipart), `POST /api/proof/batch`                                                       |
| Auth        | `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, `GET /api/auth/token`, `GET /api/auth/jwks`  |

## 🔗 Composite Services (Port Range: 6001–6006)

| Service            | Port | Primary Orchestration                                                                      | Path                             |
| :----------------- | :--- | :----------------------------------------------------------------------------------------- | :------------------------------- |
| **Open Case**      | 6001 | Resident lookup → Case creation → `case.opened` event                                      | `apps/composites/open-case`      |
| **Assign Job**     | 6002 | Consumes `case.opened` → Contractor selection → Assignment creation → `job.assigned` event | `apps/composites/assign-job`     |
| **Accept Job**     | 6003 | Assignment acceptance → Case status → Appointment creation                                 | `apps/composites/accept-job`     |
| **Close Case**     | 6004 | Proof storage → Case closure → `job.done` event                                            | `apps/composites/close-case`     |
| **Handle Breach**  | 6005 | Consumes `sla.breached` → Re-assignment → Case escalation → Metrics penalty                | `apps/composites/handle-breach`  |
| **Reschedule Job** | 6006 | Resident verification → New appointment slot → Case restoration                            | `apps/composites/reschedule-job` |

### Key Routes (Composites)

| Composite      | Route                                |
| :------------- | :----------------------------------- |
| Open Case      | `POST /api/cases/open-case`          |
| Accept Job     | `PUT /api/jobs/accept-job`           |
| Close Case     | `POST /api/cases/close-case`         |
| Handle Breach  | `PUT /api/assignments/handle-breach` |
| Reschedule Job | `POST /api/cases/reschedule-job`     |

All composites expose `/health`, `/openapi`, and `/scalar` (API explorer).

## 🖥️ Frontend Apps

| App            | Default Port | Users                                                                 | Path                       |
| :------------- | :----------- | :-------------------------------------------------------------------- | :------------------------- |
| **Contractor** | 4000         | Contractor staff — view assigned cases, acknowledge jobs, close cases | `apps/frontend/contractor` |
| **Officer**    | 4001         | Town council officers — create cases, monitor dashboard               | `apps/frontend/officer`    |
| **Resident**   | 4002         | Residents — reschedule appointments                                   | `apps/frontend/resident`   |

## 📦 Shared Packages

| Package                | Purpose                                                             | Path                 |
| :--------------------- | :------------------------------------------------------------------ | :------------------- |
| **@townops/shared-ts** | Pino logger, AMQP client, OTEL tracing, Sentry helpers, CORS config | `packages/shared-ts` |
| **@townops/ui**        | Shadcn/Radix UI components, theming                                 | `packages/ui`        |
