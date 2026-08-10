# ADR 0001: Use Temporal for Case orchestration

## Status

Accepted

## Context

Case work crosses atom-owned data, timers, and external delivery. The former
message-driven orchestration made recovery and lifecycle ownership unclear.

## Decision

1. Temporal is the sole orchestrator for Case lifecycle work.
2. Gateway is the browser boundary; Worker runs Workflows and calls private
   atom routes with `WORKER_SERVICE_TOKEN`. Gateway proxies public
   `/api/auth/*` to the Auth atom before JWT-protected Case routes apply.
3. Workflows recover forward. The only compensating action releases a held
   Appointment slot after a permanent acceptance failure.
4. RabbitMQ, AMQP, and dead-letter orchestration are removed from the active
   topology.
5. Temporal is self-hosted with its backing services, accepting that
   operational responsibility in exchange for private-network control.
6. The production cutover is a fresh reset, not an in-place migration of the
   retired topology.

## Consequences

- Atoms remain data owners and expose Worker-authenticated internal routes.
- Browser applications use Gateway URLs only.
- Workflow history and Temporal UI provide the operational record for durable
  Case progress.
