CREATE TYPE "public"."proof_type" AS ENUM('before', 'after', 'signature');--> statement-breakpoint
CREATE TABLE "proof_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"media_url" text NOT NULL,
	"type" "proof_type" NOT NULL,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now()
);
