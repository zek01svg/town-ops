# Event flow and messaging

## Current Temporal Case orchestration

Case opening, Contractor allocation, Contractor acceptance, completion, and
Acceptance SLA enforcement run through Temporal rather than the AMQP chain below.

1. A browser sends a request to the Gateway with a user JWT and idempotency
   key.
2. The Gateway starts or updates the Case Workflow in Temporal.
3. The Worker performs atom activities with `WORKER_SERVICE_TOKEN` on internal
   routes.
4. For allocation acceptance, the Worker reserves an Appointment slot, accepts
   the current Allocation Attempt, and confirms the Appointment.
5. A permanent rejection after reservation releases the held slot; transient
   activity failures retry forward.

Completion validates every selected ready Proof Item before writing, then runs
Appointment -> Assignment -> Case -> Metrics. The Metrics effect id is
`<assignmentId>/completion`, so retries record the `+10` reward once. A
permanent invariant failure after a committed transition raises Officer
Attention; it is not compensated through AMQP.

An overlap or invalid future interval creates no public Appointment and leaves
the Allocation Attempt pending.

Breach is timer-driven rather than browser-driven: an Allocation Attempt not
accepted before its own deadline breaches on the Case Workflow's timer, which
penalises the Contractor once, returns the Case to `PENDING`, raises Officer
Attention, and appends a replacement Attempt on the same Assignment. No AMQP
message is involved.

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
