-- db/prepared/stella_0007_rollback.sql
-- Reverts db/prepared/stella_0007_public_verification_capability.sql (CAP-02).
--
-- PREPARED ONLY — NOT A MIGRATION.
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_02_PUBLIC_VERIFICATION.md §13
--
-- RUN AS SUPERUSER, in one transaction:
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0007_rollback.sql
--
-- ============================================================================
-- WHAT SURVIVES, AND WHY
-- ============================================================================
-- `report_public_disclosures` is NOT dropped. Every row in it is a human
-- decision to publish a specific report, with the approver and the timestamp.
-- Dropping the table would destroy the only record of who authorised what.
-- The rollback removes the capability that READ it, leaves the table, and
-- rewrites its COMMENT to say the reader is gone.
--
-- `capability_verification_hits` IS dropped: it is a counter belonging to a
-- capability that no longer exists, holds no personal data, and nothing else
-- reads it.
--
-- After this script /verify/<hash> answers 404 for every hash — the same
-- fail-closed state as before stella_0007.
-- ============================================================================

SET search_path = public;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0007_rollback must run as a superuser (it drops a role); current_user is %.', current_user;
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
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'verify_report'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.verify_report(text) FROM uellix_app';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'record_verification_hit'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.record_verification_hit(text) FROM uellix_app';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS uellix_capability.verify_report(text);
DROP FUNCTION IF EXISTS uellix_capability.record_verification_hit(text);

-- ============================================================
-- 2. Policies, grants and the counter (owner window)
-- ============================================================

SET ROLE uellix_owner;

DROP POLICY IF EXISTS cap_verification_select_reports     ON public.sroi_reports;
DROP POLICY IF EXISTS cap_verification_select_orgs        ON public.organizations;
DROP POLICY IF EXISTS cap_verification_select_runs        ON public.sroi_calculation_runs;
DROP POLICY IF EXISTS cap_verification_select_disclosures ON public.report_public_disclosures;
DROP POLICY IF EXISTS cap_verification_write_hits         ON public.capability_verification_hits;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    EXECUTE 'REVOKE ALL ON public.sroi_reports FROM uellix_cap_verification';
    EXECUTE 'REVOKE ALL ON public.organizations FROM uellix_cap_verification';
    EXECUTE 'REVOKE ALL ON public.sroi_calculation_runs FROM uellix_cap_verification';
    EXECUTE 'REVOKE ALL ON public.report_public_disclosures FROM uellix_cap_verification';
  END IF;
END
$$;

-- The counter belongs to the capability and goes with it. Dropping the table
-- takes its policy and grants along; the explicit DROP POLICY above keeps the
-- script convergent if the table was already removed by hand.
DROP TABLE IF EXISTS public.capability_verification_hits;

-- The disclosure table stays, with its internal policies intact: an admin can
-- still see and revoke what was published, even though nothing serves it
-- publicly any more.
COMMENT ON TABLE public.report_public_disclosures IS
  'CAP-02 (rolled back): retained deliberately. Each row records a human decision to publish a report, with approver and timestamp. The capability that read it (uellix_capability.verify_report) no longer exists, so nothing is served publicly. See docs/ops/capabilities/CAP_02_PUBLIC_VERIFICATION.md §13.';

RESET ROLE;

-- ============================================================
-- 3. Role and, if empty, the schema
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA uellix_capability FROM uellix_cap_verification';
    EXECUTE 'REVOKE uellix_cap_verification FROM uellix_owner';
    EXECUTE 'DROP ROLE uellix_cap_verification';
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
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    RAISE EXCEPTION 'uellix_cap_verification still exists after rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability'
      AND p.proname IN ('verify_report','record_verification_hit')
  ) THEN
    RAISE EXCEPTION 'a CAP-02 function survives the rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND pg_catalog.left(policyname, 17) = 'cap_verification_'
  ) THEN
    RAISE EXCEPTION 'cap_verification_* policies survive the rollback.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'capability_verification_hits') THEN
    RAISE EXCEPTION 'capability_verification_hits survives the rollback.';
  END IF;

  -- The deliberate survivor.
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'report_public_disclosures') THEN
    RAISE EXCEPTION 'report_public_disclosures was dropped; the rollback must retain it.';
  END IF;

  -- The baseline is back to what it was, counted excluding whatever the OTHER
  -- capability packages contribute: they are independent and may still be
  -- applied.
  IF (SELECT count(*) FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN ('report_public_disclosures','capability_verification_hits',
                               'stripe_webhook_events','capability_bootstrap_attempts')) <> 38 THEN
    RAISE EXCEPTION 'Expected 38 non-capability tables after rollback, found %.',
      (SELECT count(*) FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('report_public_disclosures','capability_verification_hits',
                                'stripe_webhook_events','capability_bootstrap_attempts'));
  END IF;

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

  -- The three internal disclosure policies stay with the retained table.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND pg_catalog.left(policyname, 12) = 'disclosures_') <> 3 THEN
    RAISE EXCEPTION 'the internal disclosures_* policies did not survive the rollback.';
  END IF;

  RAISE NOTICE 'stella_0007 rolled back: CAP-02 absent; report_public_disclosures retained by design.';
END
$$;
