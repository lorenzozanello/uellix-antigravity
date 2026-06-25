CREATE TABLE "financial_proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"source_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"proxy_type" varchar(100),
	"country" varchar(2),
	"territory" varchar(255),
	"currency" varchar(10),
	"value" varchar(255),
	"unit" varchar(50),
	"reference_year" integer,
	"thematic_area" varchar(255),
	"methodology" text,
	"confidence_level" varchar(50),
	"methodological_risk" varchar(50),
	"review_status" varchar(50) DEFAULT 'suggested' NOT NULL,
	"reviewer_id" uuid,
	"reviewed_at" timestamp,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "confidence_level_check" CHECK ("financial_proxies"."confidence_level" IN ('high', 'medium', 'low')),
	CONSTRAINT "methodological_risk_check" CHECK ("financial_proxies"."methodological_risk" IN ('low', 'medium', 'high')),
	CONSTRAINT "review_status_check" CHECK ("financial_proxies"."review_status" IN ('suggested', 'pending_review', 'approved', 'rejected', 'archived')),
	CONSTRAINT "approved_proxy_check" CHECK ("financial_proxies"."review_status" != 'approved' OR ("financial_proxies"."value" IS NOT NULL AND "financial_proxies"."currency" IS NOT NULL AND "financial_proxies"."unit" IS NOT NULL AND "financial_proxies"."reference_year" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "outcome_proxy_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"proxy_id" uuid NOT NULL,
	"justification" text,
	"territorial_adjustment_notes" text,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxy_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"url" text,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financial_proxies" ADD CONSTRAINT "financial_proxies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxies" ADD CONSTRAINT "financial_proxies_source_id_proxy_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."proxy_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxies" ADD CONSTRAINT "financial_proxies_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxies" ADD CONSTRAINT "financial_proxies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD CONSTRAINT "outcome_proxy_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD CONSTRAINT "outcome_proxy_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD CONSTRAINT "outcome_proxy_assignments_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD CONSTRAINT "outcome_proxy_assignments_proxy_id_financial_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."financial_proxies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD CONSTRAINT "outcome_proxy_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_sources" ADD CONSTRAINT "proxy_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_sources" ADD CONSTRAINT "proxy_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;