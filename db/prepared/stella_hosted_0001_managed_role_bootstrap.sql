-- ============================================================================
-- stella_hosted_0001_managed_role_bootstrap.sql
-- TRAIN 5B — the managed-Supabase counterpart of stella_0004_role_separation.
-- ============================================================================
--
-- WHY THIS FILE EXISTS, AND WHY IT IS NOT AN EDIT OF stella_0004
--
-- Train 5A measured that `stella_0004` aborts on managed Supabase before it
-- does anything: its section 0 requires `rolsuper`, and the highest role a
-- managed project exposes is `postgres`, which is NOSUPERUSER. That is not a
-- runbook problem. `docs/ops/DATABASE_ROLE_MODEL.md` section 5.0 already said
-- the honest thing: "una variante remota sería un script distinto, con otro
-- modelo de confianza y su propia revisión". This is that script.
--
-- `stella_0004` is NOT edited, and that is deliberate twice over. Its evidence
-- is published and reproducible; and its trust model — a superuser window that
-- `postgres` can never reach — is STRONGER than anything achievable here. A
-- database that can run `stella_0004` should run `stella_0004`. Section 0 below
-- refuses if it detects one, rather than quietly installing the weaker model.
--
-- ----------------------------------------------------------------------------
-- WHAT IS WEAKER HERE, SAID OUT LOUD BEFORE ANY CODE
-- ----------------------------------------------------------------------------
-- RR-02, unchanged and unclosable on managed Supabase. When a NON-superuser
-- with CREATEROLE creates a role, PostgreSQL 16+ auto-grants it membership WITH
-- ADMIN OPTION. So `postgres` can, at any moment, run
-- `GRANT uellix_owner TO postgres WITH SET TRUE` and become the owner. The
-- owner/runtime separation is therefore an AUDITABLE OBSTACLE here — it takes
-- an explicit, loggable statement to cross — and not the cryptographic barrier
-- the local model gets. This package does not pretend otherwise, and section 6
-- records the fact in the sentinel rather than leaving it in a comment.
--
-- What it still buys, and why it is worth applying anyway:
--   * the RUNTIME does not reach the owner by inheritance;
--   * `uellix_app` never holds BYPASSRLS, so RLS governs every product query;
--   * the capability roles are NOLOGIN with zero members, so the only way to
--     reach a SECURITY DEFINER body is by calling the function it belongs to;
--   * `service_role` is never used, never granted anything new, and is one of
--     the principals stella_0017 revokes the ledger from.
--
-- ----------------------------------------------------------------------------
-- APPLICATION
-- ----------------------------------------------------------------------------
--   psql "<staging>" -1 -v ON_ERROR_STOP=1 \
--        -c "SET uellix.bootstrap_environment = 'staging'" \
--        -f db/prepared/stella_hosted_0001_managed_role_bootstrap.sql
--
-- The session setting is MANDATORY and has no default. An operator who forgets
-- it gets a refusal, not a guess — see section 0 (E4).
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Environment detection — fail closed on anything ambiguous
-- ============================================================
-- Five independent conditions. Every one of them is a REFUSAL, never a warning:
-- a bootstrap that proceeds with a caveat is a bootstrap whose caveat is
-- discovered afterwards, in an environment that is by then already changed.
DO $$
DECLARE
  v_missing        text;
  v_declared_env   text;
  v_auth_owner     text;
