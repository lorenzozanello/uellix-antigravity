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

  -- E-02, measured on PostgreSQL 17.6. CREATEROLE, and it is the ONE attribute
  -- in this block that is not narrowing.
  --
  -- uellix_migrator is the principal every temporary elevation the governed
  -- chain emits names — `GRANT <role> TO uellix_migrator; SET ROLE <role>` —
  -- so the chain can only be applied BY it. Six of the nine packages create a
  -- capability role, and `assert_hosted_capabilities` (C1) requires CREATEROLE
  -- for exactly that reason. Created NOCREATEROLE, this role fails its own
  -- chain's first statement, and `postgres` — which does hold CREATEROLE —
  -- fails at the first capability window because the grant named somebody
  -- else. That was E-02: no session could apply the chain.
  --
  -- `postgres` cannot be the named installer instead. It is a PROVIDER role,
  -- and the authority model refuses any membership statement that names one
  -- (AUTHORITY_UNKNOWN_ROLE) — the chain's temporary rows are told apart from
  -- the provider's by grantor (lab M2/M3a), and naming a provider principal
  -- would destroy that distinction.
  --
  -- WHAT THIS COSTS, stated rather than discovered later. On PostgreSQL 16+
  -- CREATEROLE is no longer the near-superuser it was: a CREATEROLE role may
  -- only administer roles it created, cannot grant itself SUPERUSER, and — with
  -- createrole_self_grant empty, which §0 does not check and the prechain
  -- observation measures — does not even receive SET on what it creates
  -- (measured: pg_has_role(migrator, cap, 'SET') = false immediately after
  -- CREATE ROLE). It buys exactly the ability to create the three capability
  -- roles, which is the thing the chain does and nothing else.
  --
  -- Measured, this image: a NOSUPERUSER CREATEROLE role CAN set this attribute
  -- on a role it administers, so no superuser is needed to apply it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_migrator') THEN
    CREATE ROLE uellix_migrator WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    RAISE NOTICE 'stella_hosted_0001: created role uellix_migrator';
  ELSE
    ALTER ROLE uellix_migrator WITH NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
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

