CREATE TABLE IF NOT EXISTS "stella_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"stella_role" varchar(50) NOT NULL,
	"pipeline_step" varchar(100) NOT NULL,
	"context_hash" varchar(64) NOT NULL,
	"response_json" jsonb NOT NULL,
	"model_used" varchar(100) DEFAULT 'gemini-2.0-flash' NOT NULL,
	"tokens_used" integer,
	"risk_level" varchar(50),
	"risk_flags" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stella_interactions_stella_role_check" CHECK ("stella_interactions"."stella_role" IN ('advisor', 'validator', 'composer')),
	CONSTRAINT "stella_interactions_risk_level_check" CHECK ("stella_interactions"."risk_level" IS NULL OR "stella_interactions"."risk_level" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stella_interactions" ADD CONSTRAINT "stella_interactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stella_interactions" ADD CONSTRAINT "stella_interactions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stella_interactions" ADD CONSTRAINT "stella_interactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stella_interactions_org_created_idx" ON "stella_interactions" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stella_interactions_project_role_idx" ON "stella_interactions" ("project_id", "stella_role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stella_interactions_created_by_created_idx" ON "stella_interactions" ("created_by", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stella_interactions_context_hash_idx" ON "stella_interactions" ("context_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stella_interactions_risk_level_idx" ON "stella_interactions" ("risk_level") WHERE "risk_level" IS NOT NULL;
