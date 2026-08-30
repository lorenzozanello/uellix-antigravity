-- db/prepared/stella_0005_rollback.sql
-- Reverses db/prepared/stella_0005_runtime_cutover.sql.
--
-- RUN AS `uellix_owner`, REACHED BY `SET ROLE` FROM `uellix_migrator`:
-- R3.4 deliberately exposes no generic rollback-by-filename command. This
-- rollback requires a separately approved, package-specific recovery process.
--
-- SCOPE. This undoes the two INSERT policies this package added, the three pinned
-- `search_path` values and the four default-privilege entries that
-- stella_0005 added. It does NOT undo stella_0004 — ownership stays with
-- `uellix_owner` — and it does NOT move the runtime back to `postgres`.
-- Reverting the CONNECTION is an application-configuration change
-- (UELLIX_RUNTIME_DATABASE_URL), not a schema change, and conflating the two
-- would let a SQL rollback silently re-privilege a running process.
--
-- WHAT REVERTING COSTS. After this script the runtime can no longer INSERT
-- into `stella_interactions` or `audit_logs`
-- unless it is once again a role that bypasses RLS. Rolling back the SQL
-- WITHOUT also rolling back the connection leaves Stella able to read its
-- interactions and unable to record new ones. Run both, or neither.
--
-- Idempotent and convergent, like the forward script.

SET search_path = public;

-- CREATE/DROP POLICY (including the same-session probe in section 4) takes
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
  -- instead of to a prediction. The probe is dropped before the 105-policy
  -- count below is trusted.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.stella_suggestion_decisions'::regclass
      AND polname = 'stella_decision_canonical_insert_probe'
  ) THEN
    RAISE EXCEPTION 'stella_0005_rollback aborted: probe policy stella_decision_canonical_insert_probe already exists on public.stella_suggestion_decisions — refusing to trust unexpected pre-existing state';
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
    RAISE EXCEPTION 'stella_0005_rollback aborted: canonical INSERT policy WITH CHECK does not match the same-session probe. actual=%, probe=%',
      COALESCE(decision_insert_check_actual, '<absent>'), COALESCE(decision_insert_check_probe, '<absent>');
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 105 THEN
    RAISE EXCEPTION
      'Expected 105 policies in public after rollback (including the canonical stella_0003 decision INSERT policy), found %.',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
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
    RAISE EXCEPTION 'stella_0005_rollback must preserve the canonical stella_0003 decision INSERT policy.';
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
