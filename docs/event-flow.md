# 📨 Event Flow & Messaging

TownOps uses RabbitMQ (via CloudAMQP) for eventual consistency and asynchronous business triggers.

## Exchange & Routing

- **Exchange**: `townops.events` (topic)
- **Routing key format**: `<entity>.<action>` — e.g., `case.opened`, `job.assigned`

## Event Catalogue

### 1. Case Lifecycle

**`case.opened`**

- Publisher: Open Case composite (after successful case creation)
- Consumer: Assign Job composite (`assign-job-queue`)
- Payload: `{ caseId, residentId, category, priority, postalCode, addressDetails, description }`
- Effect: Triggers contractor search and assignment creation

**`job.assigned`**

- Publisher: Assign Job composite (after assignment created)
- Consumer: Alert atom
- Payload: `{ assignmentId, caseId, contractorId, contractorName, contractorEmail, contractorContact, status, email }`
- Effect: Sends notification email to the contractor company

**`job.done`**

- Publisher: Close Case composite (after case closed)
- Consumers: Metrics atom, Alert atom
- Payload: `{ caseId, uploaderId }`
- Effect: Records SLA compliance score; sends closure notification

### 2. ⚠️ SLA Breach

**`sla.breached`**

- Publisher: SLA timer queue (DLX — dead-lettered after TTL expires with no acknowledgement)
- Consumer: Handle Breach composite (`handle-breach-queue`)
- Payload: `{ assignment_id, case_id, contractor_id }`
- Effect: Escalates case, reassigns to backup contractor, records penalty in Metrics

**`case.escalated`**

- Publisher: Handle Breach composite (after successful re-assignment)
- Consumer: Alert atom
- Payload: `{ caseId, assignmentId, newWorkerId, message }`
- Effect: Notifies officers of SLA escalation

### 3. No Access / Rescheduling

**`case.no_access`** _(planned — Scenario 3)_

- Publisher: Handle No Access composite
- Consumer: Alert atom
- Payload: `{ caseId, contractorId }`
- Effect: Alerts resident to reschedule

## ⏱️ SLA Timer (DLX) Pattern

When a job is assigned, the Assign Job composite publishes a TTL message to `sla-timers-queue`. If the contractor does not acknowledge within the SLA window (15 seconds in demo, 5 minutes in production), RabbitMQ dead-letters the message to `handle-breach-queue`, automatically triggering the Handle Breach composite.

```
assign-job-queue consumer
  → createAssignment()
  → publish to sla-timers-queue (TTL = 15s)
                    ↓ (on expiry, no acknowledgement)
           dead-letter → handle-breach-queue
                    ↓
        handleSlaBreach() consumer
```

## Reliability

- **Non-fatal events**: `job.done` publish failures in Close Case are caught and logged — they do not fail the HTTP response.
- **Consumer error handling**: AMQP message parse failures are logged and skipped (no requeue to avoid infinite loops).
- **Service-to-service calls inside consumers**: No Authorization header is passed — JWK middleware must not be applied to atom/composite routes called by AMQP consumers.
