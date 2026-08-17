-- ============================================================================
-- stella_hosted_0006_runtime_rls_helper_contract.sql
-- The runtime half of the cutover, which the hosted path never received.
-- ============================================================================
--
-- PREPARED ONLY — NOT A MIGRATION. FORWARD-ONLY: no rollback file, typed in
-- db/hosted/forward-only-packages.ts. The asymmetry is argued at the bottom of
-- this header and is the whole reason the file is absent rather than empty.
--
-- PRECHAIN ADMINISTRATIVE UNIT. NOT a member of HOSTED_CHAIN.
--
-- ----------------------------------------------------------------------------
-- WHAT BROKE
-- ----------------------------------------------------------------------------
-- Measured on the hosted staging project, 2026-08-16, through the deployed
-- application: every authenticated request answers
--
--     42501  permission denied for function current_user_is_super_admin
--
-- raised by the check query in db/identity-context.ts, which runs inside
-- withDatabaseIdentityContext() before any business statement. The runtime is
-- `uellix_app`; the ACL of the three RLS helpers is
--
--     current_user_is_super_admin()      authenticated, postgres, uellix_owner*
--     current_user_org_ids()             authenticated, postgres, uellix_owner*
--     current_user_role_in_org(uuid)     authenticated, postgres
--                                          (* WITH GRANT OPTION)
--
-- and no runtime principal appears anywhere in it.
--
-- ----------------------------------------------------------------------------
-- WHY THE HOSTED PATH NEVER GOT IT, WHICH IS NOT AN OVERSIGHT
-- ----------------------------------------------------------------------------
-- The runtime cutover is expressed in this repository as a PAIR of prepared
-- packages, and both are local-only:
--
--   stella_0004_role_separation.sql §6b   GRANT EXECUTE ON the three helpers
--                                         TO uellix_writer, uellix_auditor
--   stella_0005_runtime_cutover.sql       CREATE OR REPLACE of the three, with
--     lines 262-297                       SET search_path = '' and public.*
--                                         fully qualified
--
-- Neither is in db/hosted/hosted-package-manifest.ts or in
-- db/hosted/baseline-manifest.ts, and stella_0004 CANNOT be: its §4 transfers
-- 38 tables and 8 functions to uellix_owner, and moving the RLS helpers to a
-- role that cannot receive USAGE on schema `auth` would break every policy in
-- the product. stella_hosted_0001 §5d says so in its own words and substitutes
-- a NARROW privilege grant instead.
--
-- That substitution is correct and its SCOPE is what this package repairs. The
-- object set of §5d is derived by db/hosted/authority/certification/
-- prechain-requirements.ts, which walks the CHAIN's authority plan — "every
-- object a non-installer EXECUTOR touches that the chain does not itself
-- create". The executor it models is `uellix_owner`, the installer. The
-- application runtime was never in that derivation, so what hosted staging runs
-- today is the PRE-cutover helper contract:
--
--   0031_rls_core.sql   creates the three with search_path=public and
--                       unqualified relation references
--   0033_public_api_grants.sql   revokes EXECUTE on every public function
--   0039_grant_rls_helper_execution.sql   restores it — to `authenticated`, and
--                       to nobody else. `authenticated` is the PostgREST role;
--                       it was the whole answer to "who evaluates RLS" before
--                       the cutover, and it is not the answer afterwards.
--
-- ----------------------------------------------------------------------------
-- WHY THE GRANT CANNOT SHIP WITHOUT THE HARDENING
-- ----------------------------------------------------------------------------
-- The hosted bodies are SECURITY DEFINER, owned by `postgres` — a SUPERUSER —
-- with `search_path=public` and UNQUALIFIED relation references (`FROM users`,
-- `FROM organization_members`). PostgreSQL searches `pg_temp` before any schema
-- named in search_path, and every role holds TEMP on the database by default.
--
-- REPRODUCED on PostgreSQL 17.10, against a function byte-identical in shape to
-- the hosted one:
--
--     CREATE TEMP TABLE users (id uuid PRIMARY KEY, is_super_admin bool
--                              NOT NULL DEFAULT true);
--     INSERT INTO pg_temp.users VALUES ('<the caller''s own sub>', true);
--     SELECT public.current_user_is_super_admin();   -->  true
--
-- The same probe against the hardened body answers false. That function is the
-- super-admin disjunct of 89 policies, and it executes as a superuser, so the
-- shadowed read is not merely a wrong answer — it is a wrong answer computed
-- with superuser privileges.
--
-- `authenticated` already holds EXECUTE, so the primitive is present on any
-- environment that installed 0031+0039 without stella_0005. Practical
-- reachability for `authenticated` is low (PostgREST exposes no DDL), and this
-- package does not depend on that judgement: granting EXECUTE to the runtime
-- principal would hand the primitive to a role that unquestionably CAN issue
-- CREATE TEMP TABLE. So the two halves ship together or not at all.
--
-- WHY `SET search_path = ''` AND NOT MERELY QUALIFIED NAMES. Measured, PG 17.10,
-- all four combinations: qualification ALONE already defeats the shadow, and so
-- does `pg_catalog, pg_temp`. The empty path is chosen because it is the only
-- one of the three that makes the defect UNWRITABLE — these are LANGUAGE sql
-- functions, parsed at CREATE time, so an unqualified reference under
-- `search_path = ''` fails to create at all:
--
--     ERROR:  relation "users" does not exist
--
-- The second layer is not redundant with the first; it prevents a future editor
-- from removing the first. It is also the form stella_0005_runtime_cutover.sql
-- already publishes and the form db/baseline/stella_g2_schema.sql records as the
-- intended shape, so this package CONVERGES hosted to the repository's canon
-- rather than inventing a fourth spelling.
--
-- ----------------------------------------------------------------------------
-- WHY THE EXECUTOR IS THE OWNER AND NOT uellix_owner
-- ----------------------------------------------------------------------------
-- `CREATE OR REPLACE FUNCTION` requires ownership; no GRANT can confer it. The
-- hosted helpers are owned by `postgres`, so `postgres` is the executor — and as
-- owner it can also issue the EXECUTE grants directly, which dissolves a problem
-- rather than solving it: uellix_owner holds WITH GRANT OPTION on two of the
-- three helpers and NOTHING AT ALL on current_user_role_in_org(uuid), so a
-- governed T12 running as uellix_owner could not have issued the third grant.
-- No authority is escalated for uellix_owner, no owner is changed, and no
-- governed link is added.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS PACKAGE DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It grants nothing to `uellix_app`. The runtime reaches these functions
--     through `GRANT uellix_writer TO uellix_app WITH INHERIT TRUE` — issued by
--     stella_hosted_0001 §3 — and §2 asserts the EFFECTIVE privilege separately
--     from the grant, because asserting only the grant would pass on a database
--     where that membership had been dropped.
--   * It grants no USAGE on schema `auth`, and rewrites no policy. Measured on
--     PG 17.10: EXECUTE on a function is re-checked at EXECUTION, so a policy
--     whose predicate calls a helper the invoker cannot execute fails; schema
--     USAGE is checked at NAME RESOLUTION, and a stored policy holds an already
--     resolved OID, so the nine baseline policies that call `auth.uid()`
--     directly keep working for a role that has no USAGE on `auth`. The
--     identity primitive is deliberately unchanged.
--   * It creates no role, no schema, no object, no policy and no membership,
--     changes no owner, and issues no REVOKE.
--
-- ----------------------------------------------------------------------------
-- WHY THERE IS NO ROLLBACK FILE, AND THE ASYMMETRY THAT FORCES IT
-- ----------------------------------------------------------------------------
-- The two halves reverse differently, and that is the point:
--
--   THE GRANT is genuinely reversible. Deliberate reversal is one
--   administrative statement by the same principal —
--     REVOKE EXECUTE ON FUNCTION public.current_user_org_ids(),
--       public.current_user_is_super_admin(),
--       public.current_user_role_in_org(uuid)
--       FROM uellix_writer, uellix_auditor;
--   taken with the consequence visible at the time: it re-opens the 42501 on
--   every authenticated request.
--
--   THE HARDENING is not. Restoring `search_path=public` with unqualified
--   references means republishing a superuser-context privilege escalation.
--   "Restore the previous body" and "republish the vulnerability" are the same
--   sentence — the identical argument grounding_0005 records.
--
-- A `_rollback.sql` that reversed both would be a script whose job is to
-- reintroduce a vulnerability, and one that reversed only the grant would be a
-- script named "rollback" that does not roll the package back. Neither is worth
-- shipping, so the reversible half is documented above as an operator statement
-- and the file is absent by declaration.
--
-- RUN AS ONE TRANSACTION, AS THE OWNING ADMINISTRATIVE IDENTITY:
--   psql "$ADMIN_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- IDEMPOTENT AND POST-STATE AWARE. It accepts a database that is already
-- hardened (re-publishing an identical body and re-granting a held privilege
-- both change nothing) and REFUSES a third state rather than normalising it, so
-- it can be pointed at an environment whose posture has not been measured yet.
-- No project reference appears anywhere in this file.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (administrative window)
-- ============================================================
DO $$
DECLARE
  v_missing  text;
  v_wrong    text;
  v_vuln     int := 0;
  v_hard     int := 0;
  v_total    int := 0;
  r          record;
