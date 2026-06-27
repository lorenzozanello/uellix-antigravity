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
