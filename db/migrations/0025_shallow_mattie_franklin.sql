CREATE TABLE "methodology_review_matrix" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"pipeline_step" varchar(50) NOT NULL,
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"readiness_score" integer,
	"overall_notes" text,
	"reviewer_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "methodology_review_matrix_project_step_unique" UNIQUE("project_id","pipeline_step"),
	CONSTRAINT "methodology_review_matrix_step_check" CHECK ("methodology_review_matrix"."pipeline_step" IN ('stakeholders', 'outcomes', 'indicators', 'evidence', 'proxies', 'narrative')),
	CONSTRAINT "methodology_review_matrix_status_check" CHECK ("methodology_review_matrix"."status" IN ('draft', 'reviewed', 'approved', 'flagged', 'archived')),
	CONSTRAINT "methodology_review_matrix_score_check" CHECK ("methodology_review_matrix"."readiness_score" IS NULL OR ("methodology_review_matrix"."readiness_score" >= 0 AND "methodology_review_matrix"."readiness_score" <= 100))
);
--> statement-breakpoint
CREATE TABLE "methodology_review_matrix_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"item_key" varchar(255) NOT NULL,
	"label" varchar(500) NOT NULL,
	"status" varchar(50) DEFAULT 'warning' NOT NULL,
	"severity" varchar(50) DEFAULT 'medium' NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "methodology_review_matrix_items_matrix_key_unique" UNIQUE("matrix_id","item_key"),
	CONSTRAINT "methodology_review_matrix_items_status_check" CHECK ("methodology_review_matrix_items"."status" IN ('pass', 'warning', 'fail', 'not_applicable')),
	CONSTRAINT "methodology_review_matrix_items_severity_check" CHECK ("methodology_review_matrix_items"."severity" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
ALTER TABLE "methodology_review_matrix" ADD CONSTRAINT "methodology_review_matrix_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix" ADD CONSTRAINT "methodology_review_matrix_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix" ADD CONSTRAINT "methodology_review_matrix_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix" ADD CONSTRAINT "methodology_review_matrix_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix" ADD CONSTRAINT "methodology_review_matrix_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix_items" ADD CONSTRAINT "methodology_review_matrix_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix_items" ADD CONSTRAINT "methodology_review_matrix_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix_items" ADD CONSTRAINT "methodology_review_matrix_items_matrix_id_methodology_review_matrix_id_fk" FOREIGN KEY ("matrix_id") REFERENCES "public"."methodology_review_matrix"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix_items" ADD CONSTRAINT "methodology_review_matrix_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_review_matrix_items" ADD CONSTRAINT "methodology_review_matrix_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_methodology_review_matrix_project_id" ON "methodology_review_matrix" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_methodology_review_matrix_items_matrix_id" ON "methodology_review_matrix_items" USING btree ("matrix_id");