-- db/prepared/stella_0005c_runtime_policy_scope.sql
-- Scope the three append-only INSERT policies to the runtime role, and remove
-- the pre-cutover INSERT grants they were accidentally re-activating.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0005c_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/DATABASE_RUNTIME_CUTOVER.md.
--
-- RUN AS `uellix_owner`, REACHED BY `SET ROLE` FROM `uellix_migrator`:
--   pnpm db:prepared:apply:local stella_0005c_runtime_policy_scope.sql
--
-- ============================================================================
-- WHY THIS EXISTS (reaudit finding M1)
-- ============================================================================
-- stella_0005 created the three INSERT policies with no TO clause, which means
-- TO PUBLIC: they apply to EVERY role that holds an INSERT privilege on the
-- table. Measured on the rehearsal stack, `authenticated` and `service_role`
-- still hold the pre-cutover `GRANT SELECT, INSERT` on `audit_logs` and
-- `stella_interactions` (the stella_0002-era ACL, granted for a PostgREST
-- write path that no longer exists). The combination re-opened a path the
-- cutover was supposed to close:
--
--   * a caller holding a valid user JWT could INSERT into `audit_logs` and
--     `stella_interactions` DIRECTLY through PostgREST, as `authenticated`,
--     without going through the application, its validation, or its audit
--     conventions — the WITH CHECK would pass because the JWT carries the same
--     claims the identity context sets;
--   * `service_role` holds BYPASSRLS in the local Supabase stack, so for it
--     the policy text was never the fence — the GRANT was, and it was there.
--
-- The fix is two independent layers, both applied here:
--
--   1. The INSERT policies name `TO uellix_app`. For any other role there is
--      then NO applicable INSERT policy, and RLS denies by default.
--   2. The INSERT grants of `authenticated` and `service_role` on the two
--      tables are REVOKED. `authenticated` never hits layer 1; `service_role`
--      (which bypasses RLS) is stopped by the missing privilege itself.
--
-- SELECT is deliberately left untouched for both roles: the read policies are
-- organisation-scoped and reading through PostgREST was never the finding.
--
-- ============================================================================
-- THE ACTOR BINDING (audit_logs)
-- ============================================================================
-- The stella_0005 policy accepted `actor_user_id IS NULL`. Measured across the
-- runtime: every production caller of logAuditAction() passes the session
-- user's id, and the only writer that omits the actor is the Stripe webhook —
-- which is refused up front (503, no database identity) and will write through
-- a TECHNICAL identity when one exists, not through `uellix_app` with user
-- claims. A NULL actor from the runtime role is therefore always a bug or a
-- forgery, and the new policy refuses it: every row a human-facing runtime
-- session appends must attribute itself to that session's user, super admins
-- included.
--
-- ============================================================================
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It does not set, read or contain a password.
--   * It does not change any role attribute, membership or ownership.
--   * It does not grant anything to anyone. It only revokes and rescopes.
--   * It does not touch SELECT policies, SELECT grants, or any other table.
--   * It does not disable or force row level security anywhere.
--   * It uses no CASCADE, no dynamic SQL, no identifier built from a variable.
--
-- Every statement is idempotent AND convergent: a second application produces
-- the same state and changes nothing.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions — abort before touching anything
-- ============================================================