BEGIN
  -- 0.1 PostgreSQL 17, the floor every package in this chain asserts. The
  --     proconfig spelling this package compares against in §2 is a PG-version
  --     dependent detail, so the barrier is stated here rather than assumed.
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'stella_hosted_0006 aborted: PostgreSQL 17 or newer is required; this server reports %.',
      current_setting('server_version');
  END IF;

  -- 0.2 The three functions, BY EXACT SIGNATURE. Named, never discovered: a
  --     package that hardened whatever it happened to find would have no
  --     contract, and `current_user_role_in_org` in particular is easy to miss
  --     because the observed 42501 names only one of the three.
  SELECT string_agg(t.sig, ', ' ORDER BY t.sig) INTO v_missing
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  WHERE to_regprocedure(t.sig) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 aborted: % does not exist. These are baseline objects created by 0031_rls_core.sql; apply the baseline units first.', v_missing;
  END IF;

  -- 0.3 SECURITY DEFINER, all three. A helper that had become SECURITY INVOKER
  --     would read under the CALLER's privileges and RLS, which changes what
  --     every policy means — a posture this package must not silently harden
  --     into looking correct.
  SELECT string_agg(t.sig, ', ' ORDER BY t.sig) INTO v_wrong
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  WHERE NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(t.sig));

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 aborted: % is not SECURITY DEFINER. This package republishes bodies and does not change that property; a database where it has changed is one nobody has explained.', v_wrong;
  END IF;

  -- 0.4 THE EXECUTOR OWNS ALL THREE. `CREATE OR REPLACE FUNCTION` requires
  --     ownership and no privilege substitutes for it, so this is the one
  --     precondition that cannot be worked around. It compares against
  --     current_user rather than against the literal `postgres`, so the package
  --     is usable on any environment whose baseline was installed by a
  --     differently-named administrative identity.
  SELECT string_agg(t.sig || ' (owned by ' || pg_catalog.pg_get_userbyid(p.proowner) || ')', ', ' ORDER BY t.sig)
    INTO v_wrong
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
  WHERE NOT pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 aborted: the current session (%) does not own %. CREATE OR REPLACE FUNCTION requires ownership; on managed Supabase apply this as the identity that owns the baseline objects.',
      current_user, v_wrong;
  END IF;

  -- 0.5 THE GRANTEES. Both must exist before a GRANT naming them can run, and
  --     naming them here turns a bare "role does not exist" three hundred lines
  --     later into a statement about which package is missing.
  SELECT string_agg(t.r, ', ' ORDER BY t.r) INTO v_missing
  FROM (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS t(r)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t.r);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 aborted: role(s) % do not exist. Apply stella_hosted_0001_managed_role_bootstrap.sql first.', v_missing;
  END IF;

  -- 0.6 THE INHERITANCE THIS PACKAGE RELIES ON, asserted and NOT created.
  --     uellix_app is deliberately never a grantee: it reaches these functions
  --     through its membership in uellix_writer, exactly as the local model
  --     does. If that membership is absent or non-inheriting, granting to the
  --     writer would satisfy every check about the writer and leave the runtime
  --     as broken as it was — a green package over a dead product.
  IF NOT pg_catalog.pg_has_role('uellix_app', 'uellix_writer', 'USAGE') THEN
    RAISE EXCEPTION 'stella_hosted_0006 aborted: uellix_app is not an inheriting member of uellix_writer, so a grant to the writer would never reach the runtime. That membership is issued by stella_hosted_0001 §3 (GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE); this package asserts it and will not stand in for it.';
  END IF;

  IF NOT (SELECT rolinherit FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_hosted_0006 aborted: uellix_app carries NOINHERIT, so membership in uellix_writer confers no privilege without an explicit SET ROLE the runtime never issues.';
  END IF;

  -- 0.7 THE THREE PRESTATES, classified per function and then required to agree.
  --
  --     VULNERABLE   search_path is not the empty path, or the body carries an
  --                  unqualified reference to one of the two relations.
  --     HARDENED     empty search_path AND no unqualified reference.
  --     UNEXPECTED   anything else — refused, never normalised.
  --
  --     PG 17 stores `SET search_path = ''` in proconfig as `search_path=""`,
  --     QUOTED. Measured, and the same trap grounding_0005 §0 records; a check
  --     that looked for the bare form would classify a hardened database as
  --     vulnerable and re-publish bodies nobody asked it to touch.
  FOR r IN
    SELECT t.sig,
           p.proconfig,
           p.prosrc,
           coalesce(
             (SELECT c FROM unnest(p.proconfig) AS c WHERE c LIKE 'search_path=%'),
             '<unset>'
           ) AS sp
    FROM (VALUES
      ('public.current_user_org_ids()'),
      ('public.current_user_is_super_admin()'),
      ('public.current_user_role_in_org(uuid)')
    ) AS t(sig)
    JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
  LOOP
    v_total := v_total + 1;
    IF r.sp IN ('search_path=""', 'search_path=')
       AND r.prosrc !~* '\mfrom\s+(users|organization_members)\M' THEN
      v_hard := v_hard + 1;
    ELSIF r.sp = 'search_path=public'
       OR r.prosrc ~* '\mfrom\s+(users|organization_members)\M' THEN
      v_vuln := v_vuln + 1;
    ELSE
      RAISE EXCEPTION 'stella_hosted_0006 aborted: % is in a state this package cannot account for (search_path is "%"). The only postures it knows are the baseline one (search_path=public with unqualified relation references) and the hardened one (empty search_path with public.* qualified). Resolve it deliberately, then re-run.',
        r.sig, r.sp;
    END IF;
  END LOOP;

  -- MIXED IS ALSO UNEXPECTED. Two hardened and one not is not "partially
  --     applied" — it is a database somebody edited by hand, and normalising it
  --     would erase the evidence of that.
  IF v_hard <> v_total AND v_vuln <> v_total THEN
    RAISE EXCEPTION 'stella_hosted_0006 aborted: the three helpers are in MIXED states (% hardened, % vulnerable, of %). This package converges all three together or none; a mixed posture was produced by something outside this repository and must be explained before it is normalised.',
      v_hard, v_vuln, v_total;
  END IF;

  PERFORM set_config('stella_hosted_0006.prestate',
    CASE WHEN v_hard = v_total THEN 'HARDENED_PRESTATE' ELSE 'VULNERABLE_PRESTATE' END, true);

  -- 0.8 CAPTURE, for §2 to compare against. Transaction-local, so a later
  --     session cannot read them and an earlier one cannot pre-seed them.
  --
  --     The ACL is captured as a per-grantee projection rather than as the raw
  --     aclitem[] text, because CREATE OR REPLACE preserves the ACL and the
  --     GRANT below adds to it: the raw text is EXPECTED to change, and the
  --     claim worth checking is that nothing OTHER than the two intended
  --     grantees moved.
  PERFORM set_config('stella_hosted_0006.foreign_acl',
    (SELECT coalesce(string_agg(
        t.sig || '|' || a.grantee::regrole::text || '|' || a.privilege_type || '|' || a.is_grantable::text,
        E'\n' ORDER BY t.sig, a.grantee::regrole::text, a.privilege_type)
      , '')
     FROM (VALUES
       ('public.current_user_org_ids()'),
       ('public.current_user_is_super_admin()'),
       ('public.current_user_role_in_org(uuid)')
     ) AS t(sig)
     JOIN pg_proc p ON p.oid = to_regprocedure(t.sig),
     aclexplode(p.proacl) a
     WHERE a.grantee::regrole::text NOT IN ('uellix_writer', 'uellix_auditor')), true);

  PERFORM set_config('stella_hosted_0006.owners',
    (SELECT string_agg(t.sig || '|' || pg_catalog.pg_get_userbyid(p.proowner), E'\n' ORDER BY t.sig)
     FROM (VALUES
       ('public.current_user_org_ids()'),
       ('public.current_user_is_super_admin()'),
       ('public.current_user_role_in_org(uuid)')
     ) AS t(sig)
     JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)), true);

  -- Every policy in the database, so "this package rewrote none" is measured
  -- against all of them rather than against a list somebody chose. Includes
  -- storage.objects, whose three policies are the Storage half of the contract.
  PERFORM set_config('stella_hosted_0006.policies',
    (SELECT coalesce(md5(string_agg(
        schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' ||
        permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' ||
        coalesce(with_check, ''), E'\n'
        ORDER BY schemaname, tablename, policyname)), '')
     FROM pg_policies), true);

  -- The two functions that WRITE. stella_0004 §9.8 asserts by name that the
  -- runtime never gains EXECUTE on them; hosted has had no equivalent assertion
  -- until now, and this package is the first thing to grant the runtime any
  -- function privilege at all, so it is the right place for it.
  PERFORM set_config('stella_hosted_0006.writers',
    (SELECT coalesce(string_agg(t.sig || '|' || t.r || '|' ||
        has_function_privilege(t.r, t.sig, 'EXECUTE')::text, E'\n' ORDER BY t.sig, t.r), '')
     FROM (VALUES
       ('public.handle_new_user()', 'uellix_app'),
       ('public.handle_new_user()', 'uellix_writer'),
       ('public.handle_update_user()', 'uellix_app'),
       ('public.handle_update_user()', 'uellix_writer')
     ) AS t(sig, r)
     WHERE to_regprocedure(t.sig) IS NOT NULL), true);

  PERFORM set_config('stella_hosted_0006.schema_acl',
    (SELECT coalesce(string_agg(n.nspname || '|' || t.r || '|' ||
        has_schema_privilege(t.r, n.oid, 'USAGE')::text || has_schema_privilege(t.r, n.oid, 'CREATE')::text,
        E'\n' ORDER BY n.nspname, t.r), '')
     FROM pg_namespace n,
          (VALUES ('uellix_app'), ('uellix_writer'), ('uellix_auditor')) AS t(r)
     WHERE n.nspname IN ('auth', 'public', 'storage')), true);

  PERFORM set_config('stella_hosted_0006.roles',
    (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles), true);

  RAISE NOTICE 'stella_hosted_0006: prestate = %', current_setting('stella_hosted_0006.prestate', true);
