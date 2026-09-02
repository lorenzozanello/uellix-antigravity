-- db/prepared/stella_0012_rollback.sql
-- Reverts db/prepared/stella_0012_super_admin_column_acl.sql (RR-CAP-15).
--
-- PREPARED ONLY — NOT A MIGRATION.
-- SOURCE OF TRUTH: docs/ops/STELLA_FABLE_RISK_REGISTER.md (RR-CAP-15)
--
-- RUN AS SUPERUSER, in one transaction:
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0012_rollback.sql
--
-- ============================================================================
-- THIS ROLLBACK REOPENS A PRIVILEGE ESCALATION, AND SAYS SO TWICE
-- ============================================================================
-- Restoring table-level UPDATE on `public.users` to `authenticated` and
-- `uellix_writer` puts this back within reach of every authenticated subject:
--
--     UPDATE public.users SET is_super_admin = true WHERE id = auth.uid();
--
-- `users_update_own` is TO PUBLIC and bounds the ROW, and the row is the
-- privilege. That single statement makes the caller a platform super_admin,
-- which satisfies `public.current_user_is_super_admin()` — and therefore 114
-- policy predicates in this schema, plus the RESTRICTIVE bound and the body
-- check that stella_0011 relies on to protect the Stella quota.
--
-- It also puts `organization_members.role` back within reach of any
-- organisation admin, who can then mint the 'super_admin' membership that
-- CAP-01 refuses to create and CAP-05 refuses to found with.
--
-- That is what "revert" means here. A rollback whose postconditions assert a
-- SAFER state than the thing it reverts is a rollback that cannot be trusted
-- to restore anything, so this one asserts the DEFECT is back and names it in
-- a RAISE WARNING as well as a NOTICE — a warning, because an operator running
-- this during an incident is not reading the file.
--
-- ORDERING. stella_0012 is independent of the capability campaign: it touches
-- no capability role, no capability function and no capability schema. It can
-- be rolled back at any point without disturbing 0006..0011. It is applied
-- LAST only so that stella_0011's own postconditions run against the ACL they
-- describe.
--
-- WHAT IS NOT RESTORED. Nothing else: this package changed only two ACLs and
-- three COMMENTs. No policy, no role, no function and no table were touched
-- going forward, so none is touched coming back.
-- ============================================================================

SET search_path = public;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0012_rollback must run as a superuser; current_user is %.', current_user;
  END IF;
  -- Fail at the gate, not half way through: the owner window below is not
  -- reachable without it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0012_rollback requires uellix_owner.';
  END IF;
END
$$;

-- ============================================================
-- 1. The ACL (owner window)
-- ============================================================

SET ROLE uellix_owner;

-- REVOKE the column grants before restoring the table grant. A column-level
-- grant is not subsumed by a later table-level one, and leaving both would
-- make `\dp` show a column ACL that no longer means anything.
-- `anon` and PUBLIC are named on the REVOKE side to mirror the forward
-- script, which strips them deliberately as a convergence step. They are NOT
-- re-granted: in the measured baseline neither holds UPDATE, and a rollback
-- that invents a grant is not a restore either. Stated because an adversarial
-- reviewer was right that the asymmetry was undocumented.
REVOKE UPDATE ON public.users FROM authenticated, uellix_writer, anon, PUBLIC;
GRANT UPDATE ON public.users TO authenticated;
GRANT UPDATE ON public.users TO uellix_writer;

DROP POLICY IF EXISTS cap_members_no_super_admin_grant ON public.organization_members;

REVOKE UPDATE ON public.organization_members FROM authenticated, uellix_writer, anon, PUBLIC;
GRANT UPDATE ON public.organization_members TO authenticated;
GRANT UPDATE ON public.organization_members TO uellix_writer;

COMMENT ON COLUMN public.users.is_super_admin IS NULL;
COMMENT ON COLUMN public.users.deleted_at IS NULL;
COMMENT ON COLUMN public.organization_members.role IS NULL;

RESET ROLE;

-- ============================================================
-- 2. Postconditions
-- ============================================================

DO $$
BEGIN
  -- DELIBERATELY the inverse of stella_0012's: the rollback has not run
  -- correctly until the escalation is reachable again.
  IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.users',
                                         'is_super_admin', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('authenticated', 'public.users',
                                            'is_super_admin', 'UPDATE') THEN
    RAISE EXCEPTION 'the table-level UPDATE on public.users was not restored; the database is in neither the pre- nor the post-stella_0012 state.';
  END IF;
  IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organization_members',
                                         'role', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('authenticated', 'public.organization_members',
                                            'role', 'UPDATE') THEN
    RAISE EXCEPTION 'the table-level UPDATE on public.organization_members was not restored.';
  END IF;

  -- The runtime must not LOSE anything either: the profile columns and the
  -- membership status are part of the restored table grant.
  IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.users', 'email', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organization_members',
                                            'status', 'UPDATE') THEN
    RAISE EXCEPTION 'the runtime lost a column it writes; the rollback is not a restore.';
  END IF;

  -- The restored grant must cover EVERY column, which is what distinguishes a
  -- table-level grant from a residual narrower one.
  --
  -- NOT `information_schema.column_privileges`: that view expands a TABLE-level
  -- grant into one row per column, so "a column privilege exists" is true of
  -- both states and an assertion against it can never pass. Measured in the
  -- dry run, which is the only place it could have been measured.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'users'
       AND NOT pg_catalog.has_column_privilege('uellix_writer', 'public.users',
                                               c.column_name, 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'the restored grant on public.users does not cover every column; it is still narrowed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'organization_members'
       AND NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organization_members',
                                               c.column_name, 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'the restored grant on public.organization_members does not cover every column.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND policyname = 'cap_members_no_super_admin_grant') THEN
    RAISE EXCEPTION 'cap_members_no_super_admin_grant survives the rollback.';
  END IF;

  RAISE NOTICE 'stella_0012 rolled back: table-level UPDATE restored on public.users and public.organization_members.';
  RAISE WARNING 'stella_0012 ROLLED BACK. PRIVILEGE ESCALATION IS REOPEN: any authenticated subject can now run UPDATE public.users SET is_super_admin = true WHERE id = auth.uid() and become a platform super_admin, which satisfies 114 policy predicates and voids the RR-CAP-10 quota boundary. Any organisation admin can now mint a super_admin membership.';
END
$$;
