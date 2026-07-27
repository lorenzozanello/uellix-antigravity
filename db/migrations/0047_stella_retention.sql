CREATE TABLE "stella_retention_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"interaction_id" uuid,
	"hold_type" varchar(40) NOT NULL,
	"reason_code" varchar(60) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"released_by" uuid,
	"released_at" timestamp,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	CONSTRAINT "srh_hold_type_check" CHECK ("stella_retention_holds"."hold_type" IN ('legal_hold', 'audit_investigation', 'dispute', 'contractual_obligation', 'authorized_preservation')),
	CONSTRAINT "srh_status_check" CHECK ("stella_retention_holds"."status" IN ('active', 'released', 'expired')),
	CONSTRAINT "srh_released_pair_check" CHECK (("stella_retention_holds"."released_at" IS NULL AND "stella_retention_holds"."released_by" IS NULL) OR ("stella_retention_holds"."released_at" IS NOT NULL AND "stella_retention_holds"."released_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stella_retention_purge_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"policy_version" varchar(20) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"requested_by" uuid NOT NULL,
	"cutoff_at" timestamp NOT NULL,
	"batch_size" integer DEFAULT 500 NOT NULL,
	"cursor_created_at" timestamp,
	"cursor_id" uuid,
	"records_scanned" integer DEFAULT 0 NOT NULL,
	"records_eligible" integer DEFAULT 0 NOT NULL,
	"records_purged" integer DEFAULT 0 NOT NULL,
	"records_skipped_hold" integer DEFAULT 0 NOT NULL,
	"records_failed" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(60),
	"idempotency_key" varchar(100) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stella_retention_purge_runs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "srpr_mode_check" CHECK ("stella_retention_purge_runs"."mode" IN ('dry_run', 'apply')),
	CONSTRAINT "srpr_status_check" CHECK ("stella_retention_purge_runs"."status" IN ('pending', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "stella_retention_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"response_retention_months" integer NOT NULL,
	"policy_version" varchar(20) NOT NULL,
	"configured_by" uuid NOT NULL,
	"configured_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stella_retention_settings_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "srs_retention_months_check" CHECK ("stella_retention_settings"."response_retention_months" >= 1 AND "stella_retention_settings"."response_retention_months" <= 60)
);
--> statement-breakpoint
ALTER TABLE "stella_interactions" ALTER COLUMN "response_json" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stella_interactions" ADD COLUMN "response_purged_at" timestamp;--> statement-breakpoint
ALTER TABLE "stella_interactions" ADD COLUMN "response_purge_run_id" uuid;--> statement-breakpoint
ALTER TABLE "stella_retention_holds" ADD CONSTRAINT "stella_retention_holds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_retention_holds" ADD CONSTRAINT "stella_retention_holds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_retention_holds" ADD CONSTRAINT "stella_retention_holds_interaction_id_stella_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."stella_interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_retention_holds" ADD CONSTRAINT "stella_retention_holds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_retention_holds" ADD CONSTRAINT "stella_retention_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_retention_purge_runs" ADD CONSTRAINT "stella_retention_purge_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_retention_purge_runs" ADD CONSTRAINT "stella_retention_purge_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_retention_settings" ADD CONSTRAINT "stella_retention_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_retention_settings" ADD CONSTRAINT "stella_retention_settings_configured_by_users_id_fk" FOREIGN KEY ("configured_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "srh_org_status_idx" ON "stella_retention_holds" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "srh_interaction_idx" ON "stella_retention_holds" USING btree ("interaction_id") WHERE "stella_retention_holds"."interaction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "srpr_org_created_idx" ON "stella_retention_purge_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "stella_interactions_purge_eligibility_idx" ON "stella_interactions" USING btree ("organization_id","created_at") WHERE "stella_interactions"."response_purged_at" IS NULL;--> statement-breakpoint
ALTER TABLE "stella_interactions" ADD CONSTRAINT "stella_interactions_response_presence_check" CHECK ("stella_interactions"."response_json" IS NOT NULL OR "stella_interactions"."response_purged_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "stella_interactions" ADD CONSTRAINT "stella_interactions_purge_pair_check" CHECK (("stella_interactions"."response_purged_at" IS NULL AND "stella_interactions"."response_purge_run_id" IS NULL) OR ("stella_interactions"."response_purged_at" IS NOT NULL AND "stella_interactions"."response_purge_run_id" IS NOT NULL));
