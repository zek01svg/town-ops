-- PRS-146: why this Appointment is in its current state.
--
-- Written by the Contractor reporting No Access on the row it marks, and by a
-- Reschedule on the *new* row it books — never on the one it retires, whose
-- created_at is that Appointment's original booking time.
--
-- Nullable: every Appointment booked by acceptance has no reason to give, and
-- so does every row that predates this column.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reason text;
