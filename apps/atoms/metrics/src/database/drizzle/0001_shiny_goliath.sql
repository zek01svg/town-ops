ALTER TABLE "contractor_metrics" RENAME TO "performance_entries";--> statement-breakpoint
DROP INDEX "contractor_metrics_effect_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "performance_entries_effect_id_idx" ON "performance_entries" USING btree ("effect_id");