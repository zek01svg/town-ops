-- PRS-145: Contractor start-work adds a new Appointment status.
-- ADD VALUE only — this migration never uses the new label in the same
-- transaction it is added in, so it is safe inside the runner's single tx.
ALTER TYPE appointment_status ADD VALUE IF NOT EXISTS 'in_progress';
