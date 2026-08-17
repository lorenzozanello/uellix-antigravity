-- db/prepared/stella_hosted_0008_rollback.sql
-- Rollback of stella_hosted_0008_audit_log_write_capability.sql.
--
-- RUN AS `uellix_owner`.
--
-- ============================================================================
-- WHAT REVERTING COSTS, STATED BEFORE IT IS DONE
-- ============================================================================
-- Dropping this policy returns `public.audit_logs` to the state the hosted
-- staging project was measured in: RLS enabled, a SELECT policy and no INSERT
-- policy, so every audit append from the application is refused by RLS while
-- the table GRANT (stella_hosted_0007 §1) stays in place. That is SAFE and
-- FUNCTIONALLY DEAD — Stella runs, and leaves no audit trail, silently.
--
-- It ships a rollback rather than being declared forward-only precisely because
-- that state is REACHABLE and REVIEWABLE, not because it is desirable: a single
-- DROP POLICY is a complete, exact reversal of a single CREATE POLICY, which is
-- the case a rollback script is actually for.
--
-- It does NOT restore any earlier variant of the policy. There was none on the
-- hosted side: the absence is the state this reverts to.
--
-- Idempotent AND convergent.
-- ============================================================================

SET search_path = public;

DO $$
BEGIN
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION
      'stella_hosted_0008_rollback aborted: must be applied as uellix_owner (current_user = %).',
      current_user;
  END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0008_rollback aborted: table public.audit_logs not found.';
  END IF;
END $$;

DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public.audit_logs;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'audit_logs'
      AND policyname = 'audit_logs_insert_member_or_admin'
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0008_rollback postcondition failed: the policy still exists';
  END IF;
  RAISE NOTICE 'stella_hosted_0008_rollback: audit_logs has no INSERT policy. The runtime audit trail is dead again, by decision.';
END $$;
