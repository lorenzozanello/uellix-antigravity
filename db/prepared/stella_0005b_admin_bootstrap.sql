-- db/prepared/stella_0005b_admin_bootstrap.sql
-- Administrative half of the runtime cutover. Rollback: stella_0005b_rollback.sql.
--
-- PREPARED ONLY — NOT A MIGRATION.
--
-- RUN ONCE, AS A SUPERUSER, BEFORE stella_0005_runtime_cutover.sql:
--   psql "$URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0005b_admin_bootstrap.sql
--
-- ============================================================================
-- WHY THIS IS A SEPARATE SCRIPT, AND WHY IT IS THE ONLY ADMINISTRATIVE ONE
-- ============================================================================
-- stella_0005_runtime_cutover.sql runs as `uellix_owner`, reached by SET ROLE
-- from `uellix_migrator`. That is deliberate: it is the path the cutover
-- establishes, and applying it any other way would prove nothing.
--
-- Three things in this cutover CANNOT be done on that path, for reasons of
-- privilege rather than convenience. Keeping them in the same file would have
-- meant applying the whole cutover as an administrator, which would have made
-- the owner-scoped script's central assertion untestable.
--
--   1. `ALTER ROLE <role> SET <guc>` requires CREATEROLE over the target role
--      or superuser. `uellix_owner` has neither, and giving it CREATEROLE to
--      close this gap would recreate the escalation the cutover exists to
--      remove.
--
--   2. `ALTER SCHEMA drizzle OWNER TO uellix_owner` requires owning the schema
--      AND being a member of the new owner. The `drizzle` schema is owned by
--      `postgres`, and `postgres` is not a member of `uellix_owner` — nor
--      should it be made one, since that is a standing escalation path.
--
--   3. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` requires membership in
--      `postgres`.
--
-- Everything here is scoped to `public`, to the `drizzle` bookkeeping schema,
-- and to the three `uellix_*` LOGIN roles. It changes no attribute of any
-- Supabase-internal role and no object in `auth`, `storage`, `realtime`,
-- `vault`, `extensions` or `graphql`.
--
-- It sets no password. Credentials are minted by
-- scripts/rotate-local-role-credentials.ts, which is the only thing in this
-- repository that ever holds one, and holds it for the length of one process.
--
-- Idempotent and convergent.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'stella_0005b must be applied by a superuser (locally: supabase_admin). It performs the '
      'three operations uellix_owner provably cannot: ALTER ROLE ... SET, ALTER SCHEMA ... OWNER, '
      'and ALTER DEFAULT PRIVILEGES FOR ROLE postgres.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'Role uellix_owner does not exist. Apply stella_0004_role_separation.sql first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app' AND rolcanlogin) THEN
    RAISE EXCEPTION 'Role uellix_app does not exist or cannot log in.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_migrator' AND rolcanlogin) THEN
    RAISE EXCEPTION 'Role uellix_migrator does not exist or cannot log in.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    RAISE EXCEPTION
      'Schema drizzle does not exist. Run the drizzle migrations at least once before handing '
      'their bookkeeping over to uellix_owner.';
  END IF;

  -- The migrator must be able to become the owner WITHOUT inheriting its
  -- privileges implicitly. `inherit_option = false, set_option = true` is the
  -- shape stella_0004 created and the shape the wrapper depends on: privilege
  -- is acquired by an explicit, auditable SET ROLE and never by accident.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles member ON member.oid = m.member
    JOIN pg_roles granted ON granted.oid = m.roleid
    WHERE member.rolname = 'uellix_migrator'
      AND granted.rolname = 'uellix_owner'
      AND m.set_option
      AND NOT m.inherit_option
  ) THEN
    RAISE EXCEPTION
      'uellix_migrator does not hold uellix_owner as a SET-only, non-inheriting membership.';
  END IF;
END
$$;

-- ============================================================
-- 1. Session limits and a pinned search_path for the three LOGIN roles
-- ============================================================
-- SEARCH PATH. The cluster default is `"$user", public`. The `"$user"` element
-- resolves to a schema named after the connecting role if one ever exists —
-- so anyone who could create a schema called `uellix_app` would silently
-- shadow `public` for every runtime query. No such schema exists and
-- `uellix_app` cannot create one, but the dependency is free to remove.
--
-- IDLE-IN-TRANSACTION TIMEOUT is not hygiene here, it is load-bearing. After
-- the cutover every request runs inside a transaction, because that is the
-- only scope in which `SET LOCAL`-style identity context is safe (see
-- db/identity-context.ts). A request that dies between BEGIN and COMMIT would
-- otherwise pin a pooled connection — and its RLS claims — indefinitely.
--
-- The migrator gets NO statement timeout: a migration that rewrites a large
-- table must not be killed halfway. It gets a long idle timeout instead, so a
-- wrapper that crashes cannot leave an ACCESS EXCLUSIVE lock held forever.

ALTER ROLE uellix_app SET search_path = 'public';
ALTER ROLE uellix_app SET statement_timeout = '30s';
ALTER ROLE uellix_app SET idle_in_transaction_session_timeout = '60s';

ALTER ROLE uellix_migrator SET search_path = 'public';
ALTER ROLE uellix_migrator SET statement_timeout = 0;
ALTER ROLE uellix_migrator SET lock_timeout = '15s';
ALTER ROLE uellix_migrator SET idle_in_transaction_session_timeout = '300s';

ALTER ROLE uellix_auditor SET search_path = 'public';
ALTER ROLE uellix_auditor SET statement_timeout = '60s';
ALTER ROLE uellix_auditor SET idle_in_transaction_session_timeout = '60s';

-- ============================================================
-- 2. Hand the drizzle bookkeeping schema to uellix_owner
-- ============================================================
-- `drizzle.__drizzle_migrations` is a Uellix object that happens to have been
-- created by drizzle-kit while it connected as `postgres`. Leaving it there
-- would mean the migration chain still had one table the migrator could only
-- touch by borrowing an administrative identity — the exact dependency this
-- cutover removes everywhere else.
--
-- USAGE goes to `uellix_migrator` as well as to the owner, because the wrapper
-- resolves the schema BEFORE it issues SET ROLE.

ALTER SCHEMA drizzle OWNER TO uellix_owner;
ALTER TABLE drizzle.__drizzle_migrations OWNER TO uellix_owner;
ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO uellix_owner;

GRANT USAGE ON SCHEMA drizzle TO uellix_migrator;

-- ============================================================
-- 3. The legacy creators' TYPE defaults — DELIBERATELY NOT CHANGED
-- ============================================================
-- THE GAP IS REAL. `pg_default_acl` carries entries for `postgres` in `public`
-- covering relations, sequences and functions, none of which grants anything to
-- PUBLIC. TYPES have no entry, and PostgreSQL's built-in default for a type is
-- USAGE TO PUBLIC. So a composite type or domain created in `public` by
-- `postgres` — or by `supabase_admin` — is usable by `anon` the moment it
-- exists.
--
-- THE OBVIOUS FIX DOES NOT WORK. Two measurements on PostgreSQL 17.6, both
-- made while writing this script rather than reasoned about:
--
--   1. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       REVOKE USAGE ON TYPES FROM PUBLIC` alone stores NOTHING.
--      `acldefault('T', postgres)` is `{=U/postgres,postgres=U/postgres}`;
--      revoking PUBLIC's entry can leave a list PostgreSQL then discards,
--      restoring the very default it was meant to override.
--
--   2. Adding `GRANT USAGE ON TYPES TO postgres` first DOES store the row —
--      `{postgres=U/postgres}` — and the row is STILL NEVER CONSULTED. A
--      composite type created afterwards by `postgres` in `public` comes out
--      with `typacl = NULL` and `has_type_privilege('public', …, 'USAGE') =
--      true`. The same pair of statements WITHOUT `IN SCHEMA` works
--      immediately: `typacl = {postgres=U/postgres}`, PUBLIC denied. Schema-
--      scoped TYPE defaults record a row that does not apply.
--
-- WHY THE WORKING FORM IS NOT USED. The global form is exactly the one that
-- cannot be scoped: it would govern every type `postgres` ever creates in
-- `extensions`, `storage`, `realtime`, `graphql` and any schema a future
-- Supabase upgrade adds. Narrowing an internal role's global defaults is a
-- change to somebody else's contract, and the failure mode — an extension
-- installed months from now whose types `anon` cannot use — would surface far
-- from here.
--
-- WHAT IS DONE INSTEAD, per the operational-containment path:
--
--   * migrations create objects as `uellix_owner`, whose GLOBAL default ACL
--     from stella_0004 already denies PUBLIC (verified in
--     tests/database-migrator-path.test.ts against a real created type);
--   * `pnpm db:migrate:local` is the only entry point that can apply DDL, and
--     it refuses any session that is not `uellix_migrator`;
--   * tests/database-default-privileges.test.ts fails on ANY object in `public`
--     whose owner is `postgres` or `supabase_admin`, which is the condition
--     under which this residue could ever be reached.
--
-- This script does not claim to have fixed what it did not fix.

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_app' AND 'search_path=public' = ANY (rolconfig)
  ) THEN
    RAISE EXCEPTION 'uellix_app did not receive a pinned search_path.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_app' AND 'idle_in_transaction_session_timeout=60s' = ANY (rolconfig)
  ) THEN
    RAISE EXCEPTION 'uellix_app did not receive an idle-in-transaction timeout.';
  END IF;

  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'drizzle') <> 'uellix_owner' THEN
    RAISE EXCEPTION 'Schema drizzle is not owned by uellix_owner.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'drizzle' AND pg_get_userbyid(c.relowner) <> 'uellix_owner'
  ) THEN
    RAISE EXCEPTION 'Some object in schema drizzle is not owned by uellix_owner.';
  END IF;

  -- The runtime must be no more privileged than it was before this script ran.
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app' AND (rolsuper OR rolbypassrls OR rolcreaterole)
  ) THEN
    RAISE EXCEPTION 'uellix_app gained an administrative role attribute.';
  END IF;

  IF has_schema_privilege('uellix_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'uellix_app gained CREATE on public.';
  END IF;

  -- Section 3 asserts that NOBODY HAS PRETENDED TO CLOSE THE GAP.
  --
  -- The dangerous state is not the row's existence — a row whose list still
  -- contains PUBLIC is merely the built-in default written out longhand, and
  -- PostgreSQL keeps such a row rather than garbage-collecting it. The
  -- dangerous state is a schema-scoped TYPE row from which PUBLIC has been
  -- REMOVED: a catalog query then reports the gap as closed while a type
  -- created there is still USAGE-able by PUBLIC, because schema-scoped TYPE
  -- defaults are never consulted (see §3).
  --
  -- So the check is "if such a row exists, PUBLIC must still be in it".
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE pg_get_userbyid(d.defaclrole) IN ('postgres', 'supabase_admin')
      AND n.nspname = 'public'
      AND d.defaclobjtype = 'T'
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0
      )
  ) THEN
    RAISE EXCEPTION
      'A schema-scoped default TYPE privilege for postgres or supabase_admin in public has had '
      'PUBLIC removed. Measured on PostgreSQL 17.6, that row is never consulted: the catalog now '
      'reports the gap as closed while a type created there is still USAGE-able by PUBLIC. '
      'Restore PUBLIC (see stella_0005b_rollback section 3) and rely on the operational '
      'containment described in section 3 instead.';
  END IF;
END
$$;
