-- ============================================================================
-- stella_local_0000_local_role_identity_bootstrap.sql
-- HPO-ODS-W2-11 — the LOCAL/CI pre-baseline role IDENTITY + bootstrap
-- privilege package. docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_v1.0.0.json,
-- canonical_topology PHASE_LOCAL_ROLE_IDENTITY + PHASE_BOOTSTRAP_PRIVILEGE.
-- ============================================================================
--
-- WHY THIS FILE EXISTS, AND WHY IT IS NOT db/prepared/stella_0001
--
-- Three baseline-era migrations — 0042_fib_audit_insert_policy.sql,
-- 0045_fib_domain_object_version_lineage.sql and
-- 0060_fib_outcome_monetization_dispositions_governance.sql — write
-- `CREATE POLICY … TO uellix_app`. PostgreSQL resolves the role at DDL time,
-- so on a role-pristine LOCAL/CI database `pnpm db:migrate:local` stops at the
-- first of those with 42704 (role "uellix_app" does not exist).
--
-- The only package that creates the five governed roles LOCALLY today is
-- db/prepared/stella_0001_role_topology_bootstrap.sql — and it cannot run
-- first: its §3 grants REFERENCES on public.organizations / projects / users /
-- stella_interactions and EXECUTE on public.uellix_forbid_mutation(), all
-- created by drizzle migrations (0012, 0030 and earlier). Applying it before
-- `db:migrate:local` fails with "relation … does not exist"; applying
-- `db:migrate:local` before it fails with "role … does not exist". Neither
-- order works — this is the exact ordering conflict HPO-ODS-W2-03 already
-- resolved on the HOSTED side by splitting stella_hosted_0000 (identity only)
-- from stella_hosted_0001 (baseline-dependent). This file is that same split,
-- for the LOCAL/CI substrate.
--
-- AUTHORITATIVE SEQUENCE
--   PHASE_PLATFORM_SUBSTRATE
--   → PHASE_LOCAL_ROLE_IDENTITY + PHASE_BOOTSTRAP_PRIVILEGE   (this package)
--   → PHASE_PART_A_PREREQUISITE     (db/prepared/storage/20260716000001_part_a_helpers.psql.sql, verbatim)
--   → PHASE_MIGRATION_WINDOW        (pnpm db:migrate:local, 0000..0061)
--   → PHASE_LOCAL_PREPARED_CHAIN    (db/prepared/stella_0001_role_topology_bootstrap.sql onward — now ASSERTS, does not re-create)
--   → PHASE_POSTCONDITIONS
--
-- WHAT THIS PACKAGE DELIBERATELY DOES NOT DO
--   * it references NO Uellix application table, function, type or policy;
--   * it transfers NO ownership and grants NO table privilege;
--   * it depends on NO RLS helper and NO baseline migration;
--   * it creates NO application schema object;
--   * it grants NO database-level CREATE — that privilege is TEMPORARY and is
--     opened/closed by the gate script itself around the migration window
--     (PHASE_MIGRATION_WINDOW), never baked into this PERMANENT-topology file;
--   * it EXECUTEs nothing dynamic in its mutating statements — the five
--     CREATE ROLE statements and the schema grants are literals, matching the
--     static-contract rationale stella_hosted_0000/§2 and stella_0001 give.
--
-- WHY uellix_migrator IS CREATED WITHOUT CREATEROLE HERE (UNLIKE stella_hosted_0000)
--
-- stella_hosted_0000 grants uellix_migrator CREATEROLE because on managed
-- Supabase six of the nine governed chain packages need it to create a
-- capability role later. The LOCAL/CI prepared chain has no such dependency —
-- db/prepared/stella_0001_role_topology_bootstrap.sql already creates
-- uellix_migrator WITHOUT CREATEROLE (its own §1) — and
-- db/migrator.ts assertMigratorSession HARD-REJECTS a migration session that
-- carries CREATEROLE (DB_MIGRATOR_OVERPRIVILEGED). Creating it without
-- CREATEROLE from the start, rather than granting-then-narrowing as the M2
-- disposable fixture does when it borrows the HOSTED package, matches the
-- canonical LOCAL topology exactly and needs no separate narrowing step.
--
-- ACTOR PARTITION (P1A_FULL_BOOTSTRAP_AUTHORITY_AMENDMENT_v1.0.1.json
-- D5_b2_grantor.actor_partition — CORRECTED, superseding an earlier revision
-- of this file that ran role creation and memberships A/B as `postgres`)
--
-- `supabase_admin` performs: CREATE ROLE x5, membership A, membership B, and
-- the auth-schema USAGE grant. That is four statements, but only THREE are
-- privilege writes under P1A-N7's definition (a pg_auth_members row or an
-- object-ACL change) — CREATE ROLE by a genuine superuser emits ZERO
-- pg_auth_members rows (measured against the exact pinned image), so it does
-- not count. `postgres` retains ONLY the two public-schema ACL statements —
-- measured to produce a BYTE-IDENTICAL resulting ACL regardless of which
-- actor issues them, because schema `public` is owned by `pg_database_owner`,
-- not by the issuing role; routing them through `supabase_admin` would add
-- two privilege writes for zero catalog difference, which the single-write
-- discipline this file enforces (P1A-N7 = exactly 3) forbids.
--
-- This split is not stylistic. Three independently measured, mechanical
-- reasons make `supabase_admin` the only correct actor for role creation and
-- memberships A/B — none of them is "postgres cannot issue the GRANT". It
-- can:
--   1. GRANTOR PIN. db/prepared/stella_0001_role_topology_bootstrap.sql §2
--      pins the canonical grantor for these membership rows to the fixed
--      bootstrap-superuser oid (10), and refuses any unexpected relevant
--      row. `supabase_admin` IS oid 10 on this substrate; `postgres` is not.
--   2. ADMIN-OPTION AUTO-GRANTS / RR-02. PostgreSQL 16+ automatically grants
--      a CREATEROLE-non-superuser creator ADMIN OPTION over every role it
--      creates. `postgres` here is CREATEROLE-non-superuser, so creating the
--      five roles as `postgres` would leave five admin_option=true rows —
--      which stella_0001's precondition rejects, and which would let
--      `postgres` grant itself `uellix_owner … SET TRUE` and self-escalate
--      (measured: it then successfully reached `uellix_owner` via SET
--      ROLE). A genuine superuser creator — `supabase_admin` — leaves ZERO
--      such rows.
--   3. AUTH-SCHEMA FAIL-OPEN. `GRANT USAGE ON SCHEMA auth` as `postgres`
--      does not error — it silently WARNs "no privileges were granted" and
--      exits 0, leaving the privilege absent; `ON_ERROR_STOP=1` cannot catch
--      a WARNING. `supabase_admin` owns schema `auth`, and the grant
--      succeeds.
--
-- WHY THE FILE RECONNECTS TWICE (\connect), AND WHY NEITHER IS A SECOND ENTRY
-- POINT
--
-- The script's own psql invocation still connects as `postgres` (below,
-- APPLICATION) — that is the substrate-shape connection §0/E3 verifies.
-- Section 1 immediately reconnects to `supabase_admin`, reachable directly
-- on this substrate without any prior role existing (it is the pinned
-- image's own pre-existing bootstrap superuser, oid 10): every statement
-- that must be a supabase_admin privilege write happens in that ONE
-- session — role creation, membership A, membership B, the auth grant.
-- Section 5 reconnects BACK to `postgres` for the two public-schema ACL
-- statements only. `ON_ERROR_STOP=1` fails the whole script closed if
-- either reconnection fails, and each reconnect is followed by an explicit
-- identity assertion — never trusted implicitly.
--
-- WHY THIS PACKAGE REFUSES A SECOND APPLICATION (UNLIKE ITS TWO SIBLINGS)
--
-- stella_hosted_0000 and stella_0001 are both convergent/idempotent by
-- design: safe to re-run against a database that already carries their end
-- state. This package is deliberately NOT — it refuses outright if any
-- uellix_* role already exists, BEFORE any privilege mutation. The topology
-- authority's own second-run contract requires a repeated bootstrap against a
-- non-pristine database to be a DETERMINISTIC_SAFE_REJECTION, and the ONLY
-- database this package is ever authorized to run against is a disposable
-- container the gate script itself just created — convergence has no
-- legitimate use case here, and would silently mask the gate failing to
-- provision a genuinely fresh substrate.
--
-- APPLICATION (via the gate script; never by hand against a persistent DB)
--   psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -A \
--     <<< "SET uellix.bootstrap_environment = 'local';" + this file's content
--
-- The session setting is MANDATORY and has no default (E4). It is prepended
-- by the gate script, exactly as scripts/m2-disposable-pg-bootstrap.ts
-- applyHostedRoleIdentity() already does for stella_hosted_0000's own E4.
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Environment detection — fail closed on anything ambiguous
-- ============================================================
DO $$
DECLARE
  v_missing        text;
  v_declared_env   text;
  v_existing       text;
BEGIN
  -- (E1) This must look like the pinned Supabase-shaped disposable substrate,
  --      checked over the roles and schemas Supabase itself creates — not
  --      over a hostname, port or project name, which are strings somebody
  --      typed.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_missing
  FROM (VALUES ('supabase_admin'), ('anon'), ('authenticated'), ('service_role'), ('postgres')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: this does not look like the pinned Supabase-shaped disposable substrate (missing role(s): %).', v_missing;
  END IF;

  SELECT string_agg(s.name, ', ' ORDER BY s.name) INTO v_missing
  FROM (VALUES ('auth'), ('storage'), ('extensions')) AS s(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s.name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: Supabase schema(s) missing: %.', v_missing;
  END IF;

  -- (E2) PostgreSQL 17+: pg_auth_members inherit_option / set_option are
  --      load-bearing for the membership semantics below, matching
  --      stella_0001's own §0 precondition.
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'stella_local_0000 requires PostgreSQL 17+; this server is %', current_setting('server_version');
  END IF;

  -- (E3) The installer must be exactly `postgres`, connected directly (no
  --      SET ROLE in effect), non-superuser, holding CREATEROLE. `postgres`
  --      no longer performs role creation itself (see ACTOR PARTITION,
  --      above) — this proves the substrate SHAPE this package targets
  --      (the pinned image's `postgres` is deliberately CREATEROLE-but-
  --      non-superuser), independent of which actor exercises which
  --      privilege later. Written over the CONNECTING identity, not merely
  --      current_user, so a session that reached `postgres` via SET ROLE
  --      from something else is refused rather than silently trusted.
  IF session_user <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: must run as a direct `postgres` connection with no SET ROLE in effect; session_user=%, current_user=%', session_user, current_user;
  END IF;

  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: `postgres` is a superuser on this substrate. This package targets the disposable pinned-image substrate, where `postgres` is deliberately CREATEROLE-but-not-superuser; a superuser `postgres` means this is not that substrate.';
  END IF;

  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: `postgres` lacks CREATEROLE; the five roles below cannot be created without it.';
  END IF;

  -- (E4) Pristine-state precondition. Refuse BEFORE any privilege mutation —
  --      this package is a DETERMINISTIC_SAFE_REJECTION on a second
  --      application, never a convergent no-op. See the file header.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO v_existing
  FROM pg_roles WHERE rolname LIKE 'uellix\_%' ESCAPE '\';

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: uellix_* role(s) already exist (%). This package only ever targets a role-pristine disposable substrate; a non-pristine target means the gate did not provision a fresh environment, and must not proceed.', v_existing;
  END IF;

  -- (E5) The operator must DECLARE the environment. There is no default, and
  --      the comparison is exact — mirrors
  --      db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql:111-117.
  BEGIN
    v_declared_env := current_setting('uellix.bootstrap_environment');
  EXCEPTION WHEN undefined_object THEN
    v_declared_env := NULL;
  END;

  IF v_declared_env IS DISTINCT FROM 'local' THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: uellix.bootstrap_environment must be exactly ''local'' (got %). There is no default: an unset environment is an ambiguous environment, and this package refuses those.', coalesce(quote_literal(v_declared_env), '<unset>');
  END IF;

  RAISE NOTICE 'stella_local_0000: environment accepted — disposable pinned substrate, role-pristine, installer postgres (CREATEROLE, non-superuser).';
END $$;

-- ============================================================
-- 1. Reconnect as supabase_admin — the actor for every supabase_admin
--    privilege write this package performs (P1A-N7 = exactly 3)
-- ============================================================
-- See the file header, ACTOR PARTITION. `\connect` opens a brand-new backend
-- connection; ON_ERROR_STOP=1 aborts the whole script if it cannot
-- authenticate as supabase_admin, so a substrate where that role is
-- unreachable fails closed here rather than silently continuing as
-- `postgres`.
\connect - supabase_admin

DO $$
BEGIN
  IF current_user <> 'supabase_admin' OR session_user <> 'supabase_admin' THEN
    RAISE EXCEPTION 'stella_local_0000 fail-closed: \connect to supabase_admin did not take effect (current_user=%, session_user=%)', current_user, session_user;
  END IF;

  -- supabase_admin must genuinely BE the bootstrap superuser (oid 10) this
  -- package's entire actor partition depends on — never trusted by name
  -- alone. stella_0001's own canonical membership precondition pins the
  -- same oid; asserting it here, before any mutation, fails this package
  -- closed on a substrate where the identity has drifted rather than
  -- silently issuing grants a later phase will reject anyway.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: supabase_admin is not a superuser on this substrate.';
  END IF;

  IF (SELECT oid FROM pg_roles WHERE rolname = 'supabase_admin') <> 10 THEN
    RAISE EXCEPTION 'stella_local_0000 aborted: supabase_admin does not hold the fixed bootstrap-superuser oid (10) on this substrate.';
  END IF;
END $$;

-- ============================================================
-- 2. The five roles — identity only, no application table referenced
-- ============================================================
-- Every attribute is set INLINE at CREATE time, never by a later ALTER ROLE.
-- Created by a genuine superuser (supabase_admin): PostgreSQL 16+'s implicit
-- ADMIN-OPTION auto-grant applies only to a CREATEROLE-non-superuser
-- creator, so this creates ZERO pg_auth_members rows — measured against the
-- exact pinned image. The pristine-state precondition above guarantees none
-- of these five roles exists yet, so a plain CREATE ROLE (not
-- "IF NOT EXISTS … ELSE ALTER") is correct here and doubles as an additional,
-- independent pristine-state proof: a collision raises 42710 on its own.
--
-- uellix_migrator is created WITHOUT CREATEROLE — see the file header. All
-- five match db/prepared/stella_0001_role_topology_bootstrap.sql's own final
-- attribute set exactly (NOLOGIN/LOGIN, NOINHERIT, NOBYPASSRLS, NOCREATEDB,
-- NOCREATEROLE, NOREPLICATION, NOSUPERUSER).
CREATE ROLE uellix_owner    WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE uellix_migrator WITH LOGIN   NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE uellix_app      WITH LOGIN   NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE uellix_writer   WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE uellix_auditor  WITH LOGIN   NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE uellix_auditor SET default_transaction_read_only = on;

COMMENT ON ROLE uellix_owner    IS 'stella_local_0000: local/CI disposable object owner. NOLOGIN; reachable only by SET ROLE from uellix_migrator. db/prepared/stella_0001_role_topology_bootstrap.sql asserts, and does not re-create, this identity.';
COMMENT ON ROLE uellix_migrator IS 'stella_local_0000: the only LOGIN role that reaches uellix_owner, and only by explicit SET ROLE. Created WITHOUT CREATEROLE — db/migrator.ts assertMigratorSession hard-rejects a migration session that carries it.';
COMMENT ON ROLE uellix_app      IS 'stella_local_0000: local/CI application runtime identity. NOBYPASSRLS.';
COMMENT ON ROLE uellix_writer   IS 'stella_local_0000: NOLOGIN governed write-capability role, reached by uellix_app through inheritance.';
COMMENT ON ROLE uellix_auditor  IS 'stella_local_0000: LOGIN read-only audit role; default_transaction_read_only=on.';

-- ============================================================
-- 3. Membership A and B — exactly the two the migration window needs,
--    issued by supabase_admin so the grantor is the fixed bootstrap-
--    superuser oid (10) stella_0001's own precondition requires
-- ============================================================
-- Only the two memberships PHASE_MIGRATION_WINDOW depends on are established
-- here; db/prepared/stella_0001_role_topology_bootstrap.sql §2 remains the
-- owner of the third (uellix_writer TO postgres, membership C) and of
-- ongoing membership reconciliation — this package does not duplicate that
-- responsibility and does not create membership C.
GRANT uellix_owner  TO uellix_migrator WITH INHERIT FALSE, SET TRUE,  ADMIN FALSE;
GRANT uellix_writer TO uellix_app      WITH INHERIT TRUE,  SET FALSE, ADMIN FALSE;

-- ============================================================
-- 4. Auth-schema privilege — the third and final supabase_admin write
-- ============================================================
-- Verbatim in effect with db/prepared/stella_0001_role_topology_bootstrap.sql:181
-- — moved here because `postgres` cannot issue it on this substrate (see
-- ACTOR PARTITION, REASON 3, above). The THIRD and LAST privilege-changing
-- statement this package ever runs as supabase_admin — P1A-N7's
-- exactly-three invariant.
GRANT USAGE ON SCHEMA auth TO uellix_owner;

-- ============================================================
-- 5. Reconnect back to postgres for the public-schema ACL only
-- ============================================================
-- supabase_admin's work is done: it never touches schema `public`. `public`
-- is owned by `pg_database_owner`, and `postgres` owns database `postgres`,
-- so `postgres` holds effective owner-level rights here without needing
-- supabase_admin's privileges — and per ACTOR PARTITION, routing these two
-- statements through supabase_admin instead would add two more privilege
-- writes for a byte-identical resulting ACL, which P1A-N7 forbids.
\connect - postgres

DO $$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'stella_local_0000 fail-closed: \connect back to postgres did not take effect (current_user=%, session_user=%)', current_user, session_user;
  END IF;
END $$;

-- Verbatim in effect (not in file provenance) with
-- db/prepared/stella_0001_role_topology_bootstrap.sql:175-177 — established
-- here because `pnpm db:migrate:local` needs it BEFORE stella_0001 can run.
GRANT USAGE, CREATE ON SCHEMA public TO uellix_owner;
REVOKE CREATE ON SCHEMA public FROM uellix_migrator, uellix_app, uellix_writer, uellix_auditor, PUBLIC;

-- ============================================================
-- 6. Self-verification — exact end state, in this (final: postgres) session
-- ============================================================
DO $$
DECLARE
  v_problem  text;
  app_oid    oid;
  owner_oid  oid;
  migrator_oid oid;
BEGIN
  SELECT oid INTO app_oid      FROM pg_roles WHERE rolname = 'uellix_app';
  SELECT oid INTO owner_oid    FROM pg_roles WHERE rolname = 'uellix_owner';
  SELECT oid INTO migrator_oid FROM pg_roles WHERE rolname = 'uellix_migrator';

  -- (1) All five roles exist, with no dangerous attribute — including
  --     uellix_migrator's CREATEROLE, unlike stella_hosted_0000's carve-out.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_problem
  FROM (VALUES ('uellix_owner'),('uellix_migrator'),('uellix_app'),('uellix_writer'),('uellix_auditor')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: role(s) % were not created.', v_problem;
  END IF;

  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO v_problem
  FROM pg_roles
  WHERE rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor')
    AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit
         OR (rolname IN ('uellix_owner','uellix_writer') AND rolcanlogin)
         OR (rolname IN ('uellix_migrator','uellix_app','uellix_auditor') AND NOT rolcanlogin));

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: role(s) % hold a dangerous or unexpected attribute.', v_problem;
  END IF;

  -- (2) Exactly the two controlled membership tuples, each with the correct
  --     GRANTOR (fixed bootstrap-superuser oid 10 — mirrors stella_0001's
  --     own precondition, so a regression that routes these grants back
  --     through `postgres` is caught HERE, at the earliest possible point,
  --     rather than deferred to stella_0001 after other phases may have
  --     already committed), inherit/set/admin flags, and cardinality one.
  WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
    VALUES
      ('uellix_migrator', 'uellix_owner',  10::oid, false, true,  false),
      ('uellix_app',      'uellix_writer', 10::oid, true,  false, false)
  ), actual AS (
    SELECT m.rolname AS member_name, r.rolname AS role_name, a.grantor AS grantor_oid,
           g.rolname AS grantor_name,
           a.inherit_option, a.set_option, a.admin_option
    FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    JOIN pg_roles g ON g.oid = a.grantor
    WHERE m.rolname IN ('uellix_migrator', 'uellix_app')
      AND r.rolname IN ('uellix_owner', 'uellix_writer')
  )
  SELECT string_agg(a.member_name || '->' || a.role_name || ' granted-by=' || a.grantor_name || '(oid=' || a.grantor_oid || ')' ||
                     ' (inherit=' || a.inherit_option::text || ',set=' || a.set_option::text ||
                     ',admin=' || a.admin_option::text || ')', ', ' ORDER BY a.member_name)
    INTO v_problem
  FROM actual a
  WHERE NOT EXISTS (
    SELECT 1 FROM expected e
    WHERE e.member_name = a.member_name AND e.role_name = a.role_name
      AND e.grantor_oid = a.grantor_oid
      AND a.inherit_option IS NOT DISTINCT FROM e.inherit_option
      AND a.set_option IS NOT DISTINCT FROM e.set_option
      AND a.admin_option IS NOT DISTINCT FROM e.admin_option
  );

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: unexpected membership row(s) (wrong grantor, flags or ADMIN escalation): %', v_problem;
  END IF;

  IF (
    SELECT count(*) FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member JOIN pg_roles r ON r.oid = a.roleid
    WHERE m.rolname = 'uellix_migrator' AND r.rolname = 'uellix_owner'
      AND a.grantor = 10 AND a.inherit_option = false AND a.set_option = true
  ) <> 1 THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: uellix_migrator -> uellix_owner membership tuple cardinality is not exactly one row.';
  END IF;

  IF (
    SELECT count(*) FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member JOIN pg_roles r ON r.oid = a.roleid
    WHERE m.rolname = 'uellix_app' AND r.rolname = 'uellix_writer'
      AND a.grantor = 10 AND a.inherit_option = true AND a.set_option = false
  ) <> 1 THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: uellix_app -> uellix_writer membership tuple cardinality is not exactly one row.';
  END IF;

  -- (3) No SET path — direct or transitive — from uellix_app to uellix_owner
  --     or to uellix_migrator. pg_has_role(..., 'SET') follows transitive
  --     paths, unlike a direct row check.
  IF pg_has_role(app_oid, owner_oid, 'SET') THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: uellix_app has a direct or transitive SET path to uellix_owner.';
  END IF;

  IF pg_has_role(app_oid, migrator_oid, 'SET') THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: uellix_app has a direct or transitive SET path to uellix_migrator.';
  END IF;

  -- (4) Schema `public`: only uellix_owner holds CREATE; PUBLIC pseudo-role
  --     holds none.
  IF NOT has_schema_privilege('uellix_owner', 'public', 'USAGE')
     OR NOT has_schema_privilege('uellix_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: uellix_owner lacks USAGE or CREATE on schema public.';
  END IF;

  IF has_schema_privilege('uellix_migrator', 'public', 'CREATE')
     OR has_schema_privilege('uellix_app', 'public', 'CREATE')
     OR has_schema_privilege('uellix_writer', 'public', 'CREATE')
     OR has_schema_privilege('uellix_auditor', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: a non-owner uellix_* role holds effective CREATE on schema public.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS n
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
    ) AS a
    WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: schema public still carries a CREATE grant whose grantee is PUBLIC.';
  END IF;

  -- (5) Schema `auth`: only uellix_owner holds USAGE, and no Uellix role can
  --     read auth.users.
  IF NOT has_schema_privilege('uellix_owner', 'auth', 'USAGE') THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: uellix_owner lacks USAGE on schema auth.';
  END IF;

  IF has_table_privilege('uellix_owner', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_app', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_writer', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_auditor', 'auth.users', 'SELECT') THEN
    RAISE EXCEPTION 'stella_local_0000 FAILED verification: a Uellix role was granted access to auth.users.';
  END IF;

  RAISE NOTICE 'stella_local_0000: verification passed — five canonical role identities, two exact controlled membership tuples, no app SET path to owner or migrator, owner holds public USAGE/CREATE and auth USAGE, no other governed role holds public CREATE, PUBLIC holds neither.';
END $$;
