-- db/prepared/stella_hosted_0008_rollback.sql
-- Rollback of stella_hosted_0008_audit_log_write_capability.sql.
--
-- APPLIED THROUGH THE ADMINISTRATIVE HOSTED SESSION, in one transaction:
--   psql "$UELLIX_STAGING_ADMIN_URL" -X -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- ============================================================================
-- THE SAME IDENTITY CONTRACT AS THE FORWARD PACKAGE, FOR THE SAME REASON
-- ============================================================================
-- Removing a policy needs exactly what creating one needs: ownership of the
-- table. So this file measures `public.audit_logs`.relowner the same way the
-- forward package does, admits the same two outcomes — the session already IS
-- the owner, or the table is owned by uellix_owner and the session can assume
-- it — and refuses everything else by name.
--
-- An earlier revision demanded `current_user = uellix_owner`, which is the
-- LOCAL posture and not the hosted one: MEASURED, public.audit_logs is owned by
-- `postgres` on the staging project. A rollback that could not run on the
-- database its forward package targets is not a rollback.
--
-- ============================================================================
-- WHAT REVERTING COSTS, STATED BEFORE IT IS DONE
-- ============================================================================
-- Removing this policy returns `public.audit_logs` to the state the hosted
-- staging project was measured in: RLS enabled, a SELECT policy and no INSERT
-- policy, so every audit append from the application is refused by RLS while
-- the table privilege (stella_hosted_0007 §1) stays in place. That is SAFE and
-- FUNCTIONALLY DEAD — Stella runs, and leaves no audit trail, silently.
--
-- IT ALSO MAKES G1-B UNPASSABLE. §4.5 of the G1-B runbook is categorical: an
-- interaction with no audit row is a FAIL. Running this is therefore a decision
-- to stop the certification, not a way to recover from a failure inside it.
--
-- It ships a rollback rather than being declared forward-only precisely because
-- that state is REACHABLE and REVIEWABLE, not because it is desirable: a single
-- policy removal is a complete, exact reversal of a single policy creation,
-- which is the case a rollback script is actually for.
--
-- It does NOT restore any earlier variant of the policy. There was none on the
-- hosted side: the absence is the state this reverts to.
--
-- Idempotent AND convergent.
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions and the measured identity decision
-- ============================================================
DO $$
DECLARE
  v_owner name;
BEGIN
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0008_rollback aborted: table public.audit_logs not found.';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c WHERE c.oid = 'public.audit_logs'::regclass;

  PERFORM set_config('uellix.h0008r_owner_pre', v_owner, true);

  IF v_owner = current_user THEN
    PERFORM set_config('uellix.h0008r_assume_owner', 'no', true);

  ELSIF v_owner = 'uellix_owner'
        AND (pg_catalog.pg_has_role(current_user, 'uellix_owner', 'USAGE')
             OR pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET')) THEN
    PERFORM set_config('uellix.h0008r_assume_owner', 'yes', true);

  ELSE
    RAISE EXCEPTION
      'stella_hosted_0008_rollback aborted: public.audit_logs is owned by % and this session (%) is neither that role nor able to assume it. Removing a policy requires ownership of the table, exactly as creating one does.',
      v_owner, current_user;
  END IF;
END $$;

-- ============================================================
-- 1. The reversal, under the identity PostgreSQL requires
-- ============================================================
DO $$
DECLARE
  v_decision text := NULLIF(current_setting('uellix.h0008r_assume_owner', true), '');
BEGIN
  IF v_decision IS NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0008_rollback aborted: the identity decision from section 0 is not present in this transaction.';
  END IF;

  IF v_decision = 'yes' THEN
    SET LOCAL ROLE uellix_owner;
  ELSIF v_decision <> 'no' THEN
    RAISE EXCEPTION 'stella_hosted_0008_rollback aborted: unrecognised identity decision "%".', v_decision;
  END IF;

  DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public.audit_logs;

  IF v_decision = 'yes' THEN
    RESET ROLE;
  END IF;
END $$;

-- ============================================================
-- 2. Postconditions
-- ============================================================
DO $$
DECLARE
  v_owner_pre text := NULLIF(current_setting('uellix.h0008r_owner_pre', true), '');
  v_owner_now text;
  v_rls_now   boolean;
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION
      'stella_hosted_0008_rollback FAILED verification: the session is still acting as % rather than %.',
      current_user, session_user;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'audit_logs'
      AND policyname = 'audit_logs_insert_member_or_admin'
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0008_rollback postcondition failed: the policy still exists';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(c.relowner), c.relrowsecurity
    INTO v_owner_now, v_rls_now
  FROM pg_class c WHERE c.oid = 'public.audit_logs'::regclass;

  IF v_owner_pre IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0008_rollback postcondition failed: the owner measured before the reversal is not present in this transaction.';
  END IF;
  IF v_owner_now <> v_owner_pre THEN
    RAISE EXCEPTION
      'stella_hosted_0008_rollback postcondition failed: public.audit_logs is now owned by % and was owned by % when this file started.',
      v_owner_now, v_owner_pre;
  END IF;
  IF v_rls_now IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'stella_hosted_0008_rollback postcondition failed: row level security is no longer enabled on public.audit_logs.';
  END IF;

  RAISE NOTICE 'stella_hosted_0008_rollback: audit_logs has no INSERT policy. The runtime audit trail is dead again, by decision.';
END $$;
