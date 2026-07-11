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
