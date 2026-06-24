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
-- NOTES
-- ============================================================
-- 1. Application-side validation in lib/auth/session.ts must still be enforced
--    server-side. RLS is a defense-in-depth layer, not a substitute.
-- 2. The onboarding flow (createFirstOrganization server action) uses the
--    Drizzle client which connects with DATABASE_URL (service role), bypassing
--    RLS. This is intentional for the initial org+member creation.
-- 3. logAuditAction() also uses the service-level Drizzle client, which is
--    correct since audit logging should never be blocked by RLS.
