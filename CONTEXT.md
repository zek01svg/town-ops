# TownOps

TownOps manages resident-owned estate maintenance Cases from reporting through
contractor allocation, attendance, and completion.

## Language

### Participants

**Resident**:
A person to whom a Case belongs. A Resident or an Officer may originate the
Case, but every Case belongs to exactly one Resident.
_Avoid_: Requester, customer, tenant

**Officer**:
A town-council staff member who may originate and oversee Cases on behalf of
Residents.
_Avoid_: Administrator, admin

**Contractor**:
A service-provider organization or sole provider eligible to perform
maintenance work. People using TownOps for a Contractor act on its behalf.
_Avoid_: Worker, vendor

### Maintenance work

**Case**:
A resident-owned maintenance need recorded for allocation and completion.
_Avoid_: Service request, ticket, issue

**Job**:
The Contractor-facing view of a Case after it has been allocated. It is not a
separate domain entity.
_Avoid_: Using Job when Case, Assignment, or Appointment is meant precisely

**Assignment**:
A Case's allocation identity. It is created once and retained for the Case's
lifetime, including when the Case is reallocated. An Assignment names no
Contractor of its own; the Contractor is named by its Allocation Attempts.
_Avoid_: Job, Appointment, Allocation Attempt

**Allocation Attempt**:
One offer of a Case's Assignment to a specific Contractor, carrying its own
copied Acceptance SLA deadline and its own outcome. Reallocating a Case appends
a new Attempt rather than replacing the Assignment.
_Avoid_: Assignment, reassignment

**Appointment**:
A planned time interval for a Contractor to attend a Case under its Assignment.
A Case may have multiple Appointments after a Reschedule, of which at most one
is live at a time. Acceptance confirms an Appointment as SCHEDULED. A
Contractor starting work during that interval advances it to IN_PROGRESS —
after which the visit can no longer be reported as No Access, and PRS-148
(cancellation) guards against it too. An unattended SCHEDULED Appointment
becomes MISSED at its end time. It remains MISSED until a Reschedule recovers
the Case and preserves that outcome.
_Avoid_: Assignment, booking

**Reschedule**:
Replacing a Case's live Appointment with a new one at a Resident's or an
Officer's request, while the Assignment and its Allocation Attempt stand. The
replaced Appointment keeps its own outcome rather than being erased: a
proactive Reschedule retires it as RESCHEDULED, while one recovering from No
Access or a missed visit leaves it NO_ACCESS or MISSED. A Contractor cannot
Reschedule.
_Avoid_: Appointment replacement, rebooking, reassignment

**Proof Item**:
One before-work photo, after-work photo, or signature submitted as evidence that
a Case can be completed.
_Avoid_: Proof when referring to one item

### Eligibility

**Maintenance Category**:
A classification shared by a Case's required work and a Contractor's
capabilities.
_Avoid_: Category, service category

**Postal Sector**:
The geographic coverage unit identified by the first two digits of a Singapore
postal code.
_Avoid_: Sector, service area

### Exceptions and performance

**Acceptance SLA**:
The obligation for a Contractor to accept an Assignment before its response
deadline.
_Avoid_: SLA without naming the obligation

**Acceptance SLA Breach**:
A Contractor's failure to accept an Assignment before its Acceptance SLA
deadline.
_Avoid_: Generic SLA breach

**Escalation**:
The response to an Acceptance SLA Breach that reallocates the Assignment to
another eligible Contractor and flags the Case for Officer attention.
_Avoid_: Reassignment when no Officer attention is implied

**No Access**:
The condition in which a Contractor cannot enter the work location. The
Assignment remains active while the Case waits for Resident input and a new
Appointment.
_Avoid_: Cancellation, reassignment

**Performance Entry**:
A reasoned increase or decrease to a Contractor's performance score.
_Avoid_: Metric, score event

**Officer Attention**:
A durable review item raised for an Officer by a Case exception or a Derived
Effect delivery problem. The relevant recovery action resolves it; it is not a
generic notification.
_Avoid_: Alert, task, escalation when the specific condition is meant

### Derived effects

**Derived Effect**:
A side effect — an email notification or a Performance Entry — queued by a
Case Workflow transition and delivered independently through its own retry
ledger, rather than inline with the transition that queued it.
_Avoid_: Notification, side effect, alert, when the ledger entry itself is
meant

**Effect Ledger**:
The Alert atom's durable record of one Derived Effect's delivery attempts,
status, and repair history. It lives with the notification provider rather
than the Case atom: Case owns lifecycle truth, the Effect Ledger owns
provider delivery state.
_Avoid_: Outbox, queue, when the persisted record is meant rather than the
in-Workflow queue

**Waiver**:
An Officer's explicit decision to close a Derived Effect without delivery,
recorded with the acting Officer and a reason rather than silently discarded.
_Avoid_: Skip, dismiss, ignore

**Duplicate-Risk Acknowledgement**:
An Officer's explicit confirmation to retry a Derived Effect whose provider
deduplication window has expired, accepting that the retry may deliver
twice.
_Avoid_: Confirmation, override, without naming the duplicate-send risk
