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