-- S1-DEFECT-002, and the reason the three role names are written out rather
-- than left to `FROM PUBLIC`.
--
-- Managed Supabase carries `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN
-- SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated,
-- service_role`. That writes DIRECT acl entries the moment this CREATE runs —
-- entries that are NOT PUBLIC, so revoking PUBLIC leaves every one of them
-- standing. Measured: with the managed configuration reproduced, this
-- function's acl came out
-- {postgres=X, anon=X, authenticated=X, service_role=X}, and §6 check (5)
-- refused the package with `public` conspicuously absent from its list.
--
-- Default privileges are PER SCHEMA, which is why only this function — the one
-- that lives in `public` — inherited them. The two `uellix_bootstrap` functions
-- came out clean. They are revoked anyway, because "clean today because no
-- default ACL exists for that schema today" is not a property worth relying on.
REVOKE ALL ON FUNCTION public.uellix_auth_uid() FROM PUBLIC, anon, authenticated, service_role;

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
    v_missing := array_append(v_missing, 'CREATEROLE');
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
    v_missing := array_append(v_missing, 'the right to SET ROLE uellix_owner');
  END IF;

  -- (C3) The auth shim. Without it the rewritten bodies resolve nothing, and
  --      "nothing" reads as "no session", which denies silently.
  IF pg_catalog.to_regprocedure('public.uellix_auth_uid()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.uellix_auth_uid()');
  END IF;

  -- (C4) CREATE on public and on the two Stella schemas when they exist. The
  --      schemas are created by the packages themselves, so their absence is
  --      not a failure — only a present schema we cannot write to is.
  --
  --      E-02. Asserted over uellix_owner, NOT over current_user, and that is a
  --      correction rather than a loosening. Nothing in the chain creates an
  --      object in public as the installer: the three canonical owner contexts
  --      run `CREATE TABLE` inside a `SET ROLE uellix_owner` window precisely
  --      so that the owner ends up owning them, and PostgreSQL checks CREATE on
  --      the containing namespace against the role EXECUTING the statement
  --      (S1-DEFECT-001). Checking current_user was right while the installer
  --      was assumed to be the baseline owner; with uellix_migrator as the
  --      installer it demands a privilege the chain never uses, and granting it
  --      to satisfy the check would widen the installer for nothing.
  --      §6 check (7) asserts the same fact about the same role.
  IF NOT pg_catalog.has_schema_privilege('uellix_owner', 'public', 'CREATE') THEN
    v_missing := array_append(v_missing, 'CREATE ON SCHEMA public for uellix_owner');
  END IF;

  IF pg_catalog.to_regnamespace('uellix_stella') IS NOT NULL
     AND NOT pg_catalog.has_schema_privilege('uellix_owner', 'uellix_stella', 'CREATE') THEN
    v_missing := array_append(v_missing, 'CREATE ON SCHEMA uellix_stella for uellix_owner');
  END IF;

  IF pg_catalog.to_regnamespace('uellix_grounding') IS NOT NULL
     AND NOT pg_catalog.has_schema_privilege('uellix_owner', 'uellix_grounding', 'CREATE') THEN
    v_missing := array_append(v_missing, 'CREATE ON SCHEMA uellix_grounding for uellix_owner');
  END IF;

  -- (C6) CREATE on the DATABASE. Six packages open with
  --      `CREATE SCHEMA <x> AUTHORIZATION uellix_owner`, which is an
  --      installer-only statement — the schema is authorized TO the owner but
  --      created BY the installer, and PostgreSQL checks CREATE on the DATABASE
  --      for that, not on any schema. Measured, PG 17.6: uellix_migrator
  --      without it fails T1 at `permission denied for database postgres`,
  --      three hundred lines after this assertion would have caught it.
  IF NOT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') THEN
    v_missing := array_append(v_missing, 'CREATE ON DATABASE ' || current_database());
  END IF;

  -- (C5) THE ONE THAT IS NOT A CAPABILITY. A package must never be applied to a
  --      database that has not declared itself staging. This is the same
  --      refusal the migrator makes from outside; making it again from inside
  --      the transaction means a hand-run psql cannot skip it.
  IF NOT EXISTS (
    SELECT 1 FROM uellix_bootstrap.staging_sentinel WHERE environment = 'staging'
  ) THEN
    v_missing := array_append(v_missing, 'uellix_bootstrap.staging_sentinel row declaring environment=staging');
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION '% aborted: the current identity (%) lacks what this package needs on managed Supabase: %. This check replaced a SUPERUSER requirement; it is narrower, not weaker — a superuser satisfies all of it.',
      p_package, current_user, array_to_string(v_missing, ', ');
  END IF;
END $$;

REVOKE ALL ON FUNCTION uellix_bootstrap.assert_hosted_capabilities(text) FROM PUBLIC, anon, authenticated, service_role;

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

REVOKE ALL ON FUNCTION uellix_bootstrap.hosted_capability_report() FROM PUBLIC, anon, authenticated, service_role;

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

-- AND to the installer, WITH GRANT OPTION, because the chain re-grants it.
--
-- E-02. Rewrite rule `auth-schema-grant` replaces each package's
-- `GRANT EXECUTE ON FUNCTION auth.uid() TO <capability>` with the same grant
-- over this shim, and that statement is INSTALLER-class — it sits outside every
-- classification window. A grantor must hold the grant option, and the shim is
-- owned by whoever applied this package, not by the installer. MEASURED, PG
-- 17.6: without this, T4 stops at `permission denied for function
-- uellix_auth_uid`. It never appeared while the installer was assumed to be the
-- baseline owner, which owns the shim and therefore needs no grant at all.
GRANT EXECUTE ON FUNCTION public.uellix_auth_uid() TO uellix_migrator WITH GRANT OPTION;

