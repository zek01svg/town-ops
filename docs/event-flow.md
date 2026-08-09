# Case orchestration flow

1. A browser calls Gateway with its JWT and an idempotency key where required.
2. Gateway proxies public `/api/auth/*` to Auth; protected Case requests start
   or signal a Temporal Workflow.
3. Worker Activities call private atom routes with `WORKER_SERVICE_TOKEN`.
4. The Workflow preserves committed transitions and retries transient Activity
   failures. A permanent acceptance failure releases a held Appointment slot.
5. The Workflow queues Derived Effects. Alert records their delivery attempts,
   while the Performance Entry atom records idempotent score changes.

Acceptance reserves a slot, accepts the current Allocation Attempt, and
confirms the Appointment. An invalid interval creates no public Appointment.

The Workflow, not a browser request, enforces Acceptance SLA and Appointment
end-time timers. A breach returns the Case to `PENDING` and raises Officer
Attention; a missed Appointment remains recoverable through Reschedule.
