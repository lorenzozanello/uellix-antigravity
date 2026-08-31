-- FIBIU-28 — governed audit event contract, stage A (FIBC-029/FIBC-040/FIBDB-035).
--
-- Custom SQL migration: no schema.ts diff. RLS policies are hand-authored in
-- this repo's migration chain (see 0031_rls_core.sql), following the same
-- idempotent DROP POLICY IF EXISTS / CREATE POLICY pattern used there.
--
-- MEASURED STATE CORRECTION. This exact policy is already applied in the G2
-- environment (db/baseline/stella_g2_schema.sql:8822), installed there by the
-- prepared unit db/prepared/stella_0005c_runtime_policy_scope.sql. Without it,
-- a Drizzle-only environment has no way for `uellix_app` to write audit_logs
-- at all: 0031_rls_core.sql dropped "audit_logs_insert_authenticated" and
-- never replaced it with an INSERT policy scoped to the runtime identity.
--
-- This migration SUPERSEDES that specific policy clause with the exact clause
-- already measured in G2, idempotently. The rest of stella_0005c (GRANT
-- revocations, the stella_interactions policy) is NO_COLLISION and stays
-- untouched. stella_hosted_0008 (the hosted twin of this same policy) is
-- retired without being applied. See db/prepared/README.md and
-- db/prepared-package-order.ts for the full disposition record.
--
-- Deploy-safety stage A (FIB §6.1): this policy is PERMISSIVE — it enables a
-- write impossible today in a Drizzle-only environment and restricts nothing
-- already granted — so it ships in the additive stage rather than waiting for
-- hardening, and is blocking for F-16 in any environment built from the
-- Drizzle chain alone.

DROP POLICY IF EXISTS "audit_logs_insert_member_or_admin" ON audit_logs;
CREATE POLICY "audit_logs_insert_member_or_admin"
ON audit_logs FOR INSERT
TO uellix_app
WITH CHECK (
  actor_user_id = auth.uid()
  AND (
    (organization_id IS NOT NULL AND organization_id = ANY(current_user_org_ids()))
    OR current_user_is_super_admin()
  )
);
