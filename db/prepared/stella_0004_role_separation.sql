-- db/prepared/stella_0004_role_separation.sql
-- Database role separation and default-privilege hardening.
--
-- PREPARED ONLY — NOT A MIGRATION. This file lives in db/prepared/ (never in
-- db/migrations/, where drizzle-kit would apply it). Application to any
-- database is a manual, gated act. Rollback:
-- stella_0004_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/DATABASE_ROLE_MODEL.md.
--
-- RUN AS ONE TRANSACTION, AS A SUPERUSER:
--   psql "$URL" -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- Every statement below is idempotent AND convergent: a second application
-- produces the same state and changes nothing.
--
-- `-1` and ON_ERROR_STOP are NOT the barrier. Section 0 asserts the whole
-- inventory before touching anything and section 9 asserts the end state, both
-- with RAISE EXCEPTION. An operator who forgets either flag still cannot leave
-- this database half-hardened.
--
-- NOTHING HERE IS COMPOSED. Every statement is either a top-level literal or
-- an `EXECUTE '<fixed literal>'`. There is no `format()`, no `||`, no
-- `quote_ident()`, and no identifier derived from a variable, a catalog or user
-- input. The surrounding code decides only WHETHER a statement runs, never
-- WHAT it says — the invariant the other prepared stella_* scripts hold, and
-- which tests/prepared-stella-sql.test.ts enforces for all of them.
--
-- ============================================================================
-- WHY THIS EXISTS (measured on PostgreSQL 17.6, 2026-08-02)
-- ============================================================================
-- 1. All 38 tables and all 8 functions in `public` were owned by `postgres`,
--    which is the role db/client.ts connects as. The application runtime WAS
--    the object owner, so it could ALTER, DROP, disable RLS, drop policies and
--    disable the 10 append-only triggers that are supposed to constrain it.
--    A grant model can never protect a table from its own owner.
--
-- 2. `pg_default_acl` carried grants nobody declared. Two separate entries:
--
--      FOR ROLE postgres       IN SCHEMA public: authenticated=Dxtm
--      FOR ROLE supabase_admin IN SCHEMA public: anon=arwdDxtm
--
--      a=INSERT r=SELECT w=UPDATE d=DELETE D=TRUNCATE x=REFERENCES
--      t=TRIGGER m=MAINTAIN (PG17+)
--
--    Verified empirically: a table created by `postgres` in `public` is born
--    with TRUNCATE for `authenticated` (and TRUNCATE is NOT governed by RLS);
--    a table created by `supabase_admin` is born with full DML for `anon`.
--    Neither grant appears in any migration in this repository. Supabase's
--    bootstrap installs them.
--
-- 3. Sequences created by `postgres` in `public` granted UPDATE to `anon`.
--    UPDATE on a sequence confers nextval() and setval().
--
-- 4. Functions and types have a NON-EMPTY PostgreSQL default: acldefault('f')
--    is EXECUTE TO PUBLIC and acldefault('T') is USAGE TO PUBLIC. Verified:
--    has_function_privilege('anon', <new function>, 'EXECUTE') = true. Reading
--    `proacl IS NULL` as "no grants" is exactly how that is missed.
--
-- ============================================================================
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It does not change any attribute of any Supabase-internal role
--     (`postgres`, `service_role`, `supabase_*`, `anon`, `authenticated`,
--     `authenticator`, `dashboard_user`, `pgbouncer`).
--   * It does not touch any object outside the explicit allowlist in section 0
--     — no schema other than `public`, and within `public` only the 38 tables
--     and 8 functions enumerated by name.
--   * It does not create, alter or drop a single policy or trigger.
--   * It does not enable FORCE ROW LEVEL SECURITY. Doing so would subject the
--     7 SECURITY DEFINER functions owned by the new owner to RLS, and
--     handle_new_user() writes to public.users from an auth.users trigger with
--     no JWT claims — user signup would fail. That is a separate decision.
--   * It does not write, read or move a single data row.
--   * It does not set a password on any role it creates. A LOGIN role with no
--     password cannot authenticate via scram/md5 at all; credentials are
--     provisioned out of band and never live in this repository.
--   * It uses no CASCADE, no DROP OWNED, no REASSIGN OWNED, no GRANT ALL, no
--     wildcard over a schema, and no ALTER DEFAULT PRIVILEGES without FOR ROLE.
--
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions — abort before touching anything
-- ============================================================
-- The allowlist is enumerated by name, in both directions: every name below
-- must exist, and `public` must contain nothing beyond it. A table that
-- appeared since this script was written must be classified deliberately
-- (append-only or operational) before it can be hardened, so an unknown name
-- is an abort, not a default.

