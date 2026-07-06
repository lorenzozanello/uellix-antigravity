ALTER TABLE "projects" DROP CONSTRAINT "status_check";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "delete_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deletion_requested_by_users_id_fk" FOREIGN KEY ("deletion_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_projects_deletion_requested_at" ON "projects" USING btree ("deletion_requested_at") WHERE "projects"."deletion_requested_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_projects_deleted_at" ON "projects" USING btree ("deleted_at") WHERE "projects"."deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "deletion_request_consistency_check" CHECK (("projects"."deletion_requested_at" IS NULL AND "projects"."deletion_requested_by" IS NULL AND "projects"."deletion_reason" IS NULL) OR ("projects"."deletion_requested_at" IS NOT NULL AND "projects"."deletion_requested_by" IS NOT NULL AND "projects"."deletion_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "deletion_consistency_check" CHECK (("projects"."deleted_at" IS NULL AND "projects"."deleted_by" IS NULL AND "projects"."delete_reason" IS NULL) OR ("projects"."deleted_at" IS NOT NULL AND "projects"."deleted_by" IS NOT NULL AND "projects"."delete_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "status_check" CHECK ("projects"."status" IN ('draft', 'active', 'paused', 'completed', 'archived'));