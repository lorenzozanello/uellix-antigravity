-- FIBIU-07 — governed evidence erasure substrate, stage A ONLY
-- (FIBC-009/FIBDB-031, plus FIBIU-07's slice of FIBDB-043's erasure
-- vocabulary on evidence_versions). Generated cleanly by drizzle-kit
-- generate; RLS is hand-authored below.
--
-- STAGE RULE (W2-00 §7, per-item assignment): FIBDB-032 (revoke
-- evidence_items DELETE from authenticated) and FIBDB-033 (explicit
-- DELETE-rejection trigger) are stage-E hardening that "must ship
-- together" per FIB §4 — and stage E is deliberately NOT executed here.
-- Today's ambiguous DELETE path (GRANT present at 0033:35, RLS policy
-- absent since 0031:418-419 — a silent 0-row DELETE) is UNCHANGED by this
-- migration. What ships here is the governed, application-level erasure
-- path (lib/pipeline/evidence.ts) and the tombstone it produces — an
-- alternative route that does not depend on, and does not yet close, the
-- ambiguous ordinary DELETE.

CREATE TABLE "evidence_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"evidence_version_id" uuid NOT NULL,
	"erasure_state" varchar(50) NOT NULL,
	"erasure_reason" varchar(50) NOT NULL,
	"rationale" text NOT NULL,
	"content_hash_preserved" boolean DEFAULT true NOT NULL,
	"content_hash" varchar(64),
	"actor_user_id" uuid NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_tombstones_erasure_state_check" CHECK ("evidence_tombstones"."erasure_state" IN ('erasure_complete', 'erasure_partial', 'erasure_blocked')),
	CONSTRAINT "evidence_tombstones_erasure_reason_check" CHECK ("evidence_tombstones"."erasure_reason" IN ('privacy_or_data_subject_request', 'retention_policy', 'unauthorized_or_erroneous_upload', 'confidentiality_or_access_violation', 'legal_or_contractual_requirement', 'other_governed_reason'))
);
--> statement-breakpoint
ALTER TABLE "evidence_tombstones" ADD CONSTRAINT "evidence_tombstones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_tombstones" ADD CONSTRAINT "evidence_tombstones_evidence_id_evidence_items_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_tombstones" ADD CONSTRAINT "evidence_tombstones_evidence_version_id_evidence_versions_id_fk" FOREIGN KEY ("evidence_version_id") REFERENCES "public"."evidence_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_tombstones" ADD CONSTRAINT "evidence_tombstones_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_evidence_tombstones_evidence_id" ON "evidence_tombstones" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "idx_evidence_tombstones_organization_id" ON "evidence_tombstones" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_erasure_state_check" CHECK ("evidence_versions"."erasure_state" IS NULL OR "evidence_versions"."erasure_state" IN ('erasure_requested', 'erasure_in_progress', 'erasure_complete', 'erasure_partial', 'erasure_blocked'));--> statement-breakpoint

-- RLS (FIBC-041 tenancy boundary). Append-only, no UPDATE/DELETE policy.
-- INSERT is restricted to organization_admin+ — FIBC-009: "a discrete
-- permission (canEraseEvidenceContent, organization_admin+)".
ALTER TABLE evidence_tombstones ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "evidence_tombstones_select" ON evidence_tombstones;--> statement-breakpoint
CREATE POLICY "evidence_tombstones_select" ON evidence_tombstones FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "evidence_tombstones_insert" ON evidence_tombstones;--> statement-breakpoint
CREATE POLICY "evidence_tombstones_insert"
ON evidence_tombstones FOR INSERT
WITH CHECK (
  actor_user_id = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
    OR current_user_is_super_admin()
  )
);
-- No UPDATE or DELETE policy → both are denied by RLS.