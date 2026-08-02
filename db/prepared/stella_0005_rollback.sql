-- db/prepared/stella_0005_rollback.sql
-- Reverses db/prepared/stella_0005_runtime_cutover.sql.
--
-- RUN AS `uellix_owner`, REACHED BY `SET ROLE` FROM `uellix_migrator`:
--   pnpm db:prepared:apply:local stella_0005_rollback.sql
--
-- SCOPE. This undoes the three INSERT policies, the three pinned
-- `search_path` values and the four default-privilege entries that
-- stella_0005 added. It does NOT undo stella_0004 — ownership stays with
-- `uellix_owner` — and it does NOT move the runtime back to `postgres`.
-- Reverting the CONNECTION is an application-configuration change
-- (UELLIX_RUNTIME_DATABASE_URL), not a schema change, and conflating the two
-- would let a SQL rollback silently re-privilege a running process.
--
-- WHAT REVERTING COSTS. After this script the runtime can no longer INSERT
-- into `stella_interactions`, `stella_suggestion_decisions` or `audit_logs`
-- unless it is once again a role that bypasses RLS. Rolling back the SQL
-- WITHOUT also rolling back the connection leaves Stella able to read its
-- interactions and unable to record new ones. Run both, or neither.
--
-- Idempotent and convergent, like the forward script.

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION
      'stella_0005_rollback must run as uellix_owner, not %. Use the migration wrapper.',
      current_user;
  END IF;

  IF session_user <> 'uellix_migrator' THEN
    RAISE EXCEPTION
      'stella_0005_rollback reached uellix_owner from session_user % rather than uellix_migrator.',
      session_user;
  END IF;
END
$$;

-- ============================================================
-- 1. Drop the INSERT policies stella_0005 added
-- ============================================================
-- `IF EXISTS` so a partially-applied forward run, or a second rollback, is a
-- clean no-op rather than an error an operator has to interpret.

DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public.audit_logs;
DROP POLICY IF EXISTS stella_interactions_insert_member_or_admin ON public.stella_interactions;
DROP POLICY IF EXISTS stella_suggestion_decisions_insert_member_or_admin
  ON public.stella_suggestion_decisions;

-- ============================================================
-- 2. Restore the three helpers to search_path = public
-- ============================================================
-- The bodies below are the pre-stella_0005 definitions: unqualified table
-- references resolved through `public`. Restoring the search_path without
-- restoring the unqualified references would leave functions that resolve
-- nothing and fail at every call.

CREATE OR REPLACE FUNCTION public.current_user_org_ids()
  RETURNS uuid[]
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = 'public'
AS $function$
  SELECT ARRAY(
    SELECT organization_id
    FROM organization_members
    WHERE user_id = auth.uid() AND status = 'active'
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = 'public'
AS $function$
  SELECT COALESCE(
    (SELECT is_super_admin FROM users WHERE id = auth.uid() LIMIT 1),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_user_role_in_org(org_id uuid)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = 'public'
AS $function$
  SELECT role
  FROM organization_members
  WHERE user_id = auth.uid() AND organization_id = org_id AND status = 'active'
  LIMIT 1;
$function$;

-- ============================================================
-- 3. Withdraw the default privileges
-- ============================================================
-- REVOKE mirrors the forward GRANT exactly. A `REVOKE ALL` here would also
-- remove entries some other script may have added for the same role and
-- schema, which is precisely the kind of over-broad revocation that makes a
-- rollback more dangerous than the change it reverses.

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public
  REVOKE SELECT, INSERT ON TABLES FROM uellix_writer;

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public
  REVOKE SELECT ON TABLES FROM uellix_auditor;

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM uellix_writer;

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public
  REVOKE SELECT ON SEQUENCES FROM uellix_auditor;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 104 THEN
    RAISE EXCEPTION
      'Expected 104 policies in public after rollback, found %.',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('current_user_org_ids', 'current_user_is_super_admin', 'current_user_role_in_org')
      AND NOT ('search_path=public' = ANY (p.proconfig))
  ) THEN
    RAISE EXCEPTION 'A current_user_* helper was not restored to search_path=public.';
  END IF;

  -- Ownership is stella_0004's, not this script's, and must survive untouched.
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'uellix_owner') THEN
    RAISE EXCEPTION 'Rollback disturbed table ownership. stella_0004 state must be preserved.';
  END IF;
END
$$;
