ALTER TABLE "organizations" ADD COLUMN "logo_url" varchar(255);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "brand_color" varchar(7);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "white_label_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sroi_reports" ADD COLUMN "verification_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "sroi_reports" ADD CONSTRAINT "sroi_reports_verification_hash_unique" UNIQUE("verification_hash");