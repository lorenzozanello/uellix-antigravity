-- FIBIU-03 — generic domain-object version lineage, stage A/B
-- (FIBC-002/FIBC-045/FIBDB-004), plus the indicators/stakeholder_groups
-- lifecycle+archive path their exit gate requires.
--
-- Hand-edited from the generated schema diff (drizzle-kit generate):
--   * the unrelated `stella_interactions.model_used` DROP DEFAULT line is
--     removed — that column intentionally carries no default (see its
--     schema.ts comment) and this stray statement is a resurfacing of a
--     pre-existing, out-of-scope schema/migration drift (see FIB §16
--     STELLA_MODEL_USED_DRIFT_REMAINS), not a FIBIU-03 change;
--   * the self-referencing `supersedes_version_id` FK is added by hand —
--     drizzle-kit does not emit self-referencing FKs from schema.ts;
--   * the append-only trigger (reusing uellix_forbid_mutation from
--     0030_immutability.sql) and RLS policies are hand-authored, following
--     the audit_logs pattern (0031_rls_core.sql SELECT policy,
--     0042_fib_audit_insert_policy.sql INSERT policy): SELECT is org-scoped,
--     INSERT is restricted to the runtime role with an actor+org WITH CHECK,
--     and no UPDATE/DELETE policy exists at all — RLS denies by omission,
--     the trigger is defense in depth.
--
-- domain_object_versions is a NEW table (unlike audit_logs, which was
-- retrofitted at stage E), so its append-only trigger ships immediately
-- rather than being deferred — there is no earlier, less-protected state to
-- avoid regressing from. FIBDB-004's "ENABLE ALWAYS" hardening note
-- (bypassing table-owner/superuser trigger exemption) stays deferred to a
-- later consolidated stage-E migration, mirroring 0044's treatment of the
-- FIBIU-28 tables.

CREATE TABLE "domain_object_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"object_type" varchar(100) NOT NULL,
	"object_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"payload_json" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"supersedes_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "domain_object_versions_object_ordinal_unique" UNIQUE("object_type","object_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "indicators" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "indicators" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "indicators" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "stakeholder_groups" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "stakeholder_groups" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "stakeholder_groups" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "domain_object_versions" ADD CONSTRAINT "domain_object_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_object_versions" ADD CONSTRAINT "domain_object_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_object_versions" ADD CONSTRAINT "domain_object_versions_supersedes_version_id_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."domain_object_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_domain_object_versions_object" ON "domain_object_versions" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "idx_domain_object_versions_organization_id" ON "domain_object_versions" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stakeholder_groups" ADD CONSTRAINT "stakeholder_groups_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_status_check" CHECK ("indicators"."status" IN ('active', 'archived'));--> statement-breakpoint
ALTER TABLE "stakeholder_groups" ADD CONSTRAINT "stakeholder_groups_status_check" CHECK ("stakeholder_groups"."status" IN ('active', 'archived'));--> statement-breakpoint

-- Append-only guarantee (FIBC-045: "protected history not silently
-- mutated"). Reuses public.uellix_forbid_mutation() from
-- 0030_immutability.sql unchanged.
CREATE TRIGGER trg_domain_object_versions_append_only
  BEFORE UPDATE OR DELETE ON domain_object_versions
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();--> statement-breakpoint

-- RLS (FIBC-041 tenancy boundary applies to every new table). Mirrors
-- audit_logs: org-scoped SELECT, actor+org-scoped INSERT for the runtime
-- role only, no UPDATE/DELETE policy at all (denied by omission — the
-- trigger above is defense in depth, not the only guard).
ALTER TABLE domain_object_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "domain_object_versions_select" ON domain_object_versions;--> statement-breakpoint
CREATE POLICY "domain_object_versions_select" ON domain_object_versions FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "domain_object_versions_insert" ON domain_object_versions;--> statement-breakpoint
CREATE POLICY "domain_object_versions_insert"
ON domain_object_versions FOR INSERT
TO uellix_app
WITH CHECK (
  created_by = auth.uid()
  AND (
    organization_id = ANY(current_user_org_ids())
    OR current_user_is_super_admin()
  )
);
-- No UPDATE or DELETE policy → both are denied by RLS.
