-- db/policies/007_taxonomy_rls.sql
-- RLS for the Fase 3 interoperability tables. taxonomy_catalogs / taxonomy_codes
-- are GLOBAL reference data (public standards: ODS, IRIS+): readable by anyone,
-- never writable through RLS (seeded via the service-role client, which bypasses
-- RLS). outcome_taxonomy_mappings is org-scoped like the rest of the pipeline;
-- outcome-edit roles (analyst+) may create/update/delete.
-- Run in the Supabase SQL Editor. Idempotent: drops policies before recreating.

ALTER TABLE taxonomy_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE taxonomy_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_taxonomy_mappings ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- REFERENCE CATALOGS + CODES (global, read-only via RLS)
-- ============================================================
DROP POLICY IF EXISTS "taxonomy_catalogs_select" ON taxonomy_catalogs;
CREATE POLICY "taxonomy_catalogs_select" ON taxonomy_catalogs FOR SELECT USING (true);

DROP POLICY IF EXISTS "taxonomy_codes_select" ON taxonomy_codes;
CREATE POLICY "taxonomy_codes_select" ON taxonomy_codes FOR SELECT USING (true);

-- No INSERT/UPDATE/DELETE policies: writes only via the service-role seed path.

-- ============================================================
-- OUTCOME ↔ TAXONOMY MAPPINGS (org-scoped; analyst+ can write)
-- ============================================================
DROP POLICY IF EXISTS "outcome_taxonomy_mappings_select" ON outcome_taxonomy_mappings;
CREATE POLICY "outcome_taxonomy_mappings_select" ON outcome_taxonomy_mappings FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcome_taxonomy_mappings_insert" ON outcome_taxonomy_mappings;
CREATE POLICY "outcome_taxonomy_mappings_insert" ON outcome_taxonomy_mappings FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcome_taxonomy_mappings_update" ON outcome_taxonomy_mappings;
CREATE POLICY "outcome_taxonomy_mappings_update" ON outcome_taxonomy_mappings FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcome_taxonomy_mappings_delete" ON outcome_taxonomy_mappings;
CREATE POLICY "outcome_taxonomy_mappings_delete" ON outcome_taxonomy_mappings FOR DELETE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);
