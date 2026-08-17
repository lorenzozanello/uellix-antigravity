-- db/prepared/stella_hosted_0008_audit_log_write_capability.sql
-- G1-B PRECONDITIONS — the hosted half of the audit_logs INSERT policy.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_hosted_0008_rollback.sql.
--
-- PRECHAIN ADMINISTRATIVE UNIT. NOT a member of HOSTED_CHAIN.
--
-- RUN AS `uellix_owner` (the owner of the policies on public.audit_logs),
-- REACHED BY `SET ROLE` FROM the applying migrator identity.
--
-- NOT YET APPLIED TO ANY DATABASE.
--
-- ============================================================================
-- WHAT IS BROKEN, MEASURED
-- ============================================================================
-- On the hosted staging project, `public.audit_logs` has RLS ENABLED and
-- EXACTLY ONE policy. From the catalog observation kept in this repository —
-- artifacts/hosted-chain-posture-observation-postcred.json:
--
--     { name: 'audit_logs_select_member_or_admin', command: 'SELECT',
--       relation: 'public.audit_logs' }
--
-- There is NO INSERT policy. `uellix_app` is NOBYPASSRLS and owns nothing, so
-- every `INSERT INTO public.audit_logs` from the runtime is refused by
-- row-level security.
--
-- It is refused DESPITE the table privilege being correct:
-- `stella_hosted_0007` §1 grants `SELECT, INSERT ON public.audit_logs TO
-- uellix_writer`, and `stella_hosted_0001` §433 grants
-- `uellix_writer TO uellix_app WITH INHERIT TRUE`. The GRANT is present, the
-- POLICY is absent, and RLS denies by default when no permissive policy applies.
-- That posture is SAFE (nothing unauthorised can write) and FUNCTIONALLY DEAD
-- (nothing authorised can either).
--
-- ============================================================================
-- WHY THE HOSTED SIDE NEVER GOT IT
-- ============================================================================
-- The policy exists locally, created by `stella_0005c_runtime_policy_scope.sql`
-- (and before it `stella_0005`). Both are LOCAL-ONLY packages applied through
-- `pnpm db:prepared:apply:local`; neither is a member of HOSTED_CHAIN and
-- neither appears in db/hosted/hosted-package-manifest.ts. This is the same
-- class of omission `stella_hosted_0006` and `stella_hosted_0007` closed for
-- the FUNCTION and TABLE layers of stella_0004 §6 — the POLICY layer of
-- stella_0005c is the third one, and the last one the runtime needs.
--
-- ============================================================================
-- WHY THE PREDICATE IS COPIED AND NOT ADAPTED
-- ============================================================================
-- The WITH CHECK below is stella_0005c's, character for character. A hosted
-- policy that were merely SIMILAR would mean two tenancy rules to review
-- instead of one, and the difference between them would live in nobody's head.
-- tests/stella-audit-log-write-capability.test.ts compares the two bodies after
-- whitespace normalisation and fails if they diverge.
--
-- What the predicate says, and why each half is load-bearing:
--
--   actor_user_id = auth.uid()
--     Every appended row attributes itself to the SESSION's user. A NULL actor
--     from the runtime role is always a bug or a forgery — stella_0005c dropped
--     the `actor_user_id IS NULL` branch deliberately, super admins included —
--     and the caller cannot name someone else, because `auth.uid()` reads
--     `request.jwt.claims`, which only the identity context sets.
--
--   organization_id IS NOT NULL AND organization_id = ANY (current_user_org_ids())
--     The row lands in an organization the session actually belongs to. This is
--     the cross-tenant boundary for the audit trail, and it is enforced by the
--     DATABASE rather than by the caller passing the right value.
--
--   OR public.current_user_is_super_admin()
--     The one widening, and it does NOT widen the actor binding: a super admin
--     appends under their own name like everybody else.
--
-- ============================================================================
-- WHAT THIS PACKAGE DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It GRANTS NOTHING, to anyone. The table privilege already exists
--     (stella_hosted_0007 §1); the missing piece was only ever the policy.
--   * It creates NO policy for `authenticated`, `service_role`, `anon` or
--     PUBLIC. A policy with no TO clause is TO PUBLIC and would re-open the M1
--     finding stella_0005c closed: a caller with a valid user JWT writing to
--     audit_logs through PostgREST, bypassing the application entirely.
--   * It does not enable, disable or force RLS, does not touch the SELECT
--     policy, the append-only trigger, any other table, any role or any owner.
--   * It uses no CASCADE and no identifier built from a variable.
--
-- Idempotent AND convergent: DROP POLICY IF EXISTS + CREATE POLICY converges an
-- already-correct database, and a database carrying a DIFFERENT policy of the
-- same name is converged to this one rather than left ambiguous.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions — abort before touching anything
-- ============================================================
DO $$
DECLARE
  v_relrowsecurity boolean;
