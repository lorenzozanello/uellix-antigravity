-- ============================================================================
-- stella_hosted_0000_managed_role_identity_bootstrap.sql
-- HPO-ODS-W2-03 — the PRE-BASELINE managed-role IDENTITY bootstrap.
-- ============================================================================
--
-- WHY THIS FILE EXISTS, AND WHY IT IS A SPLIT RATHER THAN A COPY
--
-- Two baseline units — 0042_fib_audit_insert_policy.sql (ordinal 53) and
-- 0045_fib_domain_object_version_lineage.sql (ordinal 56) — write
-- `CREATE POLICY … TO uellix_app`. PostgreSQL resolves the role at DDL time, so
-- on a role-pristine cluster PHASE_BASELINE stops at unit 53 with 42704. The
-- only package that created the five managed roles was stella_hosted_0001,
-- which runs AFTER the whole baseline and cannot run before it: its §0 E5
-- requires the RLS helpers 0031 creates and 0039 grants, its §2c transfers the
-- ownership of a table 0012 creates, and its §5d grants on four tables and a
-- function the baseline creates. Measured, not assumed — see
-- docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.4.json.
--
-- So role IDENTITY moves here, and ONLY identity: the five roles, their
-- attributes, and the memberships that need no application table. Everything
-- that needs the baseline stays in stella_hosted_0001, which now ASSERTS what
-- this package established instead of re-creating it. This file is the single
-- source of truth for role identity; stella_hosted_0001 is its consumer.
--
-- AUTHORITATIVE SEQUENCE
--   PLATFORM_SUBSTRATE
--   → PHASE_MANAGED_ROLE_IDENTITIES   (this package)
--   → PHASE_BASELINE                  (64 units, pinned order)
--   → PHASE_STELLA_BOOTSTRAP          (stella_hosted_0001)
--   → PHASE_STELLA_CHAIN
--
-- WHAT THIS PACKAGE DELIBERATELY DOES NOT DO
--   * it references NO Uellix application table;
--   * it transfers NO ownership and grants NO table privilege;
--   * it depends on NO RLS helper and NO baseline migration;
--   * it creates NO application schema object;
--   * it EXECUTEs nothing dynamic — every statement is a literal, for the same
--     reason stella_hosted_0001 §2 gives: the roles are the security boundary
--     of the whole hosted chain, and a static contract cannot read a loop.
--
-- Every role/attribute/membership statement below is the VERBATIM statement
-- stella_hosted_0001 used to carry (its §2, §2b, COMMENT ON ROLE and membership
-- block). No new role semantics were introduced by the move.
--
-- WHAT IS WEAKER ON MANAGED SUPABASE, SAID BEFORE ANY CODE — unchanged from
-- stella_hosted_0001: RR-02. A NON-superuser with CREATEROLE receives
-- membership WITH ADMIN OPTION over every role it creates, so `postgres` can
-- at any moment grant itself SET on uellix_owner. The owner/runtime separation
-- is an AUDITABLE OBSTACLE here, not a barrier. §2 performs that gesture once,
-- deliberately, so it is audited rather than improvised.
--
-- APPLICATION
--   psql "<staging>" -1 -v ON_ERROR_STOP=1 \
--        -c "SET uellix.bootstrap_environment = 'staging'" \
--        -f db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql
--
-- The session setting is MANDATORY and has no default (E4).
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Environment detection — fail closed on anything ambiguous
-- ============================================================
-- Four independent conditions, each a REFUSAL. They are the platform half of
-- stella_hosted_0001 §0 (E1–E4); the baseline-dependent half (E5, E5b, E5c)
-- stays with the package that needs it.
DO $$
DECLARE
  v_missing        text;
  v_declared_env   text;
