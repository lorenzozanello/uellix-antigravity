ALTER TABLE "outcome_proxy_assignments" ADD COLUMN "assignment_status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD CONSTRAINT "outcome_proxy_assignments_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;