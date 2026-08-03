-- db/prepared/stella_0010_rollback.sql
-- Reverts db/prepared/stella_0010_organization_bootstrap_capability.sql (CAP-05).
--
-- PREPARED ONLY — NOT A MIGRATION.
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md §11
--
-- RUN AS SUPERUSER, in one transaction:
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0010_rollback.sql
--
-- ============================================================================
-- THIS ROLLBACK DROPS ITS TABLE, AND THAT IS DELIBERATE
-- ============================================================================
-- The campaign creates FOUR tables and its rollbacks retain TWO of them:
--
--   report_public_disclosures  RETAINED by stella_0007_rollback — each row is a
--                              human decision to publish, with author and date.
--   stripe_webhook_events      RETAINED by stella_0008_rollback — the record of
--                              which billing events were applied.
--   capability_verification_hits  DROPPED by stella_0007_rollback — an aggregate
--                              counter belonging to the capability, evidence of
--                              nothing once the capability is gone.
--   capability_bootstrap_attempts DROPPED here, for the reason below.
--
-- So this is not "the one rollback that drops a table": stella_0007_rollback
-- drops one too. What is retained is evidence; what is dropped is bookkeeping.
-- (CAP-01 and CAP-04 create no table at all — they retain a COLUMN each,
-- invitations.accepted_by and marketing_leads.consent_version, which is a
-- different kind of retention and is stated in their own rollbacks.)
--
-- capability_bootstrap_attempts holds none. Its completed rows duplicate facts
-- already recorded in audit_logs (organization.created, membership.created)
-- and in the organisations themselves; its incomplete rows are idempotency
-- keys for a capability that will no longer exist. Keeping it would preserve
-- (user_id, key) pairs of no evidentiary value, which is a privacy cost with
-- no benefit.
--
-- ORGANISATIONS CREATED WHILE THE CAPABILITY WAS LIVE ARE NOT TOUCHED. They
-- are real organisations with real members. The rollback removes the door,
-- not the rooms.
--
-- After this script, createFirstOrganization fails closed exactly as before.
-- ============================================================================

SET search_path = public;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0010_rollback must run as a superuser (it drops a role); current_user is %.', current_user;
  END IF;
END
$$;

-- ============================================================
-- 1. Function
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'bootstrap_organization'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.bootstrap_organization(uuid,text,text,text,text,text) FROM uellix_app';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS uellix_capability.bootstrap_organization(uuid, text, text, text, text, text);

-- ============================================================
-- 2. Policies, grants and the ledger (owner window)
-- ============================================================

SET ROLE uellix_owner;

DROP POLICY IF EXISTS cap_bootstrap_select_orgs      ON public.organizations;
DROP POLICY IF EXISTS cap_bootstrap_insert_orgs      ON public.organizations;
DROP POLICY IF EXISTS cap_bootstrap_select_members   ON public.organization_members;
DROP POLICY IF EXISTS cap_bootstrap_insert_members   ON public.organization_members;
DROP POLICY IF EXISTS cap_bootstrap_select_users     ON public.users;
DROP POLICY IF EXISTS cap_bootstrap_select_allowlist ON public.signup_allowlist;
DROP POLICY IF EXISTS cap_bootstrap_insert_audit     ON public.audit_logs;
DROP POLICY IF EXISTS cap_bootstrap_rw_attempts      ON public.capability_bootstrap_attempts;
DROP POLICY IF EXISTS cap_bootstrap_only_founder     ON public.organization_members;
DROP POLICY IF EXISTS cap_bootstrap_only_active      ON public.organizations;
DROP POLICY IF EXISTS cap_bootstrap_only_self        ON public.users;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap') THEN
    EXECUTE 'REVOKE ALL ON public.organizations FROM uellix_cap_bootstrap';
    EXECUTE 'REVOKE ALL ON public.organization_members FROM uellix_cap_bootstrap';
    EXECUTE 'REVOKE ALL ON public.users FROM uellix_cap_bootstrap';
    EXECUTE 'REVOKE ALL ON public.signup_allowlist FROM uellix_cap_bootstrap';
    EXECUTE 'REVOKE ALL ON public.audit_logs FROM uellix_cap_bootstrap';
    EXECUTE 'REVOKE ALL ON public.capability_bootstrap_attempts FROM uellix_cap_bootstrap';
  END IF;
END
$$;

DROP TABLE IF EXISTS public.capability_bootstrap_attempts;

RESET ROLE;

-- ============================================================
-- 3. Role and, if empty, the schema
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA uellix_capability FROM uellix_cap_bootstrap';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_org_ids() FROM uellix_cap_bootstrap';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM uellix_cap_bootstrap';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_role_in_org(uuid) FROM uellix_cap_bootstrap';
    -- The forward grants USAGE on schema auth so the definer can resolve
    -- auth.uid(); it goes back with the role.
    EXECUTE 'REVOKE ALL ON SCHEMA auth FROM uellix_cap_bootstrap';
    -- No membership to revoke: the capability role has ZERO members.
    EXECUTE 'DROP ROLE uellix_cap_bootstrap';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_capability')
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'uellix_capability'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'uellix_capability'
     )
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
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap still exists after rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'bootstrap_organization'
  ) THEN
    RAISE EXCEPTION 'bootstrap_organization survives the rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND pg_catalog.left(policyname, 14) = 'cap_bootstrap_'
  ) THEN
    RAISE EXCEPTION 'cap_bootstrap_* policies survive the rollback.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'capability_bootstrap_attempts') THEN
    RAISE EXCEPTION 'capability_bootstrap_attempts survives the rollback.';
  END IF;

  -- The two historic policies are back in sole charge, untouched throughout.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'members_insert_admin')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'orgs_insert_super_admin') THEN
    RAISE EXCEPTION 'a pre-existing policy is missing after rollback.';
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'the policy baseline is not 105 after rollback.';
  END IF;

  RAISE NOTICE 'stella_0010 rolled back: CAP-05 absent; organisations created while it was live are untouched.';
END
$$;
