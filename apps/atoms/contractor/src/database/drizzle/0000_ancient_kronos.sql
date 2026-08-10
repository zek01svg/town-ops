CREATE TABLE "contractor_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"category_code" varchar(10) NOT NULL,
	CONSTRAINT "uq_contractor_category" UNIQUE("contractor_id","category_code")
);
--> statement-breakpoint
CREATE TABLE "contractor_sectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"sector_code" varchar(5) NOT NULL,
	CONSTRAINT "uq_contractor_sector" UNIQUE("contractor_id","sector_code")
);
--> statement-breakpoint
CREATE TABLE "contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_num" varchar(20),
	"email" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contractors_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "contractor_categories" ADD CONSTRAINT "contractor_categories_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_sectors" ADD CONSTRAINT "contractor_sectors_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cat_contractor" ON "contractor_categories" USING btree ("contractor_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_cat_code" ON "contractor_categories" USING btree ("category_code" text_ops);--> statement-breakpoint
CREATE INDEX "idx_sector_contractor" ON "contractor_sectors" USING btree ("contractor_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_sector_code" ON "contractor_sectors" USING btree ("sector_code" text_ops);--> statement-breakpoint
CREATE INDEX "idx_contractors_email" ON "contractors" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "idx_contractors_active" ON "contractors" USING btree ("is_active");