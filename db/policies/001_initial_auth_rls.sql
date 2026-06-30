-- db/policies/001_initial_auth_rls.sql
-- Hardened RLS policies for Sprint 1.
-- Run in the Supabase SQL Editor (or via a managed migration tool).
-- Script is idempotent: drops existing policies before recreating.

-- ============================================================
-- SECURITY DEFINER HELPERS (run as superuser; bypass RLS safely)
-- ============================================================

-- Returns TRUE if the calling user is a super_admin
CREATE OR REPLACE FUNCTION current_user_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_super_admin FROM users WHERE id = auth.uid() LIMIT 1),
    false
  );
$$;

-- Returns all organization_ids the calling user belongs to (active memberships)
CREATE OR REPLACE FUNCTION current_user_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY(
    SELECT organization_id
    FROM organization_members
    WHERE user_id = auth.uid() AND status = 'active'
  );
$$;

-- Returns the user's role in a specific org, or NULL if not a member
CREATE OR REPLACE FUNCTION current_user_role_in_org(org_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM organization_members
  WHERE user_id = auth.uid() AND organization_id = org_id AND status = 'active'
  LIMIT 1;
$$;

-- ============================================================
-- ENABLE RLS
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- USERS TABLE
-- ============================================================

DROP POLICY IF EXISTS "users_select_own" ON users;
CREATE POLICY "users_select_own"
ON users FOR SELECT
USING (id = auth.uid() OR current_user_is_super_admin());

DROP POLICY IF EXISTS "users_insert_own" ON users;
CREATE POLICY "users_insert_own"
ON users FOR INSERT
WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "users_update_own" ON users;
CREATE POLICY "users_update_own"
ON users FOR UPDATE
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- ============================================================
-- ORGANIZATIONS TABLE
-- ============================================================

DROP POLICY IF EXISTS "orgs_select_member_or_admin" ON organizations;
CREATE POLICY "orgs_select_member_or_admin"
ON organizations FOR SELECT
USING (
  id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "orgs_insert_super_admin" ON organizations;
CREATE POLICY "orgs_insert_super_admin"
ON organizations FOR INSERT
WITH CHECK (current_user_is_super_admin());

DROP POLICY IF EXISTS "orgs_update_admin_or_super" ON organizations;
CREATE POLICY "orgs_update_admin_or_super"
ON organizations FOR UPDATE
USING (
  current_user_role_in_org(id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
);

-- ============================================================
-- ORGANIZATION_MEMBERS TABLE
-- Uses SECURITY DEFINER helpers to avoid infinite recursion
-- ============================================================

DROP POLICY IF EXISTS "members_select_own_org" ON organization_members;
CREATE POLICY "members_select_own_org"
ON organization_members FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "members_insert_admin" ON organization_members;
CREATE POLICY "members_insert_admin"
ON organization_members FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
  -- NOTE: Onboarding (createFirstOrganization server action) uses the Drizzle
  -- service client (DATABASE_URL) which bypasses RLS entirely. No self-insert
  -- exception needed here — that would allow any user to join any org.
);

DROP POLICY IF EXISTS "members_update_admin" ON organization_members;
CREATE POLICY "members_update_admin"
ON organization_members FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "members_delete_admin" ON organization_members;
CREATE POLICY "members_delete_admin"
ON organization_members FOR DELETE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
);

-- ============================================================
-- INVITATIONS TABLE
-- ============================================================

DROP POLICY IF EXISTS "invitations_select_member" ON invitations;
CREATE POLICY "invitations_select_member"
ON invitations FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "invitations_insert_admin" ON invitations;
CREATE POLICY "invitations_insert_admin"
ON invitations FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "invitations_update_admin" ON invitations;
CREATE POLICY "invitations_update_admin"
ON invitations FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR current_user_is_super_admin()
);

-- ============================================================
-- AUDIT_LOGS TABLE (APPEND-ONLY)
-- ============================================================

DROP POLICY IF EXISTS "audit_logs_insert_authenticated" ON audit_logs;
-- Removed "audit_logs_insert_authenticated" policy entirely.
-- Insert is strictly server-side using Drizzle with bypass-RLS (service role).

