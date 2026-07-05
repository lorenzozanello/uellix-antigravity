CREATE TABLE "funders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"funder_type" varchar(50) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "funders_funder_type_check" CHECK ("funders"."funder_type" IN ('public', 'private', 'foundation', 'multilateral', 'individual', 'other'))
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency" varchar(10) NOT NULL,
	"rate_date" date NOT NULL,
	"rate_to_usd" numeric(20, 6) NOT NULL,
	"source" text NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"organization_id" uuid,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_source_type_check" CHECK ("fx_rates"."source_type" IN ('auto_fetched', 'manual')),
	CONSTRAINT "fx_rates_rate_to_usd_check" CHECK ("fx_rates"."rate_to_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "outcome_funder_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outcome_id" uuid NOT NULL,
	"funder_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"allocation_pct" numeric(7, 4) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_funder_allocations_pct_check" CHECK ("outcome_funder_allocations"."allocation_pct" > 0 AND "outcome_funder_allocations"."allocation_pct" <= 100),
	CONSTRAINT "outcome_funder_allocations_status_check" CHECK ("outcome_funder_allocations"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "funders" ADD CONSTRAINT "funders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funders" ADD CONSTRAINT "funders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_funder_allocations" ADD CONSTRAINT "outcome_funder_allocations_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_funder_allocations" ADD CONSTRAINT "outcome_funder_allocations_funder_id_funders_id_fk" FOREIGN KEY ("funder_id") REFERENCES "public"."funders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_funder_allocations" ADD CONSTRAINT "outcome_funder_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_funder_allocations" ADD CONSTRAINT "outcome_funder_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_funders_organization_id" ON "funders" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_shared_currency_date_unique" ON "fx_rates" USING btree ("currency","rate_date") WHERE "fx_rates"."organization_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_org_currency_date_unique" ON "fx_rates" USING btree ("organization_id","currency","rate_date") WHERE "fx_rates"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_fx_rates_currency_date" ON "fx_rates" USING btree ("currency","rate_date");--> statement-breakpoint
CREATE INDEX "idx_ofa_outcome_id" ON "outcome_funder_allocations" USING btree ("outcome_id");--> statement-breakpoint
CREATE INDEX "idx_ofa_funder_id" ON "outcome_funder_allocations" USING btree ("funder_id");--> statement-breakpoint
CREATE INDEX "idx_ofa_organization_id" ON "outcome_funder_allocations" USING btree ("organization_id");