CREATE TABLE "signup_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(20) NOT NULL,
	"pattern" varchar(255) NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "signup_allowlist_pattern_unique" UNIQUE("pattern"),
	CONSTRAINT "signup_allowlist_type_check" CHECK ("signup_allowlist"."type" IN ('email', 'domain'))
);
--> statement-breakpoint
ALTER TABLE "signup_allowlist" ADD CONSTRAINT "signup_allowlist_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;