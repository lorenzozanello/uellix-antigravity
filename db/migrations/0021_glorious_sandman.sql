CREATE TABLE "theory_of_change_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"assumption" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "theory_of_change_links_status_check" CHECK ("theory_of_change_links"."status" IN ('active', 'archived')),
	CONSTRAINT "theory_of_change_links_no_self_check" CHECK ("theory_of_change_links"."from_node_id" != "theory_of_change_links"."to_node_id")
);
--> statement-breakpoint
CREATE TABLE "theory_of_change_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"node_type" varchar(20) NOT NULL,
	"outcome_id" uuid,
	"title" varchar(255) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "theory_of_change_nodes_type_check" CHECK ("theory_of_change_nodes"."node_type" IN ('activity', 'output', 'outcome')),
	CONSTRAINT "theory_of_change_nodes_status_check" CHECK ("theory_of_change_nodes"."status" IN ('active', 'archived')),
	CONSTRAINT "theory_of_change_nodes_outcome_ref_check" CHECK (("theory_of_change_nodes"."node_type" = 'outcome' AND "theory_of_change_nodes"."outcome_id" IS NOT NULL) OR ("theory_of_change_nodes"."node_type" != 'outcome' AND "theory_of_change_nodes"."outcome_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "theory_of_change_links" ADD CONSTRAINT "theory_of_change_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theory_of_change_links" ADD CONSTRAINT "theory_of_change_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theory_of_change_links" ADD CONSTRAINT "theory_of_change_links_from_node_id_theory_of_change_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."theory_of_change_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theory_of_change_links" ADD CONSTRAINT "theory_of_change_links_to_node_id_theory_of_change_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."theory_of_change_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theory_of_change_links" ADD CONSTRAINT "theory_of_change_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theory_of_change_nodes" ADD CONSTRAINT "theory_of_change_nodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theory_of_change_nodes" ADD CONSTRAINT "theory_of_change_nodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theory_of_change_nodes" ADD CONSTRAINT "theory_of_change_nodes_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theory_of_change_nodes" ADD CONSTRAINT "theory_of_change_nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_toc_links_project_id" ON "theory_of_change_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_toc_links_organization_id" ON "theory_of_change_links" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_toc_links_from_node_id" ON "theory_of_change_links" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "idx_toc_links_to_node_id" ON "theory_of_change_links" USING btree ("to_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "theory_of_change_nodes_outcome_unique" ON "theory_of_change_nodes" USING btree ("project_id","outcome_id") WHERE "theory_of_change_nodes"."outcome_id" IS NOT NULL AND "theory_of_change_nodes"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_toc_nodes_project_id" ON "theory_of_change_nodes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_toc_nodes_organization_id" ON "theory_of_change_nodes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_toc_nodes_outcome_id" ON "theory_of_change_nodes" USING btree ("outcome_id");