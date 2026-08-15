-- ============================================================================
-- stella_0019_storage_write_roles — GOVERNED MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm authority:generate`.
-- ============================================================================
--
-- Package: T11
-- Derived from: db/prepared/hosted/stella_0019_storage_write_roles.hosted.sql
-- Source SHA-256 (LF-normalized): e467672fa8247aac5c03c3c8ec92ec86646c7d5e60b67adcf6e2a44ef60a8a2a
--
-- WHAT CHANGED, AND ONLY THIS:
--   The canonical SET ROLE / RESET ROLE bookkeeping was replaced. It assumes
--   a superuser applies the package, which managed Supabase does not have.
--   In its place each execution segment opens exactly the authority it needs,
--   runs the canonical statements it governs, and gives that authority back.
--
-- WHAT DID NOT CHANGE:
--   Every canonical executable statement, verbatim and in canonical order.
--   No statement was moved to reduce the number of role transitions.
-- ============================================================================
-- ============================================================================
-- stella_0019_storage_write_roles — MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.
-- ============================================================================
--
-- Derived from: db/prepared/stella_0019_storage_write_roles.sql
-- Source SHA-256 (LF-normalized): 0be837a47d83417fb3e7422e009114f7d34f4d0f958353b40495df5ce9401750
--
-- The canonical file above is the ONLY source of truth. This artefact exists
-- because managed Supabase exposes no superuser and does not let `postgres`
-- grant USAGE on schema auth. Editing THIS file instead of the canonical one
-- creates the second source of truth the design exists to prevent — and the
-- verification suite will fail, because it regenerates and compares bytes.
--
-- Rewrite rules applied (id: times fired):
--   superuser-precondition: 1
--   auth-schema-grant: 0
--   auth-uid-precondition: 0
--   auth-uid-call: 0
--   capability-role-attributes: 0
--   capability-member-count: 0
--   auth-users-privilege-probe: 0
--
-- Nothing else was changed. No policy predicate, no ownership transfer, no
-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no
-- self-verification block differs from the canonical source.
-- ============================================================================
-- db/prepared/stella_0019_storage_write_roles.sql
-- M-2 — the two roles `can_write_evidence_object` forgot.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0019_rollback.sql.
--
-- DEPENDS ON: the BASELINE (unit 41, supabase/migrations/20260716000001_storage_
-- policies.sql) for the function itself, stella_0004 for the ownership this
-- package's owner window assumes, and stella_0005d for the USAGE on schema
-- `storage` without which the function returns false for everybody.
-- SOURCE OF TRUTH: absent from db/schema.ts and the drizzle snapshot on purpose
-- — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- STATUS: DESIGN. NOT APPLIED TO ANY HOSTED STACK. NO CAPABILITY IS ENABLED.
--
-- ============================================================================
-- THE DEFECT
-- ============================================================================
-- Uellix has ONE permission contract for "may this member attach evidence to
-- this project", and it is written down in three places that are supposed to
-- agree:
--
--   lib/auth/permissions.ts   canUploadEvidence(role) = hasRole(role,'analyst')
--                             i.e. ROLE_HIERARCHY >= 40, which is
--                             super_admin, organization_admin, impact_manager,
--                             analyst.
--   db/migrations/0031_rls_core.sql §evidence_items_insert
--                             current_user_role_in_org(organization_id) IN
--                             ('super_admin','organization_admin',
--                              'impact_manager','analyst')
--   public.can_write_evidence_object  ← THIS ONE
--                             om.role IN ('organization_admin','analyst')
--
-- The third disagrees with the other two by exactly two roles. The consequence
-- is not cosmetic and it is not symmetric: `evidence_items` accepts the row and
-- Storage refuses the object. An `impact_manager` — the role whose entire job
-- is running a project — and a `super_admin` acting through an ordinary
-- membership can create the metadata for a piece of evidence and cannot upload
-- the file it describes. What they see is "new row violates row-level security
-- policy" from the Storage API, on an operation the application's own
-- permission helper had already authorised, which is why the failure reads as a
-- platform fault rather than a permission decision.
--
-- The compensating DELETE in lib/pipeline/evidence.ts does NOT clean that up.
-- It is recorded as M2-COMP-01 and is DELIBERATELY NOT ADDRESSED HERE: see
-- "WHAT THIS PACKAGE IS NOT", below.
--
-- ============================================================================
-- WHAT THIS PACKAGE IS NOT
-- ============================================================================
-- It is NOT an edit to unit 41. `supabase/migrations/20260716000001_storage_
-- policies.sql` and its generated half `db/prepared/storage/20260716000001_
-- part_a_helpers.psql.sql` are BASELINE bytes: installed, hash-pinned in
-- db/hosted/baseline-manifest.ts and part of a manifest frozen at 50 units.
-- Rewriting them would make the installed artefact and the repository disagree
-- about what ran, and `pnpm storage:verify` refuses a hand edit of the derived
-- half anyway. The repair is a NEW link applied after the existing chain, which
-- is the same shape M-8 took for grounding_0005.
--
-- It is NOT a widening beyond the contract. The four roles below are the four
-- `evidence_items_insert` already names, character for character. `reviewer`
-- and `viewer` stay refused, and §2 asserts their absence rather than trusting
-- the list to have been typed correctly.
--
-- It does NOT add `OR public.current_user_is_super_admin()`. The two RLS
-- policies on `evidence_items` carry that escape and these two Storage helpers
-- do not — `can_read_evidence_object` has no such branch either. Adding one
-- here would grant a PLATFORM super admin with NO active membership the right
-- to write objects into an organisation's bucket, which is a capability that
-- exists nowhere in the current Storage contract and which nobody asked this
-- package for. The asymmetry between the table and the bucket is real and is
-- recorded as a finding, not closed by a package whose subject is a role list.
--
-- It does NOT touch `can_read_evidence_object`, the three policies on
-- `storage.objects`, any table, any grant or any role. §0 measures all of them
-- before the change and §2 measures them again after it, so "unchanged" is a
-- MEASUREMENT rather than the absence of a statement.
--
-- It is NOT the fix for M2-COMP-01. `evidence_items` has no DELETE policy — RLS
-- denies the compensating delete silently, affecting zero rows — so a metadata
-- row whose upload failed survives as an orphan. This package makes that path
-- RARER (two roles stop failing) and no more CORRECT (the roles that still fail
-- for other reasons still orphan a row). Conflating the two would let a role
-- list close a transactional-integrity defect on paper.
--
-- ============================================================================
-- WHY THERE IS A ROLLBACK, WHEN THE LAST TWO REPAIRS HAD NONE
-- ============================================================================
-- grounding_0005, stella_0016 and stella_0017 ship forward-only because their
-- rollbacks would REOPEN a vulnerability: "restore the previous body" and
-- "republish the defect" were the same sentence there.
--
-- Here they are not. This package's forward direction WIDENS an authorisation
-- from two roles to four; its rollback NARROWS it back to the two. A database
-- that has been rolled back refuses more than it did a moment earlier, never
-- less. There is no state in which running stella_0019_rollback.sql grants
-- somebody something. That is precisely the condition under which db/prepared/
-- README.md rule 4 applies with no exemption, so the exemption is not taken and
-- db/hosted/forward-only-packages.ts is not touched.
--
-- ============================================================================
-- RE-APPLICATION
-- ============================================================================
-- Idempotent and convergent. `CREATE OR REPLACE` over the body this package
-- already published is a no-op in effect, and §0 accepts that state explicitly
-- (state B) instead of refusing it.
--
-- The other direction — re-applying the BASELINE storage half over this package
-- — would republish the two-role body next to its own fix, changing no
-- signature and tripping nothing later. That re-application is not reachable
-- through any runner in this repository: `db/prepared/storage/` is not under
-- db/prepared/ root, `scripts/db-migrate-local.ts` resolves prepared scripts by
-- basename against db/prepared/ only, and the baseline units are a prechain
-- install that does not re-run one unit in isolation. It is recorded here and
-- in db/prepared/README.md as an OPERATOR hazard rather than declared in
-- db/prepared-package-order.ts, because a supersession rule whose probe can
-- never fire is a guard that teaches an operator to trust a check that is not
-- running.
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- On managed Supabase the generated variant replaces the superuser guard with
-- uellix_bootstrap.assert_hosted_capabilities(), whose (C2) and (C4) checks are
-- the two this package actually needs: the right to SET ROLE uellix_owner, and
-- CREATE on schema public FOR uellix_owner. Measured, PG 17.6: uellix_migrator
-- without the owner window fails with `permission denied for schema public`.
-- No CREATE INDEX CONCURRENTLY.

SET search_path = public;
SET lock_timeout = '5s';
-- ============================================================
-- 0. Preconditions (installer window)
-- ============================================================
-- FAIL CLOSED, cheapest refusal first. Everything this package assumes is asked
-- before a byte of the function body is republished.
--
-- WHY EVERY POSITIONAL TEST READS A COMMENT-STRIPPED DEFINITION.
-- `pg_get_functiondef` returns the source VERBATIM, comments included, and the
-- body this package publishes explains the defect by naming the roles involved.
-- Searching raw text would find `impact_manager` in the sentence that describes
-- adding it, so the "already applied" test would pass over a body that had not
-- been changed. Same rule grounding_0005 §0 states for the same reason.
--
-- WHY THE COMMENT-STRIPPING REGEX IS SPELLED `-{2}` AND NOT `--`.
-- The two are identical to PostgreSQL (verified on 17.6: the same input gives
-- the same output). They are NOT identical to a reader that strips line
-- comments before parsing strings — and this repository has one, in
-- tests/prepared-stella-sql.test.ts, which is the shape every naive stripper
-- takes. Written `'--[^\n]*'`, the literal contains the very token that ends a
-- line, so such a reader deletes from inside the string to end of line, takes
-- the closing quote with it, and every quote after that point pairs with the
-- wrong partner. Measured here before it was fixed: the parenthesis depth of
-- this file read as +2 and the rollback's as -2, and a `has_function_privilege
-- (..., 'EXECUTE')` inside a string surfaced as a bare dynamic EXECUTE. The
-- bound quantifier says the same thing without writing the token.
--
-- WHY THE ROLE TESTS SEARCH FOR QUOTED LITERALS.
-- `om.role IN ('analyst')` renders in the definition with the quotes. A bare
-- `position('analyst' in def)` is satisfied by the substring inside
-- `'proxy_analyst'` and by the word in a comment; the quoted form is satisfied
-- only by the literal itself. Same defect stella_0002 closed as MIN-A.
DO $$
DECLARE
  write_oid oid;
  read_oid  oid;
  write_def text;
  read_def  text;
  problem   text;
BEGIN
  -- 0.1 Superuser — required to open the owner window this package needs.
  -- HOSTED VARIANT (Train 5B, generated — do not edit by hand).
  -- The superuser check below was replaced by a capability assertion installed by
  -- db/prepared/stella_hosted_0001_managed_role_bootstrap.sql. Original message,
  -- preserved verbatim so the refusal it encoded stays reviewable:
  --   stella_0019 aborted: must run as a SUPERUSER (current_user=%). It republishes a function owned by uellix_owner, which requires becoming that role and holding CREATE on schema public for the length of one statement.
  PERFORM uellix_bootstrap.assert_hosted_capabilities('stella_0019_storage_write_roles');

  -- 0.2 The owner role must exist. Without it the window in §1 cannot open and
  --     the failure would arrive as a bare `role "uellix_owner" does not exist`
  --     halfway through, after the guards had all reported green.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0019 aborted: role uellix_owner does not exist. Apply db/prepared/stella_0004_role_separation.sql (local) or stella_hosted_0001_managed_role_bootstrap.sql (managed) first.';
  END IF;

  -- 0.3 Both helpers, resolved by catalog join rather than to_regprocedure, so
  --     the question can be ASKED without USAGE on anything.
  SELECT p.oid INTO write_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_write_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  IF write_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0019 aborted: public.can_write_evidence_object(text, uuid) does not exist with the expected argument names. This package republishes that exact signature IN PLACE and will not create one the baseline did not.';
  END IF;

  SELECT p.oid INTO read_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_read_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  IF read_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0019 aborted: public.can_read_evidence_object(text, uuid) does not exist. This package asserts that the READ helper is byte-identical before and after; with no sibling to compare, "unchanged" is a claim about nothing.';
  END IF;

  write_def := regexp_replace(pg_catalog.pg_get_functiondef(write_oid), '-{2}[^\n]*', '', 'g');
  read_def  := regexp_replace(pg_catalog.pg_get_functiondef(read_oid),  '-{2}[^\n]*', '', 'g');

  -- 0.4 The body about to be overwritten must be in one of exactly TWO states:
  --     the defect, or this package already applied. A third state is a body
  --     somebody edited by hand, and `CREATE OR REPLACE` over it would destroy
  --     that edit without ever naming it.
  IF position('''organization_admin''' in write_def) = 0
     OR position('''analyst''' in write_def) = 0 THEN
    RAISE EXCEPTION 'stella_0019 aborted: can_write_evidence_object does not authorise organization_admin and analyst. Neither the baseline body nor the body this package publishes can be missing those two, so this is a body stella_0019 did not write and did not expect.';
  END IF;

  IF (position('''impact_manager''' in write_def) > 0)
     <> (position('''super_admin''' in write_def) > 0) THEN
    RAISE EXCEPTION 'stella_0019 aborted: can_write_evidence_object names exactly one of impact_manager / super_admin. The contract adds the two together; a body with one of them was written by something other than this package.';
  END IF;

  IF position('''reviewer''' in write_def) > 0 OR position('''viewer''' in write_def) > 0 THEN
    RAISE EXCEPTION 'stella_0019 aborted: can_write_evidence_object already names reviewer or viewer. Those two are BELOW the upload threshold in lib/auth/permissions.ts, so this package would republish a narrower list over a wider one and report success.';
  END IF;

  -- 0.5 The READ helper must NOT filter on role, which is what makes it the
  --     read helper. Asserted before the change so that §2's "unchanged" is a
  --     statement about a known starting point.
  IF position('om.role' in read_def) > 0 THEN
    RAISE EXCEPTION 'stella_0019 aborted: can_read_evidence_object filters on om.role. The baseline read helper admits any active member; a role filter there is a posture this package neither created nor is allowed to preserve silently.';
  END IF;

  -- 0.6 Owner, definer posture and search_path — the three properties this
  --     package must leave EXACTLY as it found them. Asserted BEFORE the change
  --     because `CREATE OR REPLACE` preserves all three, which means it would
  --     also preserve a WRONG one and report success.
  --
  --     This is the precondition the M-2 read-only audit predicted would fail:
  --     it held that the two helpers might still be owned by the `postgres`
  --     superuser that created them in unit 41, in which case the owner window
  --     below could not replace them. MEASURED on a restored baseline, that is
  --     false — stella_0004 §495-496 issues `ALTER FUNCTION … OWNER TO
  --     uellix_owner` for both. The guard stays because the hypothesis was
  --     reasonable and a database where it IS true must refuse rather than
  --     transfer ownership by accident.
  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = write_oid)
     <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_0019 aborted: can_write_evidence_object is owned by %, not uellix_owner. The owner window below becomes that role to republish the body; over a differently-owned function it would either fail or transfer ownership by accident. Apply stella_0004 (local) or stella_hosted_0001 (managed) first.',
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = write_oid);
  END IF;

  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = read_oid)
     <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_0019 aborted: can_read_evidence_object is owned by %, not uellix_owner. The two helpers were published and transferred together; a split ownership is a state this package cannot account for.',
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = read_oid);
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = write_oid) THEN
    RAISE EXCEPTION 'stella_0019 aborted: can_write_evidence_object is not SECURITY DEFINER. It is invoked from a policy on storage.objects by `authenticated`, which can read neither public.projects nor public.organization_members; over an INVOKER function this package would republish a check that always answers false.';
  END IF;

  -- BOTH SPELLINGS. MEASURED on PostgreSQL 17.6 and already recorded by
  -- grounding_0002 §9: the server normalises `SET search_path = ''` into
  -- proconfig as `search_path=""` — it QUOTES the empty value — while other
  -- versions store the bare `search_path=`. A check written for one form
  -- refuses a function that is correctly configured.
  IF NOT (SELECT coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=']::text[]
               OR coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[]
          FROM pg_catalog.pg_proc p WHERE p.oid = write_oid) THEN
    RAISE EXCEPTION 'stella_0019 aborted: can_write_evidence_object does not carry SET search_path = ''''. Every name in the body this package publishes is schema-qualified on the assumption that nothing resolves without one.';
  END IF;

  -- 0.7 The USAGE stella_0005d granted. Without it `storage.foldername()` raises
  --     inside the definer, the body's own `EXCEPTION WHEN OTHERS RETURN false`
  --     swallows it, and EVERY evidence object operation is refused — for all
  --     four roles. Applying a role fix onto that database would produce a
  --     package that reports success over a surface that still denies
  --     everything, and the next audit would blame the role list.
  IF NOT has_schema_privilege('uellix_owner', 'storage', 'USAGE') THEN
    RAISE EXCEPTION 'stella_0019 aborted: uellix_owner has no USAGE on schema storage, so both helpers already return false for every caller (stella_0005d). Fixing the role list first would report success over a surface that denies everyone. Apply db/prepared/stella_0005d_storage_definer_repair.sql first.';
  END IF;

  -- 0.8 The three policies this package must not disturb. Their presence is the
  --     reason the helper matters at all: a role list nothing consults is not a
  --     permission contract.
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('select_evidence', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'select_evidence')),
    ('insert_evidence', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'insert_evidence')),
    ('delete_evidence', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'delete_evidence'))
  ) AS m(what, present)
  WHERE NOT m.present;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0019 aborted: the baseline storage policies are not all present. Missing: %. This package changes a helper those policies invoke; without them it would edit an authorisation nothing reads.', problem;
  END IF;

  -- 0.9 CAPTURE, for §2 to compare against. Transaction-local settings, so they
  --     cannot leak into a later session and cannot be pre-seeded by one.
  --
  --     WHY A CAPTURED DIGEST AND NOT A PINNED CONSTANT. The ACL of these two
  --     functions is NOT the same on every database: on a stack where unit 41
  --     ran as `postgres` and stella_0004 transferred ownership afterwards, the
  --     old owner keeps a residual `postgres=X/uellix_owner` entry that a stack
  --     installed by uellix_migrator never had. Pinning the local spelling would
  --     make the package refuse a correctly-provisioned managed project. What
  --     must hold is that this package changed NOTHING — which is a comparison,
  --     not a constant.
  PERFORM set_config('stella_0019.write_acl',
    (SELECT coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type), '')
     FROM pg_catalog.pg_proc p,
          aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
     WHERE p.oid = write_oid), true);

  PERFORM set_config('stella_0019.read_fingerprint',
    (SELECT md5(read_def || '|' ||
                coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type), ''))
     FROM pg_catalog.pg_proc p,
          aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
     WHERE p.oid = read_oid), true);

  PERFORM set_config('stella_0019.storage_policies',
    (SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' ||
                                    coalesce(qual, '') || '|' || coalesce(with_check, ''),
                                    E'\n' ORDER BY policyname), ''))
     FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'), true);
END $$;
-- authority: open W54.S1 (OWNER) as uellix_owner
SET ROLE uellix_owner;
CREATE OR REPLACE FUNCTION public.can_write_evidence_object(object_name text, user_id uuid)
RETURNS boolean
SECURITY DEFINER
SET search_path = ''
LANGUAGE plpgsql AS $$
DECLARE
    project_id_str text;
    has_access boolean;
BEGIN
    -- Avoid executing if tables do not exist yet (during initial Supabase start)
    IF to_regclass('public.projects') IS NULL OR to_regclass('public.organization_members') IS NULL THEN
        RETURN false;
    END IF;

    -- Extract project ID from path: projectId/evidenceId/filename
    project_id_str := (storage.foldername(object_name))[1];
    IF project_id_str IS NULL OR project_id_str = '' THEN
        RETURN false;
    END IF;

    -- M-2. Validate access against the CANONICAL evidence-upload contract: the
    -- four roles at or above `analyst` in lib/auth/roles.ts ROLE_HIERARCHY,
    -- which are the same four db/migrations/0031_rls_core.sql names in
    -- evidence_items_insert. The baseline list here was
    -- ('organization_admin','analyst'), which refused impact_manager and
    -- super_admin the object while the table accepted their row.
    SELECT EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.organization_members om ON om.organization_id = p.organization_id
        WHERE
            p.id::text = project_id_str AND
            om.user_id = can_write_evidence_object.user_id AND
            om.status = 'active' AND
            om.role IN ('super_admin', 'organization_admin', 'impact_manager', 'analyst')
    ) INTO has_access;

    RETURN has_access;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;
RESET ROLE;
-- authority: close W54.S1
-- NOTE ON WHAT IS DELIBERATELY ABSENT HERE.
-- No `ALTER FUNCTION ... OWNER TO`, no `REVOKE EXECUTE ... FROM PUBLIC, anon`
-- and no `GRANT EXECUTE ... TO authenticated`. `CREATE OR REPLACE FUNCTION`
-- preserves the owner and the ACL of the function it replaces, so all three
-- would be no-ops in the ordinary case — and in the case that matters they
-- would be worse than no-ops: re-stating them would REPAIR an ownership or a
-- grant that had drifted, silently, and this package would report success over
-- a database whose posture it had quietly changed. §2 MEASURES all three
-- against what §0 captured instead, and refuses.

-- ============================================================
-- 2. Self-verification — assert the end state, in this transaction
-- ============================================================
-- Read from pg_catalog, in the same transaction that made the change, so a
-- failure here rolls the change back rather than reporting on it afterwards.
DO $$
DECLARE
  write_oid oid;
  read_oid  oid;
  write_def text;
  read_def  text;
  problem   text;
  captured  text;
  observed  text;
BEGIN
  SELECT p.oid INTO write_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_write_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  IF write_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object(text, uuid) does not exist after the script ran';
  END IF;

  SELECT p.oid INTO read_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_read_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  write_def := regexp_replace(pg_catalog.pg_get_functiondef(write_oid), '-{2}[^\n]*', '', 'g');
  read_def  := regexp_replace(pg_catalog.pg_get_functiondef(read_oid),  '-{2}[^\n]*', '', 'g');

  -- (1) THE FOUR ROLES ARE PRESENT, each named individually. A single check for
  --     "the list changed" would pass over a list that gained one of the two.
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('super_admin',        position('''super_admin'''        in write_def) > 0),
    ('organization_admin', position('''organization_admin''' in write_def) > 0),
    ('impact_manager',     position('''impact_manager'''     in write_def) > 0),
    ('analyst',            position('''analyst'''            in write_def) > 0)
  ) AS m(what, present)
  WHERE NOT m.present;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object does not authorise %. M-2 is not closed.', problem;
  END IF;

  -- (2) AND THE TWO BELOW THE THRESHOLD ARE STILL ABSENT. This is the half that
  --     turns "the fix landed" into "the fix landed and nothing else did".
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('reviewer', position('''reviewer''' in write_def) > 0),
    ('viewer',   position('''viewer'''   in write_def) > 0)
  ) AS m(what, present)
  WHERE m.present;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object now authorises %, which lib/auth/permissions.ts places BELOW the evidence-upload threshold. This package widens a list by exactly two roles.', problem;
  END IF;

  -- (3) The path parse is untouched. The role list is the only delta, and a
  --     body that also changed how a project id is derived from an object name
  --     would satisfy (1) and (2) while silently re-scoping every check.
  IF position('(storage.foldername(object_name))[1]' in write_def) = 0 THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object no longer derives the project id from (storage.foldername(object_name))[1]. The role list is the only change this package is allowed to make.';
  END IF;

  IF position('om.status = ''active''' in write_def) = 0 THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object no longer requires an ACTIVE membership. A dropped status filter would let a removed member keep writing.';
  END IF;

  IF position('p.id::text = project_id_str' in write_def) = 0 THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object no longer binds the project row to the parsed path segment. Without that join the check stops being per-project.';
  END IF;

  -- (4) No platform-super-admin escape was introduced. See the header: the two
  --     evidence_items policies carry one and these helpers deliberately do not.
  IF position('current_user_is_super_admin' in write_def) > 0 THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object calls current_user_is_super_admin(). That would let a platform super admin with NO active membership write objects into an organisation bucket — a capability the read helper does not grant and this package was not asked for.';
  END IF;

  -- (5) Owner UNCHANGED. `CREATE OR REPLACE` preserves it, which is exactly why
  --     it is measured: a preserved wrong owner reports success.
  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = write_oid)
     <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object is owned by %, not uellix_owner',
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = write_oid);
  END IF;

  -- (6) SECURITY DEFINER and the empty search_path, both unchanged. Both
  --     spellings again — see §0.6.
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = write_oid) THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object is no longer SECURITY DEFINER';
  END IF;

  IF NOT (SELECT coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=']::text[]
               OR coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[]
          FROM pg_catalog.pg_proc p WHERE p.oid = write_oid) THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_write_evidence_object no longer carries SET search_path = ''''';
  END IF;

  -- (7) The argument names, as a WHOLE ARRAY with IS DISTINCT FROM. The body
  --     references `can_write_evidence_object.user_id` by name, so a rename
  --     would silently re-bind that comparison to the column of the same name.
  IF (SELECT p.proargnames FROM pg_catalog.pg_proc p WHERE p.oid = write_oid)
     IS DISTINCT FROM ARRAY['object_name', 'user_id'] THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: the argument names are %, not the two unit 41 published',
      (SELECT p.proargnames::text FROM pg_catalog.pg_proc p WHERE p.oid = write_oid);
  END IF;

  -- (8) THE ACL, LITERALLY AND UNCHANGED. Compared against what §0 captured on
  --     this same database rather than against a pinned spelling, because the
  --     residual `postgres` entry a locally-provisioned stack carries is absent
  --     from one installed by uellix_migrator, and both are correct.
  captured := current_setting('stella_0019.write_acl', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: §0 did not record the ACL of can_write_evidence_object, so "unchanged" cannot be evaluated. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type), '')
    INTO observed
  FROM pg_catalog.pg_proc p,
       aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
  WHERE p.oid = write_oid;

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: the EXECUTE ACL of can_write_evidence_object changed from [%] to [%]. This package issues no GRANT and no REVOKE; any difference is CREATE OR REPLACE failing to preserve what it promises to preserve.', captured, observed;
  END IF;

  -- (9) AND PUBLIC STILL HOLDS NOTHING. Stated separately from (8) because (8)
  --     only proves the ACL did not MOVE — on a database where PUBLIC already
  --     held EXECUTE, an unchanged ACL is an unchanged defect.
  --
  --     `coalesce(rolname,'PUBLIC')` is inside the filter because aclexplode
  --     reports a PUBLIC grant with grantee 0 and the LEFT JOIN leaves rolname
  --     NULL, so a filter on the name alone would drop the one row it exists to
  --     catch.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p,
         aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
    WHERE p.oid = write_oid
      AND coalesce(g.rolname, 'PUBLIC') IN ('PUBLIC', 'anon')
  ) THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: PUBLIC or anon holds a privilege on can_write_evidence_object. Unit 41 revokes both; an unchanged ACL that already carried one is an unchanged defect.';
  END IF;

  IF NOT has_function_privilege('authenticated', write_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: `authenticated` can no longer execute can_write_evidence_object. The three storage policies are TO authenticated and call it by name, so a preserved-but-empty ACL would deny every upload — the class of defect this package closes, in a different place.';
  END IF;

  -- (10) THE READ HELPER IS BYTE-IDENTICAL, definition and ACL together. This
  --      package must not alter read behaviour, and "we did not write a
  --      statement about it" is not evidence: a fingerprint taken before and
  --      compared after is.
  captured := current_setting('stella_0019.read_fingerprint', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: §0 did not record the fingerprint of can_read_evidence_object. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT md5(read_def || '|' ||
             coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type), ''))
    INTO observed
  FROM pg_catalog.pg_proc p,
       aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
  WHERE p.oid = read_oid;

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: can_read_evidence_object changed. Its definition or its ACL is not what it was when this transaction opened, and this package is not allowed to touch either.';
  END IF;

  -- (11) THE THREE STORAGE POLICIES ARE UNCHANGED — name, command, roles,
  --      USING and WITH CHECK. This is the measurement behind
  --      STORAGE_POLICIES_CHANGED=false: the policies keep calling the helper by
  --      name, so replacing the body is the whole deployment and no policy has
  --      to be recreated. A package that quietly dropped and recreated one would
  --      pass every other check in this block.
  captured := current_setting('stella_0019.storage_policies', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: §0 did not record the storage.objects policies. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' ||
                                 coalesce(qual, '') || '|' || coalesce(with_check, ''),
                                 E'\n' ORDER BY policyname), ''))
    INTO observed
  FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: the policies on storage.objects changed while this package ran. It republishes a function body and must recreate no policy.';
  END IF;

  -- (12) AND THEY STILL INVOKE THE HELPER. Unchanged is not enough on its own:
  --      a database whose policies never called can_write_evidence_object would
  --      also report "unchanged", and this package would have edited an
  --      authorisation nothing reads.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'insert_evidence'
      AND coalesce(with_check, '') LIKE '%can_write_evidence_object%'
  ) THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: the insert_evidence policy on storage.objects does not call can_write_evidence_object. The body this package published governs nothing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'delete_evidence'
      AND coalesce(qual, '') LIKE '%can_write_evidence_object%'
  ) THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: the delete_evidence policy on storage.objects does not call can_write_evidence_object.';
  END IF;

  -- (13) The installer gave the owner role back. `SET ROLE` in §1 is undone by
  --      an explicit RESET; a session that stayed as uellix_owner would run
  --      every later statement of a multi-file window under the wrong identity.
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'stella_0019 FAILED verification: the session is still running as % rather than %. The owner window opened in §1 was not closed.',
      current_user, session_user;
  END IF;

  RAISE NOTICE 'stella_0019: verification passed — can_write_evidence_object republished in place authorising super_admin, organization_admin, impact_manager and analyst; reviewer and viewer still refused; path parse, active-membership filter and project binding unchanged; owner, ACL, SECURITY DEFINER, search_path and argument names unchanged; can_read_evidence_object byte-identical; the three storage.objects policies unchanged and still invoking the helper.';
END $$;
