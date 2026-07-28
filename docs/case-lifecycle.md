# Case lifecycle

This document describes the implemented Temporal Case path through PRS-147 and
PRS-149.
Future lifecycle work remains specified in the Temporal orchestration plan.

## Implemented path

```mermaid
stateDiagram-v2
    [*] --> PENDING : Case opened
    PENDING --> ASSIGNED : Allocation Attempt committed
    ASSIGNED --> ASSIGNED : Current Attempt accepted and Appointment scheduled
    ASSIGNED --> PENDING : Acceptance SLA breach
    ASSIGNED --> PENDING_RESIDENT_INPUT : No Access
    PENDING_RESIDENT_INPUT --> ASSIGNED : Appointment replaced
    ASSIGNED --> ASSIGNED : Appointment replaced proactively or after MISSED
    IN_PROGRESS --> COMPLETED : Contractor completion with ready BEFORE/AFTER proof
```

Case status remains `ASSIGNED` after an Allocation Attempt is accepted. Work
start, No Access, rescheduling, missed-Appointment recovery, and completion
are separate follow-up behaviours; acceptance does not start work.

Completion is a forward-only Temporal Saga. It resolves selected ready Proof
Items that belong to the active Contractor and Case, requires at least one
`BEFORE` and one `AFTER` item, then transitions Appointment, Assignment, and
Case to `COMPLETED` before recording the idempotent `+10` performance entry.
An invariant failure after a prior transition commits raises
`COMPLETION_FAILED` Officer Attention; no completed transition is compensated.

An Attempt that is not accepted before its Acceptance SLA deadline breaches:
the Case returns to `PENDING`, one unresolved Officer Attention item is raised,
and a replacement Attempt is appended to the same Assignment. That attention
resolves when the replacement Attempt is accepted, or when the Case goes
terminal.

## Case statuses

| Status                   | Meaning on the Temporal path                                                   |
| :----------------------- | :----------------------------------------------------------------------------- |
| `PENDING`                | Case exists with no pending or accepted Allocation Attempt                     |
| `ASSIGNED`               | A Contractor is allocated; it remains this status after appointment scheduling |
| `IN_PROGRESS`            | Reserved for explicit work start                                               |
| `PENDING_RESIDENT_INPUT` | Reserved for recovery such as No Access                                        |
| `COMPLETED`              | Terminal Case state                                                            |
| `CANCELLED`              | Terminal Case state                                                            |

## Assignment and Allocation Attempts

Each Case has one stable Assignment. Reallocation appends an Allocation Attempt
instead of replacing that Assignment.

| Allocation Attempt status | Meaning                                                                |
| :------------------------ | :--------------------------------------------------------------------- |
| `PENDING_ACCEPTANCE`      | The linked Contractor may accept it before its Acceptance SLA deadline |
| `ACCEPTED`                | The Contractor accepted and one Appointment was scheduled              |
| `BREACHED`                | The Acceptance SLA elapsed without acceptance                          |
| `WITHDRAWN`               | A replacement allocation withdrew the pending offer                    |

## Appointment scheduling

The Appointment atom owns the public `SCHEDULED` Appointment and its internal
slot claim. A claim passes from `HELD` to `ACTIVE` when confirmation succeeds,
or to `RELEASED` when a permanent acceptance failure is compensated. PostgreSQL
prevents overlapping active intervals for one Contractor.

The CaseWorkflow durably tracks each SCHEDULED Appointment's end time. At its
end, an unattended Appointment becomes `MISSED` and raises one
`MISSED_APPOINTMENT` Officer Attention item. This changes neither the Case nor
its Assignment and records no performance entry or reallocation. An Officer
or the Resident recovers it through the ordinary Reschedule path: the old
Appointment remains `MISSED`, its active claim is released, a new `SCHEDULED`
Appointment is booked, and the attention resolves.
