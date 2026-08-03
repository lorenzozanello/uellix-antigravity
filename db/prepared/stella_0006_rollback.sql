-- db/prepared/stella_0006_rollback.sql
-- Reverts db/prepared/stella_0006_invitation_capability.sql (CAP-01).
--
-- PREPARED ONLY — NOT A MIGRATION.
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_01_INVITATIONS.md §13
--
-- RUN AS SUPERUSER, in one transaction:
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0006_rollback.sql
--
-- ============================================================================
-- WHAT THIS ROLLBACK DELIBERATELY DOES NOT UNDO
-- ============================================================================
-- Two objects survive, and both are data integrity rather than privilege:
--
--   * `invitations.accepted_by` — dropping it would destroy the attribution of
--     every invitation accepted while the capability was live. The rollback
--     leaves the column, emptied of purpose but not of content, and rewrites
--     its COMMENT to say so. A rollback that erases evidence is not a rollback.
--
--   * `uq_invitations_token_hash` — a UNIQUE index on a column that was always
--     meant to be unique. It was correct before this package and stays correct
--     after it. Dropping it would reintroduce the possibility the package
--     closed.
--
-- Everything that grants, executes or reads is removed. After this script the
-- capability does not exist and lib/invitations/service.ts fails closed
-- exactly as it did before stella_0006 — which is the pre-existing state, not
-- a degraded one.
--
-- The schema `uellix_capability` is dropped ONLY if it is empty: the other
-- four capability packages are independent and may still own functions there.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'stella_0006_rollback must run as a superuser (it drops a role); current_user is %.',
      current_user;
  END IF;
END
$$;

-- ============================================================
-- 1. Revoke EXECUTE, then drop the function
-- ============================================================
-- Order matters only for readability: DROP FUNCTION removes the ACL with the
-- object. The explicit REVOKE makes the intent legible in the transaction log
-- and keeps the script convergent if the function was already dropped by hand.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'accept_invitation'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.accept_invitation(text) FROM uellix_app';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS uellix_capability.accept_invitation(text);

-- ============================================================
-- 2. Policies and grants (owner window)
-- ============================================================

SET ROLE uellix_owner;

DROP POLICY IF EXISTS cap_invitation_select_invitations ON public.invitations;
DROP POLICY IF EXISTS cap_invitation_update_invitations ON public.invitations;
DROP POLICY IF EXISTS cap_invitation_select_members     ON public.organization_members;
DROP POLICY IF EXISTS cap_invitation_insert_members     ON public.organization_members;
DROP POLICY IF EXISTS cap_invitation_select_users       ON public.users;
DROP POLICY IF EXISTS cap_invitation_insert_audit       ON public.audit_logs;

-- Column-level grants are revoked at table level: REVOKE ALL on the table
-- removes column entries too. Guarded so the script survives a role that was
-- already dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    EXECUTE 'REVOKE ALL ON public.invitations FROM uellix_cap_invitation';
    EXECUTE 'REVOKE ALL ON public.organization_members FROM uellix_cap_invitation';
    EXECUTE 'REVOKE ALL ON public.users FROM uellix_cap_invitation';
    EXECUTE 'REVOKE ALL ON public.audit_logs FROM uellix_cap_invitation';
  END IF;
END
$$;

-- Restate the surviving column's meaning now that nothing writes it.
COMMENT ON COLUMN public.invitations.accepted_by IS
  'stella_0006 (rolled back): retained deliberately. Holds the auth.uid() that accepted the invitation while CAP-01 was live. Nothing writes it now. See docs/ops/capabilities/CAP_01_INVITATIONS.md §13.';

RESET ROLE;

-- ============================================================
-- 3. The capability role and, if empty, the schema
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA uellix_capability FROM uellix_cap_invitation';
    EXECUTE 'REVOKE uellix_cap_invitation FROM uellix_owner';
    -- No CASCADE. If anything still depends on this role the DROP fails, and a
    -- loud failure is the correct outcome: CASCADE here would silently remove
    -- objects the operator has not been told about.
    EXECUTE 'DROP ROLE uellix_cap_invitation';
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
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    RAISE EXCEPTION 'uellix_cap_invitation still exists after rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'accept_invitation'
  ) THEN
    RAISE EXCEPTION 'accept_invitation still exists after rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname LIKE 'cap\_invitation\_%'
  ) THEN
    RAISE EXCEPTION 'cap_invitation_* policies survive the rollback.';
  END IF;

  -- Back to the pre-stella_0006 baseline. Counted excluding whatever the OTHER
  -- capability packages contribute, since they are independent and may still
  -- be applied.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'Expected 105 baseline policies after rollback, found %.',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND pg_catalog.left(policyname, 4) <> 'cap_'
          AND pg_catalog.left(policyname, 12) <> 'disclosures_'
          AND policyname NOT IN ('anon_insert_marketing_leads',
                                 'authenticated_insert_marketing_leads'));
  END IF;

  -- The two deliberate survivors are still there.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'accepted_by'
  ) THEN
    RAISE EXCEPTION 'invitations.accepted_by was dropped; the rollback must retain it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_invitations_token_hash'
  ) THEN
    RAISE EXCEPTION 'uq_invitations_token_hash was dropped; the rollback must retain it.';
  END IF;

  RAISE NOTICE 'stella_0006 rolled back: CAP-01 absent; accepted_by and the unique index retained by design.';
END
$$;
