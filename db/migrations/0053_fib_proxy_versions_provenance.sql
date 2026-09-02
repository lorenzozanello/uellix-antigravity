-- FIBIU-08 — proxy versions and provenance, stage A
-- (FIBC-010/FIBC-012/FIBDB-006/FIBDB-039).
--
-- Hand-edited from the generated schema diff (drizzle-kit generate):
--   * the self-referencing `supersedes_version_id` FK is added by hand —
--     drizzle-kit does not emit self-referencing FKs from schema.ts, the
--     same gap 0045 (domain_object_versions) and 0048 (evidence_versions)
--     hand-filled;
--   * RLS policies are hand-authored, following the SAME shape
--     financial_proxies itself already uses (0031_rls_core.sql): a global
--     row (organization_id IS NULL) is visible once approved, an org-owned
--     row is visible to its own organisation, INSERT/UPDATE share the same
--     role floor as financial_proxies/proxy_sources/outcome_proxy_
--     assignments, and no DELETE policy exists (denied by omission — this
--     is version lineage, never deleted).
--
-- financial_proxy_versions is a NEW table specializing FIBC-002's generic
-- domain_object_versions substrate for financial proxies (its own table,
-- not a row inside that generic one), mirroring evidence_versions'
-- treatment for evidence. Unlike a plain FIBC-002 specialization, this one
-- also seals FIBC-012's approval identity (reviewer_id/reviewed_at) ON THE
-- VERSION — the sealed contract's own words: "Approval is sealed on the
-- proxy version with approver identity and timestamp." Rubric factors
-- (C1-C6/R1-R7) and derived scores are FIBDB-006 field-list items (OWNING
-- UNIT: FIBIU-08) and land as columns here; their FIBDB-044 range/derived-
-- consistency CHECK constraints are FIBIU-09's own migration, not this one.
-- Stage A: mutable in place for review-lifecycle transitions on the CURRENT
-- version, matching evidence_versions' stage-A/stage-E split — post-
-- approval immutability is FIBDB-006's declared hardening stage E, deferred.
--
-- outcome_proxy_assignments gains financial_proxy_version_id (FIBDB-039):
-- binds an assignment to the exact version reviewed at assignment time,
-- immutable per run. NULL (existing rows, backfilled as NULL — there is no
-- historical version to attribute them to) reads as ineligible for the
-- calculation engine (lib/pipeline/sroi-calculation.ts), never as "fall
-- back to whatever the live proxy currently says."

CREATE TABLE "financial_proxy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"financial_proxy_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"source_id" uuid NOT NULL,
	"value" numeric(20, 4),
	"currency" varchar(10),
	"unit" varchar(50),
	"reference_year" integer,
	"value_usd" numeric(20, 4),
	"fx_rate_id" uuid,
	"country" varchar(2),
	"territory" varchar(255),
	"thematic_area" varchar(255),
	"methodology" text,
	"geographic_contextual_scope" text,
	"linked_outcome_context" text,
	"recoverable_reference" text,
	"relevance_justification" text,
	"documented_transformations" text,
	"consultation_date" timestamp,
	"c1_source_quality_verifiability" integer,
	"c2_outcome_correspondence" integer,
	"c3_stakeholder_population_fit" integer,
	"c4_geographic_context_fit" integer,
	"c5_temporal_fit" integer,
	"c6_methodological_unit_comparability" integer,
	"r1_provenance_risk" integer,
	"r2_source_limitation_risk" integer,
	"r3_conceptual_fit_risk" integer,
	"r4_geographic_population_transfer_risk" integer,
	"r5_temporal_obsolescence_risk" integer,
	"r6_transformation_risk" integer,
	"r7_methodological_uncertainty_risk" integer,
	"confidence_score" integer,
	"confidence_level" varchar(20),
	"methodological_risk_score" integer,
	"methodological_risk" varchar(20),
	"rubric_version" varchar(20),
	"exceptional_defendibility_determination" text,
	"review_status" varchar(50) DEFAULT 'draft' NOT NULL,
	"reviewer_id" uuid,
	"reviewed_at" timestamp,
	"supersedes_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "financial_proxy_versions_proxy_ordinal_unique" UNIQUE("financial_proxy_id","ordinal"),
	CONSTRAINT "financial_proxy_versions_review_status_check" CHECK ("financial_proxy_versions"."review_status" IN ('draft', 'under_review', 'approved', 'rejected', 'archived')),
	CONSTRAINT "financial_proxy_versions_confidence_level_check" CHECK ("financial_proxy_versions"."confidence_level" IS NULL OR "financial_proxy_versions"."confidence_level" IN ('high', 'medium', 'low')),
	CONSTRAINT "financial_proxy_versions_methodological_risk_check" CHECK ("financial_proxy_versions"."methodological_risk" IS NULL OR "financial_proxy_versions"."methodological_risk" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD COLUMN "financial_proxy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_financial_proxy_id_financial_proxies_id_fk" FOREIGN KEY ("financial_proxy_id") REFERENCES "public"."financial_proxies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_source_id_proxy_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."proxy_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_proxy_versions" ADD CONSTRAINT "financial_proxy_versions_supersedes_version_id_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."financial_proxy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_financial_proxy_versions_proxy_id" ON "financial_proxy_versions" USING btree ("financial_proxy_id");--> statement-breakpoint
CREATE INDEX "idx_financial_proxy_versions_organization_id" ON "financial_proxy_versions" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "outcome_proxy_assignments" ADD CONSTRAINT "outcome_proxy_assignments_financial_proxy_version_id_financial_proxy_versions_id_fk" FOREIGN KEY ("financial_proxy_version_id") REFERENCES "public"."financial_proxy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_opa_proxy_version_id" ON "outcome_proxy_assignments" USING btree ("financial_proxy_version_id");--> statement-breakpoint

-- RLS (FIBC-041 tenancy boundary). Mirrors financial_proxies exactly
-- (0031_rls_core.sql): a global version (organization_id IS NULL) is
-- visible once its own review_status is 'approved', an org-owned version is
-- visible to its own organisation, super_admin sees everything. INSERT/
-- UPDATE share the same role floor as financial_proxies itself. No DELETE
-- policy — version lineage is append-only-by-convention at stage A (no
-- trigger yet, matching evidence_versions' same stage-A/stage-E split).
ALTER TABLE financial_proxy_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "financial_proxy_versions_select" ON financial_proxy_versions;--> statement-breakpoint
CREATE POLICY "financial_proxy_versions_select" ON financial_proxy_versions FOR SELECT
USING (
  (auth.uid() IS NOT NULL AND organization_id IS NULL AND review_status = 'approved')
  OR organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "financial_proxy_versions_insert" ON financial_proxy_versions;--> statement-breakpoint
CREATE POLICY "financial_proxy_versions_insert" ON financial_proxy_versions FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "financial_proxy_versions_update" ON financial_proxy_versions;--> statement-breakpoint
CREATE POLICY "financial_proxy_versions_update" ON financial_proxy_versions FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);
-- No DELETE policy → denied by RLS.
