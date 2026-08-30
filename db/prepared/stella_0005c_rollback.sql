-- db/prepared/stella_0005c_rollback.sql
-- Rollback of stella_0005c_runtime_policy_scope.sql: restore the two
-- stella_0005 INSERT policies (TO PUBLIC, NULL actor accepted on audit_logs) and re-grant
-- INSERT on the two tables to `authenticated` and `service_role`.
--
-- THIS ROLLBACK RESTORES A KNOWN-WEAKER STATE ON PURPOSE: it exists so the
-- rescope can be undone exactly, not because the restored state is desirable.
-- The reaudit finding (M1) that motivated the forward script applies to the
-- state this file produces.
--
-- RUN AS `uellix_owner`, REACHED BY `SET ROLE` FROM `uellix_migrator`:
-- R3.4 deliberately exposes no generic rollback-by-filename command. This
-- rollback requires a separately approved, package-specific recovery process.

SET search_path = public;

-- CREATE/DROP POLICY (including the same-session probe in section 3) takes
-- ACCESS EXCLUSIVE on the target table. Bound the wait, the same 5s doctrine
-- stella_0003 already uses, so a long reader turns this script into a clean
-- abort instead of an indefinite stall. (MSC-07B.8-R9T.)
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_0005c_rollback must run as uellix_owner, not %.', current_user;
  END IF;

  IF session_user <> 'uellix_migrator' THEN
    RAISE EXCEPTION
      'stella_0005c_rollback reached uellix_owner from session_user % rather than uellix_migrator.',
      session_user;
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 107 THEN
    RAISE EXCEPTION 'Expected 107 policies in public, found %.',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
  END IF;
END
$$;

-- ============================================================
-- 1. Restore the two stella_0005 policy shapes (TO PUBLIC)
-- ============================================================

DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public.audit_logs;
CREATE POLICY audit_logs_insert_member_or_admin
  ON public.audit_logs
  FOR INSERT
  WITH CHECK (
    (
      organization_id IS NOT NULL
      AND organization_id = ANY (public.current_user_org_ids())
      AND (actor_user_id IS NULL OR actor_user_id = auth.uid())
    )
    OR public.current_user_is_super_admin()
  );

DROP POLICY IF EXISTS stella_interactions_insert_member_or_admin ON public.stella_interactions;
CREATE POLICY stella_interactions_insert_member_or_admin
  ON public.stella_interactions
  FOR INSERT
  WITH CHECK (
    (
      organization_id = ANY (public.current_user_org_ids())
      AND created_by = auth.uid()
    )
    OR public.current_user_is_super_admin()
  );

-- ============================================================
-- 2. Restore the pre-cutover INSERT grants
-- ============================================================

GRANT INSERT ON public.audit_logs TO authenticated;
GRANT INSERT ON public.audit_logs TO service_role;
GRANT INSERT ON public.stella_interactions TO authenticated;
GRANT INSERT ON public.stella_interactions TO service_role;

-- ============================================================
-- 3. Postconditions
-- ============================================================

DO $$
DECLARE
  decision_insert_check_actual text;
  decision_insert_check_probe  text;
BEGIN
  -- Observed-vs-observed same-session probe (MSC-07B.8-R9T remediation of
  -- R9S-X root cause B: the previous verifier compared pg_get_expr(...,
  -- true) against a handwritten predicted deparse literal that was never
  -- validated live against a real PostgreSQL deparser). A disjoint,
  -- temporary policy carrying the identical WITH CHECK source is created on
  -- the decision table in this session; its pg_get_expr(polwithcheck,
  -- polrelid) — the 2-arg form, the SAME form used to observe the real
  -- policy below — is compared to the canonical policy's own observation
  -- instead of to a prediction. The probe is dropped before the 107-policy
  -- count below is trusted.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.stella_suggestion_decisions'::regclass
      AND polname = 'stella_decision_canonical_insert_probe'
  ) THEN
    RAISE EXCEPTION 'stella_0005c_rollback aborted: probe policy stella_decision_canonical_insert_probe already exists on public.stella_suggestion_decisions — refusing to trust unexpected pre-existing state';
  END IF;

  CREATE POLICY stella_decision_canonical_insert_probe
    ON public.stella_suggestion_decisions
    FOR INSERT
    TO uellix_app
    WITH CHECK (
      organization_id = current_setting('app.organization_id', true)::uuid
      AND organization_id = ANY(public.current_user_org_ids())
      AND decided_by = auth.uid()
    );

  SELECT pg_get_expr(polwithcheck, polrelid) INTO decision_insert_check_actual
  FROM pg_policy
  WHERE polrelid = 'public.stella_suggestion_decisions'::regclass
    AND polname = 'stella_suggestion_decisions_insert_member_or_admin';

  SELECT pg_get_expr(polwithcheck, polrelid) INTO decision_insert_check_probe
  FROM pg_policy
  WHERE polrelid = 'public.stella_suggestion_decisions'::regclass
    AND polname = 'stella_decision_canonical_insert_probe';

  DROP POLICY stella_decision_canonical_insert_probe ON public.stella_suggestion_decisions;

  IF decision_insert_check_actual IS NULL
     OR decision_insert_check_probe IS NULL
     OR decision_insert_check_actual <> decision_insert_check_probe THEN
    RAISE EXCEPTION 'stella_0005c_rollback aborted: canonical INSERT policy WITH CHECK does not match the same-session probe. actual=%, probe=%',
      COALESCE(decision_insert_check_actual, '<absent>'), COALESCE(decision_insert_check_probe, '<absent>');
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 107 THEN
    RAISE EXCEPTION 'Expected 107 policies in public after rollback, found %.',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN ('audit_logs_insert_member_or_admin', 'stella_interactions_insert_member_or_admin')
      AND roles <> '{public}'::name[]
  ) THEN
    RAISE EXCEPTION 'A stella_0005 INSERT policy is still role-scoped after the rollback.';
  END IF;

  IF (SELECT count(*) FROM pg_policy
      WHERE polrelid = 'public.stella_suggestion_decisions'::regclass) <> 2
     OR (SELECT count(*) FROM pg_policy
         WHERE polrelid = 'public.stella_suggestion_decisions'::regclass
           AND polcmd = 'a') <> 1
     OR EXISTS (
       SELECT 1 FROM pg_policy
       WHERE polrelid = 'public.stella_suggestion_decisions'::regclass
         AND polcmd IN ('w', 'd', '*')
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policy
       WHERE polrelid = 'public.stella_suggestion_decisions'::regclass
         AND polname = 'stella_suggestion_decisions_insert_member_or_admin'
         AND polcmd = 'a'
         AND polroles = ARRAY['uellix_app'::regrole::oid]
         AND polpermissive
         AND decision_insert_check_actual = decision_insert_check_probe
     )
  ) THEN
    RAISE EXCEPTION 'stella_0005c_rollback must preserve the canonical stella_0003 decision INSERT policy.';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated did not recover INSERT on audit_logs.';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.stella_interactions', 'INSERT') THEN
    RAISE EXCEPTION 'service_role did not recover INSERT on stella_interactions.';
  END IF;
END
$$;