BEGIN
  -- (E1) This must be a Supabase-shaped database. Checked over the roles and
  --      schemas Supabase itself creates, not over a hostname or a project
  --      name — a name is a string somebody typed.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_missing
  FROM (VALUES ('supabase_admin'), ('supabase_auth_admin'), ('supabase_storage_admin'),
               ('authenticator'), ('anon'), ('authenticated'), ('service_role')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0000 aborted: this does not look like a Supabase database (missing role(s): %). This package encodes the managed-Supabase privilege model; applying it elsewhere would create roles under assumptions that do not hold there.', v_missing;
  END IF;

  SELECT string_agg(s.name, ', ' ORDER BY s.name) INTO v_missing
  FROM (VALUES ('auth'), ('storage'), ('extensions')) AS s(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s.name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0000 aborted: Supabase schema(s) missing: %.', v_missing;
  END IF;

  -- (E2) The caller must NOT be a superuser. A superuser database can run
  --      stella_0001_role_topology_bootstrap / stella_0004, whose separation
  --      `postgres` cannot cross; installing the weaker model over it silently
  --      would be a downgrade nobody chose.
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_hosted_0000 aborted: current_user=% IS a superuser. This package exists only for databases where no superuser is reachable. Apply the local role topology (db/prepared/stella_0001_role_topology_bootstrap.sql) instead — it gives a strictly stronger separation, and this one would silently replace it with an auditable obstacle (RR-02).', current_user;
  END IF;

  -- (E3) The caller must hold CREATEROLE — the one capability this package
  --      actually uses. Named individually, so a refusal says which is missing.
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_hosted_0000 aborted: current_user=% lacks CREATEROLE. On managed Supabase the `postgres` role holds it; a restricted role does not, and the five roles below cannot be created without it.', current_user;
  END IF;

  -- (E4) The operator must DECLARE the environment. There is no default, and
  --      the comparison is exact.
  BEGIN
    v_declared_env := current_setting('uellix.bootstrap_environment');
  EXCEPTION WHEN undefined_object THEN
    v_declared_env := NULL;
  END;

  IF v_declared_env IS DISTINCT FROM 'staging' THEN
    RAISE EXCEPTION 'stella_hosted_0000 aborted: uellix.bootstrap_environment must be exactly ''staging'' (got %). Set it in the SAME session: psql -c "SET uellix.bootstrap_environment = ''staging''" -f <this file>. There is no default: an unset environment is an ambiguous environment, and this package refuses those.', coalesce(quote_literal(v_declared_env), '<unset>');
  END IF;

  RAISE NOTICE 'stella_hosted_0000: environment accepted — managed Supabase, non-superuser installer % with CREATEROLE.', current_user;
END $$;

-- ============================================================
-- 1. The five roles
-- ============================================================
-- Same five names, same shape and the same membership graph as stella_0004 /
-- stella_0001_role_topology_bootstrap, so that one role model documents both
-- environments.
--
-- NOLOGIN for owner and writer: neither is ever an endpoint of a connection.
-- NOBYPASSRLS everywhere, without exception and including the owner.
-- EVERY STATEMENT IS A LITERAL, and the repetition is the point: five literal
-- blocks can be read by a static contract (tests/prepared-stella-sql.test.ts
-- refuses dynamic EXECUTE); one loop cannot.
--
-- Each block is convergent and NARROWING ONLY: re-application strips dangerous
-- attributes somebody may have added by hand, and never adds LOGIN to a role
-- found without it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    CREATE ROLE uellix_owner WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0000: created role uellix_owner';
  ELSE
    ALTER ROLE uellix_owner WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;

  -- E-02, measured on PostgreSQL 17.6. CREATEROLE, and it is the ONE attribute
  -- in this block that is not narrowing: uellix_migrator is the principal every
  -- temporary elevation the governed chain emits names, and six of the nine
  -- chain packages create a capability role. On PostgreSQL 16+ CREATEROLE
  -- administers only the roles its holder created and cannot confer SUPERUSER.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_migrator') THEN
    CREATE ROLE uellix_migrator WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0000: created role uellix_migrator';
  ELSE
    ALTER ROLE uellix_migrator WITH NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    CREATE ROLE uellix_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0000: created role uellix_app';
  ELSE
    ALTER ROLE uellix_app WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN
    CREATE ROLE uellix_writer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0000: created role uellix_writer';
  ELSE
    ALTER ROLE uellix_writer WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_auditor') THEN
    CREATE ROLE uellix_auditor WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0000: created role uellix_auditor';
  ELSE
    ALTER ROLE uellix_auditor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. The installer must be able to BECOME the owner (RR-02)
-- ------------------------------------------------------------
-- When a NON-superuser with CREATEROLE creates a role, PostgreSQL 16+ grants it
-- membership with admin_option = true, inherit_option = false,
-- set_option = false. ADMIN OPTION is not the right to SET ROLE, and seven of
-- the nine chain packages — and stella_hosted_0001 §2c — need exactly that.
--
-- The grant below is the RR-02 gesture performed DELIBERATELY, once, in a
-- reviewed package. Written as a literal for `postgres` because that is the
-- managed-Supabase installer; any other identity gets an actionable refusal
-- naming the exact statement, rather than a dynamic GRANT no static contract
-- can read.
DO $$
BEGIN
  IF current_user = 'postgres' AND NOT pg_has_role('postgres', 'uellix_owner', 'SET') THEN
    GRANT uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE;
    RAISE NOTICE 'stella_hosted_0000: granted postgres SET on uellix_owner (RR-02, deliberate and audited).';
  END IF;

  IF NOT pg_has_role(current_user, 'uellix_owner', 'SET') THEN
    RAISE EXCEPTION 'stella_hosted_0000 aborted: % cannot SET ROLE uellix_owner, and the post-baseline bootstrap and seven chain packages open an owner window. On PostgreSQL 16+ a non-superuser CREATEROLE receives ADMIN OPTION but NOT set_option when it creates a role. Run, as a role holding ADMIN OPTION on uellix_owner: GRANT uellix_owner TO %I WITH INHERIT FALSE, SET TRUE; then re-run this package.', current_user, current_user;
  END IF;
END $$;

-- ============================================================
-- 3. Comments — the role model, readable from the catalog
-- ============================================================
COMMENT ON ROLE uellix_owner    IS 'stella_hosted_0000: object owner. NOLOGIN, NOBYPASSRLS, NOCREATEROLE. On managed Supabase postgres retains ADMIN OPTION over it (RR-02) — an auditable obstacle, not a barrier.';
COMMENT ON ROLE uellix_migrator IS 'stella_hosted_0000: the only LOGIN role that reaches uellix_owner, and only by explicit SET ROLE.';
COMMENT ON ROLE uellix_app      IS 'stella_hosted_0000: application runtime. NOBYPASSRLS — every product query is governed by RLS.';
COMMENT ON ROLE uellix_writer   IS 'stella_hosted_0000: governed write surface, reached by uellix_app through inheritance. stella_0017 revokes its INSERT on the ledger.';
COMMENT ON ROLE uellix_auditor  IS 'stella_hosted_0000: read-only auditor.';

-- ============================================================
-- 4. Membership
-- ============================================================
-- SET is granted ONLY where a role must be able to become another; INHERIT only
-- where privileges must flow without an explicit statement. Neither membership
-- references an application table.
DO $$
BEGIN
  -- migrator -> owner: SET yes, INHERIT no. The migrator must ANNOUNCE that it
  -- is acting as the owner; inheriting would make every migrator statement an
  -- owner statement.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.member
    WHERE r.rolname = 'uellix_owner' AND g.rolname = 'uellix_migrator'
  ) THEN
    GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;
  END IF;

  -- app -> writer: INHERIT yes, SET no. The runtime must not be able to shed
  -- its own identity.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.member
    WHERE r.rolname = 'uellix_writer' AND g.rolname = 'uellix_app'
  ) THEN
    GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE;
  END IF;
