-- db/prepared/stella_0001_role_topology_bootstrap.sql
--
-- Local PostgreSQL 17 role-topology bootstrap for the Stella prepared chain.
--
-- PREPARED ONLY — never a Drizzle migration and never a hosted bootstrap.
-- Execute only through scripts/stella-r3-4-local-runner.ts, in its fixed
-- administrative phase. The hosted managed trust model is deliberately not an
-- input to this package.
--
-- This is the SINGLE mutating authority for the governed local roles,
-- memberships, role-local defaults and schema privileges. stella_0004 verifies
-- this topology but does not recreate or mutate it.

SET search_path = public;

-- ============================================================
-- 0. Administrative and PostgreSQL 17 preconditions
-- ============================================================
DO $$
DECLARE
  missing_roles text;
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'stella_0001 requires PostgreSQL 17+ because pg_auth_members inherit_option and set_option are load-bearing; this server is %',
      current_setting('server_version');
  END IF;

  IF session_user <> current_user
     OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'stella_0001 must run through a raw local administrative superuser session, with no SET ROLE in effect; session_user is %, current_user is %',
      session_user, current_user;
  END IF;

  SELECT string_agg(v.rolname, ', ' ORDER BY v.rolname) INTO missing_roles
  FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('postgres')) AS v(rolname)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = v.rolname);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 aborted: local Supabase role prerequisite(s) missing: %', missing_roles;
  END IF;
END $$;

-- ============================================================
-- 1. Role attributes
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    EXECUTE 'CREATE ROLE uellix_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_migrator') THEN
    EXECUTE 'CREATE ROLE uellix_migrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    EXECUTE 'CREATE ROLE uellix_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN
    EXECUTE 'CREATE ROLE uellix_writer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_auditor') THEN
    EXECUTE 'CREATE ROLE uellix_auditor';
  END IF;
END $$;

-- All roles are globally NOINHERIT. Capability inheritance is explicit on the
-- membership row, which is the only place PostgreSQL 17 can represent the
-- intended semantics.
ALTER ROLE uellix_owner    NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_migrator LOGIN   NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_app      LOGIN   NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_writer   NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_auditor  LOGIN   NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_auditor SET default_transaction_read_only = on;

COMMENT ON ROLE uellix_owner IS
  'stella_0001: local prepared-chain object owner. NOLOGIN; reachable only by SET ROLE from uellix_migrator.';
COMMENT ON ROLE uellix_migrator IS
  'stella_0001: local prepared-chain migrator. Membership in uellix_owner is SET-only, never inherited.';
COMMENT ON ROLE uellix_app IS
  'stella_0001: local runtime role. No ownership, no BYPASSRLS and no schema CREATE; inherits only uellix_writer capability.';
COMMENT ON ROLE uellix_writer IS
  'stella_0001: NOLOGIN governed write-capability role. It never carries administrative membership.';
COMMENT ON ROLE uellix_auditor IS
  'stella_0001: LOGIN read-only audit role with no governed memberships.';

-- ============================================================
-- 2. Exact controlled membership inventory
-- ============================================================
-- A positive EXISTS test is insufficient in PostgreSQL 17: the same logical
-- member/role relationship can be represented by more than one grantor row.
-- Refuse an unexpected existing row before reconciliation. A later REVOKE is
-- not evidence that another authority's row disappeared, so it must never
-- turn an unauthorised grantor into a false-green canonical inventory.
--
-- The canonical grantor is the PostgreSQL BOOTSTRAP SUPERUSER, asserted by its
-- fixed oid (10) rather than any role name: PG17 attributes a membership
-- granted by a raw superuser session to that oid regardless of what the
-- superuser happens to be called on a given cluster. The resolved name below
-- is audit text only and never becomes the equality authority.
DO $$
DECLARE
  problem text;
