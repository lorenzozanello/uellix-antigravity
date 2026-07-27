CREATE TABLE "stella_pilot_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" varchar(20) NOT NULL,
	"notice_version" varchar(20),
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"supersedes_event_id" uuid,
	CONSTRAINT "stella_pilot_confirmations_event_type_check" CHECK ("stella_pilot_confirmations"."event_type" IN ('accepted', 'revoked')),
	CONSTRAINT "stella_pilot_confirmations_accepted_version_check" CHECK (("stella_pilot_confirmations"."event_type" = 'accepted' AND "stella_pilot_confirmations"."notice_version" IS NOT NULL) OR "stella_pilot_confirmations"."event_type" = 'revoked')
);
--> statement-breakpoint
ALTER TABLE "stella_pilot_confirmations" ADD CONSTRAINT "stella_pilot_confirmations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stella_pilot_confirmations" ADD CONSTRAINT "stella_pilot_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stella_pilot_confirmations_org_user_occurred_idx" ON "stella_pilot_confirmations" USING btree ("organization_id","user_id","occurred_at");