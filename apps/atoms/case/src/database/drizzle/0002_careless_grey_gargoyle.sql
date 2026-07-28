ALTER TYPE "public"."officer_attention_kind" ADD VALUE 'COMPLETION_FAILED';--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "completion_operation_id" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "completion_report" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "completion_proof_item_ids" jsonb;