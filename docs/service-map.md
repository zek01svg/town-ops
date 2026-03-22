# Service Map

Detailed list of all services in the TownOps ecosystem.

## Atomic Services (Port Range: 5001-5999)

| Service         | Responsibility                      | Core Entity      | Repository                |
| :-------------- | :---------------------------------- | :--------------- | :------------------------ |
| **Case**        | Internal maintenance records        | `cases`, `notes` | `/apps/atoms/case`        |
| **Resident**    | Citizen data and property mapping   | `residents`      | `/apps/atoms/resident`    |
| **Alert**       | Lifecycle notifications and SLAs    | `alerts`         | `/apps/atoms/alert`       |
| **Assignment**  | Workforce allocation                | `assignments`    | `/apps/atoms/assignment`  |
| **Appointment** | Schedule management                 | `appointments`   | `/apps/atoms/appointment` |
| **Proof**       | Attachments, photos, and signatures | `media`          | `/apps/atoms/proof`       |
| **Metrics**     | Performance and SLA analytics       | `metrics_log`    | `/apps/atoms/metrics`     |
| **Contractor**  | Vendor profiles & service coverage  | External         | OutSystems Cloud          |

## Composite Services (Port Range: 6001-6999)

| Service           | Primary Orchestration                             | Repository                        |
| :---------------- | :------------------------------------------------ | :-------------------------------- |
| **Open Case**     | Resident lookup -> Case creation -> Alert trigger | `/apps/composites/open-case`      |
| **Assign Job**    | Case status update -> Assignment creation         | `/apps/composites/assign-job`     |
| **Accept Job**    | Contractor auth -> Assignment modification        | `/apps/composites/accept-job`     |
| **Close Case**    | Final review -> Proof validation -> Close         | `/apps/composites/close-case`     |
| **Handle Breach** | SLA timeout -> Alert escalation                   | `/apps/composites/handle-breach`  |
| **Reschedule**    | Appointment modification -> Notification          | `/apps/composites/reschedule-job` |

## Shared Packages

| Package                              | Purpose                                | Repository                |
| :----------------------------------- | :------------------------------------- | :------------------------ |
| **@townops/shared-types**            | Centralized TypeScript definitions     | `/packages/shared-types`  |
| **@townops/shared-observability-ts** | Pino logging and OpenTelemetry tracing | `/packages/shared-ts`     |
| **@townops/ui-core**                 | React component library (Tailwind)     | `/packages/ui-core`       |
| **townops-shared-py**                | Common Python utilities (logging, MQ)  | `/packages/shared-python` |
