-- ============================================================================
-- stella_hosted_0003_storage_helper_ownership.sql
-- M-2 — the ONE operation the governed installer cannot delegate to itself.
-- ============================================================================
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. FORWARD-ONLY: there is no stella_hosted_0003_rollback.sql, and
-- the absence is typed in db/hosted/forward-only-packages.ts.
--
-- PRECHAIN ADMINISTRATIVE UNIT. It is NOT a member of HOSTED_CHAIN and must
-- never become one — see "WHY IT IS NOT A CHAIN LINK" below.
--
-- ----------------------------------------------------------------------------
-- WHAT IT IS FOR
-- ----------------------------------------------------------------------------
-- MEASURED by `pnpm certify:pg176` and `pnpm certify:remediation` against the
-- managed shape, twice, on 2026-08-15:
--
--   public.can_read_evidence_object(text,uuid)   owner: postgres
--   public.can_write_evidence_object(text,uuid)  owner: postgres
--
-- and locally, against the versioned baseline in db/baseline/:
--
--   both                                          owner: uellix_owner
--
-- The divergence is not a defect anybody introduced. `stella_0004` moves the 38
-- tables and 8 functions of `public` to `uellix_owner` and is LOCAL-ONLY;
-- `BASELINE_GLOBAL_INVARIANTS` records `ownershipStatements = 0` across all
-- fifty baseline units, which are applied on a managed project as `postgres`;
-- and `stella_hosted_0001`, the managed counterpart of stella_0004, transfers
-- only `public.stella_interactions` and its own schema. Nothing in the hosted
-- path ever moved these two.
--
-- The consequence is exact: `stella_0019_storage_write_roles` (T11) republishes
-- can_write_evidence_object through the governed path — `uellix_migrator` then
-- `SET ROLE uellix_owner` — and `CREATE OR REPLACE` requires being the OWNER.
-- Against a postgres-owned function that path cannot work, and T11 refuses,
-- fail-closed, in its own §0.6. This package removes the reason for the
-- refusal, and nothing else.
--
-- ----------------------------------------------------------------------------
-- THE MINIMUM PRIVILEGED OPERATION, AND WHY IT IS EXACTLY THIS
-- ----------------------------------------------------------------------------
-- `ALTER FUNCTION … OWNER TO` requires membership in the CURRENT owner role.
-- On a managed project the current owner is `postgres`, and `uellix_migrator`
-- is not a member of it: `stella_hosted_0001` grants `uellix_owner` TO
-- `postgres` (§297) and TO `uellix_migrator` (§423), and never `postgres` to
-- anyone. The T10 pattern — a temporary membership emitted by the governed
-- generator — reaches only roles `uellix_migrator` itself created and holds
-- ADMIN OPTION on. `postgres` is not one of those, and making it one would mean
-- handing the installer the administrative role permanently.
--
-- So the transfer is the one step that CANNOT be delegated, and it is the only
-- step this package takes. The functional change — the four canonical upload
-- roles — stays in T11, on the governed path, applied by `uellix_migrator`
-- with no administrative privilege at all. Splitting them that way is the whole
-- point: `postgres` is used for the operation that requires `postgres`, and for
-- nothing that does not.
--
-- ----------------------------------------------------------------------------
-- WHY BOTH HELPERS AND NOT ONLY THE ONE T11 REPUBLISHES
-- ----------------------------------------------------------------------------
-- Not symmetry, and not tidiness. `stella_0019` §0.6 asserts the owner of BOTH:
--
--   "can_read_evidence_object is owned by %, not uellix_owner. The two helpers
--    were published and transferred together; a split ownership is a state this
--    package cannot account for."
--
-- Normalising only the write helper would therefore leave T11 refusing on the
-- read helper — the same failure, one guard later. The canonical local posture
-- that `stella_0004` produces owns both, both are created by baseline unit 41,
-- both are granted EXECUTE by unit 42 (0039), and both are invoked by the three
-- policies on `storage.objects`. "The Storage helper pair" is the smallest
-- coherent unit here, and one of the two is not a unit at all.
--
-- ----------------------------------------------------------------------------
-- WHAT IT DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It does not touch a function BODY. §2 compares md5(prosrc) for both,
--     before and after.
--   * It does not GRANT or REVOKE anything, to anyone.
--   * It does not create, drop or recreate a policy, and §2 compares the digest
--     of all three on storage.objects.
--   * It does not create, drop or alter a role, and it changes no membership.
--   * It does not touch a table, a column, a schema or an extension.
--   * It does NOT grant `uellix_owner` USAGE on schema `storage`. That is
--     stella_0005d's job locally and is a SEPARATE hosted question; §2 asserts
--     the privilege is still absent so that this package cannot be mistaken for
--     having answered it.
--   * It does not perform the four-role fix. That is T11's, by design.
--
-- ----------------------------------------------------------------------------
-- THE ONE THING IT CANNOT LEAVE UNTOUCHED, STATED BEFORE THE CODE
-- ----------------------------------------------------------------------------
-- `ALTER … OWNER TO` rewrites the OWNER'S implicit ACL entry. MEASURED on PG
-- 17.6, forward direction, on the hosted shape:
--
--   before  {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--   after   {uellix_owner=X/uellix_owner, authenticated=X/uellix_owner, service_role=X/uellix_owner}
--
-- The old owner's implicit grant is dropped, the new owner's is created, and
-- every OTHER grantee is carried across with the grantor rewritten. So "the ACL
-- is unchanged" is FALSE as written and would fail on every correct run. What
-- is true, and what §2 asserts, is that the set of NON-OWNER (grantee,
-- privilege) pairs is identical before and after — `authenticated` keeps
-- EXECUTE, `service_role` keeps whatever it had, PUBLIC and anon keep nothing.
--
-- DECLARED CONSEQUENCE: `postgres` loses its implicit EXECUTE unless it also
-- held an explicit grant. No runtime path calls these helpers as `postgres` —
-- the three policies are `TO authenticated` and the functions are SECURITY
-- DEFINER — and this is precisely the posture `stella_0004` produces locally.
-- It is named here so it is a decision rather than a surprise.
--
-- ----------------------------------------------------------------------------
-- WHY IT IS NOT A CHAIN LINK
-- ----------------------------------------------------------------------------
-- The same reason `stella_hosted_0002` is not one, in the words of its own
-- registry: a package in HOSTED_CHAIN "would acquire chain witnesses, appear in
-- nextChainPackage, and become something an operator could be told to apply
-- next — which is precisely wrong: it is a PREREQUISITE of T1, not a member of
-- the sequence." This is a prerequisite of T11 and is applied by a DIFFERENT
-- principal than every chain link. Counting it as a chain member would also
-- make the chain's installed count a number no single identity can produce.
--
-- ----------------------------------------------------------------------------
-- WHY THERE IS NO ROLLBACK
-- ----------------------------------------------------------------------------
-- Same shape as grounding_0005. "Restore the previous owner" and "make the
-- governed chain uninstallable again" are the same sentence: T11 would refuse
-- once more, and a project that had already installed T11 would be left with a
-- four-role body owned by `postgres` — a state neither package produces and
-- nothing measures. Reversal, if it were ever genuinely wanted, is an
-- administrative `ALTER FUNCTION … OWNER TO postgres` taken deliberately by the
-- same principal, not a script whose correctness nobody measured.
--
-- ----------------------------------------------------------------------------
-- RUN AS ONE TRANSACTION, AS THE ROLE THAT OWNS THE HELPERS
-- ----------------------------------------------------------------------------
-- On managed Supabase that is `postgres`, the highest role the platform
-- exposes; locally it is the superuser that applied the baseline. The package
-- does not name a role: it asserts the CAPABILITY, so a project whose baseline
-- was applied by some other principal is refused rather than half-transferred.
--
--   psql "$ADMIN_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- Idempotent and convergent: re-altering to the owner a function already has is
-- a no-op and the ACL is byte-identical afterwards. MEASURED.
-- No CREATE INDEX CONCURRENTLY.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (administrative window)
-- ============================================================
-- FAIL CLOSED, cheapest refusal first. Nothing is transferred until every
-- assumption below has been asked.
DO $$
DECLARE
  read_oid   oid;
  write_oid  oid;
  read_owner name;
  write_owner name;
  problem    text;
BEGIN
  -- 0.1 The destination role. Without it there is nothing to transfer TO, and
  --     the failure would otherwise arrive from PostgreSQL halfway through.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: role uellix_owner does not exist. Apply stella_hosted_0001_managed_role_bootstrap.sql (managed) or stella_0004_role_separation.sql (local) first.';
  END IF;

  -- 0.2 Both helpers, by exact signature. This package normalises the PAIR and
  --     will not invent either half.
  SELECT p.oid INTO read_oid
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'can_read_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  SELECT p.oid INTO write_oid
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'can_write_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  IF read_oid IS NULL OR write_oid IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: the Storage helper pair is not both present with the expected argument names (read=%, write=%). They are created by baseline unit 41; a target without them has not been provisioned.',
      coalesce(read_oid::text, 'ABSENT'), coalesce(write_oid::text, 'ABSENT');
  END IF;

  read_owner  := pg_catalog.pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid = read_oid));
  write_owner := pg_catalog.pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid = write_oid));

  -- 0.3 SPLIT OWNERSHIP IS REFUSED. The two were published and granted
  --     together, and T11 §0.6 asserts both. A target where they diverged got
  --     there by something this package did not do and cannot account for.
  IF read_owner <> write_owner THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: the Storage helper pair has SPLIT ownership — can_read is owned by % and can_write by %. Both were created by baseline unit 41 and this package moves them as a pair; a divergence is a state neither the baseline, stella_0004 nor stella_hosted_0001 produces.',
      read_owner, write_owner;
  END IF;

  -- 0.4 THE ANTI-SEIZURE GUARD. Two owners are recognised and no others:
  --     `uellix_owner`, which means this package already ran (and makes
  --     re-application converge), and an owner the CURRENT SESSION can act as,
  --     which is the only case in which PostgreSQL would permit the transfer at
  --     all. Anything else is a third party's function and is left alone.
  --
  --     `pg_has_role(..., 'USAGE')` and not a hardcoded 'postgres': the managed
  --     installer happens to be postgres today, and pinning the name would
  --     refuse a correctly-provisioned project whose baseline was applied by a
  --     differently-named administrative role while silently accepting nothing
  --     extra.
  --     'USAGE' OR 'SET', and both are needed. PostgreSQL resolves OWNERSHIP
  --     through has_privs_of_role — inherited privileges, which is 'USAGE' —
  --     but a session holding only SET can reach the same place by issuing
  --     SET ROLE first. Asking for 'USAGE' alone would refuse a caller for whom
  --     the operation is available; asking for 'SET' alone would refuse the
  --     ordinary case where the session simply IS the owner.
  IF read_owner <> 'uellix_owner'
     AND NOT pg_catalog.pg_has_role(current_user, read_owner, 'USAGE')
     AND NOT pg_catalog.pg_has_role(current_user, read_owner, 'SET') THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: the Storage helpers are owned by %, and the current session (%) is not a member of that role. This package will not seize a function owned by a principal it cannot already act as. Apply it as the role that owns the baseline — on managed Supabase, postgres.',
      read_owner, current_user;
  END IF;

  -- 0.5 The session must also be able to hand ownership TO uellix_owner, and
  --     uellix_owner must be able to hold an object in this schema. PostgreSQL
  --     checks both; asking here turns two late failures into one early one.
  -- 'SET' AND NOT 'USAGE', and the distinction is the whole guard. MEASURED on
  -- PG 17.6: under `GRANT uellix_owner TO x WITH INHERIT FALSE, SET TRUE` —
  -- which is exactly what stella_hosted_0001 §297 issues for `postgres` —
  -- pg_has_role(x,'uellix_owner','USAGE') is FALSE and 'SET' is TRUE, and
  -- `ALTER FUNCTION … OWNER TO uellix_owner` SUCCEEDS for a non-superuser
  -- holding only SET. PostgreSQL requires SET-membership in the NEW owner, not
  -- inherited privileges. Asking for 'USAGE' here refused the one identity the
  -- package is written for, on a database where the transfer was permitted —
  -- measured as a 10/11 chain before this line was corrected. The bootstrap
  -- asks the same question in the same spelling, three sections earlier.
  IF NOT pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET') THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: the current session (%) cannot SET ROLE uellix_owner, so it cannot assign ownership to it. On managed Supabase stella_hosted_0001 §297 grants uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE; apply the bootstrap first, or run this as a role that holds that membership.',
      current_user;
  END IF;

  IF NOT pg_catalog.has_schema_privilege('uellix_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: uellix_owner has no CREATE on schema public, and PostgreSQL requires the NEW owner to hold it. This is the same privilege uellix_bootstrap.assert_hosted_capabilities() checks as (C4) before any chain package runs.';
  END IF;

  -- 0.6 The definer posture this package must leave exactly as it found it.
  --     Asserted BEFORE, because ALTER OWNER preserves both — which means it
  --     would also preserve a wrong one and report success.
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('can_read_evidence_object is not SECURITY DEFINER',
     (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = read_oid)),
    ('can_write_evidence_object is not SECURITY DEFINER',
     (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = write_oid))
  ) AS m(what, ok) WHERE NOT m.ok;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: %. Both helpers are SECURITY DEFINER by construction; an INVOKER one is not the object this package was written for.', problem;
  END IF;

  -- BOTH SPELLINGS. PG 17.6 stores the empty search_path QUOTED; a check
  -- written for one form refuses a correctly configured function.
  IF NOT (SELECT bool_and(coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=']::text[]
                       OR coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[])
          FROM pg_catalog.pg_proc p WHERE p.oid IN (read_oid, write_oid)) THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: one of the Storage helpers does not carry SET search_path = ''''. Every name in their bodies is schema-qualified on that assumption.';
  END IF;

  -- 0.7 PUBLIC and anon must already hold nothing. Unit 41 revokes both, and a
  --     target where one of them holds EXECUTE has a defect this package is not
  --     allowed to carry across silently — the transfer would rewrite the
  --     grantor and make it look freshly blessed by uellix_owner.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid IN (read_oid, write_oid)
      AND coalesce(g.rolname, 'PUBLIC') IN ('PUBLIC', 'anon')
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: PUBLIC or anon holds a privilege on a Storage helper. Unit 41 revokes both. Transferring ownership would re-attribute that grant to uellix_owner and make a pre-existing defect look deliberate.';
  END IF;

  -- 0.8 The three policies the helpers exist to serve. A target without them is
  --     one where this normalisation would be repairing an authorisation that
  --     nothing reads.
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('select_evidence', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='select_evidence')),
    ('insert_evidence', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='insert_evidence')),
    ('delete_evidence', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='delete_evidence'))
  ) AS m(what, present) WHERE NOT m.present;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0003 aborted: baseline storage policies missing: %.', problem;
  END IF;

  -- 0.9 CAPTURE, for §2 to compare against. Transaction-local, so nothing here
  --     can leak into a later session or be pre-seeded by one.
  --
  --     The ACL is captured as the NON-OWNER grantee set, for the reason the
  --     header states at length: ALTER OWNER legitimately rewrites the owner's
  --     own entry, so a capture of the raw ACL would compare a thing that is
  --     SUPPOSED to move.
  PERFORM set_config('stella_hosted_0003.prior_owner', read_owner, true);

  PERFORM set_config('stella_hosted_0003.bodies',
    (SELECT md5(string_agg(p.oid::text || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' ||
                           coalesce(array_to_string(p.proconfig, ','), '-'), '|' ORDER BY p.oid))
     FROM pg_catalog.pg_proc p WHERE p.oid IN (read_oid, write_oid)), true);

  PERFORM set_config('stella_hosted_0003.nonowner_acl',
    (SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '')
     FROM (
       SELECT p.oid::text || '/' || coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
       FROM pg_catalog.pg_proc p,
            aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
       WHERE p.oid IN (read_oid, write_oid)
         AND coalesce(g.rolname, 'PUBLIC') <> pg_catalog.pg_get_userbyid(p.proowner)
     ) AS x), true);

  PERFORM set_config('stella_hosted_0003.storage_policies',
    (SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' ||
                                    coalesce(qual, '') || '|' || coalesce(with_check, ''),
                                    E'\n' ORDER BY policyname), ''))
     FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'), true);

  RAISE NOTICE 'stella_hosted_0003: Storage helper pair currently owned by %; normalising to uellix_owner.', read_owner;
END $$;

-- ============================================================
-- 1. The transfer, and nothing else
-- ============================================================
-- Two statements. There is no third, and §2 measures that.
ALTER FUNCTION public.can_read_evidence_object(text, uuid) OWNER TO uellix_owner;
ALTER FUNCTION public.can_write_evidence_object(text, uuid) OWNER TO uellix_owner;

-- ============================================================
-- 2. Self-verification — assert the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  read_oid  oid;
  write_oid oid;
  captured  text;
  observed  text;
  problem   text;
BEGIN
  SELECT p.oid INTO read_oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='can_read_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';
  SELECT p.oid INTO write_oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='can_write_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  IF read_oid IS NULL OR write_oid IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: a Storage helper does not exist after the transfer.';
  END IF;

  -- (1) THE POINT OF THE PACKAGE. Both, named individually: a single check for
  --     "the pair moved" would pass over a pair where only one did.
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('can_read_evidence_object',  pg_catalog.pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid = read_oid))),
    ('can_write_evidence_object', pg_catalog.pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid = write_oid)))
  ) AS m(what, owner) WHERE m.owner <> 'uellix_owner';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: still not owned by uellix_owner: %.', problem;
  END IF;

  -- (2) NOTHING FUNCTIONAL MOVED. Body, definer posture and search_path for
  --     both, as one digest taken before and compared now. This is the
  --     assertion that separates an ownership normalisation from a rewrite.
  captured := current_setting('stella_hosted_0003.bodies', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: §0 recorded no body digest, so "unchanged" cannot be evaluated. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;
  SELECT md5(string_agg(p.oid::text || ':' || md5(p.prosrc) || ':' || p.prosecdef::text || ':' ||
                        coalesce(array_to_string(p.proconfig, ','), '-'), '|' ORDER BY p.oid))
    INTO observed
  FROM pg_catalog.pg_proc p WHERE p.oid IN (read_oid, write_oid);
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: a function body, its SECURITY DEFINER flag or its search_path changed. This package transfers ownership and must touch nothing else.';
  END IF;

  -- (3) THE ACL, IN THE ONLY FORM IN WHICH "UNCHANGED" IS TRUE. Every non-owner
  --     grantee is carried across; the owner's own entry is the one thing
  --     ALTER OWNER is allowed to rewrite, and it is excluded on both sides.
  captured := current_setting('stella_hosted_0003.nonowner_acl', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: §0 recorded no ACL. Apply with psql -1.';
  END IF;
  SELECT coalesce(string_agg(x.entry, ',' ORDER BY x.entry), '') INTO observed
  FROM (
    SELECT p.oid::text || '/' || coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type AS entry
    FROM pg_catalog.pg_proc p,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid IN (read_oid, write_oid)
      AND coalesce(g.rolname, 'PUBLIC') <> pg_catalog.pg_get_userbyid(p.proowner)
  ) AS x;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: the non-owner EXECUTE grants changed from [%] to [%]. This package issues no GRANT and no REVOKE; every difference here is one ALTER OWNER made on its own.',
      captured, observed;
  END IF;

  -- (4) The grantee the whole Storage path depends on, stated separately. (3)
  --     only proves the set did not MOVE; on a target where `authenticated` had
  --     already lost EXECUTE, an unchanged set is an unchanged outage.
  IF NOT has_function_privilege('authenticated', read_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', write_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: `authenticated` cannot execute one of the Storage helpers. The three policies on storage.objects are TO authenticated and call them by name.';
  END IF;

  -- (5) And PUBLIC / anon still hold nothing, re-asserted after the rewrite.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid IN (read_oid, write_oid)
      AND coalesce(g.rolname, 'PUBLIC') IN ('PUBLIC', 'anon')
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: PUBLIC or anon holds a privilege on a Storage helper after the transfer.';
  END IF;

  -- (6) The policies were not recreated. A package that dropped and recreated
  --     one would satisfy every other assertion in this block.
  captured := current_setting('stella_hosted_0003.storage_policies', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: §0 recorded no policy digest. Apply with psql -1.';
  END IF;
  SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' ||
                                 coalesce(qual, '') || '|' || coalesce(with_check, ''),
                                 E'\n' ORDER BY policyname), '')) INTO observed
  FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: the policies on storage.objects changed while this package ran.';
  END IF;

  -- (7) THE PRIVILEGE THIS PACKAGE IS NOT ALLOWED TO ANSWER. stella_0005d
  --     grants uellix_owner USAGE on schema storage locally, and whether the
  --     hosted path needs the same is a separate, unanswered question. If this
  --     package ever appeared to have settled it, the next audit would credit
  --     the wrong unit — so the absence is asserted rather than assumed.
  --
  --     Not an error when present: a target that already holds it got it from
  --     somewhere legitimate. It is RECORDED, and only silence is refused.
  IF has_schema_privilege('uellix_owner', 'storage', 'USAGE') THEN
    RAISE NOTICE 'stella_hosted_0003: uellix_owner already holds USAGE on schema storage. This package did not grant it and does not depend on it; the Storage helper bodies do, and that remains stella_0005d''s question on the hosted side.';
  ELSE
    RAISE NOTICE 'stella_hosted_0003: uellix_owner holds NO USAGE on schema storage. Ownership is now correct and the helper bodies will still answer false for every caller until that separate question is settled. This package deliberately does not settle it.';
  END IF;

  -- (8) No role window was opened, and none was left open.
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'stella_hosted_0003 FAILED verification: the session is running as % rather than %. This package opens no role window.',
      current_user, session_user;
  END IF;

  RAISE NOTICE 'stella_hosted_0003: verification passed — can_read_evidence_object and can_write_evidence_object are owned by uellix_owner (previously %); bodies, SECURITY DEFINER, search_path, every non-owner EXECUTE grant and the three storage.objects policies are unchanged.',
    coalesce(current_setting('stella_hosted_0003.prior_owner', true), 'unknown');
END $$;
