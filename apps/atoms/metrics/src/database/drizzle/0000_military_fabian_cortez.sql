CREATE TABLE "contractor_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"score_delta" integer NOT NULL,
	"reason" text NOT NULL,
	"effect_id" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "contractor_metrics_effect_id_idx" ON "contractor_metrics" USING btree ("effect_id");