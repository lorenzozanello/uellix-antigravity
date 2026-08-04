-- db/prepared/stella_0011_rollback.sql
-- Reverts db/prepared/stella_0011_organization_column_acl.sql (RR-CAP-10).
--
-- PREPARED ONLY — NOT A MIGRATION.
-- SOURCE OF TRUTH: docs/ops/STELLA_FABLE_RISK_REGISTER.md (RR-CAP-10)
--
-- RUN AS SUPERUSER, in one transaction:
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0011_rollback.sql
--
-- ============================================================================
-- THIS ROLLBACK REOPENS A KNOWN DEFECT, AND SAYS SO
-- ============================================================================
-- Restoring the table-level `UPDATE ON public.organizations` to `authenticated`
-- and `uellix_writer` puts `stella_monthly_quota`, `stella_plan_label` and
-- `status` back within reach of every `organization_admin` through the ORM.
-- That is what "revert" means here, and pretending otherwise by keeping the
-- column grant would leave the database in a state neither script describes.
--
-- It is written this way on purpose: a rollback whose postconditions assert a
-- SAFER state than the thing it reverts is a rollback that cannot be trusted
-- to restore anything. The RAISE NOTICE at the end names the reopened risk so
-- it appears in the operator's terminal, not only in a document.
--
-- ORDERING. This package is applied LAST and rolled back FIRST, because the
-- campaign rollback drops `uellix_capability` once it is empty: rolling 0011
-- back after 0006..0010 would find the schema already gone and its own DROP
-- FUNCTION would be a no-op against nothing, leaving `uellix_cap_platform`
-- holding grants on a schema that no longer exists.
--
-- The audit rows the two functions wrote are NOT touched. They live in
-- audit_logs, which is append-only; a quota change that happened, happened.
-- ============================================================================

SET search_path = public;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0011_rollback must run as a superuser (it drops a role); current_user is %.', current_user;
  END IF;
END
$$;

-- ============================================================
-- 1. Functions
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'admin_set_stella_service'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.admin_set_stella_service(uuid,integer,text) FROM uellix_app';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'admin_set_organization_status'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.admin_set_organization_status(uuid,text) FROM uellix_app';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS uellix_capability.admin_set_stella_service(uuid, integer, text);
DROP FUNCTION IF EXISTS uellix_capability.admin_set_organization_status(uuid, text);

-- ============================================================
-- 2. Policies and the ACL (owner window)
-- ============================================================

SET ROLE uellix_owner;

-- The RESTRICTIVE pair first. A RESTRICTIVE policy left behind is ANDed into
-- every future statement by a role of that name, so it is the one kind of
-- residue that turns a partial rollback into a silent, permanent deny.
DROP POLICY IF EXISTS cap_platform_only_super_admin_read ON public.organizations;
DROP POLICY IF EXISTS cap_platform_only_super_admin      ON public.organizations;
DROP POLICY IF EXISTS cap_platform_select_orgs           ON public.organizations;
DROP POLICY IF EXISTS cap_platform_update_orgs           ON public.organizations;
DROP POLICY IF EXISTS cap_platform_insert_audit          ON public.audit_logs;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_platform') THEN
    EXECUTE 'REVOKE ALL ON public.organizations FROM uellix_cap_platform';
    EXECUTE 'REVOKE ALL ON public.audit_logs    FROM uellix_cap_platform';
  END IF;
END
$$;

-- The column grants go, and the table grant returns. REVOKE first: a
-- column-level grant is not subsumed by a later table-level one, and leaving
-- both would make `\dp` show a column ACL that no longer means anything.
REVOKE UPDATE ON public.organizations FROM authenticated, uellix_writer;
GRANT UPDATE ON public.organizations TO authenticated;
GRANT UPDATE ON public.organizations TO uellix_writer;
GRANT DELETE ON public.organizations TO authenticated;
GRANT DELETE ON public.organizations TO uellix_writer;

COMMENT ON COLUMN public.organizations.stella_monthly_quota IS NULL;
COMMENT ON COLUMN public.organizations.stella_plan_label IS NULL;
COMMENT ON COLUMN public.organizations.status IS NULL;

RESET ROLE;

-- ============================================================
-- 3. Role and, if empty, the schema
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_platform') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA uellix_capability FROM uellix_cap_platform';
    EXECUTE 'REVOKE ALL ON SCHEMA auth FROM uellix_cap_platform';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_org_ids() FROM uellix_cap_platform';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM uellix_cap_platform';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_role_in_org(uuid) FROM uellix_cap_platform';
    EXECUTE 'DROP ROLE uellix_cap_platform';
  END IF;
END
$$;

-- The schema is shared with CAP-01..CAP-05. It is dropped only if this was the
-- last thing in it — the same guard every other rollback carries.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_capability')
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'uellix_capability')
     AND NOT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'uellix_capability')
  THEN
    EXECUTE 'DROP SCHEMA uellix_capability';
  END IF;
END
$$;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_platform') THEN
    RAISE EXCEPTION 'uellix_cap_platform still exists after rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability'
      AND p.proname IN ('admin_set_stella_service','admin_set_organization_status')
  ) THEN
    RAISE EXCEPTION 'a platform-admin function survives the rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND pg_catalog.left(policyname, 13) = 'cap_platform_'
  ) THEN
    RAISE EXCEPTION 'cap_platform_* policies survive the rollback.';
  END IF;

  -- The restored state, asserted on the column the package existed to protect.
  -- This assertion is DELIBERATELY the inverse of stella_0011's: the rollback
  -- has not run correctly until the defect is back.
  IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organizations',
                                         'stella_monthly_quota', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('authenticated', 'public.organizations',
                                            'stella_monthly_quota', 'UPDATE') THEN
    RAISE EXCEPTION 'the table-level UPDATE was not restored; the database is in neither the pre- nor the post-stella_0011 state.';
  END IF;
  IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organizations',
                                         'white_label_enabled', 'UPDATE') THEN
    RAISE EXCEPTION 'the runtime lost UPDATE on a column it writes; the rollback is not a restore.';
  END IF;

  -- No residual column-level grant alongside the restored table-level one.
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND privilege_type = 'UPDATE'
       AND grantee = 'uellix_cap_platform'
  ) THEN
    RAISE EXCEPTION 'a column grant to uellix_cap_platform survives the rollback.';
  END IF;

  RAISE NOTICE 'stella_0011 rolled back. RR-CAP-10 IS REOPENED: any organization_admin can write stella_monthly_quota, stella_plan_label and status through the ORM again.';
END
$$;
