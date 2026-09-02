-- db/prepared/stella_0019_rollback.sql
-- Rollback of stella_0019_storage_write_roles.sql.
--
-- PREPARED ONLY — NOT A MIGRATION.
--
-- ============================================================================
-- WHY THIS ROLLBACK EXISTS WHEN THE LAST THREE REPAIRS SHIPPED WITHOUT ONE
-- ============================================================================
-- grounding_0005, stella_0016 and stella_0017 are forward-only because undoing
-- them would REOPEN a vulnerability — "restore the previous body" and
-- "republish the defect" were the same sentence, and a script whose only effect
-- is to make a governed surface exploitable again is not a revert.
--
-- The direction here is the opposite one. stella_0019 WIDENS an authorisation
-- from two roles to four; this script NARROWS it back to the two unit 41
-- published. A database that has run this script refuses MORE than it did a
-- moment earlier, never less. There is no input under which it grants anybody
-- anything, so db/prepared/README.md rule 4 applies with no exemption and
-- db/hosted/forward-only-packages.ts is deliberately not involved.
--
-- ============================================================================
-- WHAT IT RESTORES, AND WHAT IT DELIBERATELY DOES NOT
-- ============================================================================
-- It restores the unit 41 body EXACTLY: same signature, same argument names,
-- same SECURITY DEFINER, same empty search_path, same guard, same path parse,
-- same EXCEPTION handler, and the two-role list.
--
-- It restores NO ownership and NO grant, for the same reason stella_0019 issues
-- none: `CREATE OR REPLACE FUNCTION` preserves owner and ACL, so re-stating
-- them would silently repair a drift instead of reporting it. §2 measures both
-- against what §0 captured.
--
-- IT DOES NOT TOUCH can_read_evidence_object AND IT DOES NOT TOUCH THE THREE
-- POLICIES ON storage.objects, because stella_0019 did not either. Both are
-- fingerprinted before and compared after.
--
-- WHAT COMES BACK IS THE DEFECT, AND THAT IS SAID PLAINLY RATHER THAN IMPLIED:
-- after this script, `impact_manager` and `super_admin` can once again create an
-- `evidence_items` row and NOT upload the object it describes, and the failure
-- surfaces to them as "new row violates row-level security policy" from the
-- Storage API. §2 ends with a RAISE NOTICE saying so. A rollback whose
-- postconditions asserted a SAFER state than the thing it reverts would be a
-- rollback that restores nothing — the asymmetry stella_0009 and stella_0011
-- both record.
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>

-- The comment-stripping regex below is spelled `-{2}` rather than `--` for the
-- reason stella_0019_storage_write_roles.sql states at length: the two are
-- identical to PostgreSQL and NOT identical to a reader that strips line
-- comments before it parses strings, which is every naive stripper including
-- the one in tests/prepared-stella-sql.test.ts.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (installer window)
-- ============================================================
DO $$
DECLARE
  write_oid oid;
  read_oid  oid;
  write_def text;
