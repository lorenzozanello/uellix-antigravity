CREATE TABLE "outcome_taxonomy_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"taxonomy_code_id" uuid NOT NULL,
	"mapping_confidence" varchar(20) DEFAULT 'medium' NOT NULL,
	"rationale" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_taxonomy_mappings_outcome_code_unique" UNIQUE("outcome_id","taxonomy_code_id"),
	CONSTRAINT "outcome_taxonomy_mappings_confidence_check" CHECK ("outcome_taxonomy_mappings"."mapping_confidence" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "taxonomy_catalogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(50) NOT NULL,
	"source_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "taxonomy_catalogs_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "taxonomy_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"label" varchar(500) NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "taxonomy_codes_catalog_code_unique" UNIQUE("catalog_id","code")
);
--> statement-breakpoint
ALTER TABLE "outcome_taxonomy_mappings" ADD CONSTRAINT "outcome_taxonomy_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_taxonomy_mappings" ADD CONSTRAINT "outcome_taxonomy_mappings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_taxonomy_mappings" ADD CONSTRAINT "outcome_taxonomy_mappings_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_taxonomy_mappings" ADD CONSTRAINT "outcome_taxonomy_mappings_taxonomy_code_id_taxonomy_codes_id_fk" FOREIGN KEY ("taxonomy_code_id") REFERENCES "public"."taxonomy_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_taxonomy_mappings" ADD CONSTRAINT "outcome_taxonomy_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_codes" ADD CONSTRAINT "taxonomy_codes_catalog_id_taxonomy_catalogs_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."taxonomy_catalogs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outcome_taxonomy_mappings_outcome_id" ON "outcome_taxonomy_mappings" USING btree ("outcome_id");--> statement-breakpoint
CREATE INDEX "idx_outcome_taxonomy_mappings_organization_id" ON "outcome_taxonomy_mappings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_taxonomy_codes_catalog_id" ON "taxonomy_codes" USING btree ("catalog_id");