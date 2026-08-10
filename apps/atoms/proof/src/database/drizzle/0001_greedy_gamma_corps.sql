ALTER TABLE "proof_items" ADD COLUMN "contractor_id" uuid;--> statement-breakpoint
ALTER TABLE "proof_items" ADD COLUMN "operation_id" text;--> statement-breakpoint
ALTER TABLE "proof_items" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "proof_items" ADD COLUMN "checksum" text;--> statement-breakpoint
ALTER TABLE "proof_items" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "proof_items_operation_id_idx" ON "proof_items" USING btree ("operation_id");