BEGIN
  -- 0.1 Superuser — the same owner window the forward package opens.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: must run as a SUPERUSER (current_user=%). It republishes a function owned by uellix_owner, which requires becoming that role and holding CREATE on schema public for the length of one statement.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: role uellix_owner does not exist. There is nothing here this script can own or replace.';
  END IF;

  SELECT p.oid INTO write_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_write_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  IF write_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: public.can_write_evidence_object(text, uuid) does not exist. This script republishes that exact signature IN PLACE and will not create one the baseline did not.';
  END IF;

  SELECT p.oid INTO read_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_read_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  IF read_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: public.can_read_evidence_object(text, uuid) does not exist, so the "read helper unchanged" postcondition cannot be evaluated.';
  END IF;

  write_def := regexp_replace(pg_catalog.pg_get_functiondef(write_oid), '-{2}[^\n]*', '', 'g');

  -- 0.2 Two recognised states, exactly as the forward package: stella_0019
  --     applied (the state this script undoes) or the baseline body already in
  --     place (which makes re-running this script converge instead of fail).
  --     Anything else is a hand-edited body, and `CREATE OR REPLACE` over it
  --     would destroy that edit without naming it.
  IF position('''organization_admin''' in write_def) = 0
     OR position('''analyst''' in write_def) = 0 THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: can_write_evidence_object does not authorise organization_admin and analyst. Neither the baseline body nor the stella_0019 body can be missing those two, so this is a body neither wrote.';
  END IF;

  IF (position('''impact_manager''' in write_def) > 0)
     <> (position('''super_admin''' in write_def) > 0) THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: can_write_evidence_object names exactly one of impact_manager / super_admin. stella_0019 adds the two together and the baseline has neither; a body with one of them was written by something else.';
  END IF;

  IF position('''reviewer''' in write_def) > 0 OR position('''viewer''' in write_def) > 0 THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: can_write_evidence_object names reviewer or viewer. Restoring the baseline body over that would remove an authorisation this script did not grant and cannot account for.';
  END IF;

  -- 0.3 Owner and definer posture — the properties this script must preserve.
  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = write_oid)
     <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: can_write_evidence_object is owned by %, not uellix_owner. The owner window below becomes that role; over a differently-owned function it would either fail or transfer ownership by accident.',
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = write_oid);
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = write_oid) THEN
    RAISE EXCEPTION 'stella_0019_rollback aborted: can_write_evidence_object is not SECURITY DEFINER, which is not a state either stella_0019 or unit 41 produced.';
  END IF;

  -- 0.4 CAPTURE, for §2. Same technique and same reason as the forward package:
  --     the ACL of these helpers differs legitimately between a stack where
  --     unit 41 ran as `postgres` and one installed by uellix_migrator, so what
  --     must hold is that THIS script changed nothing — a comparison, not a pin.
  PERFORM set_config('stella_0019_rollback.write_acl',
    (SELECT coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type), '')
     FROM pg_catalog.pg_proc p,
          aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
     WHERE p.oid = write_oid), true);

  PERFORM set_config('stella_0019_rollback.read_fingerprint',
    (SELECT md5(regexp_replace(pg_catalog.pg_get_functiondef(read_oid), '-{2}[^\n]*', '', 'g') || '|' ||
                coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type), ''))
     FROM pg_catalog.pg_proc p,
          aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
     WHERE p.oid = read_oid), true);

  PERFORM set_config('stella_0019_rollback.storage_policies',
    (SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' ||
                                    coalesce(qual, '') || '|' || coalesce(with_check, ''),
                                    E'\n' ORDER BY policyname), ''))
     FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'), true);
END $$;

-- ============================================================
-- 1. can_write_evidence_object, restored to the unit 41 body (owner window)
-- ============================================================
-- The body of supabase/migrations/20260716000001_storage_policies.sql,
-- including its comment, so a reader diffing this against the baseline sees
-- nothing but the file it came from — with ONE character of difference, stated
-- here rather than discovered later: unit 41 carries a TRAILING SPACE after
-- `WHERE` on the line that opens the EXISTS predicate, and this file does not
-- reproduce it. PostgreSQL cannot observe the difference (it is whitespace
-- inside a statement, and `prosrc` is stored as written either way), and
-- reintroducing it would mean committing trailing whitespace that
-- `git diff --check` flags. The equivalence that matters is behavioural and is
-- MEASURED: the role matrix run against the reverted body reproduces the
-- baseline verdict on all 31 scenarios, impact_manager and super_admin refused
-- included.
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

    -- Validate access: active organization_admin or analyst of the organization
    SELECT EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.organization_members om ON om.organization_id = p.organization_id
        WHERE
            p.id::text = project_id_str AND
            om.user_id = can_write_evidence_object.user_id AND
            om.status = 'active' AND
            om.role IN ('organization_admin', 'analyst')
    ) INTO has_access;

    RETURN has_access;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;

RESET ROLE;

