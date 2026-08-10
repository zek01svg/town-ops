-- btree_gist and the exclusion constraint below are hand-added: drizzle-kit
-- cannot generate CREATE EXTENSION or an EXCLUDE constraint, so they live here
-- rather than in schema.ts. A future db:generate diffs schema.ts against the
-- meta snapshot, which does not track them, so it leaves them alone.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TYPE "public"."appointment_slot_claim_status" AS ENUM('HELD', 'ACTIVE', 'RELEASED');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'in_progress', 'no_access', 'rescheduled', 'cancelled', 'missed', 'completed');--> statement-breakpoint
CREATE TABLE "appointment_slot_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" text NOT NULL,
	"case_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"contractor_id" uuid NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"status" "appointment_slot_claim_status" DEFAULT 'HELD' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"attempt_id" uuid,
	"contractor_id" uuid,
	"operation_id" text,
	"slot_claim_id" uuid,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_slot_claims_operation_id_idx" ON "appointment_slot_claims" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "idx_appointments_case" ON "appointments" USING btree ("case_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_operation_id_idx" ON "appointments" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_slot_claim_id_idx" ON "appointments" USING btree ("slot_claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_one_live_per_attempt" ON "appointments" USING btree ("attempt_id") WHERE "appointments"."status" IN ('scheduled', 'in_progress');--> statement-breakpoint
-- Hand-added (see header): a Contractor cannot hold two overlapping HELD/ACTIVE
-- slot claims. Half-open [start, end) so back-to-back intervals do not collide.
ALTER TABLE "appointment_slot_claims"
	ADD CONSTRAINT "appointment_slot_claims_contractor_interval_excl"
	EXCLUDE USING gist (
		contractor_id WITH =,
		tstzrange(start_time, end_time, '[)') WITH &&
	)
	WHERE (status IN ('HELD', 'ACTIVE'));