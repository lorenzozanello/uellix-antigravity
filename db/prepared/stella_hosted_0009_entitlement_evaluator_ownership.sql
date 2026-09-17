-- ============================================================================
-- stella_hosted_0009_entitlement_evaluator_ownership.sql
-- CE-3 — the one operation migration 0073 documents and cannot perform.
-- ============================================================================
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. FORWARD-ONLY: there is no stella_hosted_0009_rollback.sql, and
-- the absence is typed in db/hosted/prechain-ownership.ts and derived from
-- there by db/hosted/forward-only-packages.ts.
--
-- PRECHAIN ADMINISTRATIVE UNIT. It is NOT a member of HOSTED_CHAIN and must
-- never become one — the same reason stella_hosted_0002 and stella_hosted_0003
-- are not: it is a PREREQUISITE applied by a DIFFERENT principal than every
-- chain link, and counting it would make the chain's installed count a number
-- no single identity can produce.
--
-- Authority:
--   docs/ops/commercial/COMMERCIAL_ACCOUNT_CE3_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json
--     FUTURE_HOSTED_PACKAGE_CONTRACT / _PRECONDITIONS / _POSTCONDITIONS and
--     FORWARD_ONLY_CONTRACT
--   bounding docs/ops/commercial/COMMERCIAL_ACCOUNT_ENTITLEMENT_AUTHORITY_AMENDMENT_v1.0.1.json
--   ODS grant HPO-ODS-W2-31 (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.34.json)
--
-- ----------------------------------------------------------------------------
-- WHAT IT IS FOR
-- ----------------------------------------------------------------------------
-- db/migrations/0073_commercial_account_ce3_entitlement_grants.sql resolves
-- F-CE3-1 as R-A and says so in its own banner: "the read path is a SECURITY
-- DEFINER function owned by uellix_owner, for which EXACTLY ONE narrow SELECT
-- policy exists". It then CANNOT produce that owner, and says that too:
--
--   "THIS UNIT NAMES uellix_owner AND DOES NOT CREATE OR RE-HOME IT.
--    db/hosted/baseline-manifest.ts BASELINE_GLOBAL_INVARIANTS pins
--    roleStatements = 0 and ownershipStatements = 0 across the WHOLE baseline,
--    'no baseline unit may introduce this; there is no per-unit opt-out'."
--
-- So on a managed target the evaluator is left owned by whichever
-- administrative identity applied the baseline — on managed Supabase,
-- `postgres`. That is not a defect anybody introduced; it is the declared
-- consequence of an invariant the migration is not allowed to break, and the
-- repair belongs to the hosted administrative channel. This package is that
-- repair, and nothing else.
--
-- ----------------------------------------------------------------------------
-- WHY A postgres-OWNED EVALUATOR INVALIDATES THE CE-3 MEASUREMENT
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER executes the body as the function's OWNER. entitlement_grants
-- carries ENABLE + FORCE ROW LEVEL SECURITY and EXACTLY ONE policy —
-- `entitlement_grants_select_owner`, FOR SELECT, TO uellix_owner.
--
-- THE MANAGED INSTALLER IS NOT A SUPERUSER, AND THAT IS THE POINT. MEASURED on
-- supabase/postgres:17.6.1.143:
--
--   postgres        rolsuper = false   rolbypassrls = TRUE
--   supabase_admin  rolsuper = true    rolbypassrls = true
--
-- so the role that applies the baseline — and therefore owns the evaluator —
-- is precisely a BYPASSRLS principal. A guard written only against rolsuper
-- would have accepted it. With the evaluator owned by such a role:
--
--   * row-level security is bypassed outright for it, so FORCE ROW LEVEL
--     SECURITY is silently inert and every isolation probe measures the
--     exemption rather than the policy;
--   * the single policy addressed TO uellix_owner is never the thing being
--     exercised, so R-A's surviving arm — "a single narrow policy" — is
--     asserted by the migration and demonstrated by nothing.
--
-- MEASURED END TO END on that image, with the policy neutralised to
-- USING (false) inside a rolled-back transaction:
--
--   owner = uellix_owner (NOBYPASSRLS), policy USING (true)  -> UNMETERED
--   owner = uellix_owner (NOBYPASSRLS), policy USING (false) -> NO_LIVE_GRANT
--   owner = postgres     (BYPASSRLS),   policy USING (false) -> UNMETERED
--
-- The third line is the defect: the policy can say FALSE and the evaluator
-- still reads every row. The second line is what this package buys — the
-- policy becomes load-bearing, so R-A is demonstrated rather than claimed.
--
-- 0073's own banner refuses this posture by name: "NO BYPASSRLS ANYWHERE. R-A's
-- own wording admits 'a single narrow policy (or a BYPASSRLS posture)'. The
-- policy is chosen and BYPASSRLS is refused". An owner carrying either
-- attribute reintroduces exactly the arm that was refused — which is why §0
-- asserts rolsuper = false AND rolbypassrls = false on the DESTINATION rather
-- than only one of them.
--
-- The opposite error is worth naming too: an owner that is neither
-- uellix_owner nor a superuser would fail in the ANSWER direction. The single
-- policy would not match it and GRANT SELECT was issued only TO uellix_owner,
-- so the evaluator would refuse on privilege or read the empty set, and
-- NOT FOUND would report NO_LIVE_GRANT for every governed Organization. Both
-- failure modes are closed by the same transfer, and §0.6 refuses the
-- third-party owner outright rather than repairing it.
--
-- ----------------------------------------------------------------------------
-- WHAT IT DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It does not touch the function BODY. §2 compares md5(prosrc).
--   * It does not change SECURITY DEFINER, volatility, parallel safety,
--     leakproofness or proconfig. §2 compares a digest carrying all of them,
--     and asserts search_path separately BY VALUE.
--   * It does not GRANT or REVOKE anything, to anyone.
--   * It does not create, drop or recreate a policy, and does not touch RLS or
--     FORCE RLS on entitlement_grants. §2 compares the full policy set by
--     digest AND by cardinality.
--   * It does not create, drop or alter a role, and changes no membership.
--   * It does not touch a table, a column, a schema or an extension, and
--     writes no row.
--   * It does not add hosted0009 to HOSTED_CHAIN and takes no chain witness.
--
-- ----------------------------------------------------------------------------
-- THE ONE THING IT CANNOT LEAVE UNTOUCHED, STATED BEFORE THE CODE
-- ----------------------------------------------------------------------------
-- `ALTER … OWNER TO` rewrites the OWNER'S implicit ACL entry. This is
-- PostgreSQL's behaviour, measured and documented at length in
-- stella_hosted_0003:95-109: the old owner's implicit grant is dropped, the new
-- owner's is created, and every OTHER grantee is carried across with the
-- GRANTOR rewritten. So "the ACL is unchanged" is FALSE as written and would
-- fail on every correct run.
--
-- What is true, and what §2 asserts, is that the set of NON-OWNER
-- (grantee, privilege) pairs is identical before and after: `authenticated`
-- keeps EXECUTE — 0073 grants it explicitly and the typed wrapper depends on
-- it — and PUBLIC, anon, uellix_app, uellix_writer and service_role keep
-- nothing, which is what 0073 left behind after its REVOKE ... FROM PUBLIC.
-- The grantor rewrite is therefore MEASURED as a declared consequence rather
-- than ignored. Any consequence beyond the owner's own implicit entry is a
-- violation and aborts.
--
-- DECLARED CONSEQUENCE: the previous owner loses its implicit EXECUTE unless it
-- also held an explicit grant. No runtime path calls the evaluator as that
-- identity — 0073 grants EXECUTE to `authenticated` and the function is
-- SECURITY DEFINER — and this is precisely the posture the migration describes.
-- It is named here so it is a decision rather than a surprise.
--
-- ----------------------------------------------------------------------------
-- WHY THERE IS NO ROLLBACK
-- ----------------------------------------------------------------------------
-- Same class as stella_hosted_0003, and NOT the class of stella_hosted_0008 or
-- stella_0020, both of which ship a _rollback.sql because their effects admit
-- exact governed reversal. Restoring the previous owner recreates the state
-- where the evaluator executes under a role that bypasses FORCE ROW LEVEL
-- SECURITY, invalidating R-A and silently un-enforcing SEC-3, SEC-4, SEC-6 and
-- SEC-12. A rollback script here would be one whose only effect is to reopen
-- the security defect this package closes, and whose correctness after the fact
-- nobody has measured.
--
-- Deliberate reversal, if it were ever genuinely wanted, is a single
-- administrative `ALTER FUNCTION … OWNER TO <prior owner>` taken by the same
-- principal with the consequences visible at the time — not a script whose
-- correctness nobody measured. Recording that is not authorizing a rollback
-- file, and must not be read as one.
--
-- ----------------------------------------------------------------------------
-- RUN AS ONE TRANSACTION, AS THE ROLE THAT OWNS THE EVALUATOR
-- ----------------------------------------------------------------------------
-- The governed administrative hosted session — the same principal class that
-- applies stella_hosted_0003..0008. NOT uellix_migrator, and NOT the
-- application runtime. On managed Supabase that is `postgres`; locally it is
-- the superuser that applied the baseline. The package does not name a role: it
-- asserts the CAPABILITY, so a project whose baseline was applied by some other
-- principal is refused rather than half-transferred.
--
--   psql "$ADMIN_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- Idempotent and convergent: re-altering to the owner a function already has is
-- a no-op and the non-owner ACL is identical afterwards. Convergence is reached
-- by the §0.6 guard ACCEPTING uellix_owner as a recognised current owner, never
-- by swallowing an exception.
-- No CREATE INDEX CONCURRENTLY.
--
-- ----------------------------------------------------------------------------
-- TWO DIFFERENT search_path VALUES, AND THEY ARE NOT THE SAME OBJECT
-- ----------------------------------------------------------------------------
-- The `SET search_path = public;` immediately below is this SCRIPT'S SESSION
-- setting. It governs how unqualified names in THIS FILE resolve while it runs,
-- and every catalog reference below is pg_catalog-qualified anyway.
--
-- The TARGET FUNCTION'S OWN `SET search_path = public` is a different thing
-- entirely: it is frozen into pg_proc.proconfig by 0073 and is part of the CE-3
-- contract. §0.5 asserts it by value BEFORE the transfer and §2 asserts it
-- again afterwards, because ALTER OWNER preserves proconfig — which means it
-- would also preserve a DRIFTED one and report success. Changing this script's
-- session setting would not change the function's, and changing the function's
-- is prohibited outright.
SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (administrative window) + pre-state capture
-- ============================================================
-- FAIL CLOSED, cheapest refusal first. Nothing is transferred until every
-- assumption below has been asked. The package is NEVER authorized to REPAIR an
-- invalid precondition: it does not create the role, grant the CREATE, enable
-- FORCE RLS, create or drop a policy, or revoke PUBLIC's EXECUTE. A package
-- that fixes what it found is a package whose preconditions measured nothing.
DO $$
DECLARE
  fn_oid      oid;
  fn_owner    name;
  overloads   int;
  owner_super boolean;
  owner_brls  boolean;
  policy_n    int;
  tenant_n    int;
  cfg         text[];
