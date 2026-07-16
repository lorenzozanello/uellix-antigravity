-- db/policies/002_stella_interactions_rls.sql
-- RLS policies for stella_interactions (Sprint 9D).
-- Append-only audit trail: SELECT for org members, INSERT via service client only,
-- UPDATE and DELETE explicitly denied by absence of permissive policies.
-- Run in Supabase SQL Editor after applying migration 0012_stella_interactions.sql.

-- ============================================================
-- ENABLE RLS
-- ============================================================

ALTER TABLE stella_interactions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- STELLA INTERACTIONS TABLE (APPEND-ONLY AUDIT TRAIL)
-- ============================================================
-- Mirrors the audit_logs pattern:
--   - No INSERT policy: inserts are strictly server-side via service-role client
--     (getStellaValidator/getStellaAdvisor server actions use Drizzle with DATABASE_URL
--      which bypasses RLS, identical to logAuditAction())
--   - SELECT: org members can read their own org's interactions; super_admin sees all
--   - No UPDATE policy: UPDATE is denied (append-only guarantee)
--   - No DELETE policy: DELETE is denied (audit trail integrity)

DROP POLICY IF EXISTS "stella_interactions_select_member_or_admin" ON stella_interactions;
CREATE POLICY "stella_interactions_select_member_or_admin"
ON stella_interactions FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

-- EXPLICITLY DENY INSERT via RLS (no permissive INSERT policy).
-- All inserts must go through getStellaValidator / getStellaAdvisor server actions
-- using the Drizzle service client (DATABASE_URL), which bypasses RLS.
-- This prevents direct client-side inserts even if someone calls the Supabase client directly.
DROP POLICY IF EXISTS "stella_interactions_insert_denied" ON stella_interactions;

-- No UPDATE policy → UPDATE is denied by RLS
-- No DELETE policy → DELETE is denied by RLS
-- Append-only semantics enforced at database layer.
-- db/policies/003_signup_allowlist_rls.sql
-- RLS policies for signup_allowlist. Global table (no organization_id) that
-- gates self-serve org creation in onboarding — only super_admins may read
-- or manage it. Regular authenticated users never query this table directly
-- (the allowlist check happens server-side in createFirstOrganization via
-- the Drizzle service client, which bypasses RLS) — these policies exist as
-- defense-in-depth against direct client-side access.
-- Run in Supabase SQL Editor after applying migration 0014_fine_blade.sql.

-- ============================================================
-- ENABLE RLS
-- ============================================================

ALTER TABLE signup_allowlist ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- SIGNUP_ALLOWLIST TABLE (SUPER_ADMIN ONLY)
-- ============================================================

DROP POLICY IF EXISTS "signup_allowlist_select_super_admin" ON signup_allowlist;
CREATE POLICY "signup_allowlist_select_super_admin"
ON signup_allowlist FOR SELECT
USING (current_user_is_super_admin());

DROP POLICY IF EXISTS "signup_allowlist_insert_super_admin" ON signup_allowlist;
CREATE POLICY "signup_allowlist_insert_super_admin"
ON signup_allowlist FOR INSERT
WITH CHECK (current_user_is_super_admin());

DROP POLICY IF EXISTS "signup_allowlist_delete_super_admin" ON signup_allowlist;
CREATE POLICY "signup_allowlist_delete_super_admin"
ON signup_allowlist FOR DELETE
USING (current_user_is_super_admin());

-- No UPDATE policy → entries are immutable once created (remove and re-add
-- instead of editing), matching the audit_logs/stella_interactions pattern.
-- db/policies/004_fx_tables_rls.sql
-- RLS for the Fase 1a FX foundation tables (funders, fx_rates,
-- outcome_funder_allocations). Mirrors the org-scoped pattern in
-- 001_initial_auth_rls.sql and reuses its SECURITY DEFINER helpers
-- (current_user_org_ids / current_user_is_super_admin / current_user_role_in_org).
-- Run in the Supabase SQL Editor. Idempotent: drops policies before recreating.

ALTER TABLE funders ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_funder_allocations ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- FUNDERS (org-scoped; analyst+ can create/update)
-- ============================================================
DROP POLICY IF EXISTS "funders_select" ON funders;
CREATE POLICY "funders_select" ON funders FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "funders_insert" ON funders;
CREATE POLICY "funders_insert" ON funders FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "funders_update" ON funders;
CREATE POLICY "funders_update" ON funders FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)

-- ============================================================
-- FX RATES
-- Shared auto-fetched rates carry organization_id IS NULL and are readable by
-- any authenticated user. They are written only by the server (service role,
-- which bypasses RLS) — a regular user cannot INSERT an org-NULL row because
-- current_user_role_in_org(NULL) returns NULL. Manual rates are org-scoped and
-- writable by analyst+ in that org.
-- ============================================================
DROP POLICY IF EXISTS "fx_rates_select" ON fx_rates;
CREATE POLICY "fx_rates_select" ON fx_rates FOR SELECT
USING (
  (auth.uid() IS NOT NULL AND organization_id IS NULL)
  OR organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "fx_rates_insert" ON fx_rates;
CREATE POLICY "fx_rates_insert" ON fx_rates FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "fx_rates_update" ON fx_rates;
CREATE POLICY "fx_rates_update" ON fx_rates FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)