BEGIN
  WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
    VALUES
      ('uellix_migrator', 'uellix_owner', 10::oid, false, true, false),
      ('uellix_app', 'uellix_writer', 10::oid, true, false, false),
      ('postgres', 'uellix_writer', 10::oid, true, false, false)
  ), actual AS (
    SELECT m.rolname AS member_name, r.rolname AS role_name, a.grantor AS grantor_oid,
           g.rolname AS grantor_name,
           a.inherit_option, a.set_option, a.admin_option
    FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    JOIN pg_roles g ON g.oid = a.grantor
    WHERE m.rolname IN ('uellix_app', 'uellix_writer', 'uellix_migrator')
       OR r.rolname IN ('uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator')
  )
  SELECT string_agg(a.member_name || '->' || a.role_name || ' granted-by=' || a.grantor_name || '(oid=' || a.grantor_oid || ')',
                    ', ' ORDER BY a.member_name, a.role_name, a.grantor_oid)
    INTO problem
  FROM actual a
  WHERE NOT EXISTS (
    SELECT 1 FROM expected e
    WHERE e.member_name = a.member_name
      AND e.role_name = a.role_name
      AND e.grantor_oid = a.grantor_oid
      AND a.inherit_option IS NOT DISTINCT FROM e.inherit_option
      AND a.set_option IS NOT DISTINCT FROM e.set_option
      AND a.admin_option IS NOT DISTINCT FROM e.admin_option
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 FAILED: canonical membership precondition rejected unexpected relevant membership row (wrong grantor, flags or ADMIN escalation): %', problem;
  END IF;
END $$;

-- Revoke only after the precondition above has proved that no other grantor
-- can be concealed by reconciliation; then re-grant the exact controlled rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    WHERE m.rolname = 'uellix_migrator' AND r.rolname = 'uellix_owner'
  ) THEN
    EXECUTE 'REVOKE uellix_owner FROM uellix_migrator';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    WHERE m.rolname = 'uellix_app' AND r.rolname = 'uellix_writer'
  ) THEN
    EXECUTE 'REVOKE uellix_writer FROM uellix_app';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    WHERE m.rolname = 'postgres' AND r.rolname = 'uellix_writer'
  ) THEN
    EXECUTE 'REVOKE uellix_writer FROM postgres';
  END IF;
END $$;

GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT uellix_writer TO uellix_app      WITH INHERIT TRUE,  SET FALSE, ADMIN FALSE;
GRANT uellix_writer TO postgres        WITH INHERIT TRUE,  SET FALSE, ADMIN FALSE;

-- ============================================================
-- 3. Schema and role-local default privilege posture
-- ============================================================
GRANT USAGE ON SCHEMA public TO uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;
GRANT CREATE ON SCHEMA public TO uellix_owner;
REVOKE CREATE ON SCHEMA public FROM uellix_migrator, uellix_app, uellix_writer, uellix_auditor, PUBLIC;

-- The owner needs only schema lookup for auth.uid() inside the RLS helpers
-- whose ownership 0004 reconciles. It receives no auth table privilege.
GRANT USAGE ON SCHEMA auth TO uellix_owner;

-- PostgreSQL's default EXECUTE/USAGE to PUBLIC is global. The only effective
-- suppression is therefore global and scoped by creator role, not schema.
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner    REVOKE USAGE ON TYPES     FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_migrator REVOKE USAGE ON TYPES     FROM PUBLIC;

-- ============================================================
-- 4. Self-verification — exact rows, flags, cardinality and escalation
-- ============================================================
DO $$
DECLARE
  problem text;
  app_oid oid;
  owner_oid oid;
