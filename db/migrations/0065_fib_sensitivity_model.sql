-- FIBIU-18 -- governed sensitivity, stage A (FIBC-022, FIBDB-017/018/048).
-- Generated cleanly by drizzle-kit generate; RLS is hand-authored below.
-- Supersedes (not extends) lib/pipeline/sroi-sensitivity.ts's uniform
-- SCENARIO_DELTA_PP = 10 shortcut, which this migration and its companion
-- service rewrite retire.
--
-- sensitivity_candidates: org-scoped SELECT, INSERT and UPDATE at the same
-- analyst+ floor as 0064/0063. UPDATE is CONTRACT-REQUIRED (FIBC-022's
-- governed disposition transition from pending), unlike the append-only
-- FIBDB-018 table below -- the service layer restricts an UPDATE to the
-- disposition/rationale/actor columns only; RLS grants the row-level floor.
--
-- sensitivity_scenarios: org-scoped SELECT, INSERT. No UPDATE, no DELETE --
-- append-only (stage A realized by policy absence, not a trigger; stage-E
-- hardening for FIBDB-017/018/048 is explicitly deferred, not authorized
-- in B5).
--
-- Ordering: this migration (FIBDB-017/018/048, FIBIU-18) follows 0064
-- (FIBDB-015, FIBIU-17) -- write serialization only, no product DAG edge
-- (W2_B5_AUTHORITY_v1.0.0.json W2_B5_SCOPE.dag_authority: "There is NO edge
-- between FIBIU-17 and FIBIU-18 in either direction").
--
-- No new function or SECURITY DEFINER surface is introduced by this
-- migration (SEC-N4 discharged by proven absence -- see
-- tests/postgres/b5-completeness.probes.json).

CREATE TABLE "sensitivity_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"calculation_run_id" uuid NOT NULL,
	"candidate_key" varchar(200) NOT NULL,
	"candidate_kind" varchar(40) NOT NULL,
	"input_reference" jsonb NOT NULL,
	"base_value" varchar(255),
	"disposition" varchar(40) DEFAULT 'pending' NOT NULL,
	"rationale" text,
	"dispositioned_by" uuid,
	"dispositioned_at" timestamp,
	"sensitivity_model_version" varchar(20) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sensitivity_candidates_candidate_kind_check" CHECK ("sensitivity_candidates"."candidate_kind" IN ('methodological_filter', 'structured_assumption', 'proxy_value', 'other_quantitative_input')),
	CONSTRAINT "sensitivity_candidates_disposition_check" CHECK ("sensitivity_candidates"."disposition" IN ('variation_required', 'no_additional_variation_required', 'pending')),
	CONSTRAINT "sensitivity_candidates_rationale_check" CHECK ("sensitivity_candidates"."disposition" = 'pending' OR "sensitivity_candidates"."rationale" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sensitivity_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"calculation_run_id" uuid NOT NULL,
	"scenario_kind" varchar(20) NOT NULL,
	"candidate_ids" jsonb NOT NULL,
	"modified_inputs" jsonb NOT NULL,
	"reason" text NOT NULL,
	"sources" text,
	"combination_description" text,
	"sensitivity_model_version" varchar(20) NOT NULL,
	"calculation_engine_version" varchar(20) NOT NULL,
	"result_json" jsonb NOT NULL,
	"base_result_json" jsonb NOT NULL,
	"selected_by" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sensitivity_scenarios_scenario_kind_check" CHECK ("sensitivity_scenarios"."scenario_kind" IN ('one_at_a_time', 'combined')),
	CONSTRAINT "sensitivity_scenarios_combination_description_check" CHECK ("sensitivity_scenarios"."scenario_kind" <> 'combined' OR "sensitivity_scenarios"."combination_description" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "sensitivity_candidates" ADD CONSTRAINT "sensitivity_candidates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_candidates" ADD CONSTRAINT "sensitivity_candidates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_candidates" ADD CONSTRAINT "sensitivity_candidates_calculation_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_candidates" ADD CONSTRAINT "sensitivity_candidates_dispositioned_by_users_id_fk" FOREIGN KEY ("dispositioned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_candidates" ADD CONSTRAINT "sensitivity_candidates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_scenarios" ADD CONSTRAINT "sensitivity_scenarios_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_scenarios" ADD CONSTRAINT "sensitivity_scenarios_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_scenarios" ADD CONSTRAINT "sensitivity_scenarios_calculation_run_id_sroi_calculation_runs_id_fk" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."sroi_calculation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_scenarios" ADD CONSTRAINT "sensitivity_scenarios_selected_by_users_id_fk" FOREIGN KEY ("selected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitivity_scenarios" ADD CONSTRAINT "sensitivity_scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sensitivity_candidates_run_key" ON "sensitivity_candidates" USING btree ("calculation_run_id","candidate_key");--> statement-breakpoint
CREATE INDEX "idx_sensitivity_candidates_run_id" ON "sensitivity_candidates" USING btree ("calculation_run_id");--> statement-breakpoint
CREATE INDEX "idx_sensitivity_candidates_organization_id" ON "sensitivity_candidates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_sensitivity_scenarios_run_id" ON "sensitivity_scenarios" USING btree ("calculation_run_id");--> statement-breakpoint
CREATE INDEX "idx_sensitivity_scenarios_organization_id" ON "sensitivity_scenarios" USING btree ("organization_id");--> statement-breakpoint

ALTER TABLE sensitivity_candidates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "sensitivity_candidates_select" ON sensitivity_candidates;--> statement-breakpoint
CREATE POLICY "sensitivity_candidates_select" ON sensitivity_candidates FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "sensitivity_candidates_insert" ON sensitivity_candidates;--> statement-breakpoint
CREATE POLICY "sensitivity_candidates_insert"
ON sensitivity_candidates FOR INSERT
WITH CHECK (
  created_by = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);--> statement-breakpoint

DROP POLICY IF EXISTS "sensitivity_candidates_update" ON sensitivity_candidates;--> statement-breakpoint
CREATE POLICY "sensitivity_candidates_update"
ON sensitivity_candidates FOR UPDATE
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

ALTER TABLE sensitivity_scenarios ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "sensitivity_scenarios_select" ON sensitivity_scenarios;--> statement-breakpoint
CREATE POLICY "sensitivity_scenarios_select" ON sensitivity_scenarios FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "sensitivity_scenarios_insert" ON sensitivity_scenarios;--> statement-breakpoint
CREATE POLICY "sensitivity_scenarios_insert"
ON sensitivity_scenarios FOR INSERT
WITH CHECK (
  created_by = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);
-- No UPDATE policy -> denied by RLS (append-only).
-- No DELETE policy -> denied by RLS.
