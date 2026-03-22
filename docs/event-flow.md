# Event Flow & Messaging

TownOps uses RabbitMQ to handle eventual consistency and business triggers that don't need to block the user.

## Core Message Flows

### 1. Case Lifecycle

- **Event**: `Case_Opened`
  - **Publisher**: `Open Case` (Composite)
  - **Consumers**:
    - `Assign Job` (Composite): Queries contractor availability and creates an assignment.

- **Event**: `Job_Assigned`
  - **Publisher**: `Assign Job` (Composite)
  - **Consumers**:
    - `Alert` (Atom): Notifies the assigned contractor.

### 2. SLA & Breach Management

- **Event**: `SLA_Breached`
  - **Publisher**: `Assignment` (Atom, via Delayed Queue / DLX timer)
  - **Consumer**:
    - `Handle Breach` (Composite): Triggers re-assignment, sets case to ESCALATED, and records metrics penalty.

- **Event**: `Notify_Escalated`
  - **Publisher**: `Handle Breach` (Composite)
  - **Consumer**:
    - `Alert` (Atom): Notifies officers of the escalation.

### 3. Case Closure

- **Event**: `Job_Done`
  - **Publisher**: `Close Case` (Composite)
  - **Consumers**:
    - `Metrics` (Atom): Records SLA compliance and performance score.
    - `Alert` (Atom): Sends final notifications.

## Exchange Configuration

- **Exchange**: `townops.events` (Topic)
- **Routing Keys**: `<entity>.<action>` (Mapped internally to event names)
  - Examples: `case.opened`, `job.assigned`, `sla.breached`

## Reliability Patterns

1. **SLA Timers (DLX for Delivery)**: Messages with an SLA TTL sit in temporary queues; if left unacknowledged, they route to a Dead Letter Exchange to trigger `SLA_Breached`.
2. **Error Handling DLX**: Messages failing processing 3 times move to `townops.dlx` for audit.
3. **Idempotency**: All consumers use unique event IDs to prevent duplicate processing.