DO $$
DECLARE
  operational_tables text[] := ARRAY[
    'evidence_items','financial_proxies','funders','fx_rates','impact_narratives',
    'indicators','invitations','marketing_leads','methodology_review_matrix',
    'methodology_review_matrix_items','organization_members','organizations',
    'outcome_funder_allocations','outcome_proxy_assignments','outcome_taxonomy_mappings',
    'outcomes','portfolios','project_investments','projects','proxy_sources',
    'signup_allowlist','sroi_assignment_inputs','sroi_filter_sets','sroi_report_sections',
    'sroi_reports','sroi_run_review_items','sroi_run_reviews','stakeholder_groups',
    'taxonomy_catalogs','taxonomy_codes','theory_of_change_links','theory_of_change_nodes',
    'users'
  ];
  append_only_tables text[] := ARRAY[
    'audit_logs','sroi_calculation_line_items','sroi_calculation_runs',
    'stella_interactions','stella_suggestion_decisions'
  ];
  expected_functions text[] := ARRAY[
    'can_read_evidence_object(text,uuid)','can_write_evidence_object(text,uuid)',
    'current_user_is_super_admin()','current_user_org_ids()',
    'current_user_role_in_org(uuid)','handle_new_user()','handle_update_user()',
    'uellix_forbid_mutation()'
  ];
  all_tables text[] := operational_tables || append_only_tables;
  drift text;
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'stella_0004 requires PostgreSQL 17+ (MAINTAIN handling); this server is %',
      current_setting('server_version');
  END IF;

  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0004 must run as a superuser. Running as a CREATEROLE non-superuser would auto-grant that role ADMIN OPTION on every role created here (PostgreSQL 16+ behaviour, verified), which defeats the separation this script exists to create. Current role: %',
      current_user;
  END IF;

  -- Every allowlisted table must exist.
  SELECT string_agg(t, ', ' ORDER BY t) INTO drift
  FROM unnest(all_tables) AS t
  WHERE to_regclass('public.' || quote_ident(t)) IS NULL;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: allowlisted table(s) missing from public: %', drift;
  END IF;

  -- `public` must contain nothing beyond the allowlist.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO drift
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND NOT (c.relname = ANY (all_tables));
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: unclassified table(s) in public: %. Classify them as append-only or operational in this script before hardening — an unknown table must not silently receive operational (UPDATE/DELETE) grants', drift;
  END IF;

  -- Function allowlist, both directions.
  SELECT string_agg(f, ', ' ORDER BY f) INTO drift
  FROM unnest(expected_functions) AS f
  WHERE to_regprocedure('public.' || f) IS NULL;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: allowlisted function(s) missing from public: %', drift;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO drift
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(expected_functions) AS f
      WHERE to_regprocedure('public.' || f) = p.oid
    );
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: unclassified function(s) in public: %', drift;
  END IF;

  -- Structural fingerprint. These numbers are the state this script was
  -- designed against; a mismatch means the database is not the one reviewed.
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) <> 38 THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: expected 38 tables in public';
  END IF;

  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') <> 104 THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: expected 104 policies in public';
  END IF;

  IF (SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT g.tgisinternal) <> 10 THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: expected 10 non-internal triggers in public';
  END IF;

  -- `anon` and PUBLIC must already hold nothing on any table in public.
  --
  -- This is a PRECONDITION rather than something the script fixes, and the
  -- distinction is deliberate. Revoking DML from `anon` could break a public
  -- unauthenticated path that this script cannot see from the catalog (the
  -- marketing_leads table carries an `anon` INSERT policy, for instance —
  -- inert today precisely because `anon` holds no grant, but not something to
  -- silently decide about here). Section 5 narrows what `authenticated` and
  -- `service_role` hold; it does not redesign the anonymous surface. So a
  -- database where `anon` DOES hold privileges is a database this script was
  -- not written for, and it stops instead of guessing.
  SELECT string_agg(x.relname || ':' || x.grantee_name || ':' || x.privilege_type, ', '
                    ORDER BY x.relname, x.grantee_name, x.privilege_type) INTO drift
  FROM (
    SELECT c.relname,
           COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC') AS grantee_name,
           a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
    LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)
  ) x;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: anon or PUBLIC already hold privileges on table(s) in public: %. This script narrows authenticated/service_role; it does not decide what the anonymous role may do. Resolve that first', drift;
  END IF;

  -- `anon` and `service_role` must already hold no EXECUTE on any function in
  -- `public`, and PUBLIC likewise.
  --
  -- This matters more than it looks. Seven of the eight functions are SECURITY
  -- DEFINER and, after section 4, run as uellix_owner — the RLS-exempt object
  -- owner. An `anon` EXECUTE on one of them is an unauthenticated call into
  -- owner-rights code reachable over PostgREST at /rest/v1/rpc/. As with the
  -- anon table check above, this script does not decide the anonymous surface:
  -- it refuses to harden a database whose anonymous surface it was not
  -- designed for. Added after adversarial review, 2026-08-02.
  SELECT string_agg(x.func || ':' || x.grantee_name, ', ' ORDER BY x.func, x.grantee_name)
    INTO drift
  FROM (
    SELECT p.oid::regprocedure::text AS func,
           COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC') AS grantee_name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
    LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE n.nspname = 'public'
      AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole::oid, 'service_role'::regrole::oid))
  ) x;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: anon, service_role or PUBLIC already hold EXECUTE on function(s) in public: %. After the ownership transfer those functions run as uellix_owner, which is exempt from RLS. Resolve that first', drift;
  END IF;

  -- No GLOBAL default privilege may already grant anything to a third party.
  -- This script repairs SCHEMA-SCOPED entries for `public`; it cannot repair a
  -- global entry for a Supabase-internal role without reaching every schema
  -- they create in. So a database carrying one is a database it refuses.
  SELECT string_agg(pg_get_userbyid(d.defaclrole) || '/' || d.defaclobjtype::text ||
                    '/' || COALESCE(pg_get_userbyid(a.grantee),'PUBLIC') ||
                    '/' || a.privilege_type, ', ') INTO drift
  FROM pg_default_acl d,
  LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclnamespace = 0
    AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid));
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: a GLOBAL default privilege already grants to a third party: %. Global entries apply to EVERY schema, including Supabase internals, and this script will not silently alter them', drift;
  END IF;

  -- `public` must contain no relation other than the 38 allowlisted tables.
  --
  -- Every ownership and ACL check in this script filters relkind IN ('r','p').
  -- A view, materialised view or sequence therefore falls through all of them,
  -- and a `postgres`-owned view is read with ITS owner's rights — and
  -- `postgres` has rolbypassrls, so an anon-granted view in `public` is a
  -- complete RLS bypass that the 38/104/10 fingerprint would certify as clean.
  -- Measured as 0/0/0 today; this makes it a checked fact rather than a
  -- comment. Added after adversarial review, 2026-08-02.
  SELECT string_agg(c.relkind::text || ':' || c.relname, ', ' ORDER BY c.relname) INTO drift
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('v','m','S','f');
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: public contains view/matview/sequence/foreign-table object(s) that this script does not classify: %. They would fall through every relkind IN (r,p) check here — classify and handle them before hardening', drift;
  END IF;

  -- Same reasoning for user-defined types and domains: acldefault('T', ...) is
  -- USAGE TO PUBLIC, and nothing in this script would transfer or narrow them.
  SELECT string_agg(t.typname, ', ' ORDER BY t.typname) INTO drift
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype IN ('e','d','r','m');
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: public contains user-defined type(s)/domain(s) this script does not classify: %', drift;
  END IF;

  -- RLS must already be on everywhere. This script never enables it, so a
  -- table with RLS off would silently stay off behind a hardened ACL.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO drift
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity;
  IF drift IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 precondition failed: RLS is disabled on: %', drift;
  END IF;

  RAISE NOTICE 'stella_0004: preconditions passed — 38 tables (33 operational, 5 append-only), 8 functions, 104 policies, 10 triggers, RLS on 38/38.';
END $$;

-- ============================================================
-- 1. Roles
-- ============================================================
-- Created without LOGIN passwords on purpose: a LOGIN role with no password
-- cannot authenticate via scram-sha-256 or md5. That is fail-closed — the
-- roles exist and hold exactly their intended privileges, and granting
-- network access to them is a separate, explicit operational act.

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

-- Attributes are applied unconditionally so that re-running CONVERGES an
-- existing role instead of skipping it. NOINHERIT on every role: privileges
-- reached through membership must be an explicit per-grant decision
-- (section 2), never a role-wide default.
ALTER ROLE uellix_owner    NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_migrator LOGIN   NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_app      LOGIN   NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_writer   NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;
ALTER ROLE uellix_auditor  LOGIN   NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

-- The auditor's read-only default. Defence in depth, NOT the barrier: any role
-- may SET default_transaction_read_only = off in its own session. The barrier
-- is that uellix_auditor holds no write privilege to activate, has no CREATE on
-- any schema, and no EXECUTE on either of the two SECURITY DEFINER functions
-- that write (section 6b-bis grants it the three read-only RLS helpers and
-- nothing else; section 9.8 asserts the exclusion by name).
--
-- It does close one real gap: PUBLIC holds TEMPORARY on the database, so the
-- auditor CAN create a temp table — except inside a read-only transaction,
-- where it fails with SQLSTATE 25006 (verified). Revoking TEMPORARY from
-- PUBLIC would reach Supabase's own roles and is out of scope (RR-06).
ALTER ROLE uellix_auditor SET default_transaction_read_only = on;

COMMENT ON ROLE uellix_owner    IS 'stella_0004: owns the Uellix objects in public. NOLOGIN. Reachable only via SET ROLE from uellix_migrator.';
COMMENT ON ROLE uellix_migrator IS 'stella_0004: runs migrations. Holds uellix_owner with INHERIT FALSE, so it has the owner''s power only after an explicit SET ROLE.';
COMMENT ON ROLE uellix_app      IS 'stella_0004: application runtime. Not an owner, no BYPASSRLS, no DDL. All write power is inherited from uellix_writer.';
COMMENT ON ROLE uellix_writer   IS 'stella_0004: governed write surface. SELECT+INSERT on append-only tables, SELECT+INSERT+UPDATE+DELETE on operational tables. Never TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.';
COMMENT ON ROLE uellix_auditor  IS 'stella_0004: read-only auditor of structure and privileges. SELECT only, no memberships, and EXECUTE on nothing but the three read-only RLS helpers (without which a SELECT errors instead of filtering). Sees no rows: it is subject to RLS and the policies need a JWT.';