END $$;

-- ============================================================
-- 5. Self-verification — assert the identity end state, in this transaction
-- ============================================================
DO $$
DECLARE
  v_problem text;
BEGIN
  -- (1) The five roles exist, and NONE of them is dangerous. Written over the
  --     attributes rather than over a list of names, so a role added later by
  --     hand with SUPERUSER would be caught by the same query. The ONE
  --     exemption is uellix_migrator's CREATEROLE (E-02), stated rather than
  --     removed.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO v_problem
  FROM pg_roles
  WHERE rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor')
    AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolreplication
         OR (rolcreaterole AND rolname <> 'uellix_migrator'));

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0000 FAILED verification: role(s) % hold a dangerous attribute. No role this package creates may be SUPERUSER, BYPASSRLS, CREATEDB or REPLICATION, and only uellix_migrator may hold CREATEROLE.', v_problem;
  END IF;

  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_problem
  FROM (VALUES ('uellix_owner'),('uellix_migrator'),('uellix_app'),('uellix_writer'),('uellix_auditor')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0000 FAILED verification: role(s) % were not created.', v_problem;
  END IF;

  -- (2) THE RUNTIME CANNOT BECOME THE OWNER. Checked in the direction that
  --     matters: not "is there a grant" but "can this role reach that one, by
  --     any path".
  IF pg_has_role('uellix_app', 'uellix_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'stella_hosted_0000 FAILED verification: uellix_app can reach uellix_owner. The runtime must never be able to alter structure, policies or triggers.';
  END IF;

  IF pg_has_role('uellix_app', 'uellix_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'stella_hosted_0000 FAILED verification: uellix_app can reach uellix_migrator.';
  END IF;

  -- (3) The migrator reaches the owner only by SET, never by inheritance.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.member
    WHERE r.rolname = 'uellix_owner' AND g.rolname = 'uellix_migrator'
      AND m.set_option AND NOT m.inherit_option
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0000 FAILED verification: uellix_migrator must hold uellix_owner WITH SET TRUE, INHERIT FALSE. Inheriting would make every migrator statement an owner statement.';
  END IF;

  RAISE NOTICE 'stella_hosted_0000: verification passed — 5 role identities with no dangerous attribute, runtime cannot reach owner, migrator reaches it only by SET. No application table was referenced, owned or granted: that is PHASE_BASELINE and stella_hosted_0001.';
  RAISE NOTICE 'stella_hosted_0000: RESIDUAL RISK RR-02 — this installer is a non-superuser with CREATEROLE, so it retains ADMIN OPTION over every role created here and can grant itself SET on uellix_owner. The separation is an auditable obstacle, not a barrier.';
END $$;