END $$;

-- ============================================================
-- 1. The hardened bodies
-- ============================================================
-- CONTENT AUTHORITY: db/prepared/stella_0005_runtime_cutover.sql lines 262-297.
-- These are that file's bodies verbatim, which is what makes this a CONVERGENCE
-- and not a fourth opinion: after this package, the hosted objects and the local
-- ones are byte-identical, and tests/hosted/runtime-helper-contract.test.ts
-- asserts exactly that rather than trusting this comment.
--
-- CREATE OR REPLACE preserves owner and ACL. Both are captured in §0 and
-- compared in §2, because "preserves" is a property of PostgreSQL and not of
-- this package, and the difference matters on a database somebody has edited.
--
-- Signatures, volatility, language, return types and SECURITY DEFINER are all
-- unchanged. The ONLY differences from the hosted bodies are the search_path and
-- the two qualified relation names.

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
-- 2. The runtime grant
-- ============================================================
-- TO THE WRITER AND THE AUDITOR, NEVER TO uellix_app. This is
-- stella_0004_role_separation.sql §6b verbatim, and the grantee list is the
-- whole point: the local model gives the runtime its read privileges through
-- membership in uellix_writer, and naming uellix_app here would create a second
-- way for the same principal to hold the same privilege — two things to keep in
-- sync, one of which nothing measures.
--
-- No WITH GRANT OPTION: neither role has anyone to pass it to.
GRANT EXECUTE ON FUNCTION
  public.current_user_org_ids(),
  public.current_user_is_super_admin(),
  public.current_user_role_in_org(uuid)