-- ============================================================
-- 2. Memberships — explicit options, and nothing implicit
-- ============================================================
-- INHERIT and SET are set per grant (PostgreSQL 16+), which is what makes the
-- separation real rather than nominal:
--
--   uellix_migrator -> uellix_owner   SET TRUE, INHERIT FALSE
--       The migrator does NOT carry the owner's privileges while it works. It
--       acquires them only for the duration of an explicit SET ROLE, which is
--       visible in the session and in the script that issues it.
--
--   uellix_app -> uellix_writer       INHERIT TRUE, SET FALSE
--       The runtime always has the writer's DML and can never SET ROLE to it,
--       so "what can the app write" is answered by reading one role's grants.
--
--   postgres -> uellix_writer         INHERIT TRUE, SET FALSE
--       TRANSITIONAL, and load-bearing. db/client.ts still connects as
--       `postgres`. Section 4 transfers ownership away from `postgres`, and
--       ALTER TABLE ... OWNER TO does not leave the old owner's ACL entry
--       behind — it transfers it. Verified empirically on public.projects:
--       after the transfer, `postgres` had NO direct privilege left. On 37 of
--       38 tables that is masked by postgres's inherited membership in
--       authenticated / service_role / pg_read_all_data, but NOT on
--       stella_suggestion_decisions, where `authenticated` holds only SELECT
--       and `service_role` holds nothing. Without this grant the application
--       would lose the ability to persist Stella decisions.
--
--       Granting the writer role rather than raw privileges is deliberate:
--       the legacy runtime ends up with EXACTLY the governed write surface,
--       defined in one place, and demonstrably without TRUNCATE, REFERENCES,
--       TRIGGER, MAINTAIN or any DDL capability.
--
-- The REVOKEs are guarded rather than unconditional: PostgreSQL emits a
-- WARNING ("role X has not been granted membership in role Y") when there is
-- nothing to revoke, and on a first application that is three warnings an
-- operator has to read past to reach the real output. They exist so the
-- options CONVERGE even if a prior run or an operator created the membership
-- with different flags.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members a
             JOIN pg_roles mr ON mr.oid = a.member JOIN pg_roles rr ON rr.oid = a.roleid
             WHERE mr.rolname = 'uellix_migrator' AND rr.rolname = 'uellix_owner') THEN
    EXECUTE 'REVOKE uellix_owner FROM uellix_migrator';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members a
             JOIN pg_roles mr ON mr.oid = a.member JOIN pg_roles rr ON rr.oid = a.roleid
             WHERE mr.rolname = 'uellix_app' AND rr.rolname = 'uellix_writer') THEN
    EXECUTE 'REVOKE uellix_writer FROM uellix_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members a
             JOIN pg_roles mr ON mr.oid = a.member JOIN pg_roles rr ON rr.oid = a.roleid
             WHERE mr.rolname = 'postgres' AND rr.rolname = 'uellix_writer') THEN
    EXECUTE 'REVOKE uellix_writer FROM postgres';
  END IF;
END $$;

GRANT uellix_owner  TO uellix_migrator WITH SET TRUE,  INHERIT FALSE, ADMIN FALSE;
GRANT uellix_writer TO uellix_app      WITH SET FALSE, INHERIT TRUE,  ADMIN FALSE;
GRANT uellix_writer TO postgres        WITH SET FALSE, INHERIT TRUE,  ADMIN FALSE;

-- Nothing else. In particular uellix_app is NOT a member of uellix_owner, and
-- no Uellix role is a member of anon / authenticated / authenticator /
-- service_role. Section 9.4 asserts exactly that.

-- ============================================================
-- 3. Schema privileges
-- ============================================================
-- CREATE on public goes to the owner only. USAGE is the minimum needed to
-- name an object in the schema; it confers nothing by itself.

GRANT USAGE  ON SCHEMA public TO uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;
GRANT CREATE ON SCHEMA public TO uellix_owner;

REVOKE CREATE ON SCHEMA public FROM uellix_migrator, uellix_app, uellix_writer, uellix_auditor;

-- PUBLIC must not hold CREATE on public. Supabase already revokes it; this is
-- convergence, not a change, and section 9 verifies it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- USAGE on schema `auth` for the new owner — a direct and unavoidable
-- consequence of section 4, not a widening.
--
-- Three of the eight functions (current_user_org_ids,
-- current_user_is_super_admin, current_user_role_in_org) are SECURITY DEFINER
-- and call auth.uid(). Transferring them to uellix_owner changes their
-- effective user, so the schema lookup is now performed as uellix_owner. Left
-- unaddressed, EVERY policy that calls them fails with "permission denied for
-- schema auth" — not "zero rows", an outright error — for every caller,
-- including `authenticated` through PostgREST. That is the whole RLS surface
-- of the product. Measured in the disposable rehearsal, 2026-08-02.
--
-- This is the minimum that closes it: auth.uid() itself already carries
-- EXECUTE for PUBLIC, so only the schema lookup is missing. No privilege on
-- any table in `auth` is granted, and section 9.13 asserts that no Uellix role
-- can read auth.users by any route.
GRANT USAGE ON SCHEMA auth TO uellix_owner;

-- ============================================================
-- 4. Ownership transfer — allowlisted objects only
-- ============================================================
-- Enumerated by name. There is no wildcard, no loop over a catalog query and
-- no schema-level sweep: an object that is not named here does not move.
--
-- Indexes and constraints follow their table's owner automatically, and
-- section 0 has already refused to run if `public` held any sequence, view,
-- materialised view or user-defined type — so these 38 tables and 8 functions
-- are the complete set.

ALTER TABLE public.audit_logs OWNER TO uellix_owner;
ALTER TABLE public.evidence_items OWNER TO uellix_owner;
ALTER TABLE public.financial_proxies OWNER TO uellix_owner;
ALTER TABLE public.funders OWNER TO uellix_owner;
ALTER TABLE public.fx_rates OWNER TO uellix_owner;
ALTER TABLE public.impact_narratives OWNER TO uellix_owner;
ALTER TABLE public.indicators OWNER TO uellix_owner;
ALTER TABLE public.invitations OWNER TO uellix_owner;
ALTER TABLE public.marketing_leads OWNER TO uellix_owner;
ALTER TABLE public.methodology_review_matrix OWNER TO uellix_owner;
ALTER TABLE public.methodology_review_matrix_items OWNER TO uellix_owner;
ALTER TABLE public.organization_members OWNER TO uellix_owner;
ALTER TABLE public.organizations OWNER TO uellix_owner;
ALTER TABLE public.outcome_funder_allocations OWNER TO uellix_owner;
ALTER TABLE public.outcome_proxy_assignments OWNER TO uellix_owner;
ALTER TABLE public.outcome_taxonomy_mappings OWNER TO uellix_owner;
ALTER TABLE public.outcomes OWNER TO uellix_owner;
ALTER TABLE public.portfolios OWNER TO uellix_owner;
ALTER TABLE public.project_investments OWNER TO uellix_owner;
ALTER TABLE public.projects OWNER TO uellix_owner;
ALTER TABLE public.proxy_sources OWNER TO uellix_owner;
ALTER TABLE public.signup_allowlist OWNER TO uellix_owner;
ALTER TABLE public.sroi_assignment_inputs OWNER TO uellix_owner;
ALTER TABLE public.sroi_calculation_line_items OWNER TO uellix_owner;
ALTER TABLE public.sroi_calculation_runs OWNER TO uellix_owner;
ALTER TABLE public.sroi_filter_sets OWNER TO uellix_owner;
ALTER TABLE public.sroi_report_sections OWNER TO uellix_owner;
ALTER TABLE public.sroi_reports OWNER TO uellix_owner;
ALTER TABLE public.sroi_run_review_items OWNER TO uellix_owner;
ALTER TABLE public.sroi_run_reviews OWNER TO uellix_owner;
ALTER TABLE public.stakeholder_groups OWNER TO uellix_owner;
ALTER TABLE public.stella_interactions OWNER TO uellix_owner;
ALTER TABLE public.stella_suggestion_decisions OWNER TO uellix_owner;
ALTER TABLE public.taxonomy_catalogs OWNER TO uellix_owner;
ALTER TABLE public.taxonomy_codes OWNER TO uellix_owner;
ALTER TABLE public.theory_of_change_links OWNER TO uellix_owner;
ALTER TABLE public.theory_of_change_nodes OWNER TO uellix_owner;
ALTER TABLE public.users OWNER TO uellix_owner;