DROP POLICY IF EXISTS "audit_logs_select_member_or_admin" ON audit_logs;
CREATE POLICY "audit_logs_select_member_or_admin"
ON audit_logs FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

-- EXPLICITLY DENY UPDATE and DELETE on audit_logs (append-only guarantee)
-- No UPDATE policy → UPDATE is denied
-- No DELETE policy → DELETE is denied
-- This is enforced by RLS: without a permissive policy, the operation is rejected.

-- ============================================================
-- PORTFOLIOS TABLE
-- ============================================================

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "portfolios_select_member_or_admin" ON portfolios;
CREATE POLICY "portfolios_select_member_or_admin"
ON portfolios FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "portfolios_insert_allowed_roles" ON portfolios;
CREATE POLICY "portfolios_insert_allowed_roles"
ON portfolios FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "portfolios_update_allowed_roles" ON portfolios;
CREATE POLICY "portfolios_update_allowed_roles"
ON portfolios FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- ============================================================
-- PROJECTS TABLE
-- ============================================================

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_select_member_or_admin" ON projects;
CREATE POLICY "projects_select_member_or_admin"
ON projects FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "projects_insert_allowed_roles" ON projects;
CREATE POLICY "projects_insert_allowed_roles"
ON projects FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "projects_update_allowed_roles" ON projects;
CREATE POLICY "projects_update_allowed_roles"
ON projects FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- ============================================================
-- SROI PIPELINE CORE TABLES
-- ============================================================

ALTER TABLE impact_narratives ENABLE ROW LEVEL SECURITY;
ALTER TABLE stakeholder_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE indicators ENABLE ROW LEVEL SECURITY;

-- IMPACT NARRATIVES
DROP POLICY IF EXISTS "impact_narratives_select" ON impact_narratives;
CREATE POLICY "impact_narratives_select" ON impact_narratives FOR SELECT
USING (
  project_id IN (SELECT id FROM projects WHERE organization_id = ANY(current_user_org_ids()))
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "impact_narratives_insert" ON impact_narratives;
CREATE POLICY "impact_narratives_insert" ON impact_narratives FOR INSERT
WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "impact_narratives_update" ON impact_narratives;
CREATE POLICY "impact_narratives_update" ON impact_narratives FOR UPDATE
USING (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
)
WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
);

-- STAKEHOLDER GROUPS
DROP POLICY IF EXISTS "stakeholder_groups_select" ON stakeholder_groups;
CREATE POLICY "stakeholder_groups_select" ON stakeholder_groups FOR SELECT
USING (
  project_id IN (SELECT id FROM projects WHERE organization_id = ANY(current_user_org_ids()))
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "stakeholder_groups_insert" ON stakeholder_groups;
CREATE POLICY "stakeholder_groups_insert" ON stakeholder_groups FOR INSERT
WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "stakeholder_groups_update" ON stakeholder_groups;
CREATE POLICY "stakeholder_groups_update" ON stakeholder_groups FOR UPDATE
USING (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
)
WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
);

-- OUTCOMES
DROP POLICY IF EXISTS "outcomes_select" ON outcomes;
CREATE POLICY "outcomes_select" ON outcomes FOR SELECT
USING (
  project_id IN (SELECT id FROM projects WHERE organization_id = ANY(current_user_org_ids()))
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcomes_insert" ON outcomes;
CREATE POLICY "outcomes_insert" ON outcomes FOR INSERT
WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcomes_update" ON outcomes;
CREATE POLICY "outcomes_update" ON outcomes FOR UPDATE
USING (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
)
WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
);

