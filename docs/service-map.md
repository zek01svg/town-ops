# Service map

This is the current Compose service map. For exact routes, use each service's
OpenAPI/Scalar endpoint or source; route ownership changes more often than this
topology.

## Atoms

| Service     | Port | Responsibility                                                |
| :---------- | ---: | :------------------------------------------------------------ |
| Auth        | 5001 | Authentication and JWT/JWKS issuance                          |
| Alert       | 5002 | Notification delivery                                         |
| Appointment | 5003 | Appointments and internal Contractor slot claims              |
| Assignment  | 5004 | Stable Assignments, Allocation Attempts, and allocation epoch |
| Case        | 5005 | Cases, Case history, and Officer Attention                    |
| Metrics     | 5006 | Contractor performance data                                   |
| Proof       | 5007 | Completion evidence                                           |
| Resident    | 5008 | Resident profiles and property mapping                        |
| Contractor  | 5009 | Contractor data and eligibility inputs                        |

## Temporal orchestration

| Service     | Port | Responsibility                                                           |
| :---------- | ---: | :----------------------------------------------------------------------- |
| Gateway     | 6010 | Browser API for Temporal Case queries, proof, and Updates                |
| Worker      |    — | Runs the `townops-orchestration` Temporal task queue and completion Saga |
| Temporal    | 7233 | Workflow server                                                          |
| Temporal UI | 8080 | Local Workflow inspection                                                |

The current Case path is Gateway → Temporal → Worker → atoms. The Worker has
no public HTTP port.

## Existing composite services

| Service          | Port | Responsibility                       |
| :--------------- | ---: | :----------------------------------- |
| Open Case        | 6001 | Existing AMQP-backed Case opening    |
| Assign Job       | 6002 | Existing Contractor allocation       |
| Accept Job       | 6003 | Existing assignment-acceptance flow  |
| Close Case       | 6004 | Existing proof and Case closure flow |
| Handle Breach    | 6005 | Existing acceptance-SLA handling     |
| Reschedule Job   | 6006 | Existing rescheduling flow           |
| Handle No Access | 6007 | Existing No Access flow              |

## Frontends

| App        | Compose port | Users       |
| :--------- | -----------: | :---------- |
| Officer    |         3001 | Officers    |
| Contractor |         3002 | Contractors |
| Resident   |         3003 | Residents   |

## Shared packages

| Package                           | Purpose                                                  |
| :-------------------------------- | :------------------------------------------------------- |
| `@townops/shared-ts`              | Shared service utilities and authentication middleware   |
| `@townops/ui`                     | Shared UI components and styling                         |
| `@townops/orchestration-contract` | Gateway/Worker/atom contracts for the Temporal Case path |
