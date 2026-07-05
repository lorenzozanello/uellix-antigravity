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