BEGIN
  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'uellix_app';
  SELECT oid INTO owner_oid FROM pg_roles WHERE rolname = 'uellix_owner';

  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO problem
  FROM pg_roles r
  WHERE r.rolname IN ('uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor')
    AND (
      r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit
      OR (r.rolname IN ('uellix_owner', 'uellix_writer') AND r.rolcanlogin)
      OR (r.rolname IN ('uellix_migrator', 'uellix_app', 'uellix_auditor') AND NOT r.rolcanlogin)
    );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 FAILED: governed role attributes are not canonical: %', problem;
  END IF;

  -- The relevant perimeter is deliberately role-identity based. A disjoint
  -- membership is outside this controlled inventory and is not rejected merely
  -- because its name happens to contain "uellix". Grantor is compared by the
  -- fixed bootstrap-superuser oid (10), never by role name — see §2.
  WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
    VALUES
      ('uellix_migrator', 'uellix_owner', 10::oid, false, true, false),
      ('uellix_app', 'uellix_writer', 10::oid, true, false, false),
      ('postgres', 'uellix_writer', 10::oid, true, false, false)
  ), actual AS (
    SELECT m.rolname AS member_name, r.rolname AS role_name, a.grantor AS grantor_oid,
           g.rolname AS grantor_name,
           a.inherit_option, a.set_option, a.admin_option
    FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    JOIN pg_roles g ON g.oid = a.grantor
    WHERE m.rolname IN ('uellix_app', 'uellix_writer', 'uellix_migrator')
       OR r.rolname IN ('uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator')
  )
  SELECT string_agg(a.member_name || '->' || a.role_name || ' granted-by=' || a.grantor_name || '(oid=' || a.grantor_oid || ')' ||
                    '(inherit=' || a.inherit_option::text || ',set=' || a.set_option::text ||
                    ',admin=' || a.admin_option::text || ')', ', ' ORDER BY a.member_name, a.role_name, a.grantor_oid)
    INTO problem
  FROM actual a
  WHERE NOT EXISTS (
    SELECT 1 FROM expected e
    WHERE e.member_name = a.member_name
      AND e.role_name = a.role_name
      AND e.grantor_oid = a.grantor_oid
      AND a.inherit_option IS NOT DISTINCT FROM e.inherit_option
      AND a.set_option IS NOT DISTINCT FROM e.set_option
      AND a.admin_option IS NOT DISTINCT FROM e.admin_option
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 FAILED: unexpected relevant membership row (including wrong grantor, membership flags or ADMIN escalation): %', problem;
  END IF;

  WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
    VALUES
      ('uellix_migrator', 'uellix_owner', 10::oid, false, true, false),
      ('uellix_app', 'uellix_writer', 10::oid, true, false, false),
      ('postgres', 'uellix_writer', 10::oid, true, false, false)
  )
  SELECT string_agg(e.member_name || '->' || e.role_name, ', ' ORDER BY e.member_name, e.role_name)
    INTO problem
  FROM expected e
  WHERE (
    SELECT count(*)
    FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    WHERE m.rolname = e.member_name
      AND r.rolname = e.role_name
      AND a.grantor = e.grantor_oid
      AND a.inherit_option IS NOT DISTINCT FROM e.inherit_option
      AND a.set_option IS NOT DISTINCT FROM e.set_option
      AND a.admin_option IS NOT DISTINCT FROM e.admin_option
  ) <> 1;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 FAILED: canonical membership tuple cardinality is not exactly one row: %', problem;
  END IF;

  -- pg_has_role(..., 'SET') remains the final effective check. Unlike a direct
  -- row check, PostgreSQL follows a direct or transitive SET path here.
  IF pg_has_role(app_oid, owner_oid, 'SET') THEN
    RAISE EXCEPTION 'stella_0001 FAILED: uellix_app has a direct or transitive SET path to uellix_owner.';
  END IF;

  IF has_schema_privilege('uellix_app', 'public', 'CREATE')
     OR has_schema_privilege('uellix_migrator', 'public', 'CREATE')
     OR has_schema_privilege('PUBLIC', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_0001 FAILED: non-owner CREATE privilege remains on public.';
  END IF;

  IF has_table_privilege('uellix_owner', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_app', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_writer', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_auditor', 'auth.users', 'SELECT') THEN
    RAISE EXCEPTION 'stella_0001 FAILED: topology bootstrap granted a Uellix role access to auth.users.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole = 'uellix_owner'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'::"char"
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole = 'uellix_owner'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'T'::"char"
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole = 'uellix_migrator'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'::"char"
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole = 'uellix_migrator'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'T'::"char"
  ) THEN
    RAISE EXCEPTION 'stella_0001 FAILED: global PUBLIC-suppression default privilege is absent for a governed creator role.';
  END IF;

  RAISE NOTICE 'stella_0001: verification passed — five canonical role attributes, three exact controlled membership tuples including bootstrap grantor % (oid=10), no second grantor row, no ADMIN escalation, no direct/transitive app SET path to owner, and only owner CREATE on public.',
    (SELECT rolname FROM pg_roles WHERE oid = 10);
END $$;