BEGIN
  -- 0.1 The applying identity. Policies on public.audit_logs are owned by
  --     uellix_owner; no other principal may replace one.
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: must be applied as uellix_owner (current_user = %). Reach it with SET ROLE uellix_owner.',
      current_user;
  END IF;

  -- 0.2 The table must exist.
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0008 aborted: table public.audit_logs not found.';
  END IF;

  -- 0.3 RLS MUST ALREADY BE ENABLED. This package creates a PERMISSIVE policy,
  --     and a permissive policy on a table with RLS off is decoration: every
  --     role would read and write freely and the postcondition below would
  --     still pass. Refuse rather than install a fence around an open field.
  SELECT c.relrowsecurity INTO v_relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'audit_logs';

  IF v_relrowsecurity IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: row level security is not enabled on public.audit_logs. A permissive INSERT policy on a table without RLS grants nothing and hides that fact.';
  END IF;

  -- 0.4 The runtime role must exist and must already hold the table privilege.
  --     Without it the policy would be installed next to a 42501 and the gap
  --     would look closed while the runtime still could not write.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_hosted_0008 aborted: role uellix_app does not exist.';
  END IF;

  IF NOT has_table_privilege('uellix_app', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: uellix_app holds no INSERT privilege on public.audit_logs. Apply stella_hosted_0007 first — this package supplies the POLICY half only and grants nothing.';
  END IF;

  -- 0.5 The three helper functions the predicate calls must be reachable by the
  --     runtime. They are SECURITY DEFINER and stella_hosted_0006 grants them;
  --     without EXECUTE the policy evaluates to a 42501 rather than to false.
  IF NOT has_function_privilege('uellix_app', 'public.current_user_org_ids()', 'EXECUTE')
     OR NOT has_function_privilege('uellix_app', 'public.current_user_is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'stella_hosted_0008 aborted: uellix_app cannot EXECUTE the RLS helper functions the policy predicate calls. Apply stella_hosted_0006 first.';
  END IF;
END $$;

-- ============================================================
-- 1. The policy. stella_0005c's, verbatim.
-- ============================================================
DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public.audit_logs;
CREATE POLICY audit_logs_insert_member_or_admin
  ON public.audit_logs
  FOR INSERT
  TO uellix_app
  WITH CHECK (
    actor_user_id = auth.uid()
    AND (
      (
        organization_id IS NOT NULL
        AND organization_id = ANY (public.current_user_org_ids())
      )
      OR public.current_user_is_super_admin()
    )
  );

COMMENT ON POLICY audit_logs_insert_member_or_admin ON public.audit_logs IS
  'prepared stella_hosted_0008: the hosted half of stella_0005c. The application appends its own audit trail as uellix_app, bound to the session actor and to an organization the session belongs to. No client role has an INSERT policy or an INSERT grant on this table.';

-- ============================================================
-- 2. Postconditions — assert the end state
-- ============================================================
DO $$
DECLARE
  v_roles text;
  v_cmd text;
  v_check text;
  v_stray text;
BEGIN
  SELECT p.roles::text, p.cmd, p.with_check
    INTO v_roles, v_cmd, v_check
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename = 'audit_logs'
    AND p.policyname = 'audit_logs_insert_member_or_admin';

  IF v_roles IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: the policy was not created';
  END IF;
  IF v_cmd <> 'INSERT' THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: policy command is % (expected INSERT)', v_cmd;
  END IF;
  IF v_roles <> '{uellix_app}' THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: policy applies to % (expected {uellix_app})', v_roles;
  END IF;
  IF v_check IS NULL OR position('auth.uid()' in v_check) = 0 THEN
    RAISE EXCEPTION 'stella_hosted_0008 postcondition failed: the actor binding is missing from WITH CHECK';
  END IF;

  -- The other direction, and the one an INSTALL check silently gets wrong: no
  -- OTHER INSERT policy may exist on this table. A second one would be OR-ed
  -- with this one, so a permissive stray would defeat the binding above
  -- entirely while every assertion so far still passed.
  SELECT string_agg(p.policyname || ' -> ' || p.roles::text, ', ' ORDER BY p.policyname)
    INTO v_stray
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename = 'audit_logs'
    AND p.cmd IN ('INSERT', 'ALL')
    AND p.policyname <> 'audit_logs_insert_member_or_admin';

  IF v_stray IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0008 postcondition failed: a second write policy exists on public.audit_logs [%]. Permissive policies are OR-ed, so it would defeat the actor and tenant binding.',
      v_stray;
  END IF;

  RAISE NOTICE 'stella_hosted_0008: audit_logs_insert_member_or_admin INSERT TO uellix_app. OK.';
END $$;