TO uellix_writer, uellix_auditor;

-- ============================================================
-- 3. Postconditions — the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  captured  text;
  observed  text;
  problem   text;
  v_probe   boolean;
  v_sub     constant uuid := '00000000-0000-4000-8000-0000000f0006';
BEGIN
  -- (1) THE HARDENED FORM, per function, on both axes.
  SELECT string_agg(t.sig, ', ' ORDER BY t.sig) INTO problem
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
  WHERE coalesce((SELECT c FROM unnest(p.proconfig) AS c WHERE c LIKE 'search_path=%'), '<unset>')
        NOT IN ('search_path=""', 'search_path=');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: % does not carry SET search_path = ''''. PG 17 stores it as search_path="" — quoted — and both spellings are accepted here.', problem;
  END IF;

  -- (2) NO UNQUALIFIED REFERENCE TO EITHER RELATION. Checked against prosrc
  --     rather than against the file above, so it is the INSTALLED body that is
  --     measured. This is also the assertion that fails if someone later edits
  --     the body back — which, under search_path='', would not even create.
  SELECT string_agg(t.sig, ', ' ORDER BY t.sig) INTO problem
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
  WHERE p.prosrc ~* '\mfrom\s+(users|organization_members)\M';

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: the body of % still names a relation without its schema. Under an empty search_path that name resolves through pg_temp first, which is the escalation this package closes.', problem;
  END IF;

  -- (3) THE ACTIVE PROBE. A structural check says the body LOOKS right; this one
  --     drives the actual attack and requires it to fail. It is the postcondition
  --     that cannot be satisfied by a body that merely passes a regex.
  --
  --     THE PROBE MUST BE CONCLUSIVE OR FAIL. With auth.uid() NULL neither the
  --     real relation nor the shadow matches, and every assertion below would
  --     pass VACUOUSLY — a probe that cannot fail is worse than no probe,
  --     because it reports the hardening as measured. So both spellings of the
  --     claim are set (deployments of GoTrue differ: some auth.uid() bodies read
  --     `request.jwt.claim.sub`, later ones fall back to `request.jwt.claims ->>
  --     'sub'`; MEASURED on supabase/postgres:17.6.1.143, which reads only the
  --     first), and the subject is then CONFIRMED before anything is concluded.
  PERFORM set_config('request.jwt.claim.sub', v_sub::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sub::text, 'role', 'authenticated')::text, true);

  IF (SELECT auth.uid()) IS DISTINCT FROM v_sub THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: the pg_temp shadowing probe could not establish a subject — auth.uid() does not resolve to the value this transaction set. Every assertion that follows would pass without exercising anything, so the probe refuses rather than reporting a hardening it did not measure.';
  END IF;

  CREATE TEMP TABLE users (id uuid PRIMARY KEY, is_super_admin boolean NOT NULL DEFAULT true);
  INSERT INTO pg_temp.users VALUES (v_sub, true);

  CREATE TEMP TABLE organization_members (
    user_id uuid, organization_id uuid, status text, role text);
  INSERT INTO pg_temp.organization_members
    VALUES (v_sub, '00000000-0000-4000-8000-0000000f9999', 'active', 'super_admin');

  SELECT public.current_user_is_super_admin() INTO v_probe;
  IF v_probe IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: current_user_is_super_admin() answered % while a pg_temp.users row claimed super-admin for the session subject. The body is still resolving that relation through the temporary schema.', v_probe;
  END IF;

  IF coalesce(array_length(public.current_user_org_ids(), 1), 0) <> 0 THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: current_user_org_ids() returned rows while a pg_temp.organization_members row was the only match. The body is still resolving that relation through the temporary schema.';
  END IF;

  IF public.current_user_role_in_org('00000000-0000-4000-8000-0000000f9999'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: current_user_role_in_org() returned a role from pg_temp.organization_members.';
  END IF;

  DROP TABLE pg_temp.users;
  DROP TABLE pg_temp.organization_members;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- (4)(5)(6) THE PRIVILEGE, for the two grantees AND for the runtime.
  --     The uellix_app assertion is SEPARATE and is the one that matters: it
  --     measures the EFFECTIVE privilege through the membership, so a database
  --     where that membership had been dropped fails here instead of shipping a
  --     grant that reaches nobody.
  SELECT string_agg(t.r || ' on ' || t.sig, ', ' ORDER BY t.r, t.sig) INTO problem
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS s(sig)
  CROSS JOIN (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS g(r)
  CROSS JOIN LATERAL (SELECT s.sig, g.r) AS t(sig, r)
  WHERE NOT has_function_privilege(t.r, t.sig, 'EXECUTE');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: no EXECUTE for %.', problem;
  END IF;

  -- (7) OWNERS UNCHANGED. CREATE OR REPLACE preserves the owner; measured, not
  --     trusted, because a database whose owner had already moved would make
  --     every other claim here describe a different object.
  captured := current_setting('stella_hosted_0006.owners', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: §0 recorded no owners, so "unchanged" cannot be evaluated. The blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT string_agg(t.sig || '|' || pg_catalog.pg_get_userbyid(p.proowner), E'\n' ORDER BY t.sig)
    INTO observed
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  JOIN pg_proc p ON p.oid = to_regprocedure(t.sig);

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: a helper owner changed. This package issues no ALTER FUNCTION ... OWNER TO.';
  END IF;

  -- (8)(9) EVERY OTHER GRANTEE EXACTLY WHERE IT WAS — PUBLIC, anon,
  --     authenticated, postgres, uellix_owner and the four capability roles, as
  --     a delta rather than as a hand-picked canary list. This is what proves
  --     the package widened the ACL for exactly two roles.
  captured := current_setting('stella_hosted_0006.foreign_acl', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: §0 recorded no ACL projection. Apply with psql -1.';
  END IF;

  SELECT coalesce(string_agg(
      t.sig || '|' || a.grantee::regrole::text || '|' || a.privilege_type || '|' || a.is_grantable::text,
      E'\n' ORDER BY t.sig, a.grantee::regrole::text, a.privilege_type), '')
    INTO observed
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  JOIN pg_proc p ON p.oid = to_regprocedure(t.sig),
  aclexplode(p.proacl) a
  WHERE a.grantee::regrole::text NOT IN ('uellix_writer', 'uellix_auditor');

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: the ACL changed for a role other than uellix_writer and uellix_auditor. This package grants to those two and to nobody else, and revokes from no one.';
  END IF;

  -- (10) NO WRITE PATH. The two trigger functions stay unreachable from the
  --      runtime — the hosted restatement of stella_0004 §9.8.
  captured := current_setting('stella_hosted_0006.writers', true);
  SELECT coalesce(string_agg(t.sig || '|' || t.r || '|' ||
      has_function_privilege(t.r, t.sig, 'EXECUTE')::text, E'\n' ORDER BY t.sig, t.r), '')
    INTO observed
  FROM (VALUES
    ('public.handle_new_user()', 'uellix_app'),
    ('public.handle_new_user()', 'uellix_writer'),
    ('public.handle_update_user()', 'uellix_app'),
    ('public.handle_update_user()', 'uellix_writer')
  ) AS t(sig, r)
  WHERE to_regprocedure(t.sig) IS NOT NULL;

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: the runtime''s EXECUTE on handle_new_user/handle_update_user changed. This package names neither.';
  END IF;

  SELECT string_agg(t.sig || ' -> ' || t.r, ', ' ORDER BY t.sig, t.r) INTO problem
  FROM (VALUES
    ('public.handle_new_user()', 'uellix_app'),
    ('public.handle_new_user()', 'uellix_writer'),
    ('public.handle_update_user()', 'uellix_app'),
    ('public.handle_update_user()', 'uellix_writer')
  ) AS t(sig, r)
  WHERE to_regprocedure(t.sig) IS NOT NULL
    AND has_function_privilege(t.r, t.sig, 'EXECUTE');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: the runtime can execute %. No package in this repository grants that; the posture predates this one and must be resolved deliberately.', problem;
  END IF;

  -- (11) NO POLICY REWRITTEN, across every schema. The identity primitive is
  --      unchanged and so is every predicate that reads it — including the three
  --      on storage.objects.
  captured := current_setting('stella_hosted_0006.policies', true);
  SELECT coalesce(md5(string_agg(
      schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' ||
      permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' ||
      coalesce(with_check, ''), E'\n'
      ORDER BY schemaname, tablename, policyname)), '')
    INTO observed
  FROM pg_policies;

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: a row-level security policy changed. This package creates, drops and replaces none.';
  END IF;

  -- (12)(13) NO SCHEMA PRIVILEGE MOVED — in particular no USAGE on `auth`, which
  --      the measurement showed is unnecessary and which this package must not
  --      be the thing that quietly introduces.
  captured := current_setting('stella_hosted_0006.schema_acl', true);
  SELECT coalesce(string_agg(n.nspname || '|' || t.r || '|' ||
      has_schema_privilege(t.r, n.oid, 'USAGE')::text || has_schema_privilege(t.r, n.oid, 'CREATE')::text,
      E'\n' ORDER BY n.nspname, t.r), '')
    INTO observed
  FROM pg_namespace n,
       (VALUES ('uellix_app'), ('uellix_writer'), ('uellix_auditor')) AS t(r)
  WHERE n.nspname IN ('auth', 'public', 'storage');

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: a schema privilege changed for a runtime role. This package grants USAGE on nothing — least of all on schema auth, which the policies do not need.';
  END IF;

  -- (14) NO ROLE CREATED OR DROPPED.
  captured := current_setting('stella_hosted_0006.roles', true);
  SELECT string_agg(rolname, ',' ORDER BY rolname) INTO observed FROM pg_roles;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: the role set changed. This package issues no CREATE ROLE and no DROP ROLE.';
  END IF;

  -- (15) NO OBJECT CREATED OUTSIDE THE CONTRACT. The three functions are
  --      REPLACED, never created, so the count of objects in schema public must
  --      not have moved at all.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('current_user_org_ids', 'current_user_is_super_admin',
                          'current_user_role_in_org')) <> 3 THEN
    RAISE EXCEPTION 'stella_hosted_0006 FAILED verification: the helper set in schema public is no longer exactly three functions. CREATE OR REPLACE at an existing signature adds nothing; an overload would.';
  END IF;

  RAISE NOTICE 'stella_hosted_0006: verification passed — prestate %; all three helpers carry SET search_path = '''' with public.* qualified and survive an active pg_temp shadowing probe; uellix_writer, uellix_auditor and (by inheritance) uellix_app hold EXECUTE on all three; owners, every other grantee, every policy, every schema privilege and the role set are byte-identical to what this transaction opened with.',
    current_setting('stella_hosted_0006.prestate', true);
END $$;
