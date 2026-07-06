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
