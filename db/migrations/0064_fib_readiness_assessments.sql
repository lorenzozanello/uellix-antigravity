-- FIBIU-17 -- canonical readiness, stage A (FIBC-021, FIBDB-015). Generated
-- cleanly by drizzle-kit generate; RLS is hand-authored below, following the
-- counterfactual_assessments pattern (0063): org-scoped SELECT, INSERT
-- restricted to the same analyst+ role floor. No UPDATE, no DELETE policy --
-- readiness_assessments is an immutable per-run snapshot; a recompute is a
-- new run, never an edit of this row (FIBC-021: "no human or Stella may
-- inject points").
--
-- FIBDB-016 stage B (LEGACY_MARKING, W2_B5_AUTHORITY_v1.0.0.json
-- fibdb016_stage_b_realization): marks sroi_run_reviews.readiness_score
-- LEGACY_NON_AUTHORITATIVE via a plain, reversible COMMENT ON COLUMN.
-- readiness_assessments (this migration) is the sole FIBC-021-authoritative
-- readiness from this point forward; the historical manual column is
-- retained intact with its data (no DROP, no rename, no NOT NULL, no
-- read-only trigger -- that is stage F, deferred to FIBIU-30, Wave 6).
--
-- Ordering (migration_and_postgres_contract.internal_migration_dependency,
-- W2_B5_AUTHORITY_v1.0.0.json): this migration (FIBDB-015, FIBIU-17)
-- precedes 0065 (FIBDB-017/018/048, FIBIU-18) -- a write serialization on
-- the shared journal/manifest, not a product dependency; FIB section 13
-- WAVE 2 PARALLEL_GROUPS lists {17, 18} with no edge between them.
--
-- No new function or SECURITY DEFINER surface is introduced by this
-- migration (SEC-N4 discharged by proven absence, not silent omission --
-- see tests/postgres/b5-completeness.probes.json).

CREATE TABLE "readiness_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"calculation_run_id" uuid NOT NULL,
	"readiness_model_version" varchar(20) NOT NULL,
	"global_score" numeric(5, 2) NOT NULL,
	"band" varchar(30) NOT NULL,
	"dimension_scores" jsonb NOT NULL,
	"criteria_detail" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "readiness_assessments_global_score_check" CHECK ("readiness_assessments"."global_score" >= 0 AND "readiness_assessments"."global_score" <= 100),
	CONSTRAINT "readiness_assessments_band_check" CHECK ("readiness_assessments"."band" IN ('initial_preparation', 'partial_preparation', 'advanced_preparation', 'high_preparation'))
);
--> statement-breakpoint
ALTER TABLE "readiness_assessments" ADD CONSTRAINT "readiness_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_assessments" ADD CONSTRAINT "readiness_assessments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_assessments" ADD CONSTRAINT "readiness_assessments_calculation_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_assessments" ADD CONSTRAINT "readiness_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_readiness_assessments_calculation_run" ON "readiness_assessments" USING btree ("calculation_run_id");--> statement-breakpoint
CREATE INDEX "idx_readiness_assessments_project_id" ON "readiness_assessments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_readiness_assessments_organization_id" ON "readiness_assessments" USING btree ("organization_id");--> statement-breakpoint

COMMENT ON COLUMN sroi_run_reviews.readiness_score IS 'LEGACY_NON_AUTHORITATIVE (FIBDB-016 stage B, W2-B5 / HPO-ODS-W2-17): historical manual readiness value, retained as history. Never authoritative from B5 forward. Canonical readiness is readiness_assessments (FIBC-021).';--> statement-breakpoint

ALTER TABLE readiness_assessments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "readiness_assessments_select" ON readiness_assessments;--> statement-breakpoint
CREATE POLICY "readiness_assessments_select" ON readiness_assessments FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "readiness_assessments_insert" ON readiness_assessments;--> statement-breakpoint
CREATE POLICY "readiness_assessments_insert"
ON readiness_assessments FOR INSERT
WITH CHECK (
  created_by = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);
-- No UPDATE policy -> denied by RLS (immutable snapshot).
-- No DELETE policy -> denied by RLS.
