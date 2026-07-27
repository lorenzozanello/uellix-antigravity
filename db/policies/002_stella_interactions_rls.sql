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
--   - No INSERT policy: inserts happen exclusively via app/actions/stella's
--     recordStellaInteraction() (lib/stella/audit-log.ts), which uses Drizzle
--     over DATABASE_URL. Correction (Etapa A1, STL-A1-014, verified against
--     code 2026-07-25): DATABASE_URL connects as the Postgres `postgres`
--     superuser role, which bypasses RLS by Postgres's own BYPASSRLS
--     privilege — this is NOT the same mechanism as a Supabase `service_role`
--     API key/JWT used from supabase-js. The previous wording ("service-role
--     client") conflated the two; only the superuser-bypass description is
--     accurate here.
--   - SELECT: org members can read their own org's interactions; super_admin sees all
--   - No UPDATE policy: UPDATE is denied (append-only guarantee)
--   - No DELETE policy: DELETE is denied (audit trail integrity)
--
-- RESIDUAL RISK — RESOLVED (STL-A1-014, found during Etapa A1's code
-- verification; closed by STL-A15-006, Etapa A1.5): migration
-- 0033_public_api_grants.sql originally granted `authenticated` role
-- SELECT/INSERT/UPDATE/DELETE on stella_interactions. Migration
-- 0043_stella_interactions_privilege_hardening.sql (Etapa A1.5) already
-- revoked INSERT/UPDATE/DELETE from `authenticated`, leaving only SELECT —
-- verified with `has_table_privilege` in
-- tests/integration/stella-interactions-rls.test.ts. This note was stale
-- (still described the risk as open) until corrected here in Etapa A2.2.
--
-- SUPERSEDED (Etapa A2.2, STL-A22-004, DR-007 aprobado 2026-07-26): the
-- SELECT policy below ("stella_interactions_select_member_or_admin") is
-- REPLACED by db/policies/010_stella_interactions_access_control_rls.sql,
-- which applies the DR-007 access matrix (creator + organization_admin/
-- super_admin/impact_manager/analyst org-wide; no blanket super_admin
-- bypass; reviewer/viewer get no general history access). This file is kept
-- for historical reference — do not re-apply it after 010 without also
-- re-deciding whether that regresses DR-007. This DOES NOT edit the SQL
-- below; it is a documentation-only note.

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
