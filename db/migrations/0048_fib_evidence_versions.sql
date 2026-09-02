-- FIBIU-04 — evidence version lineage and content persistence, stage A/B
-- (FIBC-005/FIBC-006/FIBDB-005/FIBDB-037).
--
-- Hand-edited from the generated schema diff (drizzle-kit generate):
--   * the unrelated `stella_interactions.model_used` DROP DEFAULT line is
--     removed — that column intentionally carries no default (see its
--     schema.ts comment) and this stray statement is a resurfacing of the
--     same pre-existing, out-of-scope schema/migration drift 0045 already
--     excluded (see FIB §16 STELLA_MODEL_USED_DRIFT_REMAINS), not a
--     FIBIU-04 change;
--   * the self-referencing `supersedes_version_id` FK is added by hand —
--     drizzle-kit does not emit self-referencing FKs from schema.ts, the
--     same gap 0045 hand-filled for domain_object_versions;
--   * `evidence_items_content_hash_format_check` is reordered onto its own
--     statement with `NOT VALID` appended by hand — legacy rows are exempt
--     (FIBDB-037 BACKFILL_CLASS: PROSPECTIVE_ONLY), new writes are checked;
--   * the stage-B backfill (one v1 shell row per existing evidence_items
--     row) and RLS policies are hand-authored, following the evidence_items
--     pattern (0031_rls_core.sql) for the row-level policies and the
--     domain_object_versions pattern (0045) for a dedicated version table.
--
-- evidence_versions is a NEW table specializing FIBC-002's generic
-- domain_object_versions substrate for evidence (its own table, not a row
-- inside that generic one — FIBC-002: "append-only domain_object_versions
-- (generic) plus dedicated evidence_versions ... specializations"). Unlike
-- domain_object_versions, stage-E approved/used-version immutability is
-- explicitly deferred (FIBDB-005), so no append-only trigger ships here —
-- this table is mutable at stage A the same way evidence_items itself is.

CREATE TABLE "evidence_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text,
	"content_hash" varchar(64),
	"sensitivity_classification" varchar(50),
	"treatment" varchar(50),
	"review_status" varchar(50) DEFAULT 'draft' NOT NULL,
	"legacy_content_unverifiable" boolean DEFAULT false NOT NULL,
	"erasure_state" varchar(50),
	"supersedes_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_versions_evidence_ordinal_unique" UNIQUE("evidence_id","ordinal"),
	CONSTRAINT "evidence_versions_review_status_check" CHECK ("evidence_versions"."review_status" IN ('draft', 'under_review', 'approved', 'rejected', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_evidence_id_evidence_items_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_supersedes_version_id_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."evidence_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_evidence_versions_evidence_id" ON "evidence_versions" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "idx_evidence_versions_organization_id" ON "evidence_versions" USING btree ("organization_id");--> statement-breakpoint

-- FIBDB-037 (FIBC-006) — SHA-256 hex format on the pre-existing
-- evidence_items.content_hash column. NOT VALID: existing rows are exempt
-- (many predate a hashing convention this strict), new writes are checked.
-- Stage-E VALIDATE CONSTRAINT (scoped to the pc01b regime — see W2-GAP-2,
-- shared with FIBIU-24/FIBDB-038) is deferred.
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_content_hash_format_check" CHECK ("evidence_items"."content_hash" IS NULL OR "evidence_items"."content_hash" ~ '^[0-9a-f]{64}$') NOT VALID;--> statement-breakpoint

-- Stage B — structural backfill. One v1 shell row per existing
-- evidence_items row: reviewStatus/contentHash/created_by/created_at
-- mirrored from what already exists (never invented); content stays NULL
-- for every backfilled row because no original text bytes were ever
-- persisted before this migration (file bytes remain in storage; url
-- content was never retained either). legacy_content_unverifiable is set
-- true ONLY for type='text' — the one type FIBC-006 names as unverifiable
-- by construction ("Historical text evidence is marked
-- legacy_content_unverifiable — no reconstruction, ever"); file evidence
-- keeps verifying against the storage object via verifyFileEvidenceIntegrity
-- and url evidence was never a content claim. On an empty database this
-- affects zero rows — same class as unit 19 (0018) and unit 52 (0041).
INSERT INTO evidence_versions
  (organization_id, evidence_id, ordinal, content, content_hash, review_status, legacy_content_unverifiable, created_by, created_at)
SELECT
  organization_id,
  id,
  1,
  NULL,
  content_hash,
  status,
  (type = 'text'),
  created_by,
  created_at
FROM evidence_items
WHERE id NOT IN (SELECT evidence_id FROM evidence_versions);--> statement-breakpoint

-- RLS (FIBC-041 tenancy boundary). Mirrors evidence_items (0031_rls_core.sql):
-- org-scoped SELECT, INSERT/UPDATE restricted to the same role floor evidence
-- itself uses, no DELETE policy — governed erasure (FIBIU-07) is not a
-- DELETE and does not need one.
ALTER TABLE evidence_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "evidence_versions_select" ON evidence_versions;--> statement-breakpoint
CREATE POLICY "evidence_versions_select" ON evidence_versions FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "evidence_versions_insert" ON evidence_versions;--> statement-breakpoint
CREATE POLICY "evidence_versions_insert" ON evidence_versions FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "evidence_versions_update" ON evidence_versions;--> statement-breakpoint
CREATE POLICY "evidence_versions_update" ON evidence_versions FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);
-- No DELETE policy → denied by RLS.