BEGIN
  -- 0.1 PRE-4 / PRE-5 / PRE-6. The destination role and the two attributes that
  --     are the entire point of choosing it. rolsuper is asked SEPARATELY from
  --     rolbypassrls: a SUPERUSER bypasses row-level security regardless of
  --     rolbypassrls, so a check for BYPASSRLS alone would accept the very
  --     posture that destroys the property this transfer exists to create.
  SELECT r.rolsuper, r.rolbypassrls INTO owner_super, owner_brls
  FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_owner';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: role uellix_owner does not exist. Apply stella_hosted_0000_managed_role_identity_bootstrap.sql (managed) or stella_0004_role_separation.sql (local) first. This package does not create a role to make its own precondition true.';
  END IF;

  IF owner_super THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: uellix_owner has rolsuper = true. A superuser owner bypasses row-level security regardless of rolbypassrls, so the transfer would satisfy the letter of "owned by uellix_owner" while destroying the FORCE ROW LEVEL SECURITY posture R-A depends on. stella_hosted_0000 creates the role NOSUPERUSER; a target where it is not is one this package will not bless.';
  END IF;

  IF owner_brls THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: uellix_owner has rolbypassrls = true. This is the exact arm 0073 refuses by name ("NO BYPASSRLS ANYWHERE"): FORCE ROW LEVEL SECURITY would be silently inert for every read the evaluator performs, and the CE-3 isolation probes would be measuring nothing.';
  END IF;

  -- 0.2 PRE-1. The evaluator, by EXACT regprocedure. to_regprocedure and not a
  --     ::regprocedure cast: the cast raises PostgreSQL's own error for an
  --     absent function, and this package owes the operator a governed message
  --     naming what to apply first. The argument types are part of the
  --     identity, not decoration — a transfer against a different overload is a
  --     transfer of something nobody specified.
  fn_oid := pg_catalog.to_regprocedure('public.entitlement_effective(uuid,varchar)');

  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: public.entitlement_effective(uuid,varchar) does not exist. It is created by db/migrations/0073_commercial_account_ce3_entitlement_grants.sql; a target without it has not had CE-3 applied.';
  END IF;

  -- 0.3 EXACTLY ONE. to_regprocedure already pinned the argument types, so this
  --     cannot select a different function — what it catches is a SIBLING
  --     OVERLOAD that 0073 does not create. A second entitlement_effective is a
  --     callable evaluator this package would leave owned by the old identity
  --     while reporting success, which is the failure a per-signature transfer
  --     makes easy to miss.
  SELECT count(*) INTO overloads
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'entitlement_effective';

  IF overloads <> 1 THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: % functions named public.entitlement_effective exist; 0073 creates exactly one. A sibling overload is a second callable evaluator this package is not authorized to transfer and must not silently leave behind.', overloads;
  END IF;

  -- 0.4 PRE-2. SECURITY DEFINER. Asserted BEFORE, because ALTER OWNER preserves
  --     prosecdef — which means it would also preserve an INVOKER one and
  --     report success. An INVOKER function is not the object this package was
  --     written for, and re-homing one would be a silent no-op dressed as a
  --     security fix.
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid) THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: public.entitlement_effective(uuid,varchar) is not SECURITY DEFINER. The whole security argument is about who a SECURITY DEFINER function runs AS; transferring an INVOKER function would change an owner and protect nothing.';
  END IF;

  -- 0.5 PRE-3. The frozen CE-3 search_path, asserted BY VALUE. 0073 declares
  --     SET search_path = public. BOTH SPELLINGS are accepted for the same
  --     reason stella_hosted_0003 accepts both of its own: PostgreSQL may store
  --     the value quoted, and a check written for one form refuses a correctly
  --     configured function. A definer function whose search_path drifted is a
  --     different object with the same name, and asserting it here is what
  --     gives §2's "unchanged" claim a known starting point.
  SELECT coalesce(p.proconfig, ARRAY[]::text[]) INTO cfg
  FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;

  IF NOT (cfg @> ARRAY['search_path=public']::text[]
          OR cfg @> ARRAY['search_path="public"']::text[]) THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: public.entitlement_effective(uuid,varchar) does not carry the frozen CE-3 configuration SET search_path = public (proconfig = %). A definer function whose search_path drifted is a different object with the same name.', coalesce(array_to_string(cfg, ','), '(none)');
  END IF;

  -- 0.6 PRE-7. THE ANTI-SEIZURE GUARD. The CURRENT owner is MEASURED from
  --     pg_proc.proowner, never assumed. Two owners are recognised and no
  --     others: `uellix_owner`, which means this package already ran and makes
  --     re-application converge, and an owner the CURRENT SESSION can already
  --     act as — the only case in which PostgreSQL would permit the transfer at
  --     all. Anything else is a third party's function and is left alone.
  --
  --     pg_has_role(..., 'USAGE') OR 'SET', and NOT a hardcoded 'postgres'. The
  --     managed installer happens to be postgres today, and pinning the name
  --     would refuse a correctly-provisioned project whose baseline was applied
  --     by a differently-named administrative role. Both membership kinds are
  --     needed: PostgreSQL resolves OWNERSHIP through has_privs_of_role —
  --     inherited privileges, which is 'USAGE' — but a session holding only SET
  --     can reach the same place by issuing SET ROLE first.
  fn_owner := pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid));

  IF fn_owner <> 'uellix_owner'
     AND NOT pg_catalog.pg_has_role(current_user, fn_owner, 'USAGE')
     AND NOT pg_catalog.pg_has_role(current_user, fn_owner, 'SET') THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: public.entitlement_effective(uuid,varchar) is owned by %, and the current session (%) is not a member of that role. This package will not seize a function owned by a principal it cannot already act as. Apply it as the role that owns the baseline — on managed Supabase, postgres.',
      fn_owner, current_user;
  END IF;

  -- 0.7 PRE-8. The session must also be able to hand ownership TO uellix_owner.
  --     'SET' AND NOT 'USAGE', and the distinction is the whole guard: under
  --     `GRANT uellix_owner TO x WITH INHERIT FALSE, SET TRUE` — which is
  --     exactly what stella_hosted_0000 issues for `postgres` (RR-02) —
  --     pg_has_role(x,'uellix_owner','USAGE') is FALSE and 'SET' is TRUE, and
  --     the transfer SUCCEEDS. Asking for 'USAGE' here would refuse the one
  --     identity this package is written for, on a database where PostgreSQL
  --     permits the operation.
  IF NOT pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET') THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: the current session (%) cannot SET ROLE uellix_owner, so it cannot assign ownership to it. stella_hosted_0000 grants uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE; apply the bootstrap first, or run this as a role that holds that membership.',
      current_user;
  END IF;

  -- 0.8 PRE-9. PostgreSQL requires the NEW owner to hold CREATE on the object's
  --     schema. Asking here turns a late failure into an early, governed one.
  IF NOT pg_catalog.has_schema_privilege('uellix_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: uellix_owner has no CREATE on schema public, and PostgreSQL requires the NEW owner to hold it. This is the same privilege uellix_bootstrap.assert_hosted_capabilities() checks as (C4) before any chain package runs. This package does not grant it.';
  END IF;

  -- 0.9 PRE-10. FORCE ROW LEVEL SECURITY on entitlement_grants. The transfer's
  --     entire value is that the evaluator's reads become subject to it.
  --     Against a relation without it, this package changes who owns a function
  --     and protects nothing. ENABLE is asked too: FORCE without ENABLE is not
  --     a posture 0073 produces.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants'
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: public.entitlement_grants does not carry ENABLE + FORCE ROW LEVEL SECURITY. 0073 sets both, and without FORCE the table OWNER is exempt — which would make the single owner policy silently inert for exactly the role the definer function runs as. This package does not enable it.';
  END IF;

  -- 0.10 PRE-11. EXACTLY ONE owner SELECT policy, addressed to uellix_owner.
  --      R-A's surviving arm is "a single narrow policy". Two owner policies is
  --      a combination nobody adjudicated; zero is a relation the evaluator
  --      cannot read. Asserted as EXACTLY ONE, never as at-least-one.
  SELECT count(*) INTO policy_n
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'entitlement_grants'
    AND cmd = 'SELECT' AND roles @> ARRAY['uellix_owner']::name[];

  IF policy_n <> 1 THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: % SELECT policies addressed to uellix_owner exist on entitlement_grants; R-A requires exactly one. Zero is a relation the evaluator cannot read; two is a combination nobody adjudicated.', policy_n;
  END IF;

  -- 0.11 PRE-12. ZERO tenant-facing policies. R-C is PROHIBITED before tenancy
  --      S4, and a tenant-facing policy present at transfer time means S4 was
  --      pre-empted. The package refuses rather than blessing it by proceeding.
  SELECT count(*) INTO tenant_n
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'entitlement_grants'
    AND roles && ARRAY['authenticated','anon','uellix_app','uellix_writer','service_role','public']::name[];

  IF tenant_n <> 0 THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: % tenant-facing policies exist on entitlement_grants. 0073 authors none, and every tenant-facing policy decision is DEFERRED to tenancy S4. A target where one exists has pre-empted S4 and this package will not bless it by proceeding.', tenant_n;
  END IF;

  -- 0.12 PRE-13. PUBLIC must already hold nothing on the evaluator. 0073 issues
  --      REVOKE EXECUTE ... FROM PUBLIC precisely because PostgreSQL grants
  --      EXECUTE to PUBLIC at CREATE time. Transferring while PUBLIC still held
  --      it would rewrite the GRANTOR and re-attribute a pre-existing defect to
  --      uellix_owner, making it look freshly blessed — the exact reasoning
  --      stella_hosted_0003:279 gives for its own refusal.
  --
  --      PUBLIC ONLY, AND anon IS DELIBERATELY NOT A REFUSAL HERE. This is the
  --      one place this package knowingly declines to copy stella_hosted_0003,
  --      which refuses on 'PUBLIC or anon'. MEASURED on
  --      supabase/postgres:17.6.1.143 with 0073 applied verbatim, the evaluator's
  --      ACL is:
  --
  --        postgres=X/postgres anon=X/postgres authenticated=X/postgres
  --        service_role=X/postgres
  --
  --      anon and service_role hold EXECUTE because the managed platform carries
  --      ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon,
  --      authenticated, service_role in schema public. A REVOKE FROM PUBLIC
  --      removes PUBLIC's entry and leaves those EXPLICIT grants untouched —
  --      0073 knows this and says so, noting that 0033_public_api_grants.sql
  --      revoked from "PUBLIC, anon and authenticated" for then-existing
  --      functions and "CANNOT reach a function created later".
  --
  --      So refusing on anon would refuse EVERY correctly-provisioned managed
  --      target this package is written for. A guard that can never pass is not
  --      a stricter package; it is an inapplicable one. The authority's PRE-13
  --      names PUBLIC and only PUBLIC, and that is implemented literally.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid = fn_oid
      AND coalesce(g.rolname, 'PUBLIC') = 'PUBLIC'
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0009 aborted: PUBLIC holds a privilege on public.entitlement_effective(uuid,varchar). 0073 revokes EXECUTE from PUBLIC. Transferring ownership would re-attribute that grant to uellix_owner and make a pre-existing defect look deliberate.';
  END IF;

  -- 0.12b THE PRIVILEGE THIS PACKAGE IS NOT ALLOWED TO ANSWER. anon's EXECUTE
  --       is a real surface and a separate question: the evaluator refuses anon
  --       uniformly at its own first guard, because auth.uid() is NULL for an
  --       unauthenticated JWT and current_user_org_ids() therefore returns the
  --       empty array, so every call refuses U0113 without reaching the
  --       catalogue or the relation. It is nevertheless a reachable entry point
  --       that nothing in CE-3 revokes.
  --
  --       RECORDED, NEVER REPAIRED. This package issues no REVOKE, and if it
  --       appeared to have settled this the next audit would credit the wrong
  --       unit. Only SILENCE is refused: the posture is stated on every run so
  --       it is carried forward as an open question rather than absorbed.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid = fn_oid AND coalesce(g.rolname, 'PUBLIC') = 'anon'
  ) THEN
    RAISE NOTICE 'stella_hosted_0009: anon holds EXECUTE on the evaluator, inherited from the managed platform default privileges in schema public. This package does not revoke it and does not depend on it; the evaluator refuses anon at its own scope guard (U0113). Whether CE-3 should additionally REVOKE EXECUTE FROM anon is a SEPARATE question this package deliberately does not settle.';
  ELSE
    RAISE NOTICE 'stella_hosted_0009: anon holds no privilege on the evaluator.';
  END IF;

  -- 0.13 PRE-14. CAPTURE, for §2 to compare against. Transaction-local
  --      (set_config(..., true)), so nothing here can leak into a later session
  --      or be pre-seeded by one. A postcondition that asserts "unchanged"
  --      without a captured pre-state is asserting against a value it just
  --      re-read; the capture is what makes §2 falsifiable rather than
  --      tautological.
  --
  --      The ACL is captured as the NON-OWNER grantee set, for the reason the
  --      header states at length: ALTER OWNER legitimately rewrites the owner's
  --      own entry, so a capture of the raw ACL would compare a thing that is
  --      SUPPOSED to move.
  PERFORM set_config('stella_hosted_0009.prior_owner', fn_owner, true);

  PERFORM set_config('stella_hosted_0009.body',
    (SELECT md5(p.oid::text || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' ||
                p.provolatile::text || ':' || p.proparallel::text || ':' || p.proleakproof::text || ':' ||
                coalesce(array_to_string(p.proconfig, ','), '-'))
     FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid), true);

  PERFORM set_config('stella_hosted_0009.nonowner_acl',
    (SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '')
     FROM (
       SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
       FROM pg_catalog.pg_proc p,
            aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
       WHERE p.oid = fn_oid
         AND coalesce(g.rolname, 'PUBLIC') <> pg_catalog.pg_get_userbyid(p.proowner)
     ) AS x), true);

  PERFORM set_config('stella_hosted_0009.policies',
    (SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || permissive || '|' ||
                                    roles::text || '|' || coalesce(qual, '') || '|' ||
                                    coalesce(with_check, ''),
                                    E'\n' ORDER BY policyname), ''))
     FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'entitlement_grants'), true);

  PERFORM set_config('stella_hosted_0009.policy_count',
    (SELECT count(*)::text FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'entitlement_grants'), true);

  PERFORM set_config('stella_hosted_0009.rls',
    (SELECT c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants'), true);

  -- Role attributes and memberships, so postcondition 12's "no role or
  -- membership change" is MEASURED rather than inferred from this file
  -- containing no role statement — an inference that would hold equally for a
  -- package that called a function which issued one.
  PERFORM set_config('stella_hosted_0009.roles',
    (SELECT md5(coalesce(string_agg(r.rolname || ':' || r.rolsuper::text || ':' ||
                                    r.rolbypassrls::text || ':' || r.rolcreaterole::text || ':' ||
                                    r.rolcanlogin::text || ':' || r.rolinherit::text,
                                    E'\n' ORDER BY r.rolname), ''))
     FROM pg_catalog.pg_roles r WHERE r.rolname LIKE 'uellix%'), true);

  -- inherit_option and set_option alongside admin_option, and the distinction
  -- is load-bearing rather than thorough: stella_hosted_0000 grants
  -- uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE, and flipping INHERIT
  -- to TRUE would silently make every administrative statement an owner
  -- statement without adding or removing a single membership. A digest over
  -- the membership SET alone would not see it. Both columns exist from
  -- PostgreSQL 16, and the governed substrate is 17.
  PERFORM set_config('stella_hosted_0009.memberships',
    (SELECT md5(coalesce(string_agg(pg_catalog.pg_get_userbyid(m.member) || '->' ||
                                    pg_catalog.pg_get_userbyid(m.roleid) || ':' ||
                                    m.admin_option::text || ':' || m.inherit_option::text ||
                                    ':' || m.set_option::text,
                                    E'\n' ORDER BY m.member, m.roleid), ''))
     FROM pg_catalog.pg_auth_members m), true);

  -- The relation's row count. entitlement_grants is append-only by trigger and
  -- this package writes nothing; capturing it makes "no table-row change"
  -- falsifiable instead of inferred from the absence of a DML statement.
  PERFORM set_config('stella_hosted_0009.grant_rows',
    (SELECT count(*)::text FROM public.entitlement_grants), true);

  RAISE NOTICE 'stella_hosted_0009: public.entitlement_effective(uuid,varchar) currently owned by %; normalising to uellix_owner.', fn_owner;
END $$;

-- ============================================================
-- 1. The transfer, and nothing else
-- ============================================================
-- ONE state-mutating statement. There is no second, and §2 measures that.
-- Guards, RAISE aborts and the verification block are not second mutations;
-- what is forbidden is a second statement that changes database state.
ALTER FUNCTION public.entitlement_effective(uuid, varchar) OWNER TO uellix_owner;

-- ============================================================
-- 2. Self-verification — assert the end state, in this transaction
-- ============================================================
-- Any failure below RAISEs and aborts the transaction, leaving the prior
-- posture intact. The package does not warn, does not partially apply and does
-- not record a success with caveats.
DO $$
DECLARE
  fn_oid   oid;
  captured text;
  observed text;
BEGIN
  fn_oid := pg_catalog.to_regprocedure('public.entitlement_effective(uuid,varchar)');

  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: public.entitlement_effective(uuid,varchar) does not exist after the transfer.';
  END IF;

  -- (1) THE POINT OF THE PACKAGE. Read from pg_proc.proowner, not inferred.
  IF pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid)) <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: public.entitlement_effective(uuid,varchar) is still owned by %.',
      pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid));
  END IF;

  -- (2) The destination role's attributes, RE-ASSERTED after the transfer. §0
  --     asked before it could still refuse; asking again closes the window in
  --     which a concurrent ALTER ROLE could have made the new owner a superuser
  --     between the two blocks.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'uellix_owner' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: uellix_owner is SUPERUSER or BYPASSRLS. The evaluator is now owned by a role that bypasses FORCE ROW LEVEL SECURITY, which is the defect this package exists to close.';
  END IF;

  -- (3) NOTHING FUNCTIONAL MOVED. Body, definer posture, volatility, parallel
  --     safety, leakproofness and proconfig as one digest taken before and
  --     compared now. This is the assertion that separates an ownership
  --     normalisation from a rewrite.
  captured := current_setting('stella_hosted_0009.body', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: §0 recorded no body digest, so "unchanged" cannot be evaluated. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;
  SELECT md5(p.oid::text || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' ||
             p.provolatile::text || ':' || p.proparallel::text || ':' || p.proleakproof::text || ':' ||
             coalesce(array_to_string(p.proconfig, ','), '-'))
    INTO observed
  FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: the function body, its SECURITY DEFINER flag, its volatility, its parallel safety, its leakproofness or its search_path changed. This package transfers ownership and must touch nothing else.';
  END IF;

  -- (4) search_path and SECURITY DEFINER asserted BY VALUE as well as by
  --     digest. (3) proves they did not move; these prove what they still ARE,
  --     so a target that had drifted before §0 ran cannot pass on the strength
  --     of having drifted consistently.
  IF NOT (SELECT coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=public']::text[]
               OR coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path="public"']::text[]
          FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid) THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: the evaluator no longer carries the frozen CE-3 SET search_path = public.';
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid) THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: the evaluator is no longer SECURITY DEFINER.';
  END IF;

  -- (5) THE ACL, IN THE ONLY FORM IN WHICH "UNCHANGED" IS TRUE. Every non-owner
  --     grantee is carried across; the owner's own entry is the one thing
  --     ALTER OWNER is allowed to rewrite, and it is excluded on both sides.
  captured := current_setting('stella_hosted_0009.nonowner_acl', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: §0 recorded no ACL. Apply with psql -1.';
  END IF;
  SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '') INTO observed
  FROM (
    SELECT coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
    FROM pg_catalog.pg_proc p,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid = fn_oid
      AND coalesce(g.rolname, 'PUBLIC') <> pg_catalog.pg_get_userbyid(p.proowner)
  ) AS x;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: the non-owner EXECUTE grants changed from [%] to [%]. This package issues no GRANT and no REVOKE; every difference here is one ALTER OWNER made on its own.',
      captured, observed;
  END IF;

  -- (6) The grantee the CE-3 read path depends on, stated separately. (5) only
  --     proves the set did not MOVE; on a target where `authenticated` had
  --     already lost EXECUTE, an unchanged set is an unchanged outage. 0073
  --     grants it explicitly and lib/capabilities/entitlement-evaluator.ts
  --     calls the function as that role.
  IF NOT has_function_privilege('authenticated', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: `authenticated` cannot execute the evaluator. 0073 grants EXECUTE to it explicitly and the typed wrapper calls the function as that role.';
  END IF;

  -- (7) PUBLIC still holds nothing, re-asserted after the rewrite. anon is NOT
  --     re-asserted as absent here for the reason §0.12 measures at length: on
  --     the managed shape it legitimately holds EXECUTE from a platform default
  --     privilege, and its entry is already pinned by (5) as part of the
  --     non-owner set — so an anon grant that APPEARED during this transaction
  --     fails (5), while the one that was there all along is carried across
  --     with its grantor rewritten, exactly as declared.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid = fn_oid
      AND coalesce(g.rolname, 'PUBLIC') = 'PUBLIC'
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: PUBLIC holds a privilege on the evaluator after the transfer.';
  END IF;

  -- (8) RLS and FORCE RLS on entitlement_grants, unchanged. The transfer's
  --     value is conditional on both, and a package that altered either would
  --     satisfy every ownership assertion above.
  captured := current_setting('stella_hosted_0009.rls', true);
  SELECT c.relrowsecurity::text || '/' || c.relforcerowsecurity::text INTO observed
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'entitlement_grants';
  IF captured IS NULL OR observed IS DISTINCT FROM captured OR observed <> 'true/true' THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: entitlement_grants RLS/FORCE RLS is now [%] against a captured [%]. This package does not touch row-level security.',
      coalesce(observed, 'ABSENT'), coalesce(captured, 'UNCAPTURED');
  END IF;

  -- (9) The policy set was not recreated, BY DIGEST AND BY CARDINALITY. A
  --     package that dropped and recreated one identically would satisfy the
  --     digest; one that added a policy would satisfy neither. Both are asked
  --     because they fail in different directions.
  captured := current_setting('stella_hosted_0009.policies', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: §0 recorded no policy digest. Apply with psql -1.';
  END IF;
  SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || permissive || '|' ||
                                 roles::text || '|' || coalesce(qual, '') || '|' ||
                                 coalesce(with_check, ''),
                                 E'\n' ORDER BY policyname), '')) INTO observed
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'entitlement_grants';
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: the policies on entitlement_grants changed while this package ran.';
  END IF;

  captured := current_setting('stella_hosted_0009.policy_count', true);
  SELECT count(*)::text INTO observed FROM pg_catalog.pg_policies
  WHERE schemaname = 'public' AND tablename = 'entitlement_grants';
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: the policy COUNT on entitlement_grants moved from % to %.', captured, observed;
  END IF;

  -- (10) Tenant-facing policy count still ZERO, re-asserted. Tenancy S4 is not
  --      pre-empted by this package running.
  IF (SELECT count(*) FROM pg_catalog.pg_policies
      WHERE schemaname = 'public' AND tablename = 'entitlement_grants'
        AND roles && ARRAY['authenticated','anon','uellix_app','uellix_writer','service_role','public']::name[]) <> 0 THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: a tenant-facing policy exists on entitlement_grants after the transfer.';
  END IF;

  -- (11) No role attribute and no membership changed.
  captured := current_setting('stella_hosted_0009.roles', true);
  SELECT md5(coalesce(string_agg(r.rolname || ':' || r.rolsuper::text || ':' ||
                                 r.rolbypassrls::text || ':' || r.rolcreaterole::text || ':' ||
                                 r.rolcanlogin::text || ':' || r.rolinherit::text,
                                 E'\n' ORDER BY r.rolname), '')) INTO observed
  FROM pg_catalog.pg_roles r WHERE r.rolname LIKE 'uellix%';
  IF captured IS NULL OR observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: a uellix_* role attribute changed while this package ran.';
  END IF;

  captured := current_setting('stella_hosted_0009.memberships', true);
  SELECT md5(coalesce(string_agg(pg_catalog.pg_get_userbyid(m.member) || '->' ||
                                 pg_catalog.pg_get_userbyid(m.roleid) || ':' ||
                                 m.admin_option::text || ':' || m.inherit_option::text ||
                                 ':' || m.set_option::text,
                                 E'\n' ORDER BY m.member, m.roleid), '')) INTO observed
  FROM pg_catalog.pg_auth_members m;
  IF captured IS NULL OR observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: a role membership changed while this package ran.';
  END IF;

  -- (12) No row was written to the relation the evaluator reads.
  captured := current_setting('stella_hosted_0009.grant_rows', true);
  SELECT count(*)::text INTO observed FROM public.entitlement_grants;
  IF captured IS NULL OR observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: the entitlement_grants row count moved from % to %. This package writes no row.', captured, observed;
  END IF;

  -- (13) No role window was opened, and none was left open.
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'stella_hosted_0009 FAILED verification: the session is running as % rather than %. This package opens no role window.',
      current_user, session_user;
  END IF;

  RAISE NOTICE 'stella_hosted_0009: verification passed — public.entitlement_effective(uuid,varchar) is owned by uellix_owner (previously %); body, SECURITY DEFINER, volatility, search_path, every non-owner EXECUTE grant, entitlement_grants RLS/FORCE RLS, its policy set, every uellix_* role attribute, every membership and the relation row count are unchanged.',
    coalesce(current_setting('stella_hosted_0009.prior_owner', true), 'unknown');
END $$;