-- ============================================================
-- 2. Self-verification — assert the reverted state, in this transaction
-- ============================================================
DO $$
DECLARE
  write_oid oid;
  read_oid  oid;
  write_def text;
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
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: can_write_evidence_object(text, uuid) does not exist after the script ran';
  END IF;

  SELECT p.oid INTO read_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_read_evidence_object'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'object_name text, user_id uuid';

  write_def := regexp_replace(pg_catalog.pg_get_functiondef(write_oid), '-{2}[^\n]*', '', 'g');

  -- (1) The two roles stella_0019 added are GONE.
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('super_admin',    position('''super_admin'''    in write_def) > 0),
    ('impact_manager', position('''impact_manager''' in write_def) > 0)
  ) AS m(what, present)
  WHERE m.present;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: can_write_evidence_object still authorises %. The revert did not take.', problem;
  END IF;

  -- (2) The two the baseline published are still there. A revert that removed
  --     all four would satisfy (1) and lock every uploader out.
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('organization_admin', position('''organization_admin''' in write_def) > 0),
    ('analyst',            position('''analyst'''            in write_def) > 0)
  ) AS m(what, present)
  WHERE NOT m.present;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: can_write_evidence_object no longer authorises %. Reverting stella_0019 restores two roles; it does not remove them.', problem;
  END IF;

  -- (3) The rest of the body is the baseline's.
  IF position('(storage.foldername(object_name))[1]' in write_def) = 0
     OR position('om.status = ''active''' in write_def) = 0
     OR position('p.id::text = project_id_str' in write_def) = 0 THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: the restored body is not the unit 41 body — the path parse, the active-membership filter or the project binding is missing.';
  END IF;

  -- (4) Owner, definer posture, search_path and argument names unchanged.
  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = write_oid)
     <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: can_write_evidence_object is owned by %, not uellix_owner',
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = write_oid);
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = write_oid) THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: can_write_evidence_object is no longer SECURITY DEFINER';
  END IF;

  IF NOT (SELECT coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=']::text[]
               OR coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[]
          FROM pg_catalog.pg_proc p WHERE p.oid = write_oid) THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: can_write_evidence_object no longer carries SET search_path = ''''';
  END IF;

  IF (SELECT p.proargnames FROM pg_catalog.pg_proc p WHERE p.oid = write_oid)
     IS DISTINCT FROM ARRAY['object_name', 'user_id'] THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: the argument names are %, not the two unit 41 published',
      (SELECT p.proargnames::text FROM pg_catalog.pg_proc p WHERE p.oid = write_oid);
  END IF;

  -- (5) THE ACL IS UNCHANGED. A rollback that quietly narrowed or widened the
  --     EXECUTE grant would leave a database matching neither the state before
  --     stella_0019 nor the state after it.
  captured := current_setting('stella_0019_rollback.write_acl', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: §0 did not record the ACL, so "unchanged" cannot be evaluated. Apply with psql -1.';
  END IF;

  SELECT coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type), '')
    INTO observed
  FROM pg_catalog.pg_proc p,
       aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
  WHERE p.oid = write_oid;

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: the EXECUTE ACL of can_write_evidence_object changed from [%] to [%]. This script issues no GRANT and no REVOKE.', captured, observed;
  END IF;

  IF NOT has_function_privilege('authenticated', write_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: `authenticated` can no longer execute can_write_evidence_object, so every upload would fail rather than the two roles this script narrows.';
  END IF;

  -- (6) The read helper is byte-identical.
  captured := current_setting('stella_0019_rollback.read_fingerprint', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: §0 did not record the read-helper fingerprint. Apply with psql -1.';
  END IF;

  SELECT md5(regexp_replace(pg_catalog.pg_get_functiondef(read_oid), '-{2}[^\n]*', '', 'g') || '|' ||
             coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type), ''))
    INTO observed
  FROM pg_catalog.pg_proc p,
       aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
  WHERE p.oid = read_oid;

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: can_read_evidence_object changed. Neither stella_0019 nor its rollback may touch it.';
  END IF;

  -- (7) The three storage.objects policies are unchanged.
  captured := current_setting('stella_0019_rollback.storage_policies', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: §0 did not record the storage.objects policies. Apply with psql -1.';
  END IF;

  SELECT md5(coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' ||
                                 coalesce(qual, '') || '|' || coalesce(with_check, ''),
                                 E'\n' ORDER BY policyname), ''))
    INTO observed
  FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: the policies on storage.objects changed while this script ran.';
  END IF;

  -- (8) The owner window was closed.
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'stella_0019_rollback FAILED verification: the session is still running as % rather than %. The owner window opened in §1 was not closed.',
      current_user, session_user;
  END IF;

  RAISE WARNING 'stella_0019_rollback: M-2 IS REOPENED. can_write_evidence_object again authorises only organization_admin and analyst, so impact_manager and super_admin can create an evidence_items row and cannot upload the object it describes — the Storage API answers "new row violates row-level security policy" on an operation lib/auth/permissions.ts already authorised. The compensating DELETE in lib/pipeline/evidence.ts does not clean up the orphaned row (M2-COMP-01).';
  RAISE NOTICE 'stella_0019_rollback: verification passed — unit 41 body restored; owner, ACL, SECURITY DEFINER, search_path and argument names unchanged; can_read_evidence_object byte-identical; the three storage.objects policies unchanged.';
END $$;
