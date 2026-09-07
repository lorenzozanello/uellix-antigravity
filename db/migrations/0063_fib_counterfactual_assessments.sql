-- FIBIU-14 — counterfactual assessment, stage A (FIBC-018, FIBDB-011/046).
-- Generated cleanly by drizzle-kit generate; RLS is hand-authored below,
-- following the outcome_monetization_dispositions pattern (0059/0060):
-- org-scoped SELECT, INSERT/UPDATE restricted to the same analyst+ role
-- floor. UPDATE is included (unlike the append-only 0059 precedent) because
-- FIBDB-011's "run-bound" contract mirrors recordOutcomeMonetizationDisposition's
-- create-or-update shape exactly (one row per (outcome, run), refined until
-- the run is approved) rather than FIBDB-013's fully append-only shape.
--
-- Ordering (migration_and_postgres_contract.internal_migration_dependency,
-- W2_B4_AUTHORITY_v1.0.0.json): this migration (FIBDB-011/046, FIBIU-14)
-- follows 0062 (FIBDB-012/013/047, FIBIU-15), mirroring the certified
-- SERIAL_CONTRACT 15->{14,16}.
--
-- No new function or SECURITY DEFINER surface is introduced by this
-- migration (SEC-N4/MUT-PG-4 discharged by proven absence, not silent
-- omission — see tests/postgres/b4-completeness.probes.json).

CREATE TABLE "counterfactual_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"calculation_run_id" uuid NOT NULL,
	"baseline_availability" varchar(20) NOT NULL,
	"basis_kind" varchar(30) NOT NULL,
	"baseline_value" varchar(255),
	"baseline_period" varchar(100),
	"baseline_source" text,
	"baseline_context" text,
	"deadweight_support_state" varchar(30) NOT NULL,
	"sources" text,
	"rationale" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "counterfactual_assessments_baseline_availability_check" CHECK ("counterfactual_assessments"."baseline_availability" IN ('available', 'not_available', 'not_applicable')),
	CONSTRAINT "counterfactual_assessments_basis_kind_check" CHECK ("counterfactual_assessments"."basis_kind" IN ('baseline_observation', 'comparison_group', 'historical_trend', 'benchmark', 'statistic', 'literature', 'stakeholder_evidence', 'documented_assumption')),
	CONSTRAINT "counterfactual_assessments_deadweight_support_state_check" CHECK ("counterfactual_assessments"."deadweight_support_state" IN ('supported', 'unknown_or_insufficient')),
	CONSTRAINT "counterfactual_assessments_baseline_available_fields_check" CHECK ("counterfactual_assessments"."baseline_availability" <> 'available' OR ("counterfactual_assessments"."baseline_value" IS NOT NULL AND "counterfactual_assessments"."baseline_period" IS NOT NULL AND "counterfactual_assessments"."baseline_source" IS NOT NULL AND "counterfactual_assessments"."baseline_context" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "counterfactual_assessments" ADD CONSTRAINT "counterfactual_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterfactual_assessments" ADD CONSTRAINT "counterfactual_assessments_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterfactual_assessments" ADD CONSTRAINT "counterfactual_assessments_calculation_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterfactual_assessments" ADD CONSTRAINT "counterfactual_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_counterfactual_assessments_outcome_run" ON "counterfactual_assessments" USING btree ("outcome_id","calculation_run_id");--> statement-breakpoint
CREATE INDEX "idx_counterfactual_assessments_run_id" ON "counterfactual_assessments" USING btree ("calculation_run_id");--> statement-breakpoint

ALTER TABLE counterfactual_assessments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "counterfactual_assessments_select" ON counterfactual_assessments;--> statement-breakpoint
CREATE POLICY "counterfactual_assessments_select" ON counterfactual_assessments FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "counterfactual_assessments_insert" ON counterfactual_assessments;--> statement-breakpoint
CREATE POLICY "counterfactual_assessments_insert"
ON counterfactual_assessments FOR INSERT
WITH CHECK (
  created_by = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);--> statement-breakpoint

DROP POLICY IF EXISTS "counterfactual_assessments_update" ON counterfactual_assessments;--> statement-breakpoint
CREATE POLICY "counterfactual_assessments_update"
ON counterfactual_assessments FOR UPDATE
USING (
  organization_id = ANY(current_user_org_ids())
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
)
WITH CHECK (
  organization_id = ANY(current_user_org_ids())
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);
-- No DELETE policy -> denied by RLS.
