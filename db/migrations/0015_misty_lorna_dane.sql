ALTER TABLE "organizations" ADD COLUMN "stella_monthly_quota" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stella_plan_label" varchar(100);