ALTER FUNCTION public.can_read_evidence_object(text,uuid) OWNER TO uellix_owner;
ALTER FUNCTION public.can_write_evidence_object(text,uuid) OWNER TO uellix_owner;
ALTER FUNCTION public.current_user_is_super_admin() OWNER TO uellix_owner;
ALTER FUNCTION public.current_user_org_ids() OWNER TO uellix_owner;
ALTER FUNCTION public.current_user_role_in_org(uuid) OWNER TO uellix_owner;
ALTER FUNCTION public.handle_new_user() OWNER TO uellix_owner;
ALTER FUNCTION public.handle_update_user() OWNER TO uellix_owner;
ALTER FUNCTION public.uellix_forbid_mutation() OWNER TO uellix_owner;

-- ============================================================
-- 5. Repair the ACL the transfer consumed, and the ACL nobody declared
-- ============================================================
-- 5a. Restore `postgres`'s EXECUTE on the 8 functions.
--
-- Before this script, all 8 carried an explicit `postgres=X` entry and PUBLIC
-- held nothing (someone had already revoked the acldefault('f') grant). The
-- ownership transfer in section 4 consumed the `postgres` entry the same way
-- it did for tables. Restoring it keeps the effective ACL identical to the
-- pre-existing shape — the only intended change in this script is WHO owns the
-- function, not who may call it.
GRANT EXECUTE ON FUNCTION
  public.can_read_evidence_object(text,uuid),
  public.can_write_evidence_object(text,uuid),
  public.current_user_is_super_admin(),
  public.current_user_org_ids(),
  public.current_user_role_in_org(uuid),
  public.handle_new_user(),
  public.handle_update_user(),
  public.uellix_forbid_mutation()
TO postgres;

-- PUBLIC must hold no EXECUTE. Convergence — verified in section 9.10.
REVOKE EXECUTE ON FUNCTION
  public.can_read_evidence_object(text,uuid),
  public.can_write_evidence_object(text,uuid),
  public.current_user_is_super_admin(),
  public.current_user_org_ids(),
  public.current_user_role_in_org(uuid),
  public.handle_new_user(),
  public.handle_update_user(),
  public.uellix_forbid_mutation()
FROM PUBLIC;

-- 5b. Revoke the undeclared surplus from `authenticated` and `service_role`
-- on ALL 38 tables.
--
-- stella_0002b did this for the 4 documented append-only tables and explicitly
-- deferred the other 34 to "its own gate". This is that gate.
--
-- SELECT / INSERT / UPDATE / DELETE are deliberately left alone: PostgREST
-- needs them and RLS governs them. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
-- are needed by nothing in this product:
--
--   TRUNCATE   is not governed by RLS at all, and row triggers do not fire on
--              it — the exact hole stella_0002b was written to close.
--   REFERENCES lets a role point a foreign key at the table, which pins rows
--              against deletion and leaks existence.
--   TRIGGER    lets a role attach its own trigger, i.e. run arbitrary code
--              inside another role's write path.
--   MAINTAIN   (PG17) confers VACUUM / ANALYZE / CLUSTER / REINDEX / REFRESH
--              MATERIALIZED VIEW / LOCK TABLE. LOCK TABLE alone is a
--              denial-of-service vector against an audit trail.
--
-- MAINTAIN sits in the same statement rather than behind a version guard:
-- section 0 already aborts on anything older than PostgreSQL 17, so the token
-- can never reach a server that would reject it. One barrier, declared once.

REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.audit_logs, public.evidence_items, public.financial_proxies,
  public.funders, public.fx_rates, public.impact_narratives,
  public.indicators, public.invitations, public.marketing_leads,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_members,
  public.organizations, public.outcome_funder_allocations, public.outcome_proxy_assignments,
  public.outcome_taxonomy_mappings, public.outcomes, public.portfolios,
  public.project_investments, public.projects, public.proxy_sources,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.stella_interactions, public.stella_suggestion_decisions,
  public.taxonomy_catalogs, public.taxonomy_codes, public.theory_of_change_links,
  public.theory_of_change_nodes, public.users
FROM authenticated, service_role, anon, PUBLIC;

-- ============================================================
-- 6. Explicit grants — the governed write surface
-- ============================================================
-- Two classes, named table by table. `uellix_writer` never receives TRUNCATE,
-- REFERENCES, TRIGGER or MAINTAIN, so the append-only guarantee holds on the
-- grant layer as well as on the trigger layer.

-- 6a. Append-only: SELECT + INSERT. No UPDATE, no DELETE, ever.
GRANT SELECT, INSERT ON
  public.audit_logs,
  public.sroi_calculation_line_items,
  public.sroi_calculation_runs,
  public.stella_interactions,
  public.stella_suggestion_decisions
TO uellix_writer;

-- Convergence: if a previous run or an operator widened these, take it back.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.audit_logs,
  public.sroi_calculation_line_items,
  public.sroi_calculation_runs,
  public.stella_interactions,
  public.stella_suggestion_decisions
FROM uellix_writer;

-- 6b. Operational: full DML, nothing structural.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.evidence_items, public.financial_proxies, public.funders,
  public.fx_rates, public.impact_narratives, public.indicators,
  public.invitations, public.marketing_leads, public.methodology_review_matrix,
  public.methodology_review_matrix_items, public.organization_members, public.organizations,
  public.outcome_funder_allocations, public.outcome_proxy_assignments, public.outcome_taxonomy_mappings,
  public.outcomes, public.portfolios, public.project_investments,
  public.projects, public.proxy_sources, public.signup_allowlist,
  public.sroi_assignment_inputs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.taxonomy_catalogs, public.taxonomy_codes,
  public.theory_of_change_links, public.theory_of_change_nodes, public.users
TO uellix_writer;

REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.evidence_items, public.financial_proxies, public.funders,
  public.fx_rates, public.impact_narratives, public.indicators,
  public.invitations, public.marketing_leads, public.methodology_review_matrix,
  public.methodology_review_matrix_items, public.organization_members, public.organizations,
  public.outcome_funder_allocations, public.outcome_proxy_assignments, public.outcome_taxonomy_mappings,
  public.outcomes, public.portfolios, public.project_investments,
  public.projects, public.proxy_sources, public.signup_allowlist,
  public.sroi_assignment_inputs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.taxonomy_catalogs, public.taxonomy_codes,
  public.theory_of_change_links, public.theory_of_change_nodes, public.users
