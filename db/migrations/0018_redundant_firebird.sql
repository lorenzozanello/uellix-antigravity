-- Fase 1b — multi-funder / USD columns on the existing calculation tables.
--
-- DEPLOY-COUPLED: unlike the 1a new tables, this alters tables the live app
-- writes to. It must be applied WITH (not before) the 1b code that populates
-- funder_id / amount_usd / value_usd. Applying it to a database whose app
-- still runs pre-1b code would break investment inserts (funder_id NOT NULL)
-- and proxy approvals (extended approved_proxy_check). Hence it is NOT applied
-- to production as part of the 1b PR — it runs at deploy time.
--
-- Hand-edited from the generated diff to be backfill-safe: columns are added
-- nullable, existing rows are backfilled, THEN funder_id is set NOT NULL and
-- the approved-proxy invariant is tightened. The final schema state matches the
-- 0018 snapshot, so drizzle-kit check stays consistent.

-- ── financial_proxies: additive USD columns ─────────────────────────────────
ALTER TABLE "financial_proxies" ADD COLUMN "value_usd" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "financial_proxies" ADD COLUMN "fx_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "financial_proxies" ADD CONSTRAINT "financial_proxies_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill USD proxies so the tightened approved_proxy_check holds for every
-- already-approved proxy (all approved proxies are USD at migration time).
UPDATE "financial_proxies" SET "value_usd" = "value" WHERE "currency" = 'USD' AND "value_usd" IS NULL;--> statement-breakpoint
ALTER TABLE "financial_proxies" DROP CONSTRAINT "approved_proxy_check";--> statement-breakpoint
ALTER TABLE "financial_proxies" ADD CONSTRAINT "approved_proxy_check" CHECK ("financial_proxies"."review_status" != 'approved' OR ("financial_proxies"."value" IS NOT NULL AND "financial_proxies"."currency" IS NOT NULL AND "financial_proxies"."unit" IS NOT NULL AND "financial_proxies"."reference_year" IS NOT NULL AND "financial_proxies"."value_usd" IS NOT NULL));--> statement-breakpoint

-- ── project_investments: funder + contribution + USD columns ────────────────
ALTER TABLE "project_investments" ADD COLUMN "funder_id" uuid;--> statement-breakpoint
ALTER TABLE "project_investments" ADD COLUMN "contribution_type" varchar(20) DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_investments" ADD COLUMN "in_kind_valuation_notes" text;--> statement-breakpoint
ALTER TABLE "project_investments" ADD COLUMN "amount_usd" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "project_investments" ADD COLUMN "fx_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "project_investments" ADD CONSTRAINT "project_investments_funder_id_funders_id_fk" FOREIGN KEY ("funder_id") REFERENCES "public"."funders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_investments" ADD CONSTRAINT "project_investments_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill: one placeholder funder per org that already has investments, then
-- point every existing investment at it (nothing in-kind existed pre-1b).
INSERT INTO "funders" ("organization_id", "name", "funder_type", "created_by")
SELECT DISTINCT pi."organization_id", 'Financiador no especificado', 'other', pi."created_by"
FROM "project_investments" pi
WHERE NOT EXISTS (
  SELECT 1 FROM "funders" f
  WHERE f."organization_id" = pi."organization_id" AND f."name" = 'Financiador no especificado'
);--> statement-breakpoint
UPDATE "project_investments" pi
SET "funder_id" = (
  SELECT f."id" FROM "funders" f
  WHERE f."organization_id" = pi."organization_id" AND f."name" = 'Financiador no especificado'
  LIMIT 1
)
WHERE pi."funder_id" IS NULL;--> statement-breakpoint
UPDATE "project_investments" SET "amount_usd" = "amount" WHERE "currency" = 'USD' AND "amount_usd" IS NULL;--> statement-breakpoint
ALTER TABLE "project_investments" ALTER COLUMN "funder_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_project_investments_funder_id" ON "project_investments" USING btree ("funder_id");--> statement-breakpoint
ALTER TABLE "project_investments" ADD CONSTRAINT "project_investments_contribution_type_check" CHECK ("project_investments"."contribution_type" IN ('cash', 'in_kind'));--> statement-breakpoint
ALTER TABLE "project_investments" ADD CONSTRAINT "project_investments_in_kind_notes_check" CHECK ("project_investments"."contribution_type" <> 'in_kind' OR "project_investments"."in_kind_valuation_notes" IS NOT NULL);