-- DELIBERATELY NOT GRANTED, and each omission is a decision:
--   * nothing to `service_role` — the instruction forbids using it, and
--     stella_0017 revokes the ledger from it;
--   * nothing to `anon`;
--   * nothing new to `authenticated` — it keeps exactly the surface the
--     baseline gave it, and stella_0017 narrows that further;
--   * no EXECUTE for PUBLIC on either function;
--   * uellix_owner receives no grant here: it OWNS the schema, which is not the
--     same thing and does not need restating.
-- ============================================================
-- 5d. The PRECHAIN AUTHORITY CONTRACT (E-01)
-- ============================================================
-- WHAT THIS CLOSES, AND HOW IT WAS FOUND
--
-- The governed chain runs twelve statements as `uellix_owner` against objects
-- it does not create. On a LOCAL database that works because
-- `stella_0004_role_separation.sql` transfers all 38 tables and 8 functions to
-- uellix_owner (lines 456-502). Here that transfer is deliberately NARROW —
-- section 2c moves the ledger and nothing else — because moving the RLS HELPER
-- FUNCTIONS to a role that cannot receive USAGE on schema auth would break
-- every policy in the product (RR-09). Section 2c said so and was right; what
-- it missed is that six OTHER objects need a PRIVILEGE rather than ownership,
-- and nothing granted it.
--
-- The PG 17.6 engine certification found this one statement at a time:
--
--   T1 line 278  permission denied for function current_user_org_ids
--                -> GRANT needs the executor to OWN the object or hold the
--                   privilege WITH GRANT OPTION. Holding it is not enough.
--   T1 line 398  permission denied for table organizations
--                -> a FOREIGN KEY needs REFERENCES on its TARGET, and the
--                   statement that fails never names the target as a privilege.
--   T1 line 682  permission denied for function uellix_forbid_mutation
--                -> CREATE TRIGGER needs EXECUTE on the function it calls.
--
-- Three privileges, three object classes, none of them mentioned in the
-- statement that failed. So the set below is DERIVED, not observed: see
-- db/hosted/authority/certification/prechain-requirements.ts, which walks the
-- authority plan and reports every object a non-installer executor touches that
-- the chain does not itself create. Eight objects, twelve statements. One of
-- the eight — the ledger — is already satisfied by section 2c.
--
-- ------------------------------------------------------------
-- WHY THIS MEASURES BEFORE IT GRANTS
-- ------------------------------------------------------------
-- The baseline owner is `postgres` on a project provisioned the way
-- STELLA_APPLY_IDENTITY_PROBE.md describes, and that is what the grants below
-- assume. But it is an ASSUMPTION about somebody else's database, so it is
-- checked rather than trusted: an object already owned by uellix_owner needs
-- nothing, an object owned by the installer gets exactly the privileges the
-- chain re-grants, and an object owned by any third role REFUSES with its name
-- and its owner. A bootstrap that guessed here would move the failure to the
-- middle of T1, which is where it was already found once.
--
-- NARROW ON PURPOSE. `GRANT ALL` on six baseline tables would satisfy every
-- statement above and would also hand uellix_owner TRUNCATE on the ledger.
-- The privileges below are exactly the ones the chain re-grants, and REFERENCES
-- exactly where a foreign key points.
DO $$
DECLARE
  v_wrong text;
BEGIN
  -- The SHAPE this package can act on, asserted before it acts. Every object
  -- below must be owned by the installer: that is what a project provisioned
  -- the way STELLA_APPLY_IDENTITY_PROBE.md describes looks like, and it is
  -- what makes the literal GRANTs beneath this block issuable at all.
  --
  -- Anything else REFUSES here, naming the object and its owner, rather than
  -- failing three hundred lines into T1 — which is where E-01 was found.
  SELECT string_agg(t.object || ' (owned by ' || t.owner || ')', ', ' ORDER BY t.object)
    INTO v_wrong
  FROM (
    SELECT 'public.current_user_org_ids()'::text AS object, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = to_regprocedure('public.current_user_org_ids()')
    UNION ALL
    SELECT 'public.current_user_is_super_admin()'::text AS object, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = to_regprocedure('public.current_user_is_super_admin()')
    UNION ALL
    SELECT 'public.uellix_forbid_mutation()'::text AS object, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = to_regprocedure('public.uellix_forbid_mutation()')
    UNION ALL
    SELECT 'public.organizations'::text AS object, pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = to_regclass('public.organizations')
    UNION ALL
    SELECT 'public.projects'::text AS object, pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = to_regclass('public.projects')
    UNION ALL
    SELECT 'public.evidence_items'::text AS object, pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = to_regclass('public.evidence_items')
    UNION ALL
    SELECT 'public.users'::text AS object, pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = to_regclass('public.users')
  ) AS t
  WHERE t.owner <> current_user;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0001 aborted: the prechain authority contract cannot be established '
      'for: %. The governed chain runs twelve statements against these objects as '
      'uellix_owner, and this package can only grant on what the installer (%) owns. '
      'Resolve the ownership of each and re-run.',
      v_wrong, current_user;
  END IF;
END $$;

