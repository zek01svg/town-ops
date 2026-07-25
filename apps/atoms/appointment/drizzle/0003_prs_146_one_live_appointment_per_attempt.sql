-- PRS-146: an Attempt may own at most one live Appointment at a time.
--
-- Replacement retires the row it supersedes, which for a `scheduled` source
-- means `rescheduled` — and that alone stops it being replaced twice. A
-- `no_access` source deliberately keeps its status (AC5: the old Appointment
-- retains its NO_ACCESS outcome), so it stays eligible under the status guard
-- and a second replacement with a fresh operation ID would book a second live
-- Appointment, leaving an invisible slot claim holding the Contractor's
-- calendar. The database refuses that instead of relying on every caller
-- passing the current Appointment ID.
--
-- Legacy public-route rows carry a NULL attempt_id and are exempt: NULLs do
-- not collide in a unique index. Retired and terminal rows sit outside the
-- predicate, so existing history cannot violate this.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_one_live_per_attempt
  ON appointments (attempt_id)
  WHERE status IN ('scheduled', 'in_progress');
