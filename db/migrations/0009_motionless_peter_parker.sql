CREATE TABLE "project_investments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"amount" varchar(255) NOT NULL,
	"currency" varchar(10) NOT NULL,
	"year" integer,
	"description" text,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_investments_amount_check" CHECK (cast(nullif("project_investments"."amount", '') as numeric) > 0),
	CONSTRAINT "project_investments_status_check" CHECK ("project_investments"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "sroi_assignment_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"quantity" varchar(255) NOT NULL,
	"unit" varchar(50) NOT NULL,
	"year" integer,
	"notes" text,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sroi_assignment_inputs_quantity_check" CHECK (cast(nullif("sroi_assignment_inputs"."quantity", '') as numeric) > 0),
	CONSTRAINT "sroi_assignment_inputs_status_check" CHECK ("sroi_assignment_inputs"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "sroi_calculation_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"gross_value" varchar(255),
	"net_value" varchar(255),
	"year" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sroi_calculation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"total_investment" varchar(255),
	"total_value" varchar(255),
	"sroi_ratio" varchar(255),
	"run_date" timestamp DEFAULT now() NOT NULL,
	"status" varchar(50) DEFAULT 'completed' NOT NULL,
	"run_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sroi_calculation_runs_status_check" CHECK ("sroi_calculation_runs"."status" IN ('completed', 'failed', 'pending'))
);
--> statement-breakpoint
CREATE TABLE "sroi_filter_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"deadweight_pct" varchar(255),
	"displacement_pct" varchar(255),
	"attribution_pct" varchar(255),
	"dropoff_pct" varchar(255),
	"duration_years" integer,
	"justification" text,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sroi_filter_sets_deadweight_pct_check" CHECK (cast(nullif("sroi_filter_sets"."deadweight_pct", '') as numeric) >= 0 AND cast(nullif("sroi_filter_sets"."deadweight_pct", '') as numeric) <= 100),
	CONSTRAINT "sroi_filter_sets_displacement_pct_check" CHECK (cast(nullif("sroi_filter_sets"."displacement_pct", '') as numeric) >= 0 AND cast(nullif("sroi_filter_sets"."displacement_pct", '') as numeric) <= 100),
	CONSTRAINT "sroi_filter_sets_attribution_pct_check" CHECK (cast(nullif("sroi_filter_sets"."attribution_pct", '') as numeric) >= 0 AND cast(nullif("sroi_filter_sets"."attribution_pct", '') as numeric) <= 100),
	CONSTRAINT "sroi_filter_sets_dropoff_pct_check" CHECK (cast(nullif("sroi_filter_sets"."dropoff_pct", '') as numeric) >= 0 AND cast(nullif("sroi_filter_sets"."dropoff_pct", '') as numeric) <= 100),
	CONSTRAINT "sroi_filter_sets_duration_years_check" CHECK ("sroi_filter_sets"."duration_years" >= 1 AND "sroi_filter_sets"."duration_years" <= 50),
	CONSTRAINT "sroi_filter_sets_status_check" CHECK ("sroi_filter_sets"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "project_investments" ADD CONSTRAINT "project_investments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_investments" ADD CONSTRAINT "project_investments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_investments" ADD CONSTRAINT "project_investments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_assignment_inputs" ADD CONSTRAINT "sroi_assignment_inputs_assignment_id_outcome_proxy_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."outcome_proxy_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_assignment_inputs" ADD CONSTRAINT "sroi_assignment_inputs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_assignment_inputs" ADD CONSTRAINT "sroi_assignment_inputs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_calculation_line_items" ADD CONSTRAINT "sroi_calculation_line_items_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_calculation_line_items" ADD CONSTRAINT "sroi_calculation_line_items_assignment_id_outcome_proxy_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."outcome_proxy_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_calculation_line_items" ADD CONSTRAINT "sroi_calculation_line_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ADD CONSTRAINT "sroi_calculation_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ADD CONSTRAINT "sroi_calculation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ADD CONSTRAINT "sroi_calculation_runs_run_by_users_id_fk" FOREIGN KEY ("run_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_filter_sets" ADD CONSTRAINT "sroi_filter_sets_assignment_id_outcome_proxy_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."outcome_proxy_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_filter_sets" ADD CONSTRAINT "sroi_filter_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sroi_filter_sets" ADD CONSTRAINT "sroi_filter_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;