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
--   pnpm db:prepared:apply:local stella_0005c_rollback.sql

SET search_path = public;

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
BEGIN
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stella_suggestion_decisions'
      AND policyname = 'stella_suggestion_decisions_insert_member_or_admin'
      AND cmd = 'INSERT'
      AND roles = '{uellix_app}'::name[]
      AND with_check LIKE '%app.organization_id%'
      AND with_check LIKE '%current_user_org_ids%'
      AND with_check LIKE '%auth.uid()%'
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
