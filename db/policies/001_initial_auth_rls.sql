-- db/policies/001_initial_auth_rls.sql
-- This file contains the initial Row Level Security (RLS) policies for the MVP.
-- Since Supabase is managed through the platform, these should be executed manually
-- in the Supabase SQL Editor if not fully managed by Drizzle migrations.

-- Enable RLS on core tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own organization
CREATE POLICY "Users can view their own organization"
ON organizations
FOR SELECT
USING (
  id IN (
    SELECT organization_id 
    FROM organization_members 
    WHERE user_id = auth.uid()
  )
);

-- Policy: Users can view members of their own organization
CREATE POLICY "Users can view members of their own organization"
ON organization_members
FOR SELECT
USING (
  organization_id IN (
    SELECT organization_id 
    FROM organization_members 
    WHERE user_id = auth.uid()
  )
);

-- Policy: Organization Admins can manage members
-- Requires custom claims or subqueries. For MVP, relying on application logic.
-- NOTE: For full security, implement proper role checks in SQL or use custom JWT claims.
CREATE POLICY "OrgAdmins can manage members"
ON organization_members
FOR ALL
USING (
  organization_id IN (
    SELECT organization_id 
    FROM organization_members 
    WHERE user_id = auth.uid() AND role IN ('super_admin', 'organization_admin')
  )
);

-- Policy: Users can view invitations for their organization
CREATE POLICY "Users can view invitations for their org"
ON invitations
FOR SELECT
USING (
  organization_id IN (
    SELECT organization_id 
    FROM organization_members 
    WHERE user_id = auth.uid()
  )
);

-- Policy: Audit Logs are append-only and viewable by org
CREATE POLICY "Audit logs are append-only"
ON audit_logs
FOR INSERT
WITH CHECK (
  -- Requires application logic to enforce actor_user_id = auth.uid()
  actor_user_id = auth.uid() OR actor_user_id IS NULL
);

CREATE POLICY "Users can view org audit logs"
ON audit_logs
FOR SELECT
USING (
  organization_id IN (
    SELECT organization_id 
    FROM organization_members 
    WHERE user_id = auth.uid()
  )
);

-- NOTE/WARNING: These policies are foundational.
-- To prevent infinite recursion in `organization_members` queries, you may need to use a security definer function.
-- Do not rely solely on RLS for role validation without custom claims or proper SQL functions.
-- Server-side validation via `lib/auth/permissions.ts` must still be strictly enforced.
