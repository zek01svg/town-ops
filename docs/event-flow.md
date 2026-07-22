# Event flow and messaging

## Current Temporal Case orchestration

Case opening, Contractor allocation, and Contractor acceptance run through
Temporal rather than the AMQP chain below.

1. A browser sends a request to the Gateway with a user JWT and idempotency
   key.
2. The Gateway starts or updates the Case Workflow in Temporal.
3. The Worker performs atom activities with `WORKER_SERVICE_TOKEN` on internal
   routes.
4. For allocation acceptance, the Worker reserves an Appointment slot, accepts
   the current Allocation Attempt, and confirms the Appointment.
5. A permanent rejection after reservation releases the held slot; transient
   activity failures retry forward.

An overlap or invalid future interval creates no public Appointment and leaves
the Allocation Attempt pending.

## Existing AMQP flows

RabbitMQ (`townops.events`) remains for existing composite, notification, and
metrics flows. Its topic keys use `<entity>.<action>`.

| Event            | Publisher               | Consumer                | Effect                               |
| :--------------- | :---------------------- | :---------------------- | :----------------------------------- |
| `case.opened`    | Open Case composite     | Assign Job composite    | Existing allocation flow             |
| `job.assigned`   | Assign Job composite    | Alert atom              | Contractor notification              |
| `job.done`       | Close Case composite    | Metrics and Alert atoms | Performance and closure notification |
| `sla.breached`   | Existing SLA timer      | Handle Breach composite | Existing reassignment handling       |
| `case.escalated` | Handle Breach composite | Alert atom              | Officer notification                 |

AMQP consumers and other internal service routes must not require a user JWT.
They use their trusted internal integration instead.
