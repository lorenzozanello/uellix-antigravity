-- db/prepared/stella_0009_rollback.sql
-- Reverts db/prepared/stella_0009_public_lead_capability.sql (CAP-04).
--
-- PREPARED ONLY — NOT A MIGRATION.
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_04_PUBLIC_LEADS.md §12
--
-- RUN AS SUPERUSER, in one transaction:
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0009_rollback.sql
--
-- ============================================================================
-- THIS ROLLBACK RESTORES PRIVILEGE IT WOULD RATHER NOT
-- ============================================================================
-- stella_0009 is a net privilege REDUCTION: it revokes uellix_writer's four
-- privileges on marketing_leads and drops two dead PostgREST-era policies.
--
-- A rollback that left those improvements in place would be tempting and
-- WRONG. The point of a rollback is that the catalogue can be compared against
-- its pre-application state and found identical. A rollback that quietly
-- improves security produces a state that matches neither before nor after,
-- and the next operator cannot tell which of the two they are looking at.
--
-- So the grants and the two policies come back exactly as they were. If the
-- hardening is wanted independently of CAP-04, it belongs in its own package
-- with its own review.
--
-- WHAT DOES NOT COME BACK, and why:
--   * lead_status, consent_version and uq_marketing_leads_email_source are
--     data integrity, not privilege. Dropping lead_status would destroy the
--     working state of every lead; dropping the unique index would readmit the
--     duplicates the package excluded. Both stay, with COMMENTs.
-- ============================================================================

SET search_path = public;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0009_rollback must run as a superuser (it drops a role); current_user is %.', current_user;
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
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'submit_lead'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.submit_lead(text,text,text,text) FROM uellix_app';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS uellix_capability.submit_lead(text, text, text, text);

-- ============================================================
-- 2. Policies and grants (owner window)
-- ============================================================

SET ROLE uellix_owner;

DROP POLICY IF EXISTS cap_lead_insert ON public.marketing_leads;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_lead') THEN
    EXECUTE 'REVOKE ALL ON public.marketing_leads FROM uellix_cap_lead';
  END IF;
END
$$;

-- Restore the runtime's privileges, exactly as measured before the package:
-- uellix_writer held SELECT, INSERT, UPDATE and DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads TO uellix_writer;

-- Restore the two retired policies, verbatim. They were WITH CHECK (true) on
-- INSERT for anon and for authenticated — inert against the current runtime,
-- which is neither, which is why the endpoint was failing closed.
DROP POLICY IF EXISTS anon_insert_marketing_leads ON public.marketing_leads;
CREATE POLICY anon_insert_marketing_leads
ON public.marketing_leads FOR INSERT TO anon
WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_insert_marketing_leads ON public.marketing_leads;
CREATE POLICY authenticated_insert_marketing_leads
ON public.marketing_leads FOR INSERT TO authenticated
WITH CHECK (true);

COMMENT ON COLUMN public.marketing_leads.consent_version IS
  'stella_0009 (rolled back): retained deliberately. Records which consent text a submitter was shown. Nothing writes it now. See docs/ops/capabilities/CAP_04_PUBLIC_LEADS.md §12.';

RESET ROLE;

-- ============================================================
-- 3. Role and, if empty, the schema
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_lead') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA uellix_capability FROM uellix_cap_lead';
    -- No membership to revoke: since the adversarial review the capability role
    -- has ZERO members. The ownership transfer happens as superuser, so nothing
    -- ever needed to be a member of it.
    EXECUTE 'DROP ROLE uellix_cap_lead';
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
DECLARE
  v_policies integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_lead') THEN
    RAISE EXCEPTION 'uellix_cap_lead still exists after rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'submit_lead'
  ) THEN
    RAISE EXCEPTION 'submit_lead survives the rollback.';
  END IF;

  -- The pre-package state, restored exactly: three policies, and the runtime's
  -- four privileges back.
  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'marketing_leads';
  IF v_policies <> 3 THEN
    RAISE EXCEPTION 'Expected 3 policies on marketing_leads after rollback, found %.', v_policies;
  END IF;

  IF NOT (pg_catalog.has_table_privilege('uellix_writer', 'public.marketing_leads', 'SELECT')
      AND pg_catalog.has_table_privilege('uellix_writer', 'public.marketing_leads', 'INSERT')
      AND pg_catalog.has_table_privilege('uellix_writer', 'public.marketing_leads', 'UPDATE')
      AND pg_catalog.has_table_privilege('uellix_writer', 'public.marketing_leads', 'DELETE')) THEN
    RAISE EXCEPTION 'uellix_writer did not get its four privileges on marketing_leads back.';
  END IF;

  -- The deliberate survivors.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketing_leads' AND column_name = 'lead_status'
  ) THEN
    RAISE EXCEPTION 'marketing_leads.lead_status was dropped; the rollback must retain it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_marketing_leads_email_source'
  ) THEN
    RAISE EXCEPTION 'uq_marketing_leads_email_source was dropped; the rollback must retain it.';
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'the policy baseline is not 105 after rollback.';
  END IF;

  RAISE NOTICE 'stella_0009 rolled back: CAP-04 absent; pre-package grants and policies restored verbatim.';
END
$$;
