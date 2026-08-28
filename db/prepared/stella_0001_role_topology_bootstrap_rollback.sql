-- db/prepared/stella_0001_role_topology_bootstrap_rollback.sql
--
-- Separately governed rollback for stella_0001_role_topology_bootstrap.sql.
-- It is deliberately not invoked by the R3.4 forward runner. A caller must set
-- transaction-local uellix.rollback_confirmation=rollback-0001:<database> in
-- a separately authorised local administrative transaction.

SET search_path = public;

-- ============================================================
-- 0. Refuse while any later package or external object still depends on roles
-- ============================================================
DO $$
DECLARE
  problem text;
  expected_confirmation text := 'rollback-0001:' || current_database();
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'stella_0001 rollback must run through the local administrative superuser phase; session_user is %', session_user;
  END IF;
  IF current_setting('uellix.rollback_confirmation', true) IS DISTINCT FROM expected_confirmation THEN
    RAISE EXCEPTION 'stella_0001 rollback REFUSED: missing transaction-local confirmation for this database.';
  END IF;

  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO problem
  FROM (VALUES ('uellix_owner'), ('uellix_migrator'), ('uellix_app'), ('uellix_writer'), ('uellix_auditor')) AS r(rolname)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles p WHERE p.rolname = r.rolname);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 rollback REFUSED: governed role(s) already absent: %', problem;
  END IF;

  -- Ownership is never guessed or reassigned. Any surviving later package must
  -- be rolled back first, then this package can remove an unused topology.
  SELECT string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY n.nspname, c.relname) INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relowner IN ('uellix_owner'::regrole, 'uellix_migrator'::regrole,
                       'uellix_app'::regrole, 'uellix_writer'::regrole, 'uellix_auditor'::regrole);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 rollback REFUSED: surviving relation(s) depend on governed ownership: %', problem;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO problem
  FROM pg_proc p
  WHERE p.proowner IN ('uellix_owner'::regrole, 'uellix_migrator'::regrole,
                       'uellix_app'::regrole, 'uellix_writer'::regrole, 'uellix_auditor'::regrole);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 rollback REFUSED: surviving function(s) depend on governed ownership: %', problem;
  END IF;

  SELECT string_agg(n.nspname, ', ' ORDER BY n.nspname) INTO problem
  FROM pg_namespace n
  WHERE n.nspowner IN ('uellix_owner'::regrole, 'uellix_migrator'::regrole,
                       'uellix_app'::regrole, 'uellix_writer'::regrole, 'uellix_auditor'::regrole);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 rollback REFUSED: surviving schema(s) depend on governed ownership: %', problem;
  END IF;

  -- pg_shdepend catches ACL/default/other shared-object dependencies that an
  -- ownership scan cannot see. The three catalog classes below are the exact
  -- bootstrap-owned memberships, defaults and schema privileges removed later
  -- in this same transaction; every other dependency is unsafe to guess.
  SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid), ', ' ORDER BY pg_describe_object(d.classid, d.objid, d.objsubid))
    INTO problem
  FROM pg_shdepend d
  WHERE d.refclassid = 'pg_authid'::regclass
    AND d.refobjid IN ('uellix_owner'::regrole, 'uellix_migrator'::regrole,
                       'uellix_app'::regrole, 'uellix_writer'::regrole, 'uellix_auditor'::regrole)
    AND d.classid NOT IN ('pg_auth_members'::regclass, 'pg_default_acl'::regclass, 'pg_namespace'::regclass);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 rollback REFUSED: pg_shdepend reports surviving dependency/dependencies: %', problem;
  END IF;

  WITH canonical(member_name, role_name) AS (
    VALUES ('uellix_migrator', 'uellix_owner'), ('uellix_app', 'uellix_writer'), ('postgres', 'uellix_writer')
  )
  SELECT string_agg(m.rolname || '->' || r.rolname, ', ' ORDER BY m.rolname, r.rolname) INTO problem
  FROM pg_auth_members a
  JOIN pg_roles m ON m.oid = a.member
  JOIN pg_roles r ON r.oid = a.roleid
  WHERE (m.rolname IN ('uellix_app', 'uellix_writer', 'uellix_migrator')
         OR r.rolname IN ('uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator'))
    AND NOT EXISTS (SELECT 1 FROM canonical c WHERE c.member_name = m.rolname AND c.role_name = r.rolname);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0001 rollback REFUSED: non-canonical membership(s) still use the governed perimeter: %', problem;
  END IF;
END $$;

-- ============================================================
-- 1. Remove only the topology authority this package created
-- ============================================================
REVOKE ALL ON SCHEMA public FROM uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;
REVOKE USAGE ON SCHEMA auth FROM uellix_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner    GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner    GRANT USAGE ON TYPES     TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_migrator GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_migrator GRANT USAGE ON TYPES     TO PUBLIC;

REVOKE uellix_owner FROM uellix_migrator;
REVOKE uellix_writer FROM uellix_app;
REVOKE uellix_writer FROM postgres;
ALTER ROLE uellix_auditor RESET default_transaction_read_only;

DROP ROLE uellix_auditor;
DROP ROLE uellix_app;
DROP ROLE uellix_writer;
DROP ROLE uellix_migrator;
DROP ROLE uellix_owner;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor')
  ) THEN
    RAISE EXCEPTION 'stella_0001 rollback FAILED: one or more governed roles remain after attempted removal.';
  END IF;
  RAISE NOTICE 'stella_0001 rollback: topology removed only after dependency guards passed.';
END $$;
