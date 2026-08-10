CREATE TYPE "public"."derived_effect_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'UNKNOWN', 'WAIVED');--> statement-breakpoint
CREATE TYPE "public"."derived_effect_type" AS ENUM('EMAIL', 'PERFORMANCE_ENTRY');--> statement-breakpoint
CREATE TABLE "derived_effects" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"type" "derived_effect_type" NOT NULL,
	"purpose" text NOT NULL,
	"status" "derived_effect_status" DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb NOT NULL,
	"provider_id" text,
	"provider_idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp with time zone,
	"waiver_actor_id" uuid,
	"waiver_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "derived_effects_case_idx" ON "derived_effects" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "derived_effects_case_status_idx" ON "derived_effects" USING btree ("case_id","status");