-- ============================================================
-- OUTCOME FUNDER ALLOCATIONS (org-scoped; analyst+ can create/update)
-- ============================================================
DROP POLICY IF EXISTS "outcome_funder_allocations_select" ON outcome_funder_allocations;
CREATE POLICY "outcome_funder_allocations_select" ON outcome_funder_allocations FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcome_funder_allocations_insert" ON outcome_funder_allocations;
CREATE POLICY "outcome_funder_allocations_insert" ON outcome_funder_allocations FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcome_funder_allocations_update" ON outcome_funder_allocations;
CREATE POLICY "outcome_funder_allocations_update" ON outcome_funder_allocations FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)
-- db/policies/005_theory_of_change_rls.sql
-- RLS for the Fase 2a structured theory-of-change tables (theory_of_change_nodes,
-- theory_of_change_links). Mirrors the org-scoped pattern in
-- 001_initial_auth_rls.sql and reuses its SECURITY DEFINER helpers
-- (current_user_org_ids / current_user_is_super_admin / current_user_role_in_org).
-- Run in the Supabase SQL Editor. Idempotent: drops policies before recreating.

ALTER TABLE theory_of_change_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE theory_of_change_links ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- THEORY OF CHANGE NODES (org-scoped; analyst+ can create/update)
-- ============================================================
DROP POLICY IF EXISTS "theory_of_change_nodes_select" ON theory_of_change_nodes;
CREATE POLICY "theory_of_change_nodes_select" ON theory_of_change_nodes FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "theory_of_change_nodes_insert" ON theory_of_change_nodes;
CREATE POLICY "theory_of_change_nodes_insert" ON theory_of_change_nodes FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "theory_of_change_nodes_update" ON theory_of_change_nodes;
CREATE POLICY "theory_of_change_nodes_update" ON theory_of_change_nodes FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)

-- ============================================================
-- THEORY OF CHANGE LINKS (org-scoped; analyst+ can create/update)
-- ============================================================
DROP POLICY IF EXISTS "theory_of_change_links_select" ON theory_of_change_links;
CREATE POLICY "theory_of_change_links_select" ON theory_of_change_links FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "theory_of_change_links_insert" ON theory_of_change_links;
CREATE POLICY "theory_of_change_links_insert" ON theory_of_change_links FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "theory_of_change_links_update" ON theory_of_change_links;
CREATE POLICY "theory_of_change_links_update" ON theory_of_change_links FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)
-- db/policies/006_methodology_review_rls.sql
-- RLS for the Fase 2 generalized methodology review matrix tables
-- (methodology_review_matrix, methodology_review_matrix_items). Mirrors the
-- org-scoped pattern in 001_initial_auth_rls.sql and reuses its SECURITY DEFINER
-- helpers (current_user_org_ids / current_user_is_super_admin /
-- current_user_role_in_org). Reviewing roles (super_admin, organization_admin,
-- impact_manager, reviewer) may create/update — matching upsertSroiRunReviewItem.
-- Run in the Supabase SQL Editor. Idempotent: drops policies before recreating.

ALTER TABLE methodology_review_matrix ENABLE ROW LEVEL SECURITY;
ALTER TABLE methodology_review_matrix_items ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- METHODOLOGY REVIEW MATRIX (org-scoped; reviewer+ can create/update)
-- ============================================================
DROP POLICY IF EXISTS "methodology_review_matrix_select" ON methodology_review_matrix;
CREATE POLICY "methodology_review_matrix_select" ON methodology_review_matrix FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "methodology_review_matrix_insert" ON methodology_review_matrix;
CREATE POLICY "methodology_review_matrix_insert" ON methodology_review_matrix FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "methodology_review_matrix_update" ON methodology_review_matrix;
CREATE POLICY "methodology_review_matrix_update" ON methodology_review_matrix FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)

-- ============================================================
-- METHODOLOGY REVIEW MATRIX ITEMS (org-scoped; reviewer+ can create/update)
-- ============================================================
DROP POLICY IF EXISTS "methodology_review_matrix_items_select" ON methodology_review_matrix_items;
CREATE POLICY "methodology_review_matrix_items_select" ON methodology_review_matrix_items FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "methodology_review_matrix_items_insert" ON methodology_review_matrix_items;
CREATE POLICY "methodology_review_matrix_items_insert" ON methodology_review_matrix_items FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "methodology_review_matrix_items_update" ON methodology_review_matrix_items;
CREATE POLICY "methodology_review_matrix_items_update" ON methodology_review_matrix_items FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)
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