-- INDICATORS
DROP POLICY IF EXISTS "indicators_select" ON indicators;
CREATE POLICY "indicators_select" ON indicators FOR SELECT
USING (
  project_id IN (SELECT id FROM projects WHERE organization_id = ANY(current_user_org_ids()))
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "indicators_insert" ON indicators;
CREATE POLICY "indicators_insert" ON indicators FOR INSERT
WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "indicators_update" ON indicators;
CREATE POLICY "indicators_update" ON indicators FOR UPDATE
USING (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
)
WITH CHECK (
  project_id IN (SELECT id FROM projects WHERE current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst'))
  OR current_user_is_super_admin()
);

-- EVIDENCE ITEMS
ALTER TABLE evidence_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_items_select" ON evidence_items;
CREATE POLICY "evidence_items_select" ON evidence_items FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "evidence_items_insert" ON evidence_items;
CREATE POLICY "evidence_items_insert" ON evidence_items FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "evidence_items_update" ON evidence_items;
CREATE POLICY "evidence_items_update" ON evidence_items FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE is strictly denied for evidence_items. Archiving must be performed via UPDATE to status='archived'.
DROP POLICY IF EXISTS "evidence_items_delete" ON evidence_items;

-- ============================================================
-- STORAGE CONFIGURATION (Declarative)
-- ============================================================
-- The 'uellix-evidence' bucket must be created in Supabase Storage with:
-- - Public Access: False
-- - File Size Limit: Enforced per plan
-- - Allowed MIME Types: Images, PDFs, Documents (TBD)
-- RLS Policies for Storage should map to organization_ids in the file path
-- or be validated against the evidence_items table via function.

-- ============================================================
-- NOTES
-- ============================================================
-- 1. Application-side validation in lib/auth/session.ts must still be enforced
--    server-side. RLS is a defense-in-depth layer, not a substitute.
-- 2. The onboarding flow (createFirstOrganization server action) uses the
--    Drizzle client which connects with DATABASE_URL (service role), bypassing
--    RLS. This is intentional for the initial org+member creation.
-- 3. logAuditAction() also uses the service-level Drizzle client, which is
--    correct since audit logging should never be blocked by RLS.

-- ============================================================
-- PROXY INTELLIGENCE
-- ============================================================

ALTER TABLE proxy_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_proxies ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_proxy_assignments ENABLE ROW LEVEL SECURITY;

-- PROXY SOURCES
DROP POLICY IF EXISTS "proxy_sources_select" ON proxy_sources;
CREATE POLICY "proxy_sources_select" ON proxy_sources FOR SELECT
USING (
  (auth.uid() IS NOT NULL AND organization_id IS NULL AND status = 'active')
  OR organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "proxy_sources_insert" ON proxy_sources;
CREATE POLICY "proxy_sources_insert" ON proxy_sources FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "proxy_sources_update" ON proxy_sources;
CREATE POLICY "proxy_sources_update" ON proxy_sources FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)

-- FINANCIAL PROXIES
DROP POLICY IF EXISTS "financial_proxies_select" ON financial_proxies;
CREATE POLICY "financial_proxies_select" ON financial_proxies FOR SELECT
USING (
  (auth.uid() IS NOT NULL AND organization_id IS NULL AND review_status = 'approved')
  OR organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "financial_proxies_insert" ON financial_proxies;
CREATE POLICY "financial_proxies_insert" ON financial_proxies FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "financial_proxies_update" ON financial_proxies;
CREATE POLICY "financial_proxies_update" ON financial_proxies FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- DELETE explicitly denied (no policy)

-- OUTCOME PROXY ASSIGNMENTS
DROP POLICY IF EXISTS "outcome_proxy_assignments_select" ON outcome_proxy_assignments;
CREATE POLICY "outcome_proxy_assignments_select" ON outcome_proxy_assignments FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcome_proxy_assignments_insert" ON outcome_proxy_assignments;
CREATE POLICY "outcome_proxy_assignments_insert" ON outcome_proxy_assignments FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "outcome_proxy_assignments_update" ON outcome_proxy_assignments;
CREATE POLICY "outcome_proxy_assignments_update" ON outcome_proxy_assignments FOR UPDATE
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
-- SROI FILTERS & CALCULATION FOUNDATION
-- ============================================================

ALTER TABLE project_investments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sroi_assignment_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sroi_filter_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sroi_calculation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sroi_calculation_line_items ENABLE ROW LEVEL SECURITY;

-- PROJECT INVESTMENTS
DROP POLICY IF EXISTS "project_investments_select" ON project_investments;
CREATE POLICY "project_investments_select" ON project_investments FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "project_investments_insert" ON project_investments;
CREATE POLICY "project_investments_insert" ON project_investments FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "project_investments_update" ON project_investments;
CREATE POLICY "project_investments_update" ON project_investments FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- SROI ASSIGNMENT INPUTS
DROP POLICY IF EXISTS "sroi_assignment_inputs_select" ON sroi_assignment_inputs;
CREATE POLICY "sroi_assignment_inputs_select" ON sroi_assignment_inputs FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_assignment_inputs_insert" ON sroi_assignment_inputs;
CREATE POLICY "sroi_assignment_inputs_insert" ON sroi_assignment_inputs FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_assignment_inputs_update" ON sroi_assignment_inputs;
CREATE POLICY "sroi_assignment_inputs_update" ON sroi_assignment_inputs FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- SROI FILTER SETS
DROP POLICY IF EXISTS "sroi_filter_sets_select" ON sroi_filter_sets;
CREATE POLICY "sroi_filter_sets_select" ON sroi_filter_sets FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_filter_sets_insert" ON sroi_filter_sets;
CREATE POLICY "sroi_filter_sets_insert" ON sroi_filter_sets FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_filter_sets_update" ON sroi_filter_sets;
CREATE POLICY "sroi_filter_sets_update" ON sroi_filter_sets FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- SROI CALCULATION RUNS
DROP POLICY IF EXISTS "sroi_calculation_runs_select" ON sroi_calculation_runs;
CREATE POLICY "sroi_calculation_runs_select" ON sroi_calculation_runs FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_calculation_runs_insert" ON sroi_calculation_runs;
CREATE POLICY "sroi_calculation_runs_insert" ON sroi_calculation_runs FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- SROI CALCULATION LINE ITEMS
DROP POLICY IF EXISTS "sroi_calculation_line_items_select" ON sroi_calculation_line_items;
CREATE POLICY "sroi_calculation_line_items_select" ON sroi_calculation_line_items FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_calculation_line_items_insert" ON sroi_calculation_line_items;
CREATE POLICY "sroi_calculation_line_items_insert" ON sroi_calculation_line_items FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- ============================================================
-- SROI RESULTS HARDENING & REPORT FOUNDATION
-- ============================================================

ALTER TABLE sroi_run_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE sroi_run_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sroi_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE sroi_report_sections ENABLE ROW LEVEL SECURITY;

-- SROI RUN REVIEWS
DROP POLICY IF EXISTS "sroi_run_reviews_select" ON sroi_run_reviews;
CREATE POLICY "sroi_run_reviews_select" ON sroi_run_reviews FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_run_reviews_insert" ON sroi_run_reviews;
CREATE POLICY "sroi_run_reviews_insert" ON sroi_run_reviews FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_run_reviews_update" ON sroi_run_reviews;
CREATE POLICY "sroi_run_reviews_update" ON sroi_run_reviews FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
);

-- SROI RUN REVIEW ITEMS
DROP POLICY IF EXISTS "sroi_run_review_items_select" ON sroi_run_review_items;
CREATE POLICY "sroi_run_review_items_select" ON sroi_run_review_items FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_run_review_items_insert" ON sroi_run_review_items;
CREATE POLICY "sroi_run_review_items_insert" ON sroi_run_review_items FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_run_review_items_update" ON sroi_run_review_items;
CREATE POLICY "sroi_run_review_items_update" ON sroi_run_review_items FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'reviewer')
  OR current_user_is_super_admin()
);

-- SROI REPORTS
DROP POLICY IF EXISTS "sroi_reports_select" ON sroi_reports;
CREATE POLICY "sroi_reports_select" ON sroi_reports FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_reports_insert" ON sroi_reports;
CREATE POLICY "sroi_reports_insert" ON sroi_reports FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_reports_update" ON sroi_reports;
CREATE POLICY "sroi_reports_update" ON sroi_reports FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

-- SROI REPORT SECTIONS
DROP POLICY IF EXISTS "sroi_report_sections_select" ON sroi_report_sections;
CREATE POLICY "sroi_report_sections_select" ON sroi_report_sections FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_report_sections_insert" ON sroi_report_sections;
CREATE POLICY "sroi_report_sections_insert" ON sroi_report_sections FOR INSERT
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);

DROP POLICY IF EXISTS "sroi_report_sections_update" ON sroi_report_sections;
CREATE POLICY "sroi_report_sections_update" ON sroi_report_sections FOR UPDATE
USING (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
)
WITH CHECK (
  current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
  OR current_user_is_super_admin()
);
