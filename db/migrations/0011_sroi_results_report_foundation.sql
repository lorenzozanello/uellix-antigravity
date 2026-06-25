CREATE TABLE IF NOT EXISTS "sroi_run_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"calculation_run_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"readiness_score" integer,
	"overall_notes" text,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sroi_run_reviews_status_check" CHECK ("sroi_run_reviews"."status" IN ('draft', 'reviewed', 'approved', 'flagged', 'archived')),
	CONSTRAINT "sroi_run_reviews_score_check" CHECK ("sroi_run_reviews"."readiness_score" >= 0 AND "sroi_run_reviews"."readiness_score" <= 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sroi_run_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"item_key" varchar(255) NOT NULL,
	"status" varchar(50) DEFAULT 'warning' NOT NULL,
	"severity" varchar(50) DEFAULT 'medium' NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sroi_run_review_items_status_check" CHECK ("sroi_run_review_items"."status" IN ('pass', 'warning', 'fail', 'not_applicable')),
	CONSTRAINT "sroi_run_review_items_severity_check" CHECK ("sroi_run_review_items"."severity" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sroi_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"calculation_run_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"summary" text,
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"locked_by" uuid,
	"locked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sroi_reports_status_check" CHECK ("sroi_reports"."status" IN ('draft', 'under_review', 'locked', 'archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sroi_report_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"section_type" varchar(100) NOT NULL,
	"title" varchar(255) NOT NULL,
	"content" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sroi_report_sections_sort_order_check" CHECK ("sroi_report_sections"."sort_order" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_reviews" ADD CONSTRAINT "sroi_run_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_reviews" ADD CONSTRAINT "sroi_run_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_reviews" ADD CONSTRAINT "sroi_run_reviews_calculation_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_reviews" ADD CONSTRAINT "sroi_run_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_reviews" ADD CONSTRAINT "sroi_run_reviews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_reviews" ADD CONSTRAINT "sroi_run_reviews_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_review_items" ADD CONSTRAINT "sroi_run_review_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_review_items" ADD CONSTRAINT "sroi_run_review_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_review_items" ADD CONSTRAINT "sroi_run_review_items_review_id_sroi_run_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."sroi_run_reviews"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_review_items" ADD CONSTRAINT "sroi_run_review_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_run_review_items" ADD CONSTRAINT "sroi_run_review_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_reports" ADD CONSTRAINT "sroi_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_reports" ADD CONSTRAINT "sroi_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_reports" ADD CONSTRAINT "sroi_reports_calculation_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_reports" ADD CONSTRAINT "sroi_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_reports" ADD CONSTRAINT "sroi_reports_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_reports" ADD CONSTRAINT "sroi_reports_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_report_sections" ADD CONSTRAINT "sroi_report_sections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_report_sections" ADD CONSTRAINT "sroi_report_sections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_report_sections" ADD CONSTRAINT "sroi_report_sections_report_id_sroi_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."sroi_reports"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_report_sections" ADD CONSTRAINT "sroi_report_sections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sroi_report_sections" ADD CONSTRAINT "sroi_report_sections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