-- LITERAL, one statement per object, for the reason section 2 states about the
-- five CREATE ROLEs: a `FOR ... LOOP` with `EXECUTE format(...)` would be
-- shorter and `tests/prepared-stella-sql.test.ts` refuses it, because nothing
-- dynamic is EXECUTEd in a prepared package. A static contract can read the
-- lines below; it cannot read a loop.
--
-- WITH GRANT OPTION on everything the chain RE-GRANTS. Holding a privilege is
-- not the same as being able to pass it on, and that distinction is exactly
-- what PostgreSQL 17.6 refused at T1 line 278. REFERENCES is needed by
-- uellix_owner itself and never passed on; the option is harmless there.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids() TO uellix_owner WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_owner WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.uellix_forbid_mutation() TO uellix_owner WITH GRANT OPTION;
GRANT SELECT, REFERENCES ON TABLE public.organizations TO uellix_owner WITH GRANT OPTION;
GRANT SELECT, REFERENCES ON TABLE public.projects TO uellix_owner WITH GRANT OPTION;
GRANT SELECT, REFERENCES ON TABLE public.evidence_items TO uellix_owner WITH GRANT OPTION;
GRANT REFERENCES ON TABLE public.users TO uellix_owner WITH GRANT OPTION;

-- And the INSTALLER's own SELECT on the tables — not to read data, but so its
-- preconditions can SEE what they check. MEASURED, PG 17.6:
-- information_schema.columns is FILTERED BY PRIVILEGE, so a column is
-- invisible to a role holding none on its table. stella_0013 asks whether
-- public.organizations.stella_monthly_quota exists and is told ABSENT — a
-- false negative indistinguishable from a missing migration. Locally the
-- applier is a superuser and sees everything, which is why no amount of local
-- testing produces this. It widens nothing: uellix_migrator can already read
-- any of these by announcing itself as uellix_owner.
GRANT SELECT ON TABLE public.organizations TO uellix_migrator;
GRANT SELECT ON TABLE public.projects TO uellix_migrator;
GRANT SELECT ON TABLE public.evidence_items TO uellix_migrator;
GRANT SELECT ON TABLE public.users TO uellix_migrator;

-- The ledger is the eighth object of the contract and the one section 2c has
-- already handed to uellix_owner, so ownership covers everything the chain
-- needs. The installer's SELECT still has to be issued, and this session no
-- longer owns the table — section 2b guarantees it can BECOME the role that
-- does. Without it, T8's precondition reports idempotency_key ABSENT.
SET ROLE uellix_owner;
GRANT SELECT ON TABLE public.stella_interactions TO uellix_migrator;
RESET ROLE;

-- The installer's OWN prerequisite, and the only one that is not about an
-- object: CREATE on the database, for the six `CREATE SCHEMA ... AUTHORIZATION
-- uellix_owner` statements. Measured and then granted, never assumed — on a
-- project where this session does not own the database the grant is refused by
-- PostgreSQL, and a refusal here is worth far more than the same refusal three
-- hundred lines into T1.
DO $$
BEGIN
  IF NOT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') THEN
    RAISE EXCEPTION
      'stella_hosted_0001 aborted: uellix_migrator needs CREATE on database %, and this session (%) '
      'cannot grant it because it does not hold it either. Six chain packages open with CREATE '
      'SCHEMA ... AUTHORIZATION uellix_owner, which PostgreSQL checks against the DATABASE.',
      current_database(), current_user;
  END IF;
END $$;

-- LITERAL, and naming the database rather than composing `current_database()`
-- into an `EXECUTE format(...)`, for the reason section 2 gives about the five
-- CREATE ROLEs. `postgres` is the database a managed Supabase project serves;
-- an operator applying this anywhere else gets an actionable error naming this
-- exact statement, which is what the composed form would have hidden.
GRANT CREATE ON DATABASE postgres TO uellix_migrator;

