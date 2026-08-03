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
-- WHAT SURVIVES, AND WHY — AND WHAT DOES NOT
-- ============================================================================
-- `report_public_disclosures` is NOT dropped. Every row in it is a human
-- decision to publish a specific report, with the approver and the timestamp.
-- Dropping the table would destroy the only record of who authorised what.
--
-- But the ROWS surviving is not the same as the WRITE PATH surviving, and an
-- earlier revision of this rollback conflated the two: it kept the table, kept
-- `GRANT SELECT, INSERT, UPDATE … TO uellix_writer`, kept the two write
-- policies, and then ASSERTED their survival. The result was a post-rollback
-- catalogue holding a runtime write privilege on a table that did not exist
-- before the package — the mirror image of the defect stella_0009_rollback's
-- header warns about, and a live surface for a capability that no longer
-- exists.
--
-- So this rollback keeps the table and its rows, keeps `disclosures_select_member`
-- so an admin can still SEE what was published, and removes everything that can
-- WRITE it: the INSERT and UPDATE grants, and the two write policies. The
-- asymmetry with the other four rollbacks is deliberate and stated here rather
-- than left to be inferred.
--
-- `capability_verification_hits` IS dropped: a counter belonging to a
-- capability that no longer exists, holding no personal data, read by nothing.
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
DROP POLICY IF EXISTS cap_verification_only_locked        ON public.sroi_reports;
DROP POLICY IF EXISTS cap_verification_only_live          ON public.report_public_disclosures;

-- The write path goes with the capability. `disclosures_select_member` stays,
-- so an administrator can still read what was published while it was live.
DROP POLICY IF EXISTS disclosures_insert_admin ON public.report_public_disclosures;
DROP POLICY IF EXISTS disclosures_update_admin ON public.report_public_disclosures;

REVOKE INSERT, UPDATE ON public.report_public_disclosures FROM uellix_writer;

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

COMMENT ON TABLE public.report_public_disclosures IS
  'CAP-02 (rolled back): retained deliberately. Each row records a human decision to publish a report, with approver and timestamp. Nothing can write it any more — the INSERT/UPDATE grants and the two write policies were removed with the capability — and nothing serves it publicly. Readable by an organisation admin via disclosures_select_member. See docs/ops/capabilities/CAP_02_PUBLIC_VERIFICATION.md §13.';

RESET ROLE;

-- ============================================================
-- 3. Role and, if empty, the schema
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA uellix_capability FROM uellix_cap_verification';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_org_ids() FROM uellix_cap_verification';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM uellix_cap_verification';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_role_in_org(uuid) FROM uellix_cap_verification';
    -- No membership to revoke: the capability role has ZERO members.
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

  -- The deliberate survivor, and the write path that does NOT survive with it.
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'report_public_disclosures') THEN
    RAISE EXCEPTION 'report_public_disclosures was dropped; the rollback must retain it.';
  END IF;
  IF pg_catalog.has_any_column_privilege('uellix_writer', 'public.report_public_disclosures'::regclass, 'INSERT')
     OR pg_catalog.has_any_column_privilege('uellix_writer', 'public.report_public_disclosures'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'the runtime still holds a write privilege on report_public_disclosures after rollback.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname IN ('disclosures_insert_admin','disclosures_update_admin')
  ) THEN
    RAISE EXCEPTION 'a disclosure WRITE policy survives the rollback.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'disclosures_select_member'
  ) THEN
    RAISE EXCEPTION 'disclosures_select_member was dropped; an admin must still be able to read what was published.';
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
    RAISE EXCEPTION 'the policy baseline is not 105 after rollback.';
  END IF;

  RAISE NOTICE 'stella_0007 rolled back: CAP-02 absent; disclosure rows retained, read-only, unserved.';
END
$$;
