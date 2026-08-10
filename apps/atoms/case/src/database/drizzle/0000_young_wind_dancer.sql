CREATE TYPE "public"."case_category" AS ENUM('LE', 'PL', 'LF', 'LS', 'CL', 'PC', 'PG', 'ID', 'PT', 'CW', 'FS', 'RC', 'SC', 'GN');--> statement-breakpoint
CREATE TYPE "public"."case_priority" AS ENUM('low', 'medium', 'high', 'emergency');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('pending', 'assigned', 'dispatched', 'in_progress', 'pending_resident_input', 'completed', 'cancelled', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."officer_attention_kind" AS ENUM('NO_ELIGIBLE_CONTRACTOR', 'ALLOCATION_FAILED', 'ACCEPTANCE_SLA_BREACH', 'WORK_START_FAILED');--> statement-breakpoint
CREATE TABLE "case_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"operation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "case_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resident_id" uuid NOT NULL,
	"category" "case_category" NOT NULL,
	"priority" "case_priority" DEFAULT 'medium' NOT NULL,
	"status" "case_status" DEFAULT 'pending' NOT NULL,
	"description" text,
	"address_details" text,
	"postal_code" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "officer_attention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" "officer_attention_kind" NOT NULL,
	"detail" text NOT NULL,
	"operation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_operation_id" text
);
--> statement-breakpoint
ALTER TABLE "case_history" ADD CONSTRAINT "case_history_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "officer_attention" ADD CONSTRAINT "officer_attention_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_history_operation_id_idx" ON "case_history" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "idx_cases_postal" ON "cases" USING btree ("postal_code" text_ops);--> statement-breakpoint
CREATE INDEX "idx_cases_resident" ON "cases" USING btree ("resident_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_cases_status" ON "cases" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "officer_attention_open_case_kind_idx" ON "officer_attention" USING btree ("case_id","kind") WHERE "officer_attention"."resolved_at" IS NULL;