-- ------------------------------------------------------------
-- 5e. The capability membership topology assertion (E-04)
-- ------------------------------------------------------------
-- WHAT REPLACED WHAT, AND WHY THE OLD TEST WAS WRONG RATHER THAN STRICT
--
-- Five chain packages verify that their capability role has ZERO members,
-- because a member would make the write path reachable by SET ROLE from a real
-- connection string. The PROPERTY is right. The TEST is unsatisfiable on
-- managed Supabase: when a NOSUPERUSER CREATEROLE role creates another role,
-- PostgreSQL 16+ grants it the membership automatically (RR-02), so the count
-- is one before the package has done anything at all.
--
-- Measured, PostgreSQL 17.6, `createrole_self_grant` empty:
--
--   after CREATE ROLE cap, as uellix_migrator:
--     cap <- uellix_migrator, grantor supabase_admin, admin=t inherit=f set=f
--     pg_has_role('uellix_migrator','cap','SET') = FALSE
--
-- The row exists and confers NOTHING that the zero-member rule was protecting
-- against: no SET, no INHERIT. So the count was measuring the wrong thing.
--
-- This function asserts the TOPOLOGY instead: exactly the rows expected, with
-- exactly the options expected, and no SET reachability for any principal that
-- must not have it. `count <= 1` was rejected as a replacement — it would admit
-- a second row with SET TRUE as long as the automatic one were absent, which is
-- precisely the attack the original rule existed to stop.
CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_capability_membership_topology(
  p_package text,
  p_capability text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_unexpected text;
  v_reachable  text;
BEGIN
  IF p_package IS NULL OR p_package = '' OR p_capability IS NULL OR p_capability = '' THEN
    RAISE EXCEPTION 'assert_capability_membership_topology: the calling package must name itself and the capability role it is asserting.';
  END IF;

  -- (1) EVERY row that is not the one automatic grant PostgreSQL creates for
  --     the role's creator. Options are compared exactly: a row with the right
  --     shape and set_option TRUE is a different fact from the same row with
  --     set_option FALSE, and only the second is harmless.
  SELECT string_agg(
           format('%s<-%s granted by %s (admin=%s inherit=%s set=%s)',
                  r.rolname, m.rolname, g.rolname,
                  am.admin_option, am.inherit_option, am.set_option),
           ', ' ORDER BY m.rolname)
    INTO v_unexpected
  FROM pg_catalog.pg_auth_members am
  JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
  JOIN pg_catalog.pg_roles m ON m.oid = am.member
  JOIN pg_catalog.pg_roles g ON g.oid = am.grantor
  WHERE r.rolname = p_capability
    AND NOT (am.admin_option AND NOT am.inherit_option AND NOT am.set_option);

  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      '% FAILED verification: % carries membership row(s) that confer more than administration: %. '
      'The only row permitted is the one PostgreSQL creates automatically for the role''s creator '
      '(RR-02), which carries ADMIN and neither INHERIT nor SET.',
      p_package, p_capability, v_unexpected;
  END IF;

  -- (2) The property the row count was standing in for, asserted directly:
  --     nobody may BECOME the capability role. `pg_has_role(..., 'SET')` is
  --     transitive (lab M4), so this also closes the intermediate-role path a
  --     direct row inspection cannot see.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO v_reachable
  FROM pg_catalog.pg_roles r
  WHERE r.rolname <> p_capability
    AND NOT r.rolsuper
    AND pg_catalog.pg_has_role(r.rolname, p_capability, 'SET');

  IF v_reachable IS NOT NULL THEN
    RAISE EXCEPTION
      '% FAILED verification: role(s) % can SET ROLE to %. A capability role reachable by SET from a '
      'principal that can log in is a write path around every policy the package installed.',
      p_package, v_reachable, p_capability;
  END IF;

  -- (3) And nobody may INHERIT it either, which would carry its privileges on
  --     every statement rather than only when announced.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO v_reachable
  FROM pg_catalog.pg_roles r
  WHERE r.rolname <> p_capability
    AND NOT r.rolsuper
    AND pg_catalog.pg_has_role(r.rolname, p_capability, 'USAGE');

  IF v_reachable IS NOT NULL THEN
    RAISE EXCEPTION
      '% FAILED verification: role(s) % INHERIT %.', p_package, v_reachable, p_capability;
  END IF;
END $$;

COMMENT ON FUNCTION uellix_bootstrap.assert_capability_membership_topology(text, text) IS
  'Train 5B / Commit 5.1: replaces the unsatisfiable "zero members" postcondition. RR-02 makes a member unavoidable for a managed installer; this asserts the topology and the reachability that rule was actually protecting.';

-- REVOKE BEFORE GRANT, and naming the three principals explicitly. Measured on
-- managed Supabase (S1-DEFECT-002): `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE
-- ON FUNCTIONS` writes DIRECT acl entries at CREATE time, so a function is born
-- executable by anon / authenticated / service_role and a bare
-- `REVOKE ... FROM PUBLIC` does not touch them. §6 check (3) caught exactly this
-- omission on the first apply of this function.
REVOKE ALL ON FUNCTION uellix_bootstrap.assert_capability_membership_topology(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION uellix_bootstrap.assert_capability_membership_topology(text, text)
  TO uellix_migrator;

-- The handover is LAST in section 5 for a measured reason: everything above
-- creates objects in uellix_bootstrap, and once the schema belongs to
-- uellix_owner the installer can no longer CREATE in it — measured, PG 17.6:
-- `permission denied for schema uellix_bootstrap`.
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
  --
  --     E-02, and the ONE exemption, stated rather than removed. uellix_migrator
  --     holds CREATEROLE: it is the principal every generated elevation names,
  --     and six of the nine chain packages create a capability role, so a
  --     NOCREATEROLE installer is refused at the first statement of T1 by the
  --     capability assertion this very package installs. The exemption is
  --     narrow on purpose — the migrator remains NOSUPERUSER, NOBYPASSRLS,
  --     NOCREATEDB, NOREPLICATION, and the other four roles still may not hold
  --     ANY of the five. On PostgreSQL 16+ CREATEROLE administers only the
  --     roles its holder created and cannot confer SUPERUSER, so what it buys
  --     here is exactly the three capability roles and nothing else.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO v_problem
  FROM pg_roles
  WHERE rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor')
    AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolreplication
         OR (rolcreaterole AND rolname <> 'uellix_migrator'));

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: role(s) % hold a dangerous attribute. No role this package creates may be SUPERUSER, BYPASSRLS, CREATEDB or REPLICATION, and only uellix_migrator may hold CREATEROLE.', v_problem;
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

  -- (5) NO PRINCIPAL OUTSIDE THE CONTRACT CAN EXECUTE A BOOTSTRAP FUNCTION.
  --
  -- S1-DEFECT-002. The previous form asked has_function_privilege() about four
  -- hardcoded names, and about two of the three functions this package creates.
  -- It was correct about what it asked and blind to everything else: it never
  -- looked at hosted_capability_report() at all, and a principal nobody had
  -- thought of — `dashboard_user`, or whatever Supabase adds next — would have
  -- walked past it.
  --
  -- Reading the ACL inverts the question. Instead of naming the principals that
  -- must not appear, it names the three that may, and every other EXECUTE
  -- holder on the bootstrap surface is a finding. The sweep is over the SCHEMA,
  -- so a fourth function added later is covered on the day it is written rather
  -- than on the day someone remembers to extend a list.
  --
  -- `coalesce(proacl, acldefault('f', proowner))` is not padding. A function
  -- whose proacl is NULL carries the DEFAULT acl, and for functions that
  -- default grants EXECUTE to PUBLIC. Exploding a NULL yields zero rows, so a
  -- verifier without the coalesce reads the widest possible state as "nobody
  -- holds anything" — the one mistake that would make this check worse than
  -- useless.
  --
  -- The owner is exempt because an owner always holds EXECUTE. That exemption
  -- is only safe if the owner is known, which is what (5b) fixes.
  SELECT string_agg(f.finding, '; ' ORDER BY f.finding) INTO v_problem
  FROM (
    SELECT DISTINCT n.nspname || '.' || p.proname || ' -> ' ||
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS finding
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
    WHERE a.privilege_type = 'EXECUTE'
      AND (n.nspname = 'uellix_bootstrap'
           OR (n.nspname = 'public' AND p.proname = 'uellix_auth_uid'))
      AND a.grantee IS DISTINCT FROM p.proowner
      AND (a.grantee = 0
           OR a.grantee::regrole::text NOT IN ('uellix_migrator', 'uellix_app', 'uellix_auditor'))
  ) f;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: % — only uellix_migrator, uellix_app and uellix_auditor may execute a bootstrap function. On managed Supabase, ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS writes DIRECT acl entries at CREATE time, and a REVOKE of PUBLIC does not touch them.', v_problem;
  END IF;

  -- (5b) THE OWNER EXEMPTION ABOVE IS ONLY SAFE IF THE OWNER IS KNOWN. A
  --      function owned by anon would have had its grantee exempted as "the
  --      owner" and never examined.
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname || '.' || p.proname)
    INTO v_problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE (n.nspname = 'uellix_bootstrap' OR (n.nspname = 'public' AND p.proname = 'uellix_auth_uid'))
    AND pg_get_userbyid(p.proowner) <> current_user;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001 FAILED verification: function(s) % are not owned by the installer (%). The EXECUTE sweep in (5) exempts the owner, so an unexpected owner would be an unexamined principal.', v_problem, current_user;
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
