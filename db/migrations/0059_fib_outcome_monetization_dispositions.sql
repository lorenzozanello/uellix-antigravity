-- FIBIU-12 — monetization disposition and coverage, stage A (FIBC-016,
-- FIBDB-009/045). Generated cleanly by drizzle-kit generate; RLS is
-- hand-authored below, following the evidence_sufficiency_determinations
-- pattern (0050): org-scoped SELECT, INSERT restricted to created_by =
-- auth.uid() at the same analyst+ floor upsertSroiFilterSet/outcomes.ts
-- already use for this pipeline, no UPDATE/DELETE policy — this table is
-- append-only by design (one row per outcome per run, never edited).

CREATE TABLE "outcome_monetization_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"calculation_run_id" uuid NOT NULL,
	"disposition" varchar(20) NOT NULL,
	"reason" varchar(40),
	"justification" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_monetization_dispositions_disposition_check" CHECK ("outcome_monetization_dispositions"."disposition" IN ('monetized', 'not_monetized')),
	CONSTRAINT "outcome_monetization_dispositions_reason_check" CHECK ("outcome_monetization_dispositions"."reason" IS NULL OR "outcome_monetization_dispositions"."reason" IN ('no_defensible_proxy', 'proxy_not_approved', 'insufficient_evidence', 'not_material', 'not_yet_eligible', 'superseded_version', 'other_governed_reason')),
	CONSTRAINT "outcome_monetization_dispositions_reason_required_check" CHECK ("outcome_monetization_dispositions"."disposition" <> 'not_monetized' OR "outcome_monetization_dispositions"."reason" IS NOT NULL),
	CONSTRAINT "outcome_monetization_dispositions_justification_pair_check" CHECK ("outcome_monetization_dispositions"."reason" IS NULL OR "outcome_monetization_dispositions"."justification" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "outcome_monetization_dispositions" ADD CONSTRAINT "outcome_monetization_dispositions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_monetization_dispositions" ADD CONSTRAINT "outcome_monetization_dispositions_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_monetization_dispositions" ADD CONSTRAINT "outcome_monetization_dispositions_calculation_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_monetization_dispositions" ADD CONSTRAINT "outcome_monetization_dispositions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outcome_monetization_dispositions_outcome_run" ON "outcome_monetization_dispositions" USING btree ("outcome_id","calculation_run_id");--> statement-breakpoint
CREATE INDEX "idx_outcome_monetization_dispositions_run_id" ON "outcome_monetization_dispositions" USING btree ("calculation_run_id");--> statement-breakpoint

ALTER TABLE outcome_monetization_dispositions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "outcome_monetization_dispositions_select" ON outcome_monetization_dispositions;--> statement-breakpoint
CREATE POLICY "outcome_monetization_dispositions_select" ON outcome_monetization_dispositions FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "outcome_monetization_dispositions_insert" ON outcome_monetization_dispositions;--> statement-breakpoint
CREATE POLICY "outcome_monetization_dispositions_insert"
ON outcome_monetization_dispositions FOR INSERT
WITH CHECK (
  created_by = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);
-- No UPDATE or DELETE policy → both are denied by RLS.