FROM uellix_writer;

-- 6b-bis. EXECUTE on the three RLS read helpers.
--
-- Not optional, and not obvious from the catalog: evaluating a row-level
-- security policy requires the INVOKING role to hold EXECUTE on every function
-- the policy expression calls. Almost every policy in this schema calls
-- public.current_user_org_ids() or public.current_user_is_super_admin().
-- Without these grants a SELECT by uellix_app or uellix_auditor does not
-- return zero rows — it fails outright with "permission denied for function
-- current_user_org_ids". Measured in the disposable rehearsal, 2026-08-02.
--
-- `authenticated` already holds exactly these three for the same reason, so
-- this is consistency with the existing model rather than a new concession.
--
-- The two functions that WRITE (handle_new_user, handle_update_user) are
-- deliberately excluded, and so are the storage helpers. That is what makes
-- "no indirect write path through a function" a checkable claim rather than a
-- slogan: section 9.8 asserts the exclusion by name.
GRANT EXECUTE ON FUNCTION
  public.current_user_org_ids(),
  public.current_user_is_super_admin(),
  public.current_user_role_in_org(uuid)
TO uellix_writer, uellix_auditor;

-- 6c. Auditor: SELECT on all 38, nothing else.
GRANT SELECT ON
  public.audit_logs, public.evidence_items, public.financial_proxies,
  public.funders, public.fx_rates, public.impact_narratives,
  public.indicators, public.invitations, public.marketing_leads,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_members,
  public.organizations, public.outcome_funder_allocations, public.outcome_proxy_assignments,
  public.outcome_taxonomy_mappings, public.outcomes, public.portfolios,
  public.project_investments, public.projects, public.proxy_sources,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.stella_interactions, public.stella_suggestion_decisions,
  public.taxonomy_catalogs, public.taxonomy_codes, public.theory_of_change_links,
  public.theory_of_change_nodes, public.users
TO uellix_auditor;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.audit_logs, public.evidence_items, public.financial_proxies,
  public.funders, public.fx_rates, public.impact_narratives,
  public.indicators, public.invitations, public.marketing_leads,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_members,
  public.organizations, public.outcome_funder_allocations, public.outcome_proxy_assignments,
  public.outcome_taxonomy_mappings, public.outcomes, public.portfolios,
  public.project_investments, public.projects, public.proxy_sources,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.stella_interactions, public.stella_suggestion_decisions,
  public.taxonomy_catalogs, public.taxonomy_codes, public.theory_of_change_links,
  public.theory_of_change_nodes, public.users
FROM uellix_auditor;

-- uellix_app and uellix_migrator hold NO direct table privilege. Everything
-- the app can do arrives from uellix_writer, so the audit surface is one
-- role's grants rather than 38 ACLs.
REVOKE ALL ON
  public.audit_logs, public.evidence_items, public.financial_proxies,
  public.funders, public.fx_rates, public.impact_narratives,
  public.indicators, public.invitations, public.marketing_leads,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_members,
  public.organizations, public.outcome_funder_allocations, public.outcome_proxy_assignments,
  public.outcome_taxonomy_mappings, public.outcomes, public.portfolios,
  public.project_investments, public.projects, public.proxy_sources,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.stella_interactions, public.stella_suggestion_decisions,
  public.taxonomy_catalogs, public.taxonomy_codes, public.theory_of_change_links,
  public.theory_of_change_nodes, public.users
FROM uellix_app, uellix_migrator;

-- ============================================================
-- 7. Default privileges — the fix for objects that do not exist yet
-- ============================================================
-- ALTER DEFAULT PRIVILEGES is always written FOR ROLE <creator>: without it
-- the statement silently applies to the CURRENT role, which here is a
-- superuser, and the entry nobody meant to create is the one that bites.

-- 7a. Undo Supabase's `postgres` defaults in public.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

-- 7b. Undo Supabase's `supabase_admin` defaults in public.
--
-- LOCAL-ONLY IN PRACTICE. On Supabase managed, `postgres` is neither a
-- superuser nor a member of supabase_admin, so it cannot alter that role's
-- default privileges — see docs/ops/DATABASE_ROLE_MODEL.md §5.2 (RR-03).
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

-- 7c. Suppress the built-in PUBLIC defaults on functions and types.
--
-- THESE FOUR STATEMENTS ARE DELIBERATELY *NOT* SCHEMA-SCOPED, and that is the
-- whole point. Measured on PostgreSQL 17.6, 2026-08-02:
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE r IN SCHEMA public
--     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--       -> pg_default_acl rows for r: 0. A function then created by r in
--          public has proacl = NULL, and has_function_privilege('anon', ...,
--          'EXECUTE') is TRUE. The statement reports success and does nothing.
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE r
--     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--       -> one row with defaclnamespace = 0. A function then created by r gets
--          proacl = {r=X/r}, and has_function_privilege('anon', ...) is FALSE.
--
-- The reason is that a SCHEMA-scoped entry is merged ON TOP OF acldefault(),
-- so it can only add privileges; only the global entry replaces the base. Any
-- audit that assumed the schema-scoped form worked would be reading a
-- successful ALTER as a closed hole.
--
-- Global here is safe precisely because it is scoped BY ROLE: uellix_owner and
-- uellix_migrator are created by this script and create nothing outside
-- `public`. The entry is also RESTRICTIVE — it removes a grant — so its blast
-- radius is bounded even if that ever stopped being true.
--
-- `postgres` and `supabase_admin` are deliberately EXCLUDED: a global entry
-- for them would reach every object they create in `auth`, `storage`,
-- `realtime` and the rest of Supabase's internals, which is outside this
-- script's allowlist. The residual is recorded as RR-08 in
-- docs/ops/DATABASE_ROLE_MODEL.md — the mitigation is that Uellix objects are
-- created by uellix_owner, and that every migration creating a function must
-- still carry its own explicit REVOKE ... FROM PUBLIC (as the existing 8
-- functions already do).
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner    REVOKE USAGE   ON TYPES     FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_migrator REVOKE USAGE   ON TYPES     FROM PUBLIC;

-- 7d. No positive default is granted to ANY role.
--
-- A table created by uellix_owner is born with relacl = NULL, which
-- acldefault('r', owner) resolves to "owner only". uellix_app, uellix_writer,
-- uellix_auditor, authenticated, anon, service_role and PUBLIC all receive
-- nothing, and a new table must be granted explicitly. That is the objective,
-- not an oversight: an inherited grant is a grant nobody reviewed.

-- ============================================================
-- 8. Documentation on the objects themselves
-- ============================================================
COMMENT ON SCHEMA public IS
  'Uellix application schema. Objects are owned by uellix_owner (prepared stella_0004). Migrations run as uellix_migrator with an explicit SET ROLE uellix_owner; the application runtime holds no ownership. See docs/ops/DATABASE_ROLE_MODEL.md.';

-- ============================================================
-- 9. Self-verification — assert the end state, inside this transaction
-- ============================================================
-- A REVOKE only removes grants made by the CURRENT grantor, and PostgreSQL
-- emits a WARNING rather than an error when there is nothing to revoke. A
-- GRANT without grant option warns too. So the script must not trust that "I
-- ran REVOKE" means "the privilege is gone": it must look. Running inside the
-- same transaction is what makes it worth doing — a failure here rolls back
-- everything rather than leaving a half-hardened database that reported
-- success.
--
-- Every check below reads pg_catalog + aclexplode. None reads
-- information_schema.role_table_grants, which expands privileges reached by
-- membership and cannot express PUBLIC at all.