BEGIN
  -- (E1) This must be a Supabase-shaped database. Checked over the roles and
  --      schemas Supabase itself creates, not over a hostname or a project
  --      name — a name is a string somebody typed, and Train 5A's instruction
  --      was explicit that a name containing "staging" proves nothing.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_missing
  FROM (VALUES ('supabase_admin'), ('supabase_auth_admin'), ('supabase_storage_admin'),
               ('authenticator'), ('anon'), ('authenticated'), ('service_role')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: this does not look like a Supabase database (missing role(s): %). This package encodes the managed-Supabase privilege model; applying it elsewhere would create roles under assumptions that do not hold there.', v_missing;
  END IF;

  SELECT string_agg(s.name, ', ' ORDER BY s.name) INTO v_missing
  FROM (VALUES ('auth'), ('storage'), ('extensions')) AS s(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s.name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: Supabase schema(s) missing: %.', v_missing;
  END IF;

  -- (E2) The caller must NOT be a superuser. This is the inverse of every other
  --      package in this repository, and it is the point: a superuser database
  --      can run stella_0004, whose separation `postgres` cannot cross. Silently
  --      installing the weaker model over a database that can hold the stronger
  --      one would be a downgrade nobody chose.
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: current_user=% IS a superuser. This package exists only for databases where no superuser is reachable. Apply db/prepared/stella_0004_role_separation.sql instead — it gives a strictly stronger separation, and this one would silently replace it with an auditable obstacle (RR-02).', current_user;
  END IF;

  -- (E3) The caller must hold the two capabilities the package actually uses.
  --      Named individually, because "admin" is not a privilege and a refusal
  --      that says which one is missing is a refusal an operator can act on.
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: current_user=% lacks CREATEROLE. On managed Supabase the `postgres` role holds it; a restricted role does not, and the five roles below cannot be created without it.', current_user;
  END IF;

  IF NOT has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: current_user=% cannot CREATE in schema public, which the auth shim requires.', current_user;
  END IF;

  -- (E4) The operator must DECLARE the environment. There is no default, and
  --      the comparison is exact: `production`, `Staging`, an empty string and
  --      an unset variable all refuse. Train 5A's rule, applied at the only
  --      point where it can still stop something.
  BEGIN
    v_declared_env := current_setting('uellix.bootstrap_environment');
  EXCEPTION WHEN undefined_object THEN
    v_declared_env := NULL;
  END;

  IF v_declared_env IS DISTINCT FROM 'staging' THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: uellix.bootstrap_environment must be exactly ''staging'' (got %). Set it in the SAME session: psql -c "SET uellix.bootstrap_environment = ''staging''" -f <this file>. There is no default: an unset environment is an ambiguous environment, and this package refuses those.', coalesce(quote_literal(v_declared_env), '<unset>');
  END IF;

  -- (E5) The identity path must exist and must be reachable. Without the RLS
  --      helpers there is nothing for the capability roles to call, and without
  --      auth.uid() there is no session actor to derive.
  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: the RLS helpers are absent — apply db/migrations/0031_rls_core.sql and 0039_grant_rls_helper_execution.sql first.';
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: auth.uid() not found. Every governed function derives the actor from the session rather than from an argument.';
  END IF;

  -- (E5b) THE ONE THAT DECIDES WHETHER THE SHIM IS POSSIBLE. The shim must be
  --       owned by a role that ALREADY has USAGE on schema auth, because
  --       `postgres` holds that USAGE WITHOUT GRANT OPTION and therefore cannot
  --       pass it to a role we create (RR-09). The natural candidate is the
  --       owner of the RLS helpers — the role that already governs identity in
  --       this database. If it cannot resolve auth.uid(), there is no path and
  --       this package refuses rather than installing a shim that returns NULL
  --       for every caller, which would read as "no session" and silently deny
  --       everything.
  SELECT pg_get_userbyid(p.proowner) INTO v_auth_owner
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.current_user_org_ids()');

  IF NOT has_schema_privilege(v_auth_owner, 'auth', 'USAGE')
     OR NOT has_function_privilege(v_auth_owner, 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: % owns the RLS helpers but cannot reach auth.uid(). Without a role that already holds USAGE on schema auth there is no way to expose the session actor to a capability role we create, because postgres holds that USAGE without GRANT OPTION (RR-09). This is STELLA_TRAIN_5B_BLOCKED_AUTH_SCHEMA and it cannot be worked around from SQL.', v_auth_owner;
  END IF;

  -- (E5c) THE ROLE THAT WILL ACTUALLY OWN THE SHIM. E5b proved the owner of the
  --       RLS helpers can reach auth.uid(); the shim, however, is created by
  --       THIS session and is therefore owned by `current_user`. When the
  --       baseline was applied by a different identity — which the provisioning
  --       document explicitly allows, since it offers a separate migrator URL —
  --       the two are not the same role, and checking only the first would let
  --       the package pass while every definer failed later at runtime with
  --       `permission denied for schema auth`. Adversarial review A, MINOR.
  IF NOT has_schema_privilege(current_user, 'auth', 'USAGE')
     OR NOT has_function_privilege(current_user, 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: the installer (%) cannot reach auth.uid(), and the shim this package creates is owned by whoever creates it. Apply this package as a role that already holds USAGE on schema auth — on managed Supabase that is `postgres`. This is STELLA_TRAIN_5B_BLOCKED_AUTH_SCHEMA.', current_user;
  END IF;

  RAISE NOTICE 'stella_hosted_0001: environment accepted — managed Supabase, non-superuser installer %, identity governed by %.', current_user, v_auth_owner;
END $$;

-- ============================================================
-- 1. The bootstrap schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS uellix_bootstrap;

COMMENT ON SCHEMA uellix_bootstrap IS
  'Train 5B: the managed-Supabase compatibility surface. Holds the capability assertion every derived hosted package calls, the read-only capability report, and the staging sentinel. Never holds business data.';

-- ============================================================
-- 2. The five roles
-- ============================================================
-- Same five names, same shape and the same membership graph as stella_0004, so
-- that one role model documents both environments. What differs is stated in
-- section 6 and recorded in the sentinel, not smoothed over here.
--
-- NOLOGIN for owner and writer: neither is ever an endpoint of a connection.
-- NOBYPASSRLS everywhere, without exception and including the owner — the
-- instruction's "NO otorgues BYPASSRLS a roles runtime" is implemented as "no
-- role this package creates ever has it", which is strictly broader and cannot
-- drift when somebody later reclassifies a role as runtime.
-- EVERY STATEMENT IS A LITERAL, and the repetition is the point.
--
-- A `FOR ... LOOP` with `EXECUTE format('CREATE ROLE %I ...')` would be shorter
-- and is what this block looked like first. It was rejected by
-- `tests/prepared-stella-sql.test.ts`, whose cross-cutting invariant is that
-- nothing dynamic is EXECUTEd in a prepared package — the same rule
-- `stella_0013` section 3 states as "a composed ALTER would be a statement no
-- gate can judge". Five literal blocks can be read by a static contract; one
-- loop cannot, and the roles being created are the security boundary of the
-- whole hosted chain.
--
-- Each block is convergent and NARROWING ONLY: re-application strips dangerous
-- attributes somebody may have added by hand, and never adds LOGIN to a role
-- found without it — a role that lost LOGIN lost it for a reason this package
-- cannot see.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    CREATE ROLE uellix_owner WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0001: created role uellix_owner';
  ELSE
    ALTER ROLE uellix_owner WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_migrator') THEN
    CREATE ROLE uellix_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0001: created role uellix_migrator';
  ELSE
    ALTER ROLE uellix_migrator WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    CREATE ROLE uellix_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0001: created role uellix_app';
  ELSE
    ALTER ROLE uellix_app WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN
    CREATE ROLE uellix_writer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0001: created role uellix_writer';
  ELSE
    ALTER ROLE uellix_writer WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_auditor') THEN
    CREATE ROLE uellix_auditor WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0001: created role uellix_auditor';
  ELSE
    ALTER ROLE uellix_auditor WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2b. The installer must be able to BECOME the owner
-- ------------------------------------------------------------
-- Found by adversarial review A, and it would have stopped the chain halfway
-- through a real provisioning.
--
-- When a NON-superuser with CREATEROLE creates a role, PostgreSQL 16+ grants it
-- membership with `admin_option = true, inherit_option = false,
-- **set_option = false**` — measured on this stack and recorded in
-- `docs/ops/DATABASE_ROLE_MODEL.md` section 5.2. ADMIN OPTION is not the right
-- to SET ROLE. So the installer can create `uellix_owner` and then CANNOT
-- `SET ROLE uellix_owner` — which seven of the nine chain packages do, and which
-- `CREATE SCHEMA ... AUTHORIZATION uellix_owner` and every `ALTER ... OWNER TO`
-- also require.
--
-- The grant below is the RR-02 gesture performed DELIBERATELY, once, in a
-- reviewed package, instead of being discovered as an undocumented manual step
-- with staging half built. It changes nothing about the residual risk — the
-- installer already held ADMIN OPTION and could always have issued it — but it
-- makes the crossing explicit and auditable rather than improvised.
--
-- Written as a literal for `postgres` because that is the managed-Supabase
-- installer. Any other identity gets an actionable refusal naming the exact
-- statement, rather than a dynamic GRANT no static contract can read.
DO $$
BEGIN
  IF current_user = 'postgres' AND NOT pg_has_role('postgres', 'uellix_owner', 'SET') THEN
    GRANT uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE;
    RAISE NOTICE 'stella_hosted_0001: granted postgres SET on uellix_owner (RR-02, deliberate and audited).';
  END IF;

  IF NOT pg_has_role(current_user, 'uellix_owner', 'SET') THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: % cannot SET ROLE uellix_owner, and seven of the nine chain packages open an owner window. On PostgreSQL 16+ a non-superuser CREATEROLE receives ADMIN OPTION but NOT set_option when it creates a role. Run, as a role holding ADMIN OPTION on uellix_owner: GRANT uellix_owner TO %I WITH INHERIT FALSE, SET TRUE; then re-run this package.', current_user, current_user;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2b-bis. Schema public — the privileges §2c depends on
-- ------------------------------------------------------------
-- S1-DEFECT-001, found by the first real apply against managed staging, which
-- stopped at the ownership transfer in §2c with `permission denied for schema
-- public` AFTER the RR-02 grant above had succeeded.
--
-- The message names the executor and describes the NEW OWNER. PostgreSQL's
-- ATExecChangeOwner skips every permission check when the executor is a
-- superuser; when it is not, it makes three, and the third is ACL_CREATE on the
-- table's namespace checked against `newOwnerId`. Measured on PostgreSQL 17.6:
-- with the installer holding CREATE on public and SET on the owner, the
-- transfer still fails while uellix_owner holds no CREATE on public, and
-- succeeds with one variable moved.
--
-- `stella_0004` lines 418-421 grant exactly this. The hosted variant narrowed
-- that package's 38-table transfer to one table and dropped its
-- schema-privilege block along with it. Nothing could have caught that here:
-- locally the installer IS a superuser, so the check never runs, and this
-- suite is textual and never starts a Postgres.
--
-- THE GRANT IS PERSISTENT, AND THAT IS THE POINT — a grant/transfer/revoke
-- window would clear §2c and move the identical failure into the chain. Five
-- packages open `SET ROLE uellix_owner` and then create a NEW table in public:
-- grounding_0002 (evidence_document_versions), grounding_0003 (evidence_chunks),
-- stella_0007 (report_public_disclosures, capability_verification_hits),
-- stella_0008 (stripe_webhook_events), stella_0010
-- (capability_bootstrap_attempts). Measured: `CREATE TABLE public.x` as a role
-- without CREATE on public fails with this same error.
--
-- WHAT IS DELIBERATELY NOT DONE. `stella_0004` line 425 also issues
-- `REVOKE CREATE ON SCHEMA public FROM PUBLIC`. Here that would alter an ACL
-- this package did not create, on the baseline surface §5c promises to leave
-- exactly as it found it. It stays out, and §6 reports rather than repairs.
GRANT USAGE  ON SCHEMA public TO uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;
GRANT CREATE ON SCHEMA public TO uellix_owner;

-- CREATE for the owner ALONE. The migrator reaches structure by SET ROLE and
-- needs nothing of its own; the runtime must never create structure at all.
-- Written as a REVOKE rather than trusted to be absent, because a grant this
-- package did not make would otherwise survive unread.
REVOKE CREATE ON SCHEMA public FROM uellix_migrator, uellix_app, uellix_writer, uellix_auditor;

-- THE GRANT ABOVE CAN SILENTLY DO NOTHING. Measured on PostgreSQL 17.6: issued
-- by a role that holds CREATE on public but neither owns it nor has GRANT
-- OPTION on it, `GRANT CREATE ON SCHEMA public TO x` emits
-- `WARNING: no privileges were granted for "public"` and reports success. The
-- apply would then reach §2c and fail with the same opaque message that
-- produced this defect. So the grant is verified here, not assumed.
DO $$
BEGIN
  IF NOT has_schema_privilege('uellix_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: uellix_owner still lacks CREATE on schema public after the GRANT above. A GRANT the issuer cannot make is only a WARNING, and this is the check that catches it: % neither owns schema public nor holds GRANT OPTION on it. Run, as the owner of schema public: GRANT CREATE ON SCHEMA public TO uellix_owner; then re-run this package.', current_user;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2c. The ledger must be owned by uellix_owner
-- ------------------------------------------------------------
-- Also found by adversarial review A, and also a mid-provisioning stop.
--
-- TWO independent packages require it, and neither is satisfiable otherwise:
--
--   * `stella_0013` opens `SET ROLE uellix_owner` and then runs
--     `ALTER TABLE public.stella_interactions ADD COLUMN idempotency_key` —
--     which needs uellix_owner to OWN the table;
--   * `stella_0017` section 5 (1b) sweeps EVERY non-superuser role that is not
--     `uellix_owner` and not `uellix_cap_stella_quota` and aborts if any holds a
--     write privilege on the ledger. On managed Supabase the baseline owner is
--     `postgres`, which is NOT a superuser and NOT on that exclusion list, so it
--     holds owner-implied INSERT and the assertion fires.
--
-- Locally `stella_0004` transfers all 38 tables. Here the transfer is deliberately
-- NARROW — this one table — because the broad transfer is what RR-09 blocks: moving
-- the RLS HELPER FUNCTIONS to a role that cannot receive USAGE on schema auth would
-- break every policy in the product. A table has no such dependency: policies are
-- evaluated as the querying role, and grants survive an owner change untouched.
--
-- CONSEQUENCE, stated rather than discovered later: after this, `pnpm db:migrate`
-- style tooling connecting as the baseline owner can no longer emit DDL against
-- `public.stella_interactions`. The hosted path does not use drizzle for this
-- table, and `stella_0013` is the only package that alters it.
DO $$
DECLARE
  v_owner text;
BEGIN
  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 aborted: public.stella_interactions is absent — this database is not at the expected migration baseline (db/migrations/0012_stella_interactions.sql).';
  END IF;

  SELECT pg_get_userbyid(relowner) INTO v_owner FROM pg_class WHERE oid = 'public.stella_interactions'::regclass;

  IF v_owner <> 'uellix_owner' THEN
    ALTER TABLE public.stella_interactions OWNER TO uellix_owner;
    RAISE NOTICE 'stella_hosted_0001: transferred ownership of public.stella_interactions from % to uellix_owner.', v_owner;
  END IF;
END $$;

COMMENT ON ROLE uellix_owner    IS 'stella_hosted_0001: object owner. NOLOGIN, NOBYPASSRLS, NOCREATEROLE. On managed Supabase postgres retains ADMIN OPTION over it (RR-02) — an auditable obstacle, not a barrier.';
COMMENT ON ROLE uellix_migrator IS 'stella_hosted_0001: the only LOGIN role that reaches uellix_owner, and only by explicit SET ROLE.';
COMMENT ON ROLE uellix_app      IS 'stella_hosted_0001: application runtime. NOBYPASSRLS — every product query is governed by RLS.';
COMMENT ON ROLE uellix_writer   IS 'stella_hosted_0001: governed write surface, reached by uellix_app through inheritance. stella_0017 revokes its INSERT on the ledger.';
COMMENT ON ROLE uellix_auditor  IS 'stella_hosted_0001: read-only auditor.';

-- Membership. SET is granted ONLY where a role must be able to become another;
-- INHERIT only where privileges must flow without an explicit statement.
DO $$
BEGIN
  -- migrator -> owner: SET yes, INHERIT no. The migrator must ANNOUNCE that it
  -- is acting as the owner; inheriting would make every migrator statement an
  -- owner statement, which is how a migration tool silently gains DDL rights
  -- over objects it was only meant to read.
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
-- 3. The auth shim (the whole reason a hosted variant is possible)
-- ============================================================
-- OWNED BY THE INSTALLER, which section 0 (E5b) already proved can reach
-- auth.uid(). SECURITY DEFINER, so a capability role that holds EXECUTE
-- resolves the session actor without ever holding USAGE on schema auth.
--
-- WHY THIS IS NOT A SECOND COPY OF THE IDENTITY DERIVATION. stella_0013's own
-- comment rejected "re-implementing auth.uid()'s current_setting expression
-- inline" as a copy that drifts, and it was right. This is not that: the body
-- is the CALL, so there is exactly one derivation in the database and this
-- function is a doorway to it. Section 6 asserts the body, so a future edit
-- that inlined the expression would fail the package rather than pass it.
--
-- WHY SECURITY DEFINER OWNED BY A BYPASSRLS ROLE IS SAFE *HERE*. On managed
-- Supabase the installer is `postgres`, which has BYPASSRLS. A SECURITY DEFINER
-- function owned by it normally deserves suspicion. This one reads no table:
-- its entire body is a call that consults a GUC. There is no relation for RLS
-- to be bypassed on. Section 6 asserts exactly that, by matching the body — a
-- future edit that added a table reference would be refused, not reviewed.
CREATE OR REPLACE FUNCTION public.uellix_auth_uid()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT auth.uid() $$;

REVOKE ALL ON FUNCTION public.uellix_auth_uid() FROM PUBLIC;

COMMENT ON FUNCTION public.uellix_auth_uid() IS
  'Train 5B (stella_hosted_0001): the session actor, for capability roles that cannot hold USAGE on schema auth because postgres holds it without GRANT OPTION (RR-09). Body is exactly `SELECT auth.uid()` — one derivation in the database, reached through a doorway. Reads no table, so its definer privileges confer no data access.';

-- ============================================================
-- 4. The staging sentinel
-- ============================================================
-- The object the hosted migrator refuses to run without. Its VALUE is not a
-- secret and its presence is not a permission: it is a statement, made once at
-- provisioning time, inside the database itself, that THIS database is the
-- staging one. A connection string can be pasted from the wrong tab; a table
-- in the wrong database cannot be.
--
-- Single-row by construction. The CHECK on `id` is what makes "the sentinel"
-- singular rather than "some sentinel row", so a second INSERT cannot make the
-- database claim two identities.
CREATE TABLE IF NOT EXISTS uellix_bootstrap.staging_sentinel (
  id                 boolean     PRIMARY KEY DEFAULT true,
  environment        text        NOT NULL,
  project_ref        text        NOT NULL,
  provisioned_at     timestamptz NOT NULL DEFAULT now(),
  bootstrap_version  text        NOT NULL,
  -- Recorded rather than commented: RR-02 is a live property of this database,
  -- and an operator reading the sentinel must see it without finding this file.
  owner_separation   text        NOT NULL,
  CONSTRAINT staging_sentinel_singleton   CHECK (id),
  CONSTRAINT staging_sentinel_environment CHECK (environment = 'staging'),
  CONSTRAINT staging_sentinel_project_ref CHECK (project_ref ~ '^[a-z]{20}$')
);

COMMENT ON TABLE uellix_bootstrap.staging_sentinel IS
  'Train 5B: the in-database declaration that this project is staging. The hosted migrator refuses to apply anything without it, and refuses if its project_ref disagrees with the one the operator declared. Contains no secret: a Supabase project ref is public in every URL the project serves.';

COMMENT ON CONSTRAINT staging_sentinel_environment ON uellix_bootstrap.staging_sentinel IS
  'A production database cannot be made to satisfy this by editing a variable: the value lives here, and this CHECK admits exactly one string.';

-- The row itself is NOT inserted by this package. Writing it is the last step
-- of PROVISIONING, done by a human who has just created the project and can
-- read its ref from the dashboard — see
-- docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md. A bootstrap
-- that minted its own sentinel would be a bootstrap that certifies itself.

-- ============================================================
-- 5. The capability assertion every derived package calls
-- ============================================================
-- This replaces nine copies of `IF NOT rolsuper THEN RAISE`. It is STRICTLY
-- NARROWER than what it replaces: a superuser satisfies every check below, so
-- nothing that used to be refused is now allowed.
--
-- SECURITY INVOKER on purpose. The whole question is what THE CALLER can do; a
-- definer would answer it about the wrong role.
CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(p_package text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF p_package IS NULL OR p_package = '' THEN
    RAISE EXCEPTION 'assert_hosted_capabilities: the calling package must name itself. An anonymous capability assertion cannot be attributed when it fails.';
  END IF;

  -- (C1) CREATEROLE. Six of the nine packages create a capability role.
  IF NOT (SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    v_missing := v_missing || 'CREATEROLE';
  END IF;

  -- (C2) The right to BECOME uellix_owner. Every package opens an owner window
  --      with SET ROLE, and on PostgreSQL 16+ `MEMBER` does NOT imply that
  --      right — `set_option` is a separate grant option, and a CREATEROLE that
  --      creates a role receives ADMIN without it. Asserting MEMBER here would
  --      approve a caller the package refuses three sections later, which is the
  --      worst kind of green: it moves the failure past the point where the
  --      operator can still stop cheaply.
  --
  --      pg_has_role rather than a pg_auth_members row: membership can be
  --      transitive, and a direct-row check would refuse a legitimate chain.
  IF NOT pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET') THEN
    v_missing := v_missing || 'the right to SET ROLE uellix_owner';
  END IF;

  -- (C3) The auth shim. Without it the rewritten bodies resolve nothing, and
  --      "nothing" reads as "no session", which denies silently.
  IF pg_catalog.to_regprocedure('public.uellix_auth_uid()') IS NULL THEN
    v_missing := v_missing || 'public.uellix_auth_uid()';
  END IF;

  -- (C4) CREATE on public and on the two Stella schemas when they exist. The
  --      schemas are created by the packages themselves, so their absence is
  --      not a failure — only a present schema we cannot write to is.
  IF NOT pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') THEN
    v_missing := v_missing || 'CREATE ON SCHEMA public';
  END IF;

  IF pg_catalog.to_regnamespace('uellix_stella') IS NOT NULL
     AND NOT pg_catalog.has_schema_privilege(current_user, 'uellix_stella', 'CREATE') THEN
    v_missing := v_missing || 'CREATE ON SCHEMA uellix_stella';
  END IF;

  IF pg_catalog.to_regnamespace('uellix_grounding') IS NOT NULL
     AND NOT pg_catalog.has_schema_privilege(current_user, 'uellix_grounding', 'CREATE') THEN
    v_missing := v_missing || 'CREATE ON SCHEMA uellix_grounding';
  END IF;

  -- (C5) THE ONE THAT IS NOT A CAPABILITY. A package must never be applied to a
  --      database that has not declared itself staging. This is the same
  --      refusal the migrator makes from outside; making it again from inside
  --      the transaction means a hand-run psql cannot skip it.
  IF NOT EXISTS (
    SELECT 1 FROM uellix_bootstrap.staging_sentinel WHERE environment = 'staging'
  ) THEN
    v_missing := v_missing || 'uellix_bootstrap.staging_sentinel row declaring environment=staging';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION '% aborted: the current identity (%) lacks what this package needs on managed Supabase: %. This check replaced a SUPERUSER requirement; it is narrower, not weaker — a superuser satisfies all of it.',
      p_package, current_user, array_to_string(v_missing, ', ');
  END IF;
END $$;

REVOKE ALL ON FUNCTION uellix_bootstrap.assert_hosted_capabilities(text) FROM PUBLIC;

COMMENT ON FUNCTION uellix_bootstrap.assert_hosted_capabilities(text) IS
  'Train 5B: the capability precondition every derived hosted package calls in place of a rolsuper check. SECURITY INVOKER — the question is what the CALLER can do.';

-- ------------------------------------------------------------
-- 5b. The read-only capability report
-- ------------------------------------------------------------
-- CHECKPOINT A of the migration plan runs this and nothing else. It answers
-- every question in the Train 5B capability matrix without writing anything,
-- and it deliberately returns booleans rather than prose so a runner can gate
-- on it instead of an operator reading it.
CREATE OR REPLACE FUNCTION uellix_bootstrap.hosted_capability_report()
RETURNS TABLE (capability text, satisfied boolean, detail text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT 'postgres_version_17_plus',
         current_setting('server_version_num')::int >= 170000,
         current_setting('server_version')
  UNION ALL SELECT 'current_user_is_not_superuser',
         NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user),
         current_user
  UNION ALL SELECT 'createrole',
         (SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user),
         current_user
  UNION ALL SELECT 'create_on_public',
         pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE'), 'public'
  UNION ALL SELECT 'member_of_uellix_owner',
         pg_catalog.to_regrole('uellix_owner') IS NOT NULL
           AND pg_catalog.pg_has_role(current_user, 'uellix_owner', 'MEMBER'),
         'uellix_owner'
  UNION ALL SELECT 'auth_shim_installed',
         pg_catalog.to_regprocedure('public.uellix_auth_uid()') IS NOT NULL,
         'public.uellix_auth_uid()'
  UNION ALL SELECT 'rls_helpers_present',
         pg_catalog.to_regprocedure('public.current_user_org_ids()') IS NOT NULL
           AND pg_catalog.to_regprocedure('public.current_user_is_super_admin()') IS NOT NULL,
         'public.current_user_org_ids(), public.current_user_is_super_admin()'
  UNION ALL SELECT 'gen_random_uuid_builtin',
         pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL,
         'pg_catalog'
  UNION ALL SELECT 'sha256_builtin',
         pg_catalog.to_regprocedure('pg_catalog.sha256(bytea)') IS NOT NULL,
         'pg_catalog'
  UNION ALL SELECT 'advisory_locks',
         pg_catalog.to_regprocedure('pg_catalog.pg_advisory_xact_lock(bigint)') IS NOT NULL,
         'pg_advisory_xact_lock'
  UNION ALL SELECT 'staging_sentinel_present',
         EXISTS (SELECT 1 FROM uellix_bootstrap.staging_sentinel WHERE environment = 'staging'),
         'uellix_bootstrap.staging_sentinel'
  UNION ALL SELECT 'runtime_has_no_bypassrls',
         NOT COALESCE((SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'uellix_app'), false),
         'uellix_app'
$$;

REVOKE ALL ON FUNCTION uellix_bootstrap.hosted_capability_report() FROM PUBLIC;

-- ============================================================
-- 5c. Grants — the narrowest set that makes the chain applicable
-- ============================================================
GRANT USAGE   ON SCHEMA uellix_bootstrap TO uellix_migrator, uellix_app, uellix_auditor;
GRANT EXECUTE ON FUNCTION uellix_bootstrap.assert_hosted_capabilities(text) TO uellix_migrator;
GRANT EXECUTE ON FUNCTION uellix_bootstrap.hosted_capability_report()       TO uellix_migrator, uellix_auditor;
GRANT SELECT  ON uellix_bootstrap.staging_sentinel TO uellix_migrator, uellix_app, uellix_auditor;

-- The runtime needs the shim because the SECURITY DEFINER functions it calls
-- run as capability roles, and those receive their EXECUTE from the packages
-- themselves (rewrite rule `auth-schema-grant`). uellix_app gets it too because
-- policies on tables it queries directly evaluate the actor as uellix_app.
GRANT EXECUTE ON FUNCTION public.uellix_auth_uid() TO uellix_app;

-- DELIBERATELY NOT GRANTED, and each omission is a decision:
--   * nothing to `service_role` — the instruction forbids using it, and
--     stella_0017 revokes the ledger from it;
--   * nothing to `anon`;
--   * nothing new to `authenticated` — it keeps exactly the surface the
--     baseline gave it, and stella_0017 narrows that further;
--   * no EXECUTE for PUBLIC on either function;
--   * uellix_owner receives no grant here: it OWNS the schema, which is not the
--     same thing and does not need restating.
ALTER SCHEMA uellix_bootstrap OWNER TO uellix_owner;

-- ============================================================
-- 6. Self-verification — assert the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  v_problem text;
  v_body    text;
BEGIN
  -- (1) The five roles exist, and NONE of them is dangerous. Written over the
  --     attributes rather than over a list of names, so a role added later by
  --     hand with SUPERUSER would be caught by the same query.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO v_problem
  FROM pg_roles
  WHERE rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor')
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication);

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: role(s) % hold a dangerous attribute. No role this package creates may be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION.', v_problem;
  END IF;

  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_problem
  FROM (VALUES ('uellix_owner'),('uellix_migrator'),('uellix_app'),('uellix_writer'),('uellix_auditor')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: role(s) % were not created.', v_problem;
  END IF;

  -- (2) THE RUNTIME CANNOT BECOME THE OWNER. This is the property the whole
  --     role model is for, and it is checked in the direction that matters:
  --     not "is there a grant" but "can this role reach that one, by any path".
  IF pg_has_role('uellix_app', 'uellix_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: uellix_app can reach uellix_owner. The runtime must never be able to alter structure, policies or triggers.';
  END IF;

  IF pg_has_role('uellix_app', 'uellix_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: uellix_app can reach uellix_migrator.';
  END IF;

  -- (3) The migrator reaches the owner only by SET, never by inheritance.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.member
    WHERE r.rolname = 'uellix_owner' AND g.rolname = 'uellix_migrator'
      AND m.set_option AND NOT m.inherit_option
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: uellix_migrator must hold uellix_owner WITH SET TRUE, INHERIT FALSE. Inheriting would make every migrator statement an owner statement.';
  END IF;

  -- (4) THE SHIM IS A DOORWAY, NOT A COPY, AND TOUCHES NO TABLE. Asserted by
  --     matching the body, because "it only calls auth.uid()" is exactly the
  --     kind of claim that stops being true one careless edit later.
  SELECT pg_get_functiondef(to_regprocedure('public.uellix_auth_uid()')) INTO v_body;

  IF position('SELECT auth.uid()' in v_body) = 0 THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: public.uellix_auth_uid() does not delegate to auth.uid(). Inlining the derivation would create the second copy stella_0013 explicitly refused.';
  END IF;

  IF position('FROM' in upper(split_part(v_body, 'AS $function$', 2))) > 0 THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: public.uellix_auth_uid() reads a relation. Its definer privileges are only safe because the body touches no table.';
  END IF;

  -- BOTH SPELLINGS, and this is not defensive padding. PostgreSQL stores
  -- `SET search_path = ''` in proconfig as `search_path=""` — it QUOTES the
  -- empty value. Checking only the bare form makes the predicate below always
  -- true, so this RAISE fires on EVERY apply and the package cannot be
  -- installed at all. That is not a hypothesis: `grounding_0002` lines
  -- 1087-1093 record it as a measured defect found by
  -- scripts/grounding-dry-run.sh, and every stella_0006..0018 package in this
  -- directory already checks both forms. The first draft of this file checked
  -- one, which would have made the whole hosted chain inapplicable while every
  -- offline test stayed green — the suite is textual and never runs Postgres.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.uellix_auth_uid()')
      AND prosecdef
      AND proconfig IS NOT NULL
      AND (proconfig @> ARRAY['search_path=']::text[]
           OR proconfig @> ARRAY['search_path=""']::text[])
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: public.uellix_auth_uid() must be SECURITY DEFINER with an empty search_path.';
  END IF;

  -- (5) NEITHER FUNCTION IS EXECUTABLE BY PUBLIC, anon or service_role.
  SELECT string_agg(t.who, ', ' ORDER BY t.who) INTO v_problem
  FROM (VALUES ('public'),('anon'),('service_role'),('authenticated')) AS t(who)
  WHERE has_function_privilege(t.who, 'public.uellix_auth_uid()', 'EXECUTE')
     OR has_function_privilege(t.who, 'uellix_bootstrap.assert_hosted_capabilities(text)', 'EXECUTE');

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: % can execute a bootstrap function. Only uellix_migrator and uellix_app were meant to.', v_problem;
  END IF;

  -- (6) The sentinel table exists and is EMPTY. Provisioning writes the row, not
  --     this package: a bootstrap that minted its own sentinel would be
  --     certifying itself.
  IF to_regclass('uellix_bootstrap.staging_sentinel') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: the staging sentinel table is absent.';
  END IF;

  -- (7) THE OWNER CAN HOLD AND CREATE OBJECTS IN public (S1-DEFECT-001).
  --     Asserted at the end as well as before §2c, because the first apply
  --     proved that a package can pass every guard it has and still stop on a
  --     privilege nobody stated.
  IF NOT has_schema_privilege('uellix_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: uellix_owner lacks CREATE on schema public. The §2c ledger transfer needs it, and grounding_0002, grounding_0003, stella_0007, stella_0008 and stella_0010 each create a table in public inside a SET ROLE uellix_owner window.';
  END IF;

  -- (8) AND NO OTHER ROLE THIS PACKAGE CREATED DOES. Read over the ACL rather
  --     than over effective privilege on purpose: if PUBLIC holds CREATE on
  --     schema public, that is a baseline property this package neither made
  --     nor repairs, and reporting it as this package's doing would be a false
  --     accusation. What is asserted is what this package is answerable for.
  SELECT string_agg(a.grantee::regrole::text, ', ' ORDER BY a.grantee::regrole::text) INTO v_problem
  FROM pg_namespace n, aclexplode(n.nspacl) a
  WHERE n.nspname = 'public'
    AND a.privilege_type = 'CREATE'
    AND a.grantee::regrole::text IN ('uellix_migrator','uellix_app','uellix_writer','uellix_auditor');

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: role(s) % hold CREATE on schema public. Only uellix_owner may create structure there; the migrator reaches it by SET ROLE and the runtime must never reach it at all.', v_problem;
  END IF;

  RAISE NOTICE 'stella_hosted_0001: verification passed — 5 roles with no dangerous attribute, runtime cannot reach owner, migrator reaches it only by SET, auth shim delegates and reads no relation, no bootstrap function reachable by PUBLIC/anon/service_role/authenticated, sentinel table present and awaiting its provisioning row.';
  RAISE NOTICE 'stella_hosted_0001: RESIDUAL RISK RR-02 — this installer is a non-superuser with CREATEROLE, so it retains ADMIN OPTION over every role created here and can grant itself SET on uellix_owner. The separation is an auditable obstacle, not a barrier. Record it in the sentinel row at provisioning time.';
END $$;
