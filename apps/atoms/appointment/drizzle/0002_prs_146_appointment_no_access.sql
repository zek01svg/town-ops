-- PRS-146: a Contractor reporting No Access adds a new Appointment status.
-- ('rescheduled' already exists from 0000.)
-- ADD VALUE only — this migration never uses the new label in the same
-- transaction it is added in, so it is safe inside the runner's single tx.
ALTER TYPE appointment_status ADD VALUE IF NOT EXISTS 'no_access';
