-- ============================================================================
-- stella_hosted_0005_storage_helper_table_read.sql
-- M-2 — the third and last prechain prerequisite of the Storage helpers.
-- ============================================================================
--
-- PREPARED ONLY — NOT A MIGRATION. FORWARD-ONLY: no rollback file, typed in
-- db/hosted/forward-only-packages.ts.
--
-- PRECHAIN ADMINISTRATIVE UNIT. NOT a member of HOSTED_CHAIN.
--
-- ----------------------------------------------------------------------------
-- WHAT BROKE, AND WHY THE PAIR BEFORE IT WAS NOT ENOUGH
-- ----------------------------------------------------------------------------
-- stella_hosted_0003 gives the two helpers to `uellix_owner`. stella_hosted_0004
-- gives that owner USAGE on schema `storage` so their bodies can resolve
-- `storage.foldername(name)`. Both were verified, and the surface was still
-- dead — for every role, on read AND on write.
--
-- MEASURED on the certification shape (baseline 50 -> stella_hosted_0001 ->
-- 0003 -> 0004), 2026-08-15:
--
--   owner of both helpers                                     uellix_owner
--   has_schema_privilege(uellix_owner,'storage','USAGE')      true
--   has_table_privilege(uellix_owner,'public.projects',...)   true
--   has_table_privilege(uellix_owner,
--                       'public.organization_members','SELECT')  FALSE
--
-- and, driven through the REAL policies on storage.objects as `authenticated`
-- with a real request.jwt.claim.sub, all nine cases of the role matrix:
--
--   super_admin organization_admin impact_manager analyst
--   reviewer viewer inactive no-membership cross-org
--     -> write DENY, read DENY.  Every one of them.
--
-- Both helper bodies read TWO relations, not one:
--
--     FROM public.projects p
--     JOIN public.organization_members om ON om.organization_id = p.organization_id
--
-- As SECURITY DEFINER those reads happen with the OWNER's privileges. Missing
-- SELECT on either one raises `permission denied for table ...` INSIDE the
-- definer, where the bodies' own `EXCEPTION WHEN OTHERS THEN RETURN false`
-- swallows it and answers false for every caller, silently — the identical
-- failure mode stella_hosted_0004 closes one schema earlier, in a second place
-- nobody had measured.
--
-- ----------------------------------------------------------------------------
-- WHY ONE TABLE AND NOT TWO, WHICH IS THE WHOLE QUESTION
-- ----------------------------------------------------------------------------
-- Because `public.projects` IS already covered, and by something that predates
-- this package. stella_hosted_0001 §7 issues
--
--     GRANT SELECT, REFERENCES ON TABLE public.projects TO uellix_owner
--       WITH GRANT OPTION;
--
-- alongside the same for `organizations`, `evidence_items` and `users`. That
-- list is derived from a DIFFERENT question — the bootstrap says so in its own
-- refusal text: "the governed chain runs twelve statements against these
-- objects as uellix_owner". It is the CHAIN's read surface, and it is correct
-- for the chain.
--
-- `public.organization_members` is not on it because no chain package touches
-- that table. Nothing was overlooked when the list was written: at that moment
-- the helpers were still owned by `postgres`, which owns both tables outright
-- and needs no grant to read them. stella_hosted_0003 changed WHO executes
-- those bodies, and that silently moved a relation into the required-read set
-- that no list recomputed. This package recomputes it, for exactly the one
-- relation the recomputation adds.
--
-- ----------------------------------------------------------------------------
-- THE SECOND HALF OF THE READ SURFACE: RLS, WHICH IS NOT A GRANT
-- ----------------------------------------------------------------------------
-- Worth stating because it is the reason this package does NOT grant more.
-- MEASURED: both tables have RLS ENABLED, both are owned by `postgres`, and
-- `uellix_owner` has rolbypassrls = false — so the row-level policies apply to
-- the definer too, and their SELECT policies read
--
--     organization_id = ANY (current_user_org_ids()) OR current_user_is_super_admin()
--
-- Those two functions are themselves SECURITY DEFINER owned by `postgres`, and
-- stella_hosted_0001 §7 already grants `uellix_owner` EXECUTE on both WITH
-- GRANT OPTION. So the row filter resolves correctly and needs nothing from
-- here — §0.6 ASSERTS that rather than assuming it, because a missing EXECUTE
-- there produces the same silent false, and would do so only for some callers.
--
-- A consequence worth recording, because it makes one obvious probe worthless:
-- `current_user_org_ids()` reads `auth.uid()`, i.e. request.jwt.claim.sub. A
-- session with no claim set sees NO rows through those policies, so
--
--     SELECT public.can_write_evidence_object('<project>/e/f.txt', '<uuid>');
--
-- returns false from an ordinary administrative psql session even on a database
-- where this package has been applied and every upload works. MEASURED, both
-- ways: false with no claim, true with the claim set. A certification that
-- probed the helper that way would report DENY-for-all on a healthy database
-- and could not tell it apart from the outage above. That is why the functional
-- probe drives the storage.objects policies as `authenticated` with a real
-- claim, and does not call the function bare.
--
-- ----------------------------------------------------------------------------
-- WHY IT IS A SEPARATE PACKAGE FROM 0003 AND 0004
-- ----------------------------------------------------------------------------
-- The same reason 0004 is separate from 0003, applied once more. Each answers a
-- different question about a different object class — who owns our function,
-- may our owner resolve a name in the platform's schema, may our owner read our
-- own table — and each of the two earlier packages states in its own pinned
-- contract what it does NOT do. stella_hosted_0003: "It also does NOT grant
-- uellix_owner USAGE on schema storage". stella_hosted_0004: "No table
-- privilege in storage is granted". Both are INSTALLED and recorded in
-- artifacts/hosted-remediation-attempts.jsonl; editing either would make the
-- installed artefact and the repository disagree about what ran, and would
-- retire the only sentence a reviewer can check them against.
--
-- ----------------------------------------------------------------------------
-- WHY THERE IS NO ROLLBACK
-- ----------------------------------------------------------------------------
-- Revoking it re-opens exactly the outage described above — every evidence
-- object operation refused, silently, for every role — on a project whose
-- helpers uellix_owner now owns and whose USAGE it now holds. "Restore the
-- previous state" and "return the Storage surface to denying everyone without
-- saying so" are the same sentence. Deliberate reversal is a single
-- administrative REVOKE by the same principal, taken with the consequence
-- visible at the time.
--
-- RUN AS ONE TRANSACTION, AS THE ADMINISTRATIVE IDENTITY:
--   psql "$ADMIN_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent: re-granting a privilege already held changes nothing.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (administrative window)
-- ============================================================
DO $$
BEGIN
  -- 0.1 The role the grant is for.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: role uellix_owner does not exist. Apply stella_hosted_0001_managed_role_bootstrap.sql first.';
  END IF;

  -- 0.2 The table this grants on. Named, not discovered: a package that granted
  --     on whatever it happened to find would have no contract at all.
  IF to_regclass('public.organization_members') IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: public.organization_members does not exist. It is a baseline table; apply the fifty baseline units first.';
  END IF;

  -- 0.3 THE FUNCTIONS THIS EXISTS TO SERVE, and their owner — the dependency on
  --     stella_hosted_0003. Applying this first would grant a table privilege to
  --     a role that does not yet execute anything needing it, and would leave an
  --     ordering nobody reviewed. BOTH helpers, because both read both tables and
  --     the read helper being silently dead is half of what was measured.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'can_read_evidence_object'
      AND p.prosecdef
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'uellix_owner'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'can_write_evidence_object'
      AND p.prosecdef
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'uellix_owner'
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: both Storage helpers must exist, be SECURITY DEFINER and be owned by uellix_owner before this grant means anything. Apply stella_hosted_0003_storage_helper_ownership.sql first.';
  END IF;

  -- 0.4 THE ORDERING AGAINST stella_hosted_0004, stated as a refusal rather than
  --     as a comment. Granting the table read over a surface that still cannot
  --     resolve storage.foldername() would close the second of two holes and
  --     report success while the first one still denies everyone — the precise
  --     failure this package exists because of.
  IF NOT has_schema_privilege('uellix_owner', 'storage', 'USAGE') THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: uellix_owner has no USAGE on schema storage, so both helpers already return false for every caller regardless of any table privilege. Apply stella_hosted_0004_storage_schema_usage.sql first.';
  END IF;

  -- 0.5 THE OTHER HALF OF THE READ SURFACE, asserted and not granted. If this
  --     ever fails, the bootstrap's §7 grant list did not run or was revoked,
  --     and the right repair is there and not here — this package would
  --     otherwise quietly become the owner of a privilege another package
  --     declares.
  IF NOT has_table_privilege('uellix_owner', 'public.projects', 'SELECT') THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: uellix_owner cannot SELECT public.projects, which both helper bodies read in the same statement as organization_members. That privilege is issued by stella_hosted_0001 §7 (GRANT SELECT, REFERENCES ON TABLE public.projects TO uellix_owner WITH GRANT OPTION); this package grants one privilege on one table and will not silently stand in for that one.';
  END IF;

  -- 0.6 THE RLS DEPENDENCY, asserted for the same reason. Both tables have RLS
  --     enabled and uellix_owner neither owns them nor holds BYPASSRLS, so their
  --     SELECT policies run for the definer too and call these two. Missing
  --     EXECUTE on either raises inside the definer and is swallowed identically
  --     — and, because the policy is an OR, would do so only for SOME callers,
  --     which is worse than failing for all of them.
  IF NOT has_function_privilege('uellix_owner', 'public.current_user_org_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: uellix_owner cannot execute public.current_user_org_ids(), which the SELECT policies on both projects and organization_members invoke. Granted by stella_hosted_0001 §7; a SELECT privilege alone would not make the helpers answer true.';
  END IF;

  IF NOT has_function_privilege('uellix_owner', 'public.current_user_is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: uellix_owner cannot execute public.current_user_is_super_admin(), the second disjunct of the same SELECT policies. Granted by stella_hosted_0001 §7.';
  END IF;

  -- 0.7 THE CAPABILITY, asked rather than assumed. SELECT can be passed on by the
  --     table's owner, by a superuser, or by a role holding it WITH GRANT OPTION;
  --     anything else would fail three lines later with a bare permission error.
  IF NOT (
    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
    OR pg_catalog.pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.organization_members'::regclass), 'USAGE')
    OR EXISTS (
      SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = 'public.organization_members'::regclass
        AND a.privilege_type = 'SELECT'
        AND a.is_grantable
        AND pg_catalog.pg_has_role(current_user, a.grantee, 'USAGE')
    )
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: the current session (%) cannot pass on SELECT for public.organization_members. On managed Supabase apply this as postgres, which owns the baseline tables.', current_user;
  END IF;

  -- 0.8 UNKNOWN POSTURE ABORTS. The only two states this package can account for
  --     are "SELECT missing" and "SELECT already present, nothing else". A role
  --     that already holds a WRITE privilege on this table got it from something
  --     that is not in this repository, and §2's "no write privilege was added"
  --     would then be measuring a widening it did not cause and cannot see.
  IF has_table_privilege('uellix_owner', 'public.organization_members', 'INSERT')
     OR has_table_privilege('uellix_owner', 'public.organization_members', 'UPDATE')
     OR has_table_privilege('uellix_owner', 'public.organization_members', 'DELETE')
     OR has_table_privilege('uellix_owner', 'public.organization_members', 'TRUNCATE') THEN
    RAISE EXCEPTION 'stella_hosted_0005 aborted: uellix_owner already holds a WRITE privilege on public.organization_members. No package in this repository grants that, so the posture is one this package cannot account for and must not normalise. Resolve it deliberately, then re-run.';
  END IF;

  -- 0.9 CAPTURE, for §2 to compare against. Transaction-local, so they cannot
  --     leak into a later session and cannot be pre-seeded by one. The two
  --     function fingerprints are here because the loudest way this package
  --     could go wrong is by touching the objects it exists to serve.
  PERFORM set_config('stella_hosted_0005.app_had_select',
    has_table_privilege('uellix_app', 'public.organization_members', 'SELECT')::text, true);
  PERFORM set_config('stella_hosted_0005.migrator_had_select',
    has_table_privilege('uellix_migrator', 'public.organization_members', 'SELECT')::text, true);

  -- THE WHOLE READ SURFACE OF uellix_owner IN SCHEMA public, not a hand-picked
  -- canary list. §2 requires the delta to be exactly one relation, so "this
  -- package granted on one table" is measured against every table there is
  -- rather than against three somebody chose — and a list chosen by hand would
  -- have been wrong here anyway: uellix_owner OWNS public.stella_interactions
  -- (stella_hosted_0001 §2c) and therefore reads it implicitly.
  PERFORM set_config('stella_hosted_0005.select_surface',
    (SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND has_table_privilege('uellix_owner', c.oid, 'SELECT')), true);

  PERFORM set_config('stella_hosted_0005.helpers',
    (SELECT md5(string_agg(
        p.proname || '|' || pg_catalog.pg_get_functiondef(p.oid) || '|' ||
        pg_catalog.pg_get_userbyid(p.proowner) || '|' ||
        coalesce(p.proacl::text, ''), E'\n' ORDER BY p.proname))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('can_read_evidence_object', 'can_write_evidence_object')), true);

  PERFORM set_config('stella_hosted_0005.storage_policies',
    (SELECT coalesce(md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' ||
                                    coalesce(qual, '') || '|' || coalesce(with_check, ''),
                                    E'\n' ORDER BY policyname)), '')
     FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'), true);
END $$;

-- ============================================================
-- 1. The grant, and nothing else
-- ============================================================
-- ONE PRIVILEGE ON ONE TABLE. No INSERT, no UPDATE, no DELETE, no TRUNCATE, no
-- REFERENCES, no TRIGGER, no GRANT OPTION — the owner never passes this on, and
-- an option nobody needs is an option somebody will eventually use.
GRANT SELECT ON TABLE public.organization_members TO uellix_owner;

-- ============================================================
-- 2. Postconditions — the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  captured text;
  observed text;
  problem  text;
BEGIN
  -- (1) THE PRIVILEGE THIS PACKAGE EXISTS FOR.
  IF NOT has_table_privilege('uellix_owner', 'public.organization_members', 'SELECT') THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: uellix_owner still cannot SELECT public.organization_members.';
  END IF;

  -- (2) AND NOTHING ELSE ON IT. The list is exhaustive on purpose: naming only
  --     INSERT/UPDATE/DELETE would leave TRUNCATE, REFERENCES and TRIGGER as
  --     three ways to widen this package without failing its own check.
  SELECT string_agg(m.priv, ', ' ORDER BY m.priv) INTO problem
  FROM (VALUES
    ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
  ) AS m(priv)
  WHERE has_table_privilege('uellix_owner', 'public.organization_members', m.priv);

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: uellix_owner holds % on public.organization_members. This package grants SELECT and only SELECT.', problem;
  END IF;

  -- (3) NOT GRANTABLE. Issued without WITH GRANT OPTION, and measured rather
  --     than trusted to the syntax.
  IF EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.oid = 'public.organization_members'::regclass
      AND a.grantee = 'uellix_owner'::regrole
      AND a.privilege_type = 'SELECT'
      AND a.is_grantable
  ) THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: uellix_owner holds SELECT WITH GRANT OPTION on public.organization_members. It has no one to pass it to and was granted none.';
  END IF;

  -- (4) SCOPE, as a DELTA over every relation in schema public rather than over
  --     a list somebody chose. Exactly one relation may have been added, and it
  --     must be the one this package names. A second GRANT smuggled into §1 is
  --     caught here whatever it targets.
  captured := current_setting('stella_hosted_0005.select_surface', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: §0 did not record the read surface of uellix_owner, so "one table and no other" cannot be evaluated. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') INTO observed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND has_table_privilege('uellix_owner', c.oid, 'SELECT');

  SELECT string_agg(rel, ', ' ORDER BY rel) INTO problem
  FROM (
    SELECT unnest(string_to_array(nullif(observed, ''), ',')) AS rel
    EXCEPT
    SELECT unnest(string_to_array(nullif(captured, ''), ',')) AS rel
  ) AS added
  WHERE rel <> 'organization_members';

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: uellix_owner gained SELECT on %, which this package does not name. Its scope is public.organization_members alone.', problem;
  END IF;

  -- And nothing was REMOVED either. A package that revoked while granting would
  -- pass every check above.
  SELECT string_agg(rel, ', ' ORDER BY rel) INTO problem
  FROM (
    SELECT unnest(string_to_array(nullif(captured, ''), ',')) AS rel
    EXCEPT
    SELECT unnest(string_to_array(nullif(observed, ''), ',')) AS rel
  ) AS removed;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: uellix_owner LOST SELECT on %. This package issues no REVOKE.', problem;
  END IF;

  -- (5) THE RUNTIME ROLE, AND THE INSTALLER, EXACTLY WHERE THEY WERE. Compared
  --     against the captured values rather than asserted outright: a project
  --     that had already granted either got there some other way, and this
  --     package must not be the thing that silently changes it in EITHER
  --     direction.
  IF has_table_privilege('uellix_app', 'public.organization_members', 'SELECT')::text
     IS DISTINCT FROM current_setting('stella_hosted_0005.app_had_select', true) THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: uellix_app''s SELECT on public.organization_members changed while this package ran. It grants to uellix_owner and to nobody else.';
  END IF;

  IF has_table_privilege('uellix_migrator', 'public.organization_members', 'SELECT')::text
     IS DISTINCT FROM current_setting('stella_hosted_0005.migrator_had_select', true) THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: uellix_migrator''s SELECT on public.organization_members changed while this package ran.';
  END IF;

  -- (6) THE HELPERS ARE UNTOUCHED — definition, owner and ACL, all three, as one
  --     fingerprint. This package issues no CREATE OR REPLACE, no ALTER FUNCTION
  --     and no GRANT on a function; the whole functional change stays in T11, on
  --     the governed path.
  captured := current_setting('stella_hosted_0005.helpers', true);
  IF captured IS NULL OR captured = '' THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: §0 did not record the helper fingerprint, so "unchanged" cannot be evaluated. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT md5(string_agg(
      p.proname || '|' || pg_catalog.pg_get_functiondef(p.oid) || '|' ||
      pg_catalog.pg_get_userbyid(p.proowner) || '|' ||
      coalesce(p.proacl::text, ''), E'\n' ORDER BY p.proname))
    INTO observed
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('can_read_evidence_object', 'can_write_evidence_object');

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: the body, owner or ACL of a Storage helper changed while this package ran. It grants one table privilege and touches no function.';
  END IF;

  -- (7) AND THE POLICIES THAT INVOKE THEM.
  captured := current_setting('stella_hosted_0005.storage_policies', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: §0 did not record the storage.objects policies. The two blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT coalesce(md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' ||
                                 coalesce(qual, '') || '|' || coalesce(with_check, ''),
                                 E'\n' ORDER BY policyname)), '')
    INTO observed
  FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0005 FAILED verification: the policies on storage.objects changed while this package ran. It recreates no policy.';
  END IF;

  RAISE NOTICE 'stella_hosted_0005: verification passed — uellix_owner holds SELECT (and only SELECT, not grantable) on public.organization_members; no other relation moved; uellix_app and uellix_migrator are unchanged; both helpers and all storage.objects policies are byte-identical to what this transaction opened with.';
END $$;