DO $$
DECLARE
  all_tables text[] := ARRAY[
    'audit_logs','evidence_items','financial_proxies','funders','fx_rates',
    'impact_narratives','indicators','invitations','marketing_leads',
    'methodology_review_matrix','methodology_review_matrix_items',
    'organization_members','organizations','outcome_funder_allocations',
    'outcome_proxy_assignments','outcome_taxonomy_mappings','outcomes','portfolios',
    'project_investments','projects','proxy_sources','signup_allowlist',
    'sroi_assignment_inputs','sroi_calculation_line_items','sroi_calculation_runs',
    'sroi_filter_sets','sroi_report_sections','sroi_reports','sroi_run_review_items',
    'sroi_run_reviews','stakeholder_groups','stella_interactions',
    'stella_suggestion_decisions','taxonomy_catalogs','taxonomy_codes',
    'theory_of_change_links','theory_of_change_nodes','users'
  ];
  append_only text[] := ARRAY[
    'audit_logs','sroi_calculation_line_items','sroi_calculation_runs',
    'stella_interactions','stella_suggestion_decisions'
  ];
  problem text;
BEGIN
  -- 9.1 Ownership: all 38 tables and all 8 functions belong to uellix_owner.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND c.relowner <> 'uellix_owner'::regrole;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: table(s) not owned by uellix_owner: %', problem;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proowner <> 'uellix_owner'::regrole;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: function(s) not owned by uellix_owner: %', problem;
  END IF;

  -- 9.2 No Uellix role may own anything outside the allowlist.
  --
  -- `pg_toast` is excluded deliberately, not as a convenience: a TOAST table
  -- and its index are storage for their parent relation and PostgreSQL keeps
  -- their owner in lockstep with it. Transferring 38 tables therefore
  -- transfers ~70 pg_toast entries as an unavoidable side effect, and treating
  -- those as "a Uellix role owns something outside public" would make this
  -- check permanently red. Caught by the disposable rehearsal, 2026-08-02.
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('public', 'pg_toast')
    AND c.relowner IN ('uellix_owner'::regrole, 'uellix_migrator'::regrole,
                       'uellix_app'::regrole, 'uellix_writer'::regrole,
                       'uellix_auditor'::regrole);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a Uellix role owns relation(s) outside public: %', problem;
  END IF;

  -- pg_class is not the only ownership catalog. A function, a type or a schema
  -- that changed hands would be invisible to the check above. Added after
  -- adversarial review, 2026-08-02.
  SELECT string_agg(y.kind || ' ' || y.objname, ', ') INTO problem
  FROM (
    SELECT 'function' AS kind, p.oid::regprocedure::text AS objname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> 'public' AND pg_get_userbyid(p.proowner) LIKE 'uellix\_%'
    UNION ALL
    SELECT 'type', n.nspname || '.' || t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname <> 'public' AND pg_get_userbyid(t.typowner) LIKE 'uellix\_%'
    UNION ALL
    SELECT 'schema', n.nspname
    FROM pg_namespace n
    WHERE pg_get_userbyid(n.nspowner) LIKE 'uellix\_%'
  ) y;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a Uellix role owns a function, type or schema it should not: %', problem;
  END IF;

  -- 9.3 Role attributes.
  SELECT string_agg(rolname || '(' ||
           CASE WHEN rolsuper       THEN 'SUPERUSER '   ELSE '' END ||
           CASE WHEN rolbypassrls   THEN 'BYPASSRLS '   ELSE '' END ||
           CASE WHEN rolcreaterole  THEN 'CREATEROLE '  ELSE '' END ||
           CASE WHEN rolcreatedb    THEN 'CREATEDB '    ELSE '' END ||
           CASE WHEN rolreplication THEN 'REPLICATION ' ELSE '' END ||
           CASE WHEN rolinherit     THEN 'INHERIT '     ELSE '' END || ')', ', ')
    INTO problem
  FROM pg_roles
  WHERE rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor')
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: Uellix role(s) carry a forbidden attribute: %', problem;
  END IF;

  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_owner must be NOLOGIN — an owner that can open a session is an owner that can serve traffic';
  END IF;
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_writer') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_writer must be NOLOGIN';
  END IF;

  -- Any LOGIN role created here should be passwordless: rolpassword IS NULL
  -- means scram/md5 authentication is impossible. A credential set out of band
  -- is an operator decision, so this reports rather than aborts.
  SELECT string_agg(rolname, ', ') INTO problem
  FROM pg_authid
  WHERE rolname IN ('uellix_migrator','uellix_app','uellix_auditor')
    AND rolpassword IS NOT NULL;
  IF problem IS NOT NULL THEN
    RAISE NOTICE 'stella_0004: role(s) % already carry a credential. That is an operator decision made out of band; this script neither set nor read it.', problem;
  END IF;

  -- 9.4 Memberships: exactly three, with exactly these options.
  SELECT string_agg(m.rolname || '->' || r.rolname ||
           '(admin=' || a.admin_option || ',inherit=' || a.inherit_option || ',set=' || a.set_option || ')', ', ')
    INTO problem
  FROM pg_auth_members a
  JOIN pg_roles m ON m.oid = a.member
  JOIN pg_roles r ON r.oid = a.roleid
  WHERE (m.rolname LIKE 'uellix\_%' OR r.rolname LIKE 'uellix\_%')
    AND NOT (
      (m.rolname = 'uellix_migrator' AND r.rolname = 'uellix_owner'
        AND NOT a.admin_option AND NOT a.inherit_option AND a.set_option)
      OR (m.rolname = 'uellix_app' AND r.rolname = 'uellix_writer'
        AND NOT a.admin_option AND a.inherit_option AND NOT a.set_option)
      OR (m.rolname = 'postgres' AND r.rolname = 'uellix_writer'
        AND NOT a.admin_option AND a.inherit_option AND NOT a.set_option)
    );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: unexpected membership(s) involving a Uellix role: %', problem;
  END IF;

  -- The runtime must not be able to become the owner, by any path.
  IF pg_has_role('uellix_app', 'uellix_owner', 'USAGE')
     OR pg_has_role('uellix_app', 'uellix_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_app can reach uellix_owner';
  END IF;
  IF pg_has_role('postgres', 'uellix_owner', 'USAGE')
     OR pg_has_role('postgres', 'uellix_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: postgres can reach uellix_owner — the ownership transfer would be nominal';
  END IF;
  IF pg_has_role('uellix_auditor', 'uellix_writer', 'USAGE')
     OR pg_has_role('uellix_auditor', 'uellix_owner', 'USAGE') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_auditor reaches a write role';
  END IF;

  -- 9.5 No dangerous privilege survives anywhere, for anyone but the owner.
  -- Read from relacl directly (COALESCE with acldefault so a NULL ACL is read
  -- as its real meaning, not as "empty").
  SELECT string_agg(x.relname || ':' || x.grantee_name || ':' || x.privilege_type, ', '
                    ORDER BY x.relname, x.grantee_name, x.privilege_type)
    INTO problem
  FROM (
    SELECT c.relname,
           COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC') AS grantee_name,
           a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
    LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
      AND a.grantee <> 'uellix_owner'::regrole::oid
  ) x;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: TRUNCATE/REFERENCES/TRIGGER/MAINTAIN still held by a non-owner: %', problem;
  END IF;

  -- 9.6 anon and PUBLIC hold nothing at all on any table in public.
  SELECT string_agg(x.relname || ':' || x.grantee_name || ':' || x.privilege_type, ', ')
    INTO problem
  FROM (
    SELECT c.relname,
           COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC') AS grantee_name,
           a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
    LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)
  ) x;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: anon or PUBLIC hold privileges in public: %', problem;
  END IF;

  -- 9.7 uellix_writer: SELECT+INSERT on append-only, +UPDATE/DELETE on the
  -- rest, and nothing beyond that.
  SELECT string_agg(t || ':' || p, ', ') INTO problem
  FROM unnest(append_only) AS t,
       (VALUES ('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) AS v(p)
  WHERE has_table_privilege('uellix_writer', ('public.' || quote_ident(t))::regclass, p);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_writer holds a forbidden privilege on an append-only table: %', problem;
  END IF;

  SELECT string_agg(t || ':' || p, ', ') INTO problem
  FROM unnest(all_tables) AS t,
       (VALUES ('SELECT'),('INSERT')) AS v(p)
  WHERE NOT has_table_privilege('uellix_writer', ('public.' || quote_ident(t))::regclass, p);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_writer LOST an expected privilege: %', problem;
  END IF;

  -- ...and the operational tables must ALSO have UPDATE and DELETE. Asserting
  -- only SELECT+INSERT would let a silently-failed GRANT in section 6b pass
  -- verification and break the application at its first write. Added after
  -- adversarial review, 2026-08-02.
  SELECT string_agg(t || ':' || p, ', ') INTO problem
  FROM unnest(all_tables) AS t,
       (VALUES ('UPDATE'),('DELETE')) AS v(p)
  WHERE NOT (t = ANY (append_only))
    AND NOT has_table_privilege('uellix_writer', ('public.' || quote_ident(t))::regclass, p);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_writer lacks UPDATE/DELETE on operational table(s): %. The application would fail on its first write', problem;
  END IF;

  -- 9.8 uellix_auditor is read-only in fact, not just by GUC.
  SELECT string_agg(t || ':' || p, ', ') INTO problem
  FROM unnest(all_tables) AS t,
       (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) AS v(p)
  WHERE has_table_privilege('uellix_auditor', ('public.' || quote_ident(t))::regclass, p);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_auditor holds a write privilege: %', problem;
  END IF;

  -- The auditor may EXECUTE the three read-only RLS helpers (section 6b-bis)
  -- and NOTHING else. Enumerating the allowed three by name — rather than
  -- asserting "no EXECUTE at all" — is what keeps this check meaningful: the
  -- property that matters is "no function that writes", and the two functions
  -- that write are named in the exclusion below.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND has_function_privilege('uellix_auditor', p.oid, 'EXECUTE')
    AND p.oid NOT IN (
      'public.current_user_org_ids()'::regprocedure,
      'public.current_user_is_super_admin()'::regprocedure,
      'public.current_user_role_in_org(uuid)'::regprocedure
    );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_auditor can EXECUTE function(s) beyond the three read-only RLS helpers, which is a potential indirect write path: %', problem;
  END IF;

  IF has_function_privilege('uellix_auditor', 'public.handle_new_user()', 'EXECUTE')
     OR has_function_privilege('uellix_auditor', 'public.handle_update_user()', 'EXECUTE')
     OR has_function_privilege('uellix_writer', 'public.handle_new_user()', 'EXECUTE')
     OR has_function_privilege('uellix_writer', 'public.handle_update_user()', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a Uellix role can EXECUTE a SECURITY DEFINER function that writes to public.users';
  END IF;

  -- Policy evaluation must actually work for both roles, or a "read-only
  -- auditor" is a role that cannot read at all.
  SELECT string_agg(v.rolname || ':' || v.fn, ', ') INTO problem
  FROM (VALUES
    ('uellix_writer','public.current_user_org_ids()'),
    ('uellix_writer','public.current_user_is_super_admin()'),
    ('uellix_writer','public.current_user_role_in_org(uuid)'),
    ('uellix_auditor','public.current_user_org_ids()'),
    ('uellix_auditor','public.current_user_is_super_admin()'),
    ('uellix_auditor','public.current_user_role_in_org(uuid)')
  ) AS v(rolname, fn)
  WHERE NOT has_function_privilege(v.rolname, v.fn::regprocedure, 'EXECUTE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: missing EXECUTE on an RLS helper — a SELECT would fail with "permission denied for function" instead of returning rows: %', problem;
  END IF;

  -- 9.9 The runtime keeps exactly what the application needs, and no more.
  SELECT string_agg(t || ':' || p, ', ') INTO problem
  FROM unnest(all_tables) AS t,
       (VALUES ('SELECT'),('INSERT')) AS v(p)
  WHERE NOT has_table_privilege('uellix_app', ('public.' || quote_ident(t))::regclass, p);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_app cannot read/insert where it must: %', problem;
  END IF;

  SELECT string_agg(t || ':' || p, ', ') INTO problem
  FROM unnest(append_only) AS t,
       (VALUES ('UPDATE'),('DELETE'),('TRUNCATE')) AS v(p)
  WHERE has_table_privilege('uellix_app', ('public.' || quote_ident(t))::regclass, p);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: uellix_app can mutate an append-only table: %', problem;
  END IF;

  -- The legacy runtime must still be able to persist Stella decisions — the
  -- one table where the ownership transfer would otherwise have stripped it.
  IF NOT has_table_privilege('postgres', 'public.stella_suggestion_decisions', 'INSERT') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: postgres lost INSERT on stella_suggestion_decisions; the application would stop persisting decisions';
  END IF;

  -- 9.10 Neither PUBLIC nor anon nor service_role holds EXECUTE on any
  -- function in public.
  --
  -- This used to test PUBLIC only, which left the more dangerous grantee
  -- unchecked: after section 4 the seven SECURITY DEFINER functions run as
  -- uellix_owner, so an `anon` EXECUTE is an unauthenticated call into
  -- owner-rights code over PostgREST /rest/v1/rpc/. Widened after adversarial
  -- review, 2026-08-02.
  SELECT string_agg(x.func || ':' || x.grantee_name, ', ' ORDER BY x.func, x.grantee_name)
    INTO problem
  FROM (
    SELECT p.oid::regprocedure::text AS func,
           COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC') AS grantee_name
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
    LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE n.nspname = 'public'
      AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole::oid, 'service_role'::regrole::oid))
  ) x;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: PUBLIC, anon or service_role hold EXECUTE on function(s) that now run as uellix_owner: %', problem;
  END IF;

  -- 9.11 Default privileges: nothing unsafe survives for any creator role.
  --
  -- SCOPE: schema-scoped rows for `public` AND GLOBAL rows (defaclnamespace=0).
  -- The join used to be an INNER join on pg_namespace, which can never match a
  -- global row — so this check was blind to exactly the class section 7c
  -- argues is the decisive one. Caught by adversarial review, 2026-08-02.
  --
  -- defaclobjtype is "char", not text: concatenating it without a cast makes
  -- `||` ambiguous ("operator is not unique: text || char") on PostgreSQL 17.
  SELECT string_agg(pg_get_userbyid(d.defaclrole) || '/' ||
                    CASE WHEN d.defaclnamespace = 0 THEN 'GLOBAL' ELSE n.nspname END || '/' ||
                    d.defaclobjtype::text || '/' ||
                    COALESCE(pg_get_userbyid(a.grantee),'PUBLIC') ||
                    '/' || a.privilege_type, ', ')
    INTO problem
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
  LATERAL aclexplode(d.defaclacl) a
  WHERE (d.defaclnamespace = 0 OR n.nspname = 'public')
    AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: unsafe default privilege(s) remain (scope GLOBAL means defaclnamespace = 0, which applies to every schema): %', problem;
  END IF;

  -- The four GLOBAL suppression rows must exist. Asserting their presence is
  -- not enough on its own — a schema-scoped row would also be "present" while
  -- having no effect — so defaclnamespace = 0 is checked explicitly, and
  -- 9.11b proves the behaviour rather than the row.
  SELECT string_agg(v.rolname || '/' || v.objtype, ', ') INTO problem
  FROM (VALUES
    ('uellix_owner','f'), ('uellix_owner','T'),
    ('uellix_migrator','f'), ('uellix_migrator','T')
  ) AS v(rolname, objtype)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole = v.rolname::regrole
      AND d.defaclnamespace = 0
      AND d.defaclobjtype = v.objtype::"char"
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: global PUBLIC-suppression default privilege missing for %. A SCHEMA-SCOPED entry does not work here: it is merged on top of acldefault() and can only ADD privileges', problem;
  END IF;

  -- 9.11b Behavioural proof: create a function, a type and a table as
  -- uellix_owner and confirm nobody else is reached. This asserts the EFFECT
  -- rather than the catalog row, which is the whole lesson of section 7c — the
  -- wrong form of the statement leaves a row that looks plausible and does
  -- nothing. Each probe object is dropped again immediately, and the script's
  -- own transaction would discard it in any case.
  SET LOCAL ROLE uellix_owner;
  EXECUTE 'CREATE FUNCTION public.zz_stella_0004_probe() RETURNS int LANGUAGE sql AS ''SELECT 1''';
  EXECUTE 'CREATE TYPE public.zz_stella_0004_probe_t AS ENUM (''a'')';
  EXECUTE 'CREATE TABLE public.zz_stella_0004_probe_tbl (id int)';

  IF has_function_privilege('public', 'public.zz_stella_0004_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a function created by uellix_owner is still EXECUTE-able by PUBLIC';
  END IF;
  IF has_type_privilege('public', 'public.zz_stella_0004_probe_t', 'USAGE') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a type created by uellix_owner is still USAGE-able by PUBLIC';
  END IF;

  SELECT string_agg(COALESCE(pg_get_userbyid(a.grantee),'PUBLIC') || ':' || a.privilege_type, ', ')
    INTO problem
  FROM pg_class c,
  LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = 'public.zz_stella_0004_probe_tbl'::regclass
    AND a.grantee <> 'uellix_owner'::regrole::oid;

  EXECUTE 'DROP TABLE public.zz_stella_0004_probe_tbl';
  EXECUTE 'DROP TYPE public.zz_stella_0004_probe_t';
  EXECUTE 'DROP FUNCTION public.zz_stella_0004_probe()';
  RESET ROLE;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a table created by uellix_owner is born with third-party grants: %', problem;
  END IF;

  -- 9.13 The USAGE granted on schema `auth` must be exactly that: no Uellix
  -- role may hold a privilege on any object inside a Supabase-internal schema.
  SELECT string_agg(n.nspname || '.' || c.relname || ':' ||
                    COALESCE(pg_get_userbyid(a.grantee),'PUBLIC') || ':' || a.privilege_type, ', ')
    INTO problem
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace,
  LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE n.nspname NOT IN ('public','pg_toast')
    AND c.relkind IN ('r','p','v','m','S')
    AND a.grantee IN ('uellix_owner'::regrole::oid, 'uellix_migrator'::regrole::oid,
                      'uellix_app'::regrole::oid, 'uellix_writer'::regrole::oid,
                      'uellix_auditor'::regrole::oid);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a Uellix role holds a privilege on a Supabase-internal object: %', problem;
  END IF;

  SELECT string_agg(n.nspname || ':' || COALESCE(pg_get_userbyid(a.grantee),'PUBLIC') || ':' || a.privilege_type, ', ')
    INTO problem
  FROM pg_namespace n,
  LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
  WHERE n.nspname NOT IN ('public')
    AND a.grantee IN ('uellix_owner'::regrole::oid, 'uellix_migrator'::regrole::oid,
                      'uellix_app'::regrole::oid, 'uellix_writer'::regrole::oid,
                      'uellix_auditor'::regrole::oid)
    AND NOT (n.nspname = 'auth' AND a.grantee = 'uellix_owner'::regrole::oid AND a.privilege_type = 'USAGE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a Uellix role holds a schema privilege beyond the single documented USAGE on auth: %', problem;
  END IF;

  -- The ACL-entry scan above cannot see a privilege that arrives via PUBLIC or
  -- via membership, so the EFFECTIVE answer is asserted separately for the one
  -- table that would matter most. has_*_privilege is the right tool here
  -- precisely because it folds every path into one boolean: the claim being
  -- made is "cannot read it, by any route", not "holds no direct grant".
  IF has_table_privilege('uellix_owner', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_app', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_writer', 'auth.users', 'SELECT')
     OR has_table_privilege('uellix_auditor', 'auth.users', 'SELECT') THEN
    RAISE EXCEPTION 'stella_0004 FAILED: a Uellix role can read auth.users. The USAGE on schema auth exists so that auth.uid() resolves, not to expose the identity store';
  END IF;

  -- 9.13b Behavioural proof that the RLS helpers actually run under the new
  -- owner. A catalog check cannot see the schema-lookup failure that the
  -- ownership transfer introduces.
  BEGIN
    SET LOCAL ROLE uellix_writer;
    PERFORM public.current_user_org_ids();
    PERFORM public.current_user_is_super_admin();
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION 'stella_0004 FAILED: the SECURITY DEFINER RLS helpers do not execute under the new owner (%). Every policy that calls them would error rather than filter', SQLERRM;
  END;

  -- 9.12 Nothing structural moved.
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) <> 38
     OR (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') <> 104
     OR (SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT g.tgisinternal) <> 10
     OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity) <> 0 THEN
    RAISE EXCEPTION 'stella_0004 FAILED: structural drift — tables/policies/triggers/RLS no longer match the 38/104/10/0 fingerprint';
  END IF;

  -- Every trigger must still be enabled in origin mode.
  SELECT string_agg(c.relname || '.' || g.tgname, ', ') INTO problem
  FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT g.tgisinternal AND g.tgenabled <> 'O';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 FAILED: trigger(s) not enabled in origin mode: %', problem;
  END IF;

  -- Deliberately precise about SCOPE. An earlier version said "anon and PUBLIC
  -- hold nothing" and "default privileges clean", both of which were true only
  -- of tables and of schema-scoped entries respectively — the kind of summary
  -- that reads as a broader guarantee than it verified.
  RAISE NOTICE 'stella_0004: verification passed — 38 tables and 8 functions in public owned by uellix_owner; 5 roles; exactly 3 memberships; no non-owner holds TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on any of the 38; anon and PUBLIC hold no table privilege and no EXECUTE in public; no default privilege (schema-scoped OR global) reaches anon/authenticated/service_role/PUBLIC; a future table, function and type created by uellix_owner reach nobody else; 104 policies, 10 triggers and RLS on 38/38 untouched.';
END $$;
