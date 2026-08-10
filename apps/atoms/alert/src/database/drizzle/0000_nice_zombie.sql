CREATE TYPE "public"."alert_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"recipient_id" uuid NOT NULL,
	"channel" "alert_channel" DEFAULT 'email' NOT NULL,
	"message" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now()
);
