-- ============================================================================
-- stella_hosted_0002_prechain_authority_reconciliation.sql
-- COMMIT 5.2 — the forward-only vehicle that carries an ALREADY-BOOTSTRAPPED
-- managed project to the prechain state Commit 5.1 certified on PG 17.6.
-- ============================================================================
--
-- WHY THIS EXISTS INSTEAD OF RE-RUNNING stella_hosted_0001
--
-- REPRODUCED on public.ecr.aws/supabase/postgres:17.6.1.143, against a database
-- shaped exactly like the measured staging project:
--
--   psql:<stdin>:175: ERROR:  must be owner of schema uellix_bootstrap
--
-- stella_hosted_0001 section 5 ends with ALTER SCHEMA uellix_bootstrap OWNER TO
-- uellix_owner. From the second apply onwards `postgres` no longer owns the
-- schema, and SEVENTEEN statements of that package require exactly that
-- ownership. It fails at its first COMMENT ON SCHEMA — before reconciling
-- anything at all.
--
-- That defect was recorded and deferred in
-- docs/ops/staging/STELLA_HOSTED_FORWARD_ONLY_CONTRACT.md section 9, on the
-- premise that it "no bloquea la cadena actual ni el retry futuro de T1". The
-- premise expired: the Commit 5.1 prechain remediation IS a second apply.
--
-- Rather than make the bootstrap generally re-runnable — which would mean
-- re-deriving, for every one of its statements, whether replaying it against a
-- project in an unknown state is safe — this package does one thing, once,
-- forward-only. stella_hosted_0001 remains the FIRST-PROVISION bootstrap,
-- unchanged, and its second pass stays PROHIBITED.
--
-- ----------------------------------------------------------------------------
-- WHAT IT DELIVERS, AND WHAT IT REFUSES TO GUESS
--   E-02  uellix_migrator holds CREATEROLE, plus the database-level and
--         visibility prerequisites its own preconditions need. It is the
--         HOSTED_INSTALLER: the chain names it in every elevation it emits.
--   E-01  uellix_owner holds exactly the twelve prerequisite privileges the
--         governed chain re-grants or references, over the eight objects the
--         authority plan derives — and nothing else.
--   E-04  uellix_bootstrap carries the capability-topology assertion the five
--         restating packages call, and assert_hosted_capabilities is replaced
--         by the certified body (which also closes E-03).
--
-- It creates NO capability role. T1, T4 and T5 do that, and a database that
-- already has one is not the database this package is for.
--
-- Section 0 refuses on ANY material difference from the measured source state.
-- Nothing below is conditional on a guess.
--
-- ----------------------------------------------------------------------------
-- APPLICATION
--   psql "<staging>" -1 -v ON_ERROR_STOP=1 \
--        -c "SET uellix.bootstrap_environment = 'staging'" \
--        -f db/prepared/stella_hosted_0002_prechain_authority_reconciliation.sql
--
-- ONE package, ONE transaction. It is NOT T1 and must never be combined with
-- it: the operator boundary between them is where a fresh observation and the
-- prechain authority gate go.
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Source state — refuse on any material difference
-- Every value asserted below was MEASURED on the staging project by a read-only
-- observation. A project that differs is a project this package was not
-- designed against, and the honest response is to stop before touching it.
DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_wrong   text;
BEGIN
  -- (S0) The operator must DECLARE the environment, exactly as the bootstrap
  --      demands. There is no default and no inference from a hostname.
  BEGIN
    IF current_setting('uellix.bootstrap_environment') IS DISTINCT FROM 'staging' THEN
      RAISE EXCEPTION 'stella_hosted_0002 aborted: uellix.bootstrap_environment must be exactly ''staging''. Set it in the SAME session.';
    END IF;
  EXCEPTION WHEN undefined_object THEN
    RAISE EXCEPTION 'stella_hosted_0002 aborted: uellix.bootstrap_environment is unset. An unset environment is an ambiguous environment, and this package refuses those.';
  END;

  -- (S1) stella_hosted_0001 must ALREADY have run. This package reconciles a
  --      bootstrapped project; it does not bootstrap one and does not replace
  --      the bootstrap for a fresh target.
  IF pg_catalog.to_regnamespace('uellix_bootstrap') IS NULL
     OR pg_catalog.to_regprocedure('uellix_bootstrap.assert_hosted_capabilities(text)') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0002 aborted: uellix_bootstrap is absent — apply stella_hosted_0001 first. A fresh target gets the bootstrap, which already carries everything below.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM uellix_bootstrap.staging_sentinel WHERE environment = 'staging') THEN
    RAISE EXCEPTION 'stella_hosted_0002 aborted: no uellix_bootstrap.staging_sentinel row declaring environment=staging.';
  END IF;

  -- (S2) The five separated roles exist, and uellix_migrator is the LOGIN role
  --      the governed chain names in every elevation it emits.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_wrong
  FROM (VALUES ('uellix_owner'), ('uellix_migrator'), ('uellix_app'),
               ('uellix_writer'), ('uellix_auditor')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0002 aborted: role(s) % absent. The bootstrap has not run, or has been partially undone.', v_wrong;
  END IF;

  IF NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_migrator') THEN
    RAISE EXCEPTION 'stella_hosted_0002 aborted: uellix_migrator cannot log in. The governed chain is applied AS it.';
  END IF;

  -- (S3) THE AUTHORITY THIS SESSION MUST ACTUALLY HAVE. Four distinct
  --      capabilities, named separately, because a refusal that says which one
  --      is missing is a refusal an operator can act on.
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    v_missing := array_append(v_missing, 'CREATEROLE for ' || current_user);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members am
    JOIN pg_roles r ON r.oid = am.roleid
    JOIN pg_roles m ON m.oid = am.member
    WHERE r.rolname = 'uellix_migrator' AND m.rolname = current_user AND am.admin_option
  ) THEN
    v_missing := array_append(v_missing, 'ADMIN OPTION on uellix_migrator (needed to set CREATEROLE on it)');
  END IF;

  IF NOT pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET') THEN
    v_missing := array_append(v_missing, 'the right to SET ROLE uellix_owner (needed for the owner phase)');
  END IF;

  IF NOT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') THEN
    v_missing := array_append(v_missing, 'CREATE ON DATABASE ' || current_database() || ' (needed to grant it onward)');
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0002 aborted: the current identity (%) lacks: %. This package performs each operation as the principal that actually holds the authority for it; it cannot substitute one for another.',
      current_user, array_to_string(v_missing, ', ');
  END IF;

  -- (S4) THE E-01 OWNERSHIP SHAPE. Eight objects: seven owned by this session,
  --      the ledger by uellix_owner. A THIRD owner REFUSES — this package
  --      grants on what the installer owns and stands in as uellix_owner for
  --      what uellix_owner owns, and it has no third authority to reach
  --      anything else.
  SELECT string_agg(t.object || ' (owned by ' || t.owner || ', expected ' || t.expected || ')', ', ' ORDER BY t.object)
    INTO v_wrong
  FROM (
    SELECT 'public.current_user_org_ids()'::text AS object, pg_get_userbyid(p.proowner) AS owner, current_user::text AS expected FROM pg_proc p WHERE p.oid = to_regprocedure('public.current_user_org_ids()')
    UNION ALL
    SELECT 'public.current_user_is_super_admin()'::text, pg_get_userbyid(p.proowner), current_user::text FROM pg_proc p WHERE p.oid = to_regprocedure('public.current_user_is_super_admin()')
    UNION ALL
    SELECT 'public.uellix_forbid_mutation()'::text, pg_get_userbyid(p.proowner), current_user::text FROM pg_proc p WHERE p.oid = to_regprocedure('public.uellix_forbid_mutation()')
    UNION ALL
    SELECT 'public.uellix_auth_uid()'::text, pg_get_userbyid(p.proowner), current_user::text FROM pg_proc p WHERE p.oid = to_regprocedure('public.uellix_auth_uid()')
    UNION ALL
    SELECT 'public.organizations'::text, pg_get_userbyid(c.relowner), current_user::text FROM pg_class c WHERE c.oid = to_regclass('public.organizations')
    UNION ALL
    SELECT 'public.projects'::text, pg_get_userbyid(c.relowner), current_user::text FROM pg_class c WHERE c.oid = to_regclass('public.projects')
    UNION ALL
    SELECT 'public.evidence_items'::text, pg_get_userbyid(c.relowner), current_user::text FROM pg_class c WHERE c.oid = to_regclass('public.evidence_items')
    UNION ALL
    SELECT 'public.users'::text, pg_get_userbyid(c.relowner), current_user::text FROM pg_class c WHERE c.oid = to_regclass('public.users')
    UNION ALL
    SELECT 'public.stella_interactions'::text, pg_get_userbyid(c.relowner), 'uellix_owner'::text FROM pg_class c WHERE c.oid = to_regclass('public.stella_interactions')
  ) AS t
  WHERE t.owner <> t.expected;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0002 aborted: the prechain ownership shape is not the one measured on staging: %. The governed chain runs twelve statements against these objects as uellix_owner; this package can only grant on what the installer owns and stand in as uellix_owner for what uellix_owner owns. A third owner is an authority nobody here has.',
      v_wrong;
  END IF;

  -- (S5) CAPABILITY ROLES ABSENT. T1, T4 and T5 create them. A database that
  --      already has one has run part of the chain, and reconciling its
  --      PRECHAIN authority is not a well-posed operation.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO v_wrong
  FROM pg_roles
  WHERE rolname IN ('uellix_cap_grounding', 'uellix_cap_stella_quota', 'uellix_cap_stella_ticket');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0002 aborted: capability role(s) % already exist. This package reconciles the state BEFORE T1; what happens to a project that has already run part of the chain is governed by the forward-only contract, not by this package.',
      v_wrong;
  END IF;

  -- (S6) FORWARD-ONLY, asserted against its own witness. Re-applying a
  --      remediation over its own result is the one thing a one-shot package
  --      must refuse, and refusing it here costs a single catalogue lookup.
  IF pg_catalog.to_regprocedure('uellix_bootstrap.assert_capability_membership_topology(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_hosted_0002 aborted: uellix_bootstrap.assert_capability_membership_topology already exists, so this remediation has already been applied. It is FORWARD-ONLY: an installed package is never written again. Take a fresh observation and consult the prechain authority gate.';
  END IF;

  RAISE NOTICE 'stella_hosted_0002: source state accepted — bootstrapped project, installer %, seven baseline objects owned by it, ledger owned by uellix_owner, no capability role.', current_user;
END $$;

-- ============================================================
-- 1. POSTGRES PHASE — only what this session has authority for
-- E-02. The installer attribute, and ONLY it. uellix_migrator stays
-- NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and NOREPLICATION, and its LOGIN and
-- INHERIT are left exactly as measured. On PostgreSQL 16+ CREATEROLE
-- administers only the roles its holder creates and cannot confer SUPERUSER:
-- what it buys here is the three capability roles T1/T4/T5 create, and nothing
-- else. Section 0 (S3) proved this session holds ADMIN OPTION on the role.
ALTER ROLE uellix_migrator WITH CREATEROLE;

-- Six packages open with CREATE SCHEMA <x> AUTHORIZATION uellix_owner. The
-- schema is authorized TO the owner but created BY the installer, and
-- PostgreSQL checks CREATE on the DATABASE for that, not on any schema.
GRANT CREATE ON DATABASE postgres TO uellix_migrator;

-- E-01. The prerequisite privileges on the seven objects this session owns,
-- WITH GRANT OPTION on everything the chain RE-GRANTS. Holding a privilege is
-- not the same as being able to pass it on, and that distinction is exactly
-- what PostgreSQL 17.6 refused at T1 line 278. REFERENCES is needed by
-- uellix_owner itself and is never passed on; the option is harmless there.
--
-- LITERAL, one statement per object: tests/prepared-stella-sql.test.ts refuses
-- anything dynamically EXECUTEd in a prepared package, because a static
-- contract can read these lines and cannot read a loop.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids() TO uellix_owner WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_owner WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.uellix_forbid_mutation() TO uellix_owner WITH GRANT OPTION;
GRANT SELECT, REFERENCES ON TABLE public.organizations TO uellix_owner WITH GRANT OPTION;
GRANT SELECT, REFERENCES ON TABLE public.projects TO uellix_owner WITH GRANT OPTION;
GRANT SELECT, REFERENCES ON TABLE public.evidence_items TO uellix_owner WITH GRANT OPTION;
GRANT REFERENCES ON TABLE public.users TO uellix_owner WITH GRANT OPTION;

-- The auth shim. Rewrite rule `auth-schema-grant` replaces each package's
-- GRANT EXECUTE ON FUNCTION auth.uid() TO <capability> with the same grant over
-- this shim, and that statement is INSTALLER-class. A grantor must hold the
-- grant option to issue it.
GRANT EXECUTE ON FUNCTION public.uellix_auth_uid() TO uellix_migrator WITH GRANT OPTION;

-- The installer's own SELECT — not to read data, but so its PRECONDITIONS can
-- see what they check. MEASURED, PG 17.6: information_schema.columns is
-- FILTERED BY PRIVILEGE, so a column is invisible to a role holding none on its
-- table, and stella_0013 is told public.organizations.stella_monthly_quota is
-- ABSENT — a false negative indistinguishable from a missing migration. It
-- widens nothing: uellix_migrator can already read any of these by announcing
-- itself as uellix_owner.
GRANT SELECT ON TABLE public.organizations TO uellix_migrator;
GRANT SELECT ON TABLE public.projects TO uellix_migrator;
GRANT SELECT ON TABLE public.evidence_items TO uellix_migrator;
GRANT SELECT ON TABLE public.users TO uellix_migrator;

-- ============================================================
-- 2. OWNER PHASE — what only uellix_owner has authority for
-- ============================================================
-- Everything below belongs to uellix_owner: schema uellix_bootstrap (handed
-- over by stella_hosted_0001 section 5) and the ledger (section 2c). This
-- session cannot mutate them directly — that is the very failure this package
-- exists to route around — and section 0 (S3) proved it can BECOME the role
-- that can. ONE elevation, explicit, closed before commit. No nesting:
-- PostgreSQL does not stack SET ROLE (lab M6).
SET ROLE uellix_owner;

-- The ledger's SELECT for the installer, for the same information_schema
-- reason as above: without it T8's precondition reports idempotency_key ABSENT.
GRANT SELECT ON TABLE public.stella_interactions TO uellix_migrator;

-- E-04. The capability-topology assertion the five restating packages call.
-- The zero-member postcondition they carried is unsatisfiable under RR-02: a
-- NOSUPERUSER CREATEROLE role that creates another role receives the membership
-- automatically. MEASURED on 17.6 with createrole_self_grant empty, that row
-- carries ADMIN and neither INHERIT nor SET, and pg_has_role(installer,
-- capability, 'SET') is FALSE — the property the count protected holds while
-- the count itself can never pass.
--
-- BODY IDENTICAL to stella_hosted_0001 section 5e, lifted rather than
-- transcribed. A permanent test asserts the two are byte-equal, so an edit to
-- one that misses the other cannot ship.
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
  'Train 5B / Commit 5.1, delivered to an already-bootstrapped project by stella_hosted_0002: replaces the unsatisfiable "zero members" postcondition. RR-02 makes a member unavoidable for a managed installer; this asserts the topology and the reachability that rule was actually protecting.';

-- REVOKE BEFORE GRANT, naming the three principals explicitly. MEASURED on
-- managed Supabase (S1-DEFECT-002): ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE
-- ON FUNCTIONS writes DIRECT acl entries at CREATE time, so a function is born
-- executable by anon / authenticated / service_role and a bare
-- REVOKE ... FROM PUBLIC does not touch them.
--
-- STILL INSIDE THE OWNER PHASE. These act on the function this phase just
-- created, and both statements need USAGE on uellix_bootstrap as well as
-- ownership of the object — uellix_owner has both, this session has neither.
REVOKE ALL ON FUNCTION uellix_bootstrap.assert_capability_membership_topology(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION uellix_bootstrap.assert_capability_membership_topology(text, text)
  TO uellix_migrator;


-- ============================================================
-- 2c. The one privilege this package borrows, and gives back
-- MEASURED, and it is the sharpest edge in this package: replacing
-- uellix_bootstrap.assert_hosted_capabilities requires BOTH
--
--   ownership OF THE FUNCTION  — held by this session, which created it; and
--   USAGE ON THE SCHEMA        — held by uellix_owner, which was handed the
--                                schema by stella_hosted_0001 section 5.
--
-- No principal on a bootstrapped project holds both. `CREATE OR REPLACE` as
-- uellix_owner answers `must be owner of function assert_hosted_capabilities`;
-- as this session it answers `permission denied for schema uellix_bootstrap`.
-- That is the same handover that makes the bootstrap unrunnable twice, met
-- from the other side.
--
-- So the owner LENDS the schema's USAGE for exactly one statement, and takes it
-- back in section 5 before commit. The alternative — leaving the grant in place
-- — would put the remediated project in a state the certification never
-- produced, which is the one outcome this whole package exists to avoid.
-- USAGE **and CREATE**: measured, PG 17.6 checks CREATE on the schema even for
-- a CREATE OR REPLACE that only replaces. USAGE alone still answers
-- `permission denied for schema uellix_bootstrap`.
GRANT USAGE, CREATE ON SCHEMA uellix_bootstrap TO postgres;


RESET ROLE;

-- ============================================================
-- 3. POSTGRES PHASE (2) — what only the function's owner may do
-- E-03 and the corrected capability contract. On an already-bootstrapped
-- project the body in place is the ORIGINAL one: it appends to a text[] with
-- `||` (which resolves as anyarray||anyarray and masks EVERY refusal as
-- `malformed array literal`), it asks for CREATE on schemas against
-- current_user rather than against the role that actually creates in them, and
-- it does not check CREATE on the database at all.
--
-- Replaced HERE, in the postgres phase, because CREATE OR REPLACE of an EXISTING
-- function requires ownership OF THE FUNCTION — which this session has and
-- uellix_owner does not. MEASURED: attempting it from inside the owner phase
-- answers `must be owner of function assert_hosted_capabilities`. Ownership of
-- the SCHEMA is what the new function below needs, and that is the other way
-- round. BODY IDENTICAL to stella_hosted_0001 section 5, same
-- test, same reason.
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

-- NO COMMENT ON is issued for this function, and the omission is deliberate.
-- COMMENT requires USAGE on the containing schema as well as ownership of the
-- object. uellix_bootstrap belongs to uellix_owner while this function belongs
-- to this session, so the two authorities sit on opposite sides and no single
-- principal holds both. MEASURED: `permission denied for schema
-- uellix_bootstrap`.
--
-- Granting this session USAGE to fix a COMMENT would leave the remediated
-- project in a state the certification never produced, in order to change a
-- string nothing reads. The BODY is what matters and it is now the certified
-- one; the comment still describes the bootstrap that first installed it.


-- ============================================================
-- 4. Give the borrowed privilege back, before commit
-- The schema returns to exactly the ACL the certification produced: USAGE for
-- uellix_migrator, uellix_app and uellix_auditor, and for nobody else. Section
-- 5 check (7) reads the catalogue to prove it.
SET ROLE uellix_owner;
REVOKE USAGE, CREATE ON SCHEMA uellix_bootstrap FROM postgres;
RESET ROLE;

-- ============================================================
-- 5. Self-verification — assert the end state, in this transaction
-- Every check reads the CATALOG. A package that verified itself from the
-- variables it had just set would be asserting its own intentions.
DO $$
DECLARE
  v_problem text;
BEGIN
  -- (1) The installer contract, exactly, including what must NOT have moved.
  SELECT string_agg(x.what, ', ' ORDER BY x.what) INTO v_problem
  FROM (
    SELECT 'uellix_migrator lacks CREATEROLE'::text AS what WHERE NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = 'uellix_migrator')
    UNION ALL
    SELECT 'uellix_migrator cannot log in' WHERE NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_migrator')
    UNION ALL
    SELECT 'uellix_migrator holds a dangerous attribute' WHERE (SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname = 'uellix_migrator')
    UNION ALL
    SELECT 'uellix_migrator cannot SET ROLE uellix_owner' WHERE NOT pg_catalog.pg_has_role('uellix_migrator', 'uellix_owner', 'SET')
    UNION ALL
    SELECT 'uellix_migrator lacks CREATE on the database' WHERE NOT pg_catalog.has_database_privilege('uellix_migrator', current_database(), 'CREATE')
  ) AS x;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0002 FAILED verification: %.', v_problem;
  END IF;

  -- (2) The E-01 privileges, INCLUDING the grant option — the whole
  --     distinction the engine refused on.
  SELECT string_agg(x.what, ', ' ORDER BY x.what) INTO v_problem
  FROM (
    SELECT 'uellix_owner lacks EXECUTE WITH GRANT OPTION on current_user_org_ids'::text AS what WHERE NOT has_function_privilege('uellix_owner', 'public.current_user_org_ids()', 'EXECUTE WITH GRANT OPTION')
    UNION ALL
    SELECT 'uellix_owner lacks EXECUTE WITH GRANT OPTION on current_user_is_super_admin' WHERE NOT has_function_privilege('uellix_owner', 'public.current_user_is_super_admin()', 'EXECUTE WITH GRANT OPTION')
    UNION ALL
    SELECT 'uellix_owner lacks EXECUTE on uellix_forbid_mutation' WHERE NOT has_function_privilege('uellix_owner', 'public.uellix_forbid_mutation()', 'EXECUTE')
    UNION ALL
    SELECT 'uellix_owner lacks REFERENCES on organizations' WHERE NOT has_table_privilege('uellix_owner', 'public.organizations', 'REFERENCES')
    UNION ALL
    SELECT 'uellix_owner lacks REFERENCES on projects' WHERE NOT has_table_privilege('uellix_owner', 'public.projects', 'REFERENCES')
    UNION ALL
    SELECT 'uellix_owner lacks REFERENCES on evidence_items' WHERE NOT has_table_privilege('uellix_owner', 'public.evidence_items', 'REFERENCES')
    UNION ALL
    SELECT 'uellix_owner lacks REFERENCES on users' WHERE NOT has_table_privilege('uellix_owner', 'public.users', 'REFERENCES')
    UNION ALL
    SELECT 'uellix_owner lacks SELECT WITH GRANT OPTION on organizations' WHERE NOT has_table_privilege('uellix_owner', 'public.organizations', 'SELECT WITH GRANT OPTION')
    UNION ALL
    SELECT 'uellix_migrator lacks EXECUTE WITH GRANT OPTION on uellix_auth_uid' WHERE NOT has_function_privilege('uellix_migrator', 'public.uellix_auth_uid()', 'EXECUTE WITH GRANT OPTION')
    UNION ALL
    SELECT 'uellix_migrator cannot see public.organizations' WHERE NOT has_table_privilege('uellix_migrator', 'public.organizations', 'SELECT')
    UNION ALL
    SELECT 'uellix_migrator cannot see public.stella_interactions' WHERE NOT has_table_privilege('uellix_migrator', 'public.stella_interactions', 'SELECT')
  ) AS x;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0002 FAILED verification: %.', v_problem;
  END IF;

  -- (3) NO capability role was created. This package must not anticipate T1.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO v_problem
  FROM pg_roles WHERE rolname IN ('uellix_cap_grounding', 'uellix_cap_stella_quota', 'uellix_cap_stella_ticket');

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0002 FAILED verification: capability role(s) % exist. This package creates none; T1, T4 and T5 do.', v_problem;
  END IF;

  -- (4) Ownership did not move. A remediation that transferred ownership "for
  --     convenience" would be a far larger authority change than the one
  --     reviewed, and it would do it silently.
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.stella_interactions'::regclass) <> 'uellix_owner'
     OR (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.organizations'::regclass) <> session_user THEN
    RAISE EXCEPTION 'stella_hosted_0002 FAILED verification: ownership moved. This package grants privileges; it transfers nothing.';
  END IF;

  -- (5) The session is not left elevated. A package that committed while still
  --     acting as uellix_owner would leave the operator holding authority
  --     nobody closed.
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'stella_hosted_0002 FAILED verification: the session is still acting as %. The owner phase must close before commit.', current_user;
  END IF;

  -- (6) The witness this package is identified by.
  IF pg_catalog.to_regprocedure('uellix_bootstrap.assert_capability_membership_topology(text,text)') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0002 FAILED verification: the topology assertion was not installed.';
  END IF;

  RAISE NOTICE 'stella_hosted_0002: verification passed — the installer holds CREATEROLE and its database and visibility prerequisites, uellix_owner holds the E-01 privileges with the grant options the chain re-grants, the capability topology assertion is installed and callable by the installer alone, no capability role exists, and no ownership moved.';
END $$;
