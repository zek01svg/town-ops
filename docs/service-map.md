# Service map

This is the active Compose topology. Service configuration and source code are
authoritative for exact routes and ports.

## Atoms

| Service                            | Port | Responsibility                             |
| :--------------------------------- | ---: | :----------------------------------------- |
| Auth                               | 5001 | Authentication and JWT/JWKS issuance       |
| Alert                              | 5002 | Derived Effect delivery ledger             |
| Appointment                        | 5003 | Appointments and Contractor slot claims    |
| Assignment                         | 5004 | Assignments and Allocation Attempts        |
| Case                               | 5005 | Cases, Case history, and Officer Attention |
| Performance Entry (`metrics-atom`) | 5006 | Contractor performance data                |
| Proof                              | 5007 | Completion evidence                        |
| Resident                           | 5008 | Resident profiles and property mapping     |
| Contractor                         | 5009 | Contractor profiles and eligibility        |

## Temporal orchestration

| Service     | Port | Responsibility                                          |
| :---------- | ---: | :------------------------------------------------------ |
| Gateway     | 6010 | Browser API, public `/api/auth/*`, and Workflow Updates |
| Worker      |    — | Temporal task queue and private atom Activities         |
| Temporal    | 7233 | Workflow server                                         |
| Temporal UI | 8080 | Local Workflow inspection                               |

The active Case path is Gateway → Temporal → Worker → private atoms. The
Worker has no public HTTP port, and frontends never reach atoms directly.

## Frontends

| App        | Compose port | Users       |
| :--------- | -----------: | :---------- |
| Officer    |         3001 | Officers    |
| Contractor |         3002 | Contractors |
| Resident   |         3003 | Residents   |

## Shared packages

| Package                           | Purpose                                                            |
| :-------------------------------- | :----------------------------------------------------------------- |
| `@townops/shared-ts`              | Shared observability, logging, and Worker authentication utilities |
| `@townops/ui`                     | Shared UI components and styling                                   |
| `@townops/orchestration-contract` | Gateway, Worker, and atom contracts for Case Workflows             |
