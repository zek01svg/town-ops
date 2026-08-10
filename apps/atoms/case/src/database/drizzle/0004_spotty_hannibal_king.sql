ALTER TYPE "public"."officer_attention_kind" ADD VALUE 'DERIVED_EFFECT_UNKNOWN';--> statement-breakpoint
DROP INDEX "officer_attention_open_case_kind_idx";--> statement-breakpoint
ALTER TABLE "officer_attention" ADD COLUMN "effect_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "officer_attention_open_effect_idx" ON "officer_attention" USING btree ("case_id","kind","effect_id") WHERE "officer_attention"."resolved_at" IS NULL AND "officer_attention"."effect_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "officer_attention_open_case_kind_idx" ON "officer_attention" USING btree ("case_id","kind") WHERE "officer_attention"."resolved_at" IS NULL AND "officer_attention"."effect_id" IS NULL;