-- db/prepared/stella_0008_rollback.sql
-- Reverts db/prepared/stella_0008_stripe_webhook_identity.sql (CAP-03).
--
-- PREPARED ONLY — NOT A MIGRATION.
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_03_STRIPE.md §14
--
-- RUN AS SUPERUSER, in one transaction:
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0008_rollback.sql
--
-- ============================================================================
-- WHAT SURVIVES, AND WHY
-- ============================================================================
-- `stripe_webhook_events` is NOT dropped. It is the record of which billing
-- events were processed and what happened to them. In a dispute — "was this
-- plan change applied?" — it is the only thing that can answer. A rollback
-- that erases the billing audit trail is not a rollback, it is a cover-up.
--
-- The operator must also REVOKE THE CREDENTIAL of uellix_stripe out of band
-- (rotate or remove UELLIX_STRIPE_DATABASE_URL). Dropping the role here
-- invalidates it in the database, but a copy of the connection string may
-- exist in a deployment environment and should be removed explicitly.
--
-- After this script the webhook handler returns 503 and Stripe retries — the
-- same fail-closed, noisy state as before stella_0008.
-- ============================================================================

SET search_path = public;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0008_rollback must run as a superuser (it drops roles); current_user is %.', current_user;
  END IF;
END
$$;

-- ============================================================
-- 1. Functions
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_stripe') THEN
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'uellix_capability' AND p.proname = 'stripe_begin_event'
    ) THEN
      -- Both signatures. The RR-CAP-14 revision widened stripe_begin_event to
      -- carry the claimed Stripe identity; a rollback that knew only the old
      -- arity would leave a live EXECUTE on a function it then failed to drop.
      EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.stripe_begin_event(text,text,text,text) FROM uellix_stripe';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'uellix_capability' AND p.proname = 'stripe_begin_event'
        AND p.pronargs = 2
    ) THEN
      EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.stripe_begin_event(text,text) FROM uellix_stripe';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'uellix_capability' AND p.proname = 'stripe_apply_subscription'
    ) THEN
      EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.stripe_apply_subscription(text,text,text,text,text,text,integer,text) FROM uellix_stripe';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'uellix_capability' AND p.proname = 'stripe_fail_event'
    ) THEN
      EXECUTE 'REVOKE ALL ON FUNCTION uellix_capability.stripe_fail_event(text,text) FROM uellix_stripe';
    END IF;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS uellix_capability.stripe_begin_event(text, text, text, text);
-- The pre-RR-CAP-14 arity, for a database that was rolled forward before the
-- revision and back after it.
DROP FUNCTION IF EXISTS uellix_capability.stripe_begin_event(text, text);
DROP FUNCTION IF EXISTS uellix_capability.stripe_apply_subscription(text, text, text, text, text, text, integer, text);
DROP FUNCTION IF EXISTS uellix_capability.stripe_fail_event(text, text);

-- ============================================================
-- 2. Policies and grants (owner window)
-- ============================================================

SET ROLE uellix_owner;

DROP POLICY IF EXISTS cap_stripe_select_orgs  ON public.organizations;
DROP POLICY IF EXISTS cap_stripe_update_orgs  ON public.organizations;
-- The two RESTRICTIVE row bounds added for RR-CAP-14. A RESTRICTIVE policy left
-- behind by a rollback is worse than a permissive one: it is ANDed into every
-- future query by the named role, so a role of the same name recreated later
-- would inherit an invisible deny.
DROP POLICY IF EXISTS cap_stripe_only_claimed_read ON public.organizations;
DROP POLICY IF EXISTS cap_stripe_only_claimed_org  ON public.organizations;
DROP POLICY IF EXISTS cap_stripe_insert_audit ON public.audit_logs;
DROP POLICY IF EXISTS cap_stripe_rw_events    ON public.stripe_webhook_events;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stripe') THEN
    EXECUTE 'REVOKE ALL ON public.organizations FROM uellix_cap_stripe';
    EXECUTE 'REVOKE ALL ON public.audit_logs FROM uellix_cap_stripe';
    EXECUTE 'REVOKE ALL ON public.stripe_webhook_events FROM uellix_cap_stripe';
  END IF;
END
$$;

-- The runtime's privileges on the event table are NOT restored: it never had
-- them by design, only by the owner's default ACL, and stella_0008 took them
-- back. Restoring them would hand a rolled-back capability's log to the app.

-- The event table stays. Nothing can write it any more; nothing needs to.
COMMENT ON TABLE public.stripe_webhook_events IS
  'CAP-03 (rolled back): retained deliberately. Records which Stripe billing events were processed, with state, attempts and a fixed error code. The capability that wrote it no longer exists. Retention is DP-CAP-07 and is the migrator''s job. See docs/ops/capabilities/CAP_03_STRIPE.md §14.';

RESET ROLE;

-- ============================================================
-- 3. Roles and, if empty, the schema
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_stripe') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA uellix_capability FROM uellix_stripe';
    -- ALTER ROLE ... RESET ALL clears the three session settings so a role of
    -- the same name recreated later does not silently inherit them.
    EXECUTE 'ALTER ROLE uellix_stripe RESET ALL';
    EXECUTE 'DROP ROLE uellix_stripe';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stripe') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA uellix_capability FROM uellix_cap_stripe';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_org_ids() FROM uellix_cap_stripe';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM uellix_cap_stripe';
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_user_role_in_org(uuid) FROM uellix_cap_stripe';
    EXECUTE 'REVOKE uellix_cap_stripe FROM uellix_owner';
    EXECUTE 'DROP ROLE uellix_cap_stripe';
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
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('uellix_stripe','uellix_cap_stripe')) THEN
    RAISE EXCEPTION 'a CAP-03 role still exists after rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND pg_catalog.left(p.proname, 7) = 'stripe_'
  ) THEN
    RAISE EXCEPTION 'a CAP-03 function survives the rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND pg_catalog.left(policyname, 11) = 'cap_stripe_'
  ) THEN
    RAISE EXCEPTION 'cap_stripe_* policies survive the rollback.';
  END IF;

  -- The deliberate survivor.
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'stripe_webhook_events') THEN
    RAISE EXCEPTION 'stripe_webhook_events was dropped; the rollback must retain it.';
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

  RAISE NOTICE 'stella_0008 rolled back: CAP-03 absent; stripe_webhook_events retained. Rotate UELLIX_STRIPE_DATABASE_URL out of band.';
END
$$;
