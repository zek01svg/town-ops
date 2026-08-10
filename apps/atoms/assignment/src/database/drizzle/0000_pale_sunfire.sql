CREATE TYPE "public"."allocation_attempt_status" AS ENUM('PENDING_ACCEPTANCE', 'ACCEPTED', 'BREACHED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."assignment_source" AS ENUM('AUTO_ASSIGN', 'MANUAL_ASSIGN', 'BREACH_REASSIGN');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('PENDING_ACCEPTANCE', 'ACCEPTED', 'IN_PROGRESS', 'BREACHED', 'REASSIGNED', 'CANCELLED', 'COMPLETED');--> statement-breakpoint
CREATE TABLE "allocation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"contractor_id" uuid NOT NULL,
	"source" "assignment_source" NOT NULL,
	"status" "allocation_attempt_status" DEFAULT 'PENDING_ACCEPTANCE' NOT NULL,
	"acceptance_sla_ms" integer NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"reason" text,
	"operation_id" text NOT NULL,
	"acceptance_operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocation_epoch" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"from_status" "assignment_status",
	"to_status" "assignment_status" NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"contractor_id" uuid,
	"status" "assignment_status" DEFAULT 'PENDING_ACCEPTANCE' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_due_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"source" "assignment_source",
	"reassigned_from_assignment_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocation_attempts" ADD CONSTRAINT "allocation_attempts_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_status_history" ADD CONSTRAINT "assignment_status_history_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_reassigned_from_assignment_id_fkey" FOREIGN KEY ("reassigned_from_assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_attempts_operation_id_idx" ON "allocation_attempts" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_attempts_acceptance_operation_id_idx" ON "allocation_attempts" USING btree ("acceptance_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_case_id_idx" ON "assignments" USING btree ("case_id");