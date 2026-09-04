-- FIBIU-15 — structured methodological assumptions, stage A (FIBC-019,
-- FIBDB-012/013/047). Generated cleanly by drizzle-kit generate; RLS is
-- hand-authored below, following the outcome_monetization_dispositions
-- pattern (0059/0060): org-scoped SELECT, INSERT restricted to
-- created_by = auth.uid() at the same analyst+ floor upsertSroiFilterSet
-- already uses for this pipeline. Unlike 0059, methodological_assumptions
-- also carries an UPDATE policy — FIBC-019's "a material modification
-- creates a new version" is service-enforced by
-- lib/pipeline/domain-object-versions.ts (the row's id is the assumption's
-- permanent identity; its prior content is preserved as a
-- domain_object_versions row before the UPDATE is applied), not by refusing
-- the UPDATE itself. assumption_object_links stays append-only — SELECT and
-- INSERT only, no UPDATE/DELETE policy — mirroring FIBDB-013's own
-- "IMMUTABILITY: none beyond the assumption's own versioning": a link
-- records a fact about what an assumption affects and is never itself
-- edited.
--
-- Ordering (migration_and_postgres_contract.internal_migration_dependency,
-- W2_B4_AUTHORITY_v1.0.0.json): FIBDB-012/013/047 (this migration) precede
-- FIBDB-011/046 (0063, FIBIU-14), mirroring the certified SERIAL_CONTRACT
-- 15->{14,16}. FIBDB-013 (assumption_object_links) depends on FIBDB-012
-- (methodological_assumptions) via its assumption_id FK, both created here.
--
-- No new function or SECURITY DEFINER surface is introduced by this
-- migration (SEC-N4/MUT-PG-4 discharged by proven absence, not silent
-- omission — see tests/postgres/b4-completeness.probes.json).

CREATE TABLE "assumption_object_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"assumption_id" uuid NOT NULL,
	"affected_object_type" varchar(40) NOT NULL,
	"affected_object_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "assumption_object_links_affected_type_check" CHECK ("assumption_object_links"."affected_object_type" IN ('outcome', 'theory_of_change_node', 'theory_of_change_link', 'sroi_calculation_run', 'indicator', 'project'))
);
--> statement-breakpoint
CREATE TABLE "methodological_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"formulation" text NOT NULL,
	"rationale" text NOT NULL,
	"basis_type" varchar(30) NOT NULL,
	"provenance_reference" text,
	"materiality_flag" varchar(20) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "methodological_assumptions_basis_type_check" CHECK ("methodological_assumptions"."basis_type" IN ('evidence_or_external_source', 'derived', 'documented_human_judgement')),
	CONSTRAINT "methodological_assumptions_materiality_flag_check" CHECK ("methodological_assumptions"."materiality_flag" IN ('material', 'non_material')),
	CONSTRAINT "methodological_assumptions_provenance_reference_check" CHECK ("methodological_assumptions"."basis_type" <> 'evidence_or_external_source' OR "methodological_assumptions"."provenance_reference" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "assumption_object_links" ADD CONSTRAINT "assumption_object_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assumption_object_links" ADD CONSTRAINT "assumption_object_links_assumption_id_methodological_assumptions_id_fk" FOREIGN KEY ("assumption_id") REFERENCES "public"."methodological_assumptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assumption_object_links" ADD CONSTRAINT "assumption_object_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodological_assumptions" ADD CONSTRAINT "methodological_assumptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodological_assumptions" ADD CONSTRAINT "methodological_assumptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodological_assumptions" ADD CONSTRAINT "methodological_assumptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodological_assumptions" ADD CONSTRAINT "methodological_assumptions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assumption_object_links_assumption_object" ON "assumption_object_links" USING btree ("assumption_id","affected_object_type","affected_object_id");--> statement-breakpoint
CREATE INDEX "idx_assumption_object_links_assumption_id" ON "assumption_object_links" USING btree ("assumption_id");--> statement-breakpoint
CREATE INDEX "idx_assumption_object_links_organization_id" ON "assumption_object_links" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_methodological_assumptions_project_id" ON "methodological_assumptions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_methodological_assumptions_organization_id" ON "methodological_assumptions" USING btree ("organization_id");--> statement-breakpoint

ALTER TABLE methodological_assumptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "methodological_assumptions_select" ON methodological_assumptions;--> statement-breakpoint
CREATE POLICY "methodological_assumptions_select" ON methodological_assumptions FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "methodological_assumptions_insert" ON methodological_assumptions;--> statement-breakpoint
CREATE POLICY "methodological_assumptions_insert"
ON methodological_assumptions FOR INSERT
WITH CHECK (
  created_by = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);--> statement-breakpoint

DROP POLICY IF EXISTS "methodological_assumptions_update" ON methodological_assumptions;--> statement-breakpoint
CREATE POLICY "methodological_assumptions_update"
ON methodological_assumptions FOR UPDATE
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
-- No DELETE policy -> denied by RLS. An assumption is superseded by an
-- UPDATE plus a domain_object_versions history row, never removed.
--> statement-breakpoint

ALTER TABLE assumption_object_links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "assumption_object_links_select" ON assumption_object_links;--> statement-breakpoint
CREATE POLICY "assumption_object_links_select" ON assumption_object_links FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "assumption_object_links_insert" ON assumption_object_links;--> statement-breakpoint
CREATE POLICY "assumption_object_links_insert"
ON assumption_object_links FOR INSERT
WITH CHECK (
  created_by = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    OR current_user_is_super_admin()
  )
);
-- No UPDATE or DELETE policy -> both are denied by RLS. Append-only: a link
-- records a fact about what an assumption affects and is never itself
-- edited (FIBDB-013 "IMMUTABILITY: none beyond the assumption's own
-- versioning").