DO $$
BEGIN
  -- 0.1 The applying identity, same contract as stella_0005.
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION
      'stella_0005c must run as uellix_owner, not %. Apply it with the migration wrapper '
      '(pnpm db:prepared:apply:local), which connects as uellix_migrator and issues SET ROLE.',
      current_user;
  END IF;

  IF session_user <> 'uellix_migrator' THEN
    RAISE EXCEPTION
      'stella_0005c reached uellix_owner from session_user % rather than uellix_migrator.',
      session_user;
  END IF;

  -- 0.2 The database must be in the post-stella_0005 state this script was
  -- written against: 38 tables, 107 policies, 10 append-only triggers, RLS on
  -- everywhere, and the three INSERT policies present under their names.
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') <> 38 THEN
    RAISE EXCEPTION 'Expected exactly 38 tables in public, found %.',
      (SELECT count(*) FROM pg_tables WHERE schemaname = 'public');
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 107 THEN
    RAISE EXCEPTION
      'Expected 107 policies in public (the post-stella_0005 inventory), found %.',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
  END IF;

  IF (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd = 'INSERT'
      AND policyname IN (
        'audit_logs_insert_member_or_admin',
        'stella_interactions_insert_member_or_admin',
        'stella_suggestion_decisions_insert_member_or_admin'
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'The three stella_0005 INSERT policies are not all present. Apply stella_0005 first.';
  END IF;

  IF (
    SELECT count(*) FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ) <> 10 THEN
    RAISE EXCEPTION 'Expected exactly 10 non-internal triggers in public, found %.',
      (SELECT count(*) FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Some table in public has row level security disabled.';
  END IF;

  -- 0.3 The runtime role must exist and still be harmless.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'Role uellix_app does not exist. Apply stella_0004 first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_app'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'uellix_app carries an administrative attribute. Refusing to scope policies to it.';
  END IF;

  -- 0.4 The runtime write path must survive this script: uellix_app reaches
  -- INSERT through uellix_writer, not through the grants being revoked below.
  IF NOT has_table_privilege('uellix_app', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_app has no INSERT on audit_logs before the rescope; the runtime path is broken.';
  END IF;

  IF NOT has_table_privilege('uellix_app', 'public.stella_interactions', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_app has no INSERT on stella_interactions before the rescope.';
  END IF;
END
$$;

-- ============================================================
-- 1. Revoke the pre-cutover INSERT grants (layer 2)
-- ============================================================
-- REVOKE of an absent privilege is a no-op, so re-running converges.

REVOKE INSERT ON public.audit_logs FROM authenticated;
REVOKE INSERT ON public.audit_logs FROM service_role;
REVOKE INSERT ON public.stella_interactions FROM authenticated;
REVOKE INSERT ON public.stella_interactions FROM service_role;

-- ============================================================
-- 2. Rescope the three INSERT policies to the runtime role (layer 1)
-- ============================================================
-- Each policy keeps its stella_0005 shape — organisation bound to the claims,
-- actor bound to the claims — with two deliberate changes:
--
--   * TO uellix_app: the policy no longer applies to whatever role happens to
--     hold an INSERT privilege. `stella_suggestion_decisions` had no stray
--     grant to activate, but it is rescoped identically so the three
--     append-only write policies stay one shape, reviewed once.
--   * audit_logs: `actor_user_id IS NULL` is gone (see header). The actor
--     binding now applies to the super-admin branch too — an administrator
--     appends under their own name like everyone else.

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

DROP POLICY IF EXISTS stella_interactions_insert_member_or_admin ON public.stella_interactions;
CREATE POLICY stella_interactions_insert_member_or_admin
  ON public.stella_interactions
  FOR INSERT
  TO uellix_app
  WITH CHECK (
    created_by = auth.uid()
    AND (
      organization_id = ANY (public.current_user_org_ids())
      OR public.current_user_is_super_admin()
    )
  );

DROP POLICY IF EXISTS stella_suggestion_decisions_insert_member_or_admin
  ON public.stella_suggestion_decisions;
CREATE POLICY stella_suggestion_decisions_insert_member_or_admin
  ON public.stella_suggestion_decisions
  FOR INSERT
  TO uellix_app
  WITH CHECK (
    decided_by = auth.uid()
    AND (
      organization_id = ANY (public.current_user_org_ids())
      OR public.current_user_is_super_admin()
    )
  );

-- ============================================================
-- 3. Postconditions — assert the end state
-- ============================================================

DO $$
DECLARE
  bad_row record;
BEGIN
  -- 3.1 Still exactly 107 policies: three were replaced, none added or lost.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 107 THEN
    RAISE EXCEPTION 'Expected 107 policies in public after the rescope, found %.',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
  END IF;

  -- 3.2 The three INSERT policies now apply to uellix_app and no one else.
  FOR bad_row IN
    SELECT policyname, roles::text AS roles
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN (
        'audit_logs_insert_member_or_admin',
        'stella_interactions_insert_member_or_admin',
        'stella_suggestion_decisions_insert_member_or_admin'
      )
      AND roles <> '{uellix_app}'
  LOOP
    RAISE EXCEPTION 'Policy % applies to % rather than {uellix_app}.',
      bad_row.policyname, bad_row.roles;
  END LOOP;

  IF (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd = 'INSERT'
      AND roles = '{uellix_app}'::name[]
      AND policyname IN (
        'audit_logs_insert_member_or_admin',
        'stella_interactions_insert_member_or_admin',
        'stella_suggestion_decisions_insert_member_or_admin'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'Not all three INSERT policies were rescoped to uellix_app.';
  END IF;

  -- 3.3 The NULL-actor branch is gone from audit_logs.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'audit_logs_insert_member_or_admin'
      AND with_check LIKE '%actor_user_id IS NULL%'
  ) THEN
    RAISE EXCEPTION 'audit_logs INSERT policy still accepts a NULL actor.';
  END IF;

  -- 3.4 No effective INSERT capability remains for the PostgREST roles or
  -- PUBLIC on either table. has_table_privilege() answers through role
  -- membership, so this also covers privileges reached indirectly.
  IF has_table_privilege('authenticated', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated still holds INSERT on audit_logs.';
  END IF;
  IF has_table_privilege('authenticated', 'public.stella_interactions', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated still holds INSERT on stella_interactions.';
  END IF;
  IF has_table_privilege('anon', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'anon holds INSERT on audit_logs.';
  END IF;
  IF has_table_privilege('anon', 'public.stella_interactions', 'INSERT') THEN
    RAISE EXCEPTION 'anon holds INSERT on stella_interactions.';
  END IF;
  IF has_table_privilege('service_role', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'service_role still holds INSERT on audit_logs.';
  END IF;
  IF has_table_privilege('service_role', 'public.stella_interactions', 'INSERT') THEN
    RAISE EXCEPTION 'service_role still holds INSERT on stella_interactions.';
  END IF;

  -- PUBLIC (grantee oid 0) must hold nothing on either table.
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
    WHERE c.oid IN ('public.audit_logs'::regclass, 'public.stella_interactions'::regclass)
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC holds a privilege on an append-only table.';
  END IF;

  -- 3.5 The runtime path is intact: uellix_app (via uellix_writer) can still
  -- INSERT, governed by the rescoped policies; SELECT stays where it was.
  IF NOT has_table_privilege('uellix_app', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_app lost INSERT on audit_logs.';
  END IF;
  IF NOT has_table_privilege('uellix_app', 'public.stella_interactions', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_app lost INSERT on stella_interactions.';
  END IF;
  IF NOT has_table_privilege('uellix_app', 'public.stella_suggestion_decisions', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_app lost INSERT on stella_suggestion_decisions.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.audit_logs', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on audit_logs — this script must not touch reads.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.stella_interactions', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on stella_interactions.';
  END IF;

  -- 3.6 Append-only survived: the triggers are still there and RLS is on.
  IF (
    SELECT count(*) FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ) <> 10 THEN
    RAISE EXCEPTION 'The append-only trigger inventory changed.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'A table lost row level security while this script ran.';
  END IF;

  -- 3.7 Nothing widened the runtime while we were in here.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_app' AND (rolsuper OR rolbypassrls OR rolcreaterole)
  ) THEN
    RAISE EXCEPTION 'uellix_app gained an administrative role attribute.';
  END IF;

  IF has_table_privilege('uellix_app', 'public.audit_logs', 'UPDATE')
     OR has_table_privilege('uellix_app', 'public.audit_logs', 'DELETE')
     OR has_table_privilege('uellix_app', 'public.stella_interactions', 'UPDATE')
     OR has_table_privilege('uellix_app', 'public.stella_interactions', 'DELETE') THEN
    RAISE EXCEPTION 'uellix_app gained UPDATE or DELETE on an append-only table.';
  END IF;
END
$$;
