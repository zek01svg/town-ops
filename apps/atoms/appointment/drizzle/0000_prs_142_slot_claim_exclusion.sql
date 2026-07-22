CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointment_status') THEN
    CREATE TYPE appointment_status AS ENUM (
      'scheduled', 'rescheduled', 'cancelled', 'missed', 'completed'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'appointment_slot_claim_status'
  ) THEN
    CREATE TYPE appointment_slot_claim_status AS ENUM ('HELD', 'ACTIVE', 'RELEASED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  case_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  attempt_id uuid,
  contractor_id uuid,
  operation_id text,
  slot_claim_id uuid,
  start_time timestamp with time zone NOT NULL,
  end_time timestamp with time zone NOT NULL,
  status appointment_status NOT NULL DEFAULT 'scheduled',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS attempt_id uuid,
  ADD COLUMN IF NOT EXISTS contractor_id uuid,
  ADD COLUMN IF NOT EXISTS operation_id text,
  ADD COLUMN IF NOT EXISTS slot_claim_id uuid;

CREATE INDEX IF NOT EXISTS idx_appointments_case ON appointments (case_id);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_operation_id_idx
  ON appointments (operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_slot_claim_id_idx
  ON appointments (slot_claim_id);

CREATE TABLE IF NOT EXISTS appointment_slot_claims (
  id uuid PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  operation_id text NOT NULL,
  case_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  start_time timestamp with time zone NOT NULL,
  end_time timestamp with time zone NOT NULL,
  status appointment_slot_claim_status NOT NULL DEFAULT 'HELD'
);

CREATE UNIQUE INDEX IF NOT EXISTS appointment_slot_claims_operation_id_idx
  ON appointment_slot_claims (operation_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'appointment_slot_claims_contractor_interval_excl'
  ) THEN
    ALTER TABLE appointment_slot_claims
      ADD CONSTRAINT appointment_slot_claims_contractor_interval_excl
      EXCLUDE USING gist (
        contractor_id WITH =,
        tstzrange(start_time, end_time, '[)') WITH &&
      )
      WHERE (status IN ('HELD', 'ACTIVE'));
  END IF;
END $$;
