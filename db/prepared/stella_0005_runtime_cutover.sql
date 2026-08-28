-- db/prepared/stella_0005_runtime_cutover.sql
-- Owner-scoped half of the runtime cutover from `postgres` to `uellix_app`.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0005_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/DATABASE_RUNTIME_CUTOVER.md.
--
-- RUN AS `uellix_owner`, REACHED BY `SET ROLE` FROM `uellix_migrator`:
--   pnpm db:prepared:apply:local stella_0005_runtime_cutover.sql
--
-- Section 0 REFUSES to run under any other identity, including a superuser.
-- That refusal is the point: this script's whole subject is which role owns
-- and may reach what, and a script about least privilege that is itself
-- applied by an administrator proves nothing about the path it describes.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- stella_0004 moved all 38 tables and 8 functions in `public` to
-- `uellix_owner` and created `uellix_app` / `uellix_migrator` /
-- `uellix_auditor`. Measured afterwards, on 2026-08-02, PostgreSQL 17.6:
--
--   * the model was correct when exercised directly;
--   * the runtime never used it — `DATABASE_URL` still resolved to `postgres`,
--     which holds BYPASSRLS, CREATEROLE and CREATE on `public` through
--     `pg_database_owner`;
--   * so `row_security_active` was FALSE for every query the product actually
--     ran, and the 104 policies governed no application traffic at all.
--
-- Switching the connection role is necessary and NOT sufficient. Three gaps
-- measured on the same stack would have turned the cutover into an outage:
--
--   1. `stella_interactions` and `audit_logs` carry a SELECT policy and NO
--      INSERT policy. Every write to them
--      currently succeeds only because `postgres` bypasses RLS. Under
--      `uellix_app` the same INSERT fails with
--      "new row violates row-level security policy" — verified, not inferred.
--      Section 1 adds those two missing INSERT policies. The decision-table
--      policy is canonical in stella_0003 and is verified, never replaced,
--      here.
--
--   2. `current_user_org_ids()`, `current_user_is_super_admin()` and
--      `current_user_role_in_org()` are SECURITY DEFINER with
--      `search_path = public`. They are the only three of the eight that are
--      not already pinned to the empty path. Section 2 pins them and
--      schema-qualifies every reference, with the bodies otherwise unchanged.
--
--   3. `uellix_owner` had no default privileges for TABLES or SEQUENCES in
--      `public`, so a table created by a future migration would be invisible
--      to the runtime until someone remembered to grant it. Section 3 gives
--      future objects a deliberate, least-privilege baseline.
--
-- ============================================================================
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It does not set, read or contain a password.
--   * It does not change any attribute of any role. It cannot: `uellix_owner`
--     has no CREATEROLE. Role attributes, role-level `SET`, the ownership of
--     the `drizzle` migration bookkeeping schema, and the default privileges
--     of `postgres` all live in stella_0005b_admin_bootstrap.sql, which is a
--     SEPARATE, EXPLICITLY ADMINISTRATIVE script for exactly that reason.
--   * It does not touch any Supabase-internal role, schema or object.
--   * It does not grant to `anon`, `authenticated`, `service_role` or PUBLIC.
--   * It does not make `uellix_app` an owner, or grant it BYPASSRLS,
--     CREATEROLE, or CREATE on any schema.
--   * It uses no CASCADE, no DROP OWNED, no REASSIGN OWNED, and no
--     ALTER DEFAULT PRIVILEGES without FOR ROLE.
--   * It writes, reads and moves no data row.
--   * Nothing is composed: every statement is a top-level literal. There is no
--     `format()`, no `||`, no `quote_ident()`, no identifier derived from a
--     variable or a catalog.
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
  -- 0.1 The applying identity. `session_user` must still be the migrator and
  -- `current_user` must be the owner: that pair is only reachable by
  -- connecting as `uellix_migrator` and issuing `SET ROLE uellix_owner`, which
  -- is precisely the migration path this cutover is supposed to establish.
  -- Running as a superuser would satisfy every later assertion while proving
  -- nothing about whether the path works.
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION
      'stella_0005 must run as uellix_owner, not %. Apply it with the migration wrapper '
      '(pnpm db:prepared:apply:local), which connects as uellix_migrator and issues SET ROLE.',
      current_user;
  END IF;

  IF session_user <> 'uellix_migrator' THEN
    RAISE EXCEPTION
      'stella_0005 reached uellix_owner from session_user % rather than uellix_migrator. '
      'The owner is NOLOGIN by design; a session that authenticated as anything else has a '
      'privilege path this cutover is meant to remove.',
      session_user;
  END IF;

  -- 0.2 stella_0004 must already be in place. Checking the OUTCOME (ownership)
  -- rather than a migration bookkeeping row: a bookkeeping row can be present
  -- on a database whose objects were later moved.
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') <> 38 THEN
    RAISE EXCEPTION
      'Expected exactly 38 tables in public, found %. This script is pinned to the '
      'post-stella_0004 inventory; a different count means the database is not the one it '
      'was written against.',
      (SELECT count(*) FROM pg_tables WHERE schemaname = 'public');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'uellix_owner') THEN
    RAISE EXCEPTION
      'Some table in public is not owned by uellix_owner. Apply stella_0004_role_separation.sql first.';
  END IF;

  -- 0.2b stella_0003 now owns the decision-table INSERT policy. This package
  -- must start from that exact 105-policy state, then add only the two missing
  -- policies for audit_logs and stella_interactions.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 105 THEN
    RAISE EXCEPTION 'Expected 105 policies in public before stella_0005 (including the two stella_0003 decision policies), found %.',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
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
    RAISE EXCEPTION 'stella_0005 requires the canonical transaction-bound stella_0003 decision INSERT policy before it runs.';
  END IF;

  -- 0.3 The runtime role must already be harmless. If any of these were true
  -- the cutover would be moving traffic onto a role that is administrative
  -- under a different name.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'Role uellix_app does not exist. Apply stella_0004_role_separation.sql first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_app'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION
      'uellix_app carries a superuser, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION attribute. '
      'Refusing to route application traffic to it.';
  END IF;

  IF has_schema_privilege('uellix_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'uellix_app holds CREATE on schema public. Refusing to make it the runtime role.';
  END IF;

  -- 0.4 The three tables whose write path this script is about must still be
  -- append-only at the trigger level. Adding an INSERT policy to a table that
  -- had quietly become mutable would widen far more than intended.
  IF (
    SELECT count(*) FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ) <> 10 THEN
    RAISE EXCEPTION
      'Expected exactly 10 non-internal triggers in public, found %.',
      (SELECT count(*) FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal);
  END IF;

  -- 0.5 RLS must be enabled everywhere. A policy added to a table with RLS
  -- disabled is decoration.
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Some table in public has row level security disabled.';
  END IF;
END
$$;

-- ============================================================
-- 1. The two missing INSERT policies
-- ============================================================
-- WHY EACH ONE IS SHAPED THE WAY IT IS
--
-- Both tables are append-only: the BEFORE UPDATE/DELETE triggers from
-- stella_0002b already refuse mutation, and `uellix_app` holds no UPDATE,
-- DELETE or TRUNCATE privilege on them. So an INSERT policy is the ONLY write
-- these tables can ever accept, and it is the last place to constrain them.
--
-- Each policy therefore pins two things rather than one:
--
--   * the ORGANISATION — the row must land in an organisation the caller is
--     an active member of, which is what stops cross-tenant writes;
--   * the ACTOR — the row must attribute itself to the calling user, which is
--     what stops a member of the right organisation from forging a record in
--     a colleague's name. An append-only audit trail that anyone in the
--     organisation can write under anyone else's identity is not an audit
--     trail.
--
-- `current_user_is_super_admin()` is an OR branch rather than a bypass: a
-- super admin still writes rows that satisfy the columns' NOT NULL and FK
-- constraints, they are simply not restricted to their own memberships.

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
-- 2. Pin the search_path of the three remaining SECURITY DEFINER helpers
-- ============================================================
-- These three run as `uellix_owner`, which owns every table in `public`. A
-- SECURITY DEFINER function whose search_path is a SCHEMA NAME resolves its
-- unqualified references at call time against whatever that name then
-- contains; `search_path = ''` resolves nothing implicitly, so the object a
-- body names is fixed at definition time.
--
-- Today `public` is not writable by `uellix_app` (section 0.3 asserts it), so
-- this closes a path that is currently unreachable rather than one that is
-- open. It is still worth closing: it removes the dependency of these three
-- functions on a schema ACL staying correct, which is a much weaker guarantee
-- than not depending on it at all.
--
-- BEHAVIOUR IS UNCHANGED. Every reference is the same object, now written out
-- in full. `auth.uid()` was already schema-qualified in all three bodies and
-- resolves identically. Column references (`role`, `status`, `is_super_admin`)
-- are not schema-resolved and are untouched. `CREATE OR REPLACE FUNCTION`
-- preserves the owner and the existing ACL, so the grants stella_0004 made are
-- not disturbed.
--
-- tests/database-runtime-rls.test.ts exercises all three against real rows,
-- with valid claims, with foreign claims and with no claims at all.

CREATE OR REPLACE FUNCTION public.current_user_org_ids()
  RETURNS uuid[]
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $function$
  SELECT ARRAY(
    SELECT om.organization_id
    FROM public.organization_members om
    WHERE om.user_id = auth.uid() AND om.status = 'active'
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $function$
  SELECT COALESCE(
    (SELECT u.is_super_admin FROM public.users u WHERE u.id = auth.uid() LIMIT 1),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_user_role_in_org(org_id uuid)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $function$
  SELECT om.role
  FROM public.organization_members om
  WHERE om.user_id = auth.uid()
    AND om.organization_id = org_id
    AND om.status = 'active'
  LIMIT 1;
$function$;

-- ============================================================
-- 3. Default privileges for objects future migrations create
-- ============================================================
-- Without an entry here, a table created by a future migration is readable by
-- nobody but `uellix_owner`, and the first symptom is a production 500 rather
-- than a failed migration. With a careless entry, every future table is born
-- fully mutable by the runtime — including the next append-only one.
--
-- The baseline is therefore SELECT + INSERT and no more. Append-only is the
-- DEFAULT; UPDATE and DELETE are an explicit, per-table opt-in that a
-- migration has to write down. That is the direction the four existing
-- append-only tables already point in, made automatic.
--
-- `FOR ROLE uellix_owner` is not optional: an unqualified ALTER DEFAULT
-- PRIVILEGES silently means "for the role running this statement", which is a
-- different and much broader thing when the statement is replayed by someone
-- else.

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO uellix_writer;

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO uellix_auditor;

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO uellix_writer;

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO uellix_auditor;

-- ============================================================
-- 4. Postconditions — assert the end state
-- ============================================================

DO $$
BEGIN
  -- 4.1 The two policies this script adds exist; the canonical decision policy
  --     survives untouched, so 105 before + 2 is still 107.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 107 THEN
    RAISE EXCEPTION
      'Expected 107 policies in public after this script (105 before + 2 INSERT policies), found %.',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'stella_interactions' AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'stella_interactions still has no INSERT policy.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'stella_suggestion_decisions' AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'stella_suggestion_decisions still has no INSERT policy.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'audit_logs still has no INSERT policy.';
  END IF;

  -- 4.2 No function in public is left on a schema-name search_path, and none
  -- became SECURITY INVOKER or changed owner along the way.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      -- The stored form of `SET search_path = ''` is the six characters
      -- `search_path=` followed by a quoted empty string, NOT a bare trailing
      -- `=`. Matching the bare form would make this assertion vacuously
      -- true — it would never fire, on any database, for any function.
      AND (p.proconfig IS NULL OR NOT ('search_path=""' = ANY (p.proconfig)))
  ) THEN
    RAISE EXCEPTION
      'A SECURITY DEFINER function in public does not pin search_path to the empty string.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'uellix_owner'
  ) THEN
    RAISE EXCEPTION 'A function in public is no longer owned by uellix_owner.';
  END IF;

  -- 4.3 The default privileges landed, and did not hand out UPDATE or DELETE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE pg_get_userbyid(d.defaclrole) = 'uellix_owner'
      AND n.nspname = 'public'
      AND d.defaclobjtype = 'r'
  ) THEN
    RAISE EXCEPTION 'No default table privileges recorded for uellix_owner in public.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE pg_get_userbyid(d.defaclrole) = 'uellix_owner'
      AND n.nspname = 'public'
      AND d.defaclobjtype = 'r'
      AND array_to_string(d.defaclacl, ',') ~ 'uellix_writer=[^/]*[wd]'
  ) THEN
    RAISE EXCEPTION
      'Default table privileges grant UPDATE or DELETE to uellix_writer. Append-only must stay '
      'the default; mutability is a per-table opt-in.';
  END IF;

  -- 4.4 Nothing widened the runtime while we were in here.
  IF has_schema_privilege('uellix_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'uellix_app gained CREATE on public.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app' AND (rolsuper OR rolbypassrls OR rolcreaterole)
  ) THEN
    RAISE EXCEPTION 'uellix_app gained an administrative role attribute.';
  END IF;

  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'uellix_owner') <> 0 THEN
    RAISE EXCEPTION 'A table in public changed owner.';
  END IF;
END
$$;
