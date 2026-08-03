-- db/prepared/stella_0008_stripe_webhook_identity.sql
-- CAP-03 — a dedicated technical identity for the Stripe webhook.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_0008_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_03_STRIPE.md
-- COMMON MODEL:    docs/ops/DATABASE_CAPABILITY_MODEL.md
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. THE CAPABILITY IS NOT ENABLED.
-- WEBHOOK_DATABASE_IDENTITY_AVAILABLE stays false; the route still answers 503
-- and tests/stripe-webhook-route.test.ts must stay green after this package.
--
-- ============================================================================
-- WHY BOTH A LOGIN ROLE AND A DEFINER FUNCTION
-- ============================================================================
-- Stripe is the only one of the five capabilities with no human subject: there
-- is no session, and the organisation is found by stripe_customer_id, so the
-- row belongs to no user's membership. stella_0005c anticipated exactly this
-- and promised the webhook would write "through a TECHNICAL identity when one
-- exists, not through uellix_app with user claims". This package is that
-- promise.
--
--   * A definer function alone would hang the billing mutation off uellix_app:
--     un-rotatable, un-revocable separately, indistinguishable in
--     pg_stat_activity from ordinary traffic.
--   * A LOGIN role alone would need UPDATE and SELECT on organizations —
--     SELECT on organizations IS the customer list.
--
-- Together: uellix_stripe holds EXECUTE on three functions and NO privilege of
-- any kind on any table in public. A leak of its credential cannot read one
-- SROI datum, one customer name, or one project.
--
-- NOTE ON A CLAIM THIS PACKAGE DOES NOT MAKE. uellix_stripe does inherit USAGE
-- on schema public, because the schema's ACL carries an entry for PUBLIC
-- (measured: `=U/pg_database_owner`) and PostgreSQL ACLs are additive — there
-- is no per-role deny. Removing it would mean REVOKE USAGE ON SCHEMA public
-- FROM PUBLIC, which reaches Supabase-internal roles and is out of scope for a
-- capability package (RR-CAP-7). Being able to NAME a table one has no
-- privilege on buys nothing; the postconditions below prove the privilege side.
--
-- Runs as superuser for the CREATE ROLE window; see stella_0006's header.
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0008_stripe_webhook_identity.sql
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
--   * It does NOT set a password. uellix_stripe is created LOGIN with no
--     password; the operator sets one out of band and stores it as
--     UELLIX_STRIPE_DATABASE_URL, available to the webhook handler alone.
--     A password in a versioned file is a password in the repository.
--   * It grants uellix_stripe no membership, no BYPASSRLS, no CREATEROLE, no
--     CREATE, and no table privilege whatsoever.
--   * It grants uellix_app NOTHING here: the runtime must not be able to move
--     a quota.
--   * It stores no Stripe payload, ever.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0008 must run as a superuser (it creates roles); current_user is %.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0008 requires stella_0004 (uellix_owner is absent).';
  END IF;

  IF (SELECT count(*) FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN ('report_public_disclosures','capability_verification_hits',
                               'stripe_webhook_events','capability_bootstrap_attempts')) <> 38 THEN
    RAISE EXCEPTION 'Expected 38 non-capability tables in public, found %.',
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
    RAISE EXCEPTION 'Expected 105 baseline policies in public, found %.',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND pg_catalog.left(policyname, 4) <> 'cap_'
          AND pg_catalog.left(policyname, 12) <> 'disclosures_'
          AND policyname NOT IN ('anon_insert_marketing_leads',
                                 'authenticated_insert_marketing_leads'));
  END IF;

  -- The billing columns this capability moves must exist under the names it
  -- uses. A rename upstream would otherwise surface as a runtime error inside
  -- a webhook, which is the worst place to discover it.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name IN ('stripe_customer_id','stripe_subscription_id',
                             'stripe_price_id','stella_monthly_quota','stella_plan_label')) <> 5 THEN
    RAISE EXCEPTION 'stella_0008 requires the five billing columns on public.organizations.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('organizations','audit_logs')
      AND c.relrowsecurity IS FALSE
  ) THEN
    RAISE EXCEPTION 'stella_0008 requires RLS enabled on organizations and audit_logs.';
  END IF;
END
$$;

-- ============================================================
-- 1. WINDOW 1 (superuser) — the two roles and the schema
-- ============================================================

-- 1.1 The technical connection identity. LOGIN, and nothing else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_stripe') THEN
    EXECUTE 'CREATE ROLE uellix_stripe';
  END IF;
END
$$;

ALTER ROLE uellix_stripe
  LOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

-- Part of the contract, not tuning. A webhook that stalls with an open
-- transaction would hold organizations rows against every other writer; and a
-- long statement is never correct here, since the handler's own budget is
-- seconds. These also bound the "orphan processing" window (RR-CAP-03-A).
ALTER ROLE uellix_stripe SET statement_timeout = '10s';
ALTER ROLE uellix_stripe SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE uellix_stripe SET search_path = 'uellix_capability';

COMMENT ON ROLE uellix_stripe IS
  'stella_0008 / CAP-03: connection identity for the Stripe webhook handler ONLY. Holds EXECUTE on three functions and no table privilege anywhere. Its credential is set out of band and must not be shared with any other webhook or service.';

-- 1.2 The definer.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stripe') THEN
    EXECUTE 'CREATE ROLE uellix_cap_stripe';
  END IF;
END
$$;

ALTER ROLE uellix_cap_stripe
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

GRANT uellix_cap_stripe TO uellix_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

COMMENT ON ROLE uellix_cap_stripe IS
  'stella_0008 / CAP-03: definer of the three uellix_capability.stripe_* functions. NOLOGIN, no memberships, subject to RLS. Reaches only the five billing columns of organizations, the webhook event table, and audit_logs.';

CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_stripe;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_stripe;

-- ============================================================
-- 2. WINDOW 2 (owner) — event table, functions, grants, policies
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 The idempotency store.
--
-- event_id is the PRIMARY KEY, and that single fact replaces the current
-- check-then-act (a SELECT on audit_logs.reason followed by a write, with no
-- constraint behind it and a window wide enough for two concurrent Stripe
-- deliveries to both pass). Two deliveries now contend for one key and the
-- engine decides.
--
-- There is NO payload column, and there never should be: the Stripe event
-- carries payment and customer data that Stripe already custodies and the
-- application does not need. last_error_code is a CODE, not a message —
-- a PostgreSQL error message can quote a row value.
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id        text        PRIMARY KEY,
  event_type      text        NOT NULL,
  status          text        NOT NULL DEFAULT 'received',
  attempts        integer     NOT NULL DEFAULT 1,
  received_at     timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  failed_at       timestamptz,
  last_error_code text,
  organization_id uuid REFERENCES public.organizations(id),
  CONSTRAINT stripe_webhook_events_status_check
    CHECK (status IN ('received','processing','completed','failed')),
  CONSTRAINT stripe_webhook_events_error_code_check
    CHECK (last_error_code IS NULL
           OR last_error_code IN ('signature','org_not_resolved','price_unmapped','internal'))
);

COMMENT ON TABLE public.stripe_webhook_events IS
  'CAP-03. One row per Stripe event, keyed by the Stripe event id — the idempotency key. Deliberately holds NO payload and no error message, only a fixed error CODE. Not append-only (the state machine needs UPDATE) but the capability has no DELETE: it cannot erase what it did.';

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status
  ON public.stripe_webhook_events (status, received_at);

-- 2.2 Claim an event.
--
-- Returns 'claimed' | 'duplicate' | 'in_progress'. The handler proceeds only on
-- 'claimed'; 'duplicate' is a 200 with no work; 'in_progress' is a 5xx so
-- Stripe retries.
--
-- The processing lease: a row stuck in 'processing' because a worker died
-- between begin and apply would otherwise reject every retry forever, and
-- Stripe would eventually give up — the silent loss the current handler
-- refuses to commit. Fifteen minutes is a lease, not a lock, and it is
-- documented as a heuristic (RR-CAP-03-A).
CREATE OR REPLACE FUNCTION uellix_capability.stripe_begin_event(
  p_event_id   text,
  p_event_type text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_claimed boolean := false;
  v_status  text;
BEGIN
  IF p_event_id IS NULL OR pg_catalog.length(p_event_id) = 0
     OR pg_catalog.length(p_event_id) > 255
     OR p_event_type IS NULL OR pg_catalog.length(p_event_type) > 255 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  INSERT INTO public.stripe_webhook_events AS e (event_id, event_type, status, attempts)
  VALUES (p_event_id, p_event_type, 'processing', 1)
  ON CONFLICT (event_id) DO UPDATE
     SET status      = 'processing',
         attempts    = e.attempts + 1,
         received_at = pg_catalog.now(),
         failed_at   = NULL
   WHERE e.status IN ('failed','received')
      OR (e.status = 'processing'
          AND e.received_at < pg_catalog.now() - interval '15 minutes')
  RETURNING true INTO v_claimed;

  IF v_claimed THEN
    RETURN 'claimed';
  END IF;

  -- The ON CONFLICT matched nothing to update, so the row exists in a state we
  -- may not take. Distinguishing the two is safe: the caller is Stripe, which
  -- already knows it sent this event.
  SELECT e.status INTO v_status
    FROM public.stripe_webhook_events e
   WHERE e.event_id = p_event_id;

  IF v_status = 'completed' THEN
    RETURN 'duplicate';
  END IF;

  RETURN 'in_progress';
END
$$;

ALTER FUNCTION uellix_capability.stripe_begin_event(text, text) OWNER TO uellix_cap_stripe;

-- 2.3 Apply a subscription change. ONE transaction, six steps.
--
-- This closes the current handler's worst defect: today the UPDATE of
-- organizations and the INSERT into audit_logs are separate statements, so a
-- failure between them leaves a quota changed with no record of why — the
-- worst possible partial state in billing.
CREATE OR REPLACE FUNCTION uellix_capability.stripe_apply_subscription(
  p_event_id               text,
  p_match_kind             text,
  p_match_value            text,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_stripe_price_id        text,
  p_quota                  integer,
  p_plan_label             text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_org_id  uuid;
  v_before  jsonb;
  v_matches integer;
BEGIN
  SET LOCAL lock_timeout = '3s';

  IF p_match_kind NOT IN ('customer','subscription','organization')
     OR p_match_value IS NULL
     OR p_quota IS NULL OR p_quota < 0 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- The event must be one we claimed. Without this an attacker who reached the
  -- function could apply a change that no signed event ever asked for.
  IF NOT EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE e.event_id = p_event_id AND e.status = 'processing'
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Resolve EXACTLY one organisation. Zero or many is a failure, not a
  -- best-effort pick.
  SELECT count(*), pg_catalog.min(o.id) INTO v_matches, v_org_id
    FROM public.organizations o
   WHERE (p_match_kind = 'customer'     AND o.stripe_customer_id     = p_match_value)
      OR (p_match_kind = 'subscription' AND o.stripe_subscription_id = p_match_value)
      OR (p_match_kind = 'organization' AND o.id::text               = p_match_value);

  IF v_matches <> 1 THEN
    UPDATE public.stripe_webhook_events
       SET status = 'failed', failed_at = pg_catalog.now(), last_error_code = 'org_not_resolved'
     WHERE event_id = p_event_id;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- client_reference_id is chosen by whoever created the checkout session, so
  -- 'organization' is an ASSERTION, not a fact. An organisation that already
  -- belongs to a different Stripe customer may not be re-pointed by a checkout
  -- session: that would let one tenant's checkout capture another's billing.
  IF p_match_kind = 'organization' THEN
    IF EXISTS (
      SELECT 1 FROM public.organizations o
       WHERE o.id = v_org_id
         AND o.stripe_customer_id IS NOT NULL
         AND o.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    ) THEN
      UPDATE public.stripe_webhook_events
         SET status = 'failed', failed_at = pg_catalog.now(), last_error_code = 'org_not_resolved'
       WHERE event_id = p_event_id;
      RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
    END IF;
  END IF;

  SELECT pg_catalog.jsonb_build_object(
           'priceId', o.stripe_price_id,
           'quota',   o.stella_monthly_quota,
           'label',   o.stella_plan_label)
    INTO v_before
    FROM public.organizations o
   WHERE o.id = v_org_id;

  UPDATE public.organizations
     SET stripe_customer_id     = pg_catalog.coalesce(p_stripe_customer_id, stripe_customer_id),
         stripe_subscription_id = p_stripe_subscription_id,
         stripe_price_id        = p_stripe_price_id,
         stella_monthly_quota   = p_quota,
         stella_plan_label      = p_plan_label,
         updated_at             = pg_catalog.now()
   WHERE id = v_org_id;

  -- actor_user_id is NULL, and the policy REQUIRES it to be. A billing change
  -- made by Stripe must not be attributed to a person who did not make it —
  -- stella_0005c's reasoning, applied from the other side.
  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action,
     before_json, after_json, reason)
  VALUES
    (v_org_id, NULL, 'organization', v_org_id, 'stripe.subscription.applied',
     v_before,
     pg_catalog.jsonb_build_object('priceId', p_stripe_price_id, 'quota', p_quota, 'label', p_plan_label),
     'stripe_event');

  UPDATE public.stripe_webhook_events
     SET status = 'completed', completed_at = pg_catalog.now(), organization_id = v_org_id
   WHERE event_id = p_event_id;
END
$$;

ALTER FUNCTION uellix_capability.stripe_apply_subscription(text, text, text, text, text, text, integer, text)
  OWNER TO uellix_cap_stripe;

-- 2.4 Record a failure. The code is validated against a fixed list, so it
-- cannot become a channel for a message that quotes data.
CREATE OR REPLACE FUNCTION uellix_capability.stripe_fail_event(
  p_event_id   text,
  p_error_code text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
BEGIN
  IF p_error_code NOT IN ('signature','org_not_resolved','price_unmapped','internal') THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  UPDATE public.stripe_webhook_events
     SET status = 'failed', failed_at = pg_catalog.now(), last_error_code = p_error_code
   WHERE event_id = p_event_id AND status = 'processing';
END
$$;

ALTER FUNCTION uellix_capability.stripe_fail_event(text, text) OWNER TO uellix_cap_stripe;

-- 2.5 Definer grants — column-scoped.
--
-- SELECT on organizations gives up the five billing columns and the id. NOT
-- name, NOT slug, NOT status, NOT country. The capability cannot produce a
-- customer list even if its body tried.
GRANT SELECT (id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
              stella_monthly_quota, stella_plan_label)
  ON public.organizations TO uellix_cap_stripe;

GRANT UPDATE (stripe_customer_id, stripe_subscription_id, stripe_price_id,
              stella_monthly_quota, stella_plan_label, updated_at)
  ON public.organizations TO uellix_cap_stripe;

GRANT SELECT, INSERT ON public.stripe_webhook_events TO uellix_cap_stripe;
-- No UPDATE on event_id or event_type: what arrived cannot be rewritten.
-- No DELETE at all: the capability cannot erase the record of what it did.
-- Retention purges (DP-CAP-07) are the migrator's job.
GRANT UPDATE (status, attempts, received_at, completed_at, failed_at,
              last_error_code, organization_id)
  ON public.stripe_webhook_events TO uellix_cap_stripe;

GRANT INSERT (organization_id, actor_user_id, entity_type, entity_id, action,
              before_json, after_json, reason)
  ON public.audit_logs TO uellix_cap_stripe;

-- 2.6 Policies.

DROP POLICY IF EXISTS cap_stripe_select_orgs ON public.organizations;
CREATE POLICY cap_stripe_select_orgs
ON public.organizations FOR SELECT TO uellix_cap_stripe
USING (true);

DROP POLICY IF EXISTS cap_stripe_update_orgs ON public.organizations;
CREATE POLICY cap_stripe_update_orgs
ON public.organizations FOR UPDATE TO uellix_cap_stripe
USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cap_stripe_rw_events ON public.stripe_webhook_events;
CREATE POLICY cap_stripe_rw_events
ON public.stripe_webhook_events FOR ALL TO uellix_cap_stripe
USING (true) WITH CHECK (true);

-- actor_user_id IS NULL is MANDATORY here, and it is the mirror image of the
-- uellix_app policy stella_0005c wrote, which mandates the opposite. The two
-- are disjoint by role and by action prefix, so neither had to be relaxed to
-- accommodate the other.
DROP POLICY IF EXISTS cap_stripe_insert_audit ON public.audit_logs;
CREATE POLICY cap_stripe_insert_audit
ON public.audit_logs FOR INSERT TO uellix_cap_stripe
WITH CHECK (
  actor_user_id IS NULL
  AND entity_type = 'organization'
  AND pg_catalog.left(action, 7) = 'stripe.'
);

RESET ROLE;

-- ============================================================
-- 3. WINDOW 3 (superuser) — function ACLs
-- ============================================================
-- EXECUTE goes to uellix_stripe and to NOBODY else. That uellix_app cannot
-- call these is as important as that uellix_stripe can: it is what stops any
-- application endpoint from moving a quota.

REVOKE ALL ON FUNCTION uellix_capability.stripe_begin_event(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_capability.stripe_apply_subscription(text, text, text, text, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_capability.stripe_fail_event(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION uellix_capability.stripe_begin_event(text, text) TO uellix_stripe;
GRANT EXECUTE ON FUNCTION uellix_capability.stripe_apply_subscription(text, text, text, text, text, text, integer, text) TO uellix_stripe;
GRANT EXECUTE ON FUNCTION uellix_capability.stripe_fail_event(text, text) TO uellix_stripe;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
DECLARE
  v_policies integer;
  v_leaks    integer;
BEGIN
  -- 4.1 Role attributes.
  IF NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_stripe') THEN
    RAISE EXCEPTION 'uellix_stripe must be LOGIN.';
  END IF;
  IF (SELECT rolbypassrls OR rolcreaterole OR rolcreatedb OR rolsuper
        FROM pg_roles WHERE rolname = 'uellix_stripe') THEN
    RAISE EXCEPTION 'uellix_stripe has a forbidden role attribute.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'uellix_stripe')
  ) THEN
    RAISE EXCEPTION 'uellix_stripe is a member of a role; it must have none.';
  END IF;
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_stripe') THEN
    RAISE EXCEPTION 'uellix_cap_stripe must be NOLOGIN.';
  END IF;

  -- 4.2 THE claim of this capability: zero privilege on every table in public,
  -- in all four DML modes. Column-aware, because a column grant would not show
  -- up in has_table_privilege.
  SELECT count(*) INTO v_leaks
    FROM pg_tables t
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS m(mode)
   WHERE t.schemaname = 'public'
     AND pg_catalog.has_any_column_privilege(
           'uellix_stripe',
           ('public.' || pg_catalog.quote_ident(t.tablename))::regclass, m.mode);
  IF v_leaks <> 0 THEN
    RAISE EXCEPTION 'uellix_stripe holds % table/column privileges in public; it must hold none.', v_leaks;
  END IF;

  -- 4.3 The definer must not reach anything outside billing.
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    WHERE t.schemaname = 'public'
      AND t.tablename IN ('projects','sroi_reports','sroi_calculation_runs',
                          'evidence_items','stella_interactions','invitations',
                          'marketing_leads','organization_members','users')
      AND pg_catalog.has_any_column_privilege(
            'uellix_cap_stripe',
            ('public.' || pg_catalog.quote_ident(t.tablename))::regclass, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_stripe can read a table outside CAP-03.';
  END IF;

  IF pg_catalog.has_column_privilege('uellix_cap_stripe', 'public.organizations', 'name', 'SELECT') THEN
    RAISE EXCEPTION 'uellix_cap_stripe can read organizations.name.';
  END IF;
  IF pg_catalog.has_column_privilege('uellix_cap_stripe', 'public.organizations', 'name', 'UPDATE') THEN
    RAISE EXCEPTION 'uellix_cap_stripe can rename an organisation.';
  END IF;
  IF pg_catalog.has_column_privilege('uellix_cap_stripe', 'public.stripe_webhook_events', 'event_id', 'UPDATE') THEN
    RAISE EXCEPTION 'uellix_cap_stripe can rewrite a Stripe event id.';
  END IF;
  IF pg_catalog.has_table_privilege('uellix_cap_stripe', 'public.stripe_webhook_events', 'DELETE') THEN
    RAISE EXCEPTION 'uellix_cap_stripe can delete its own event record.';
  END IF;

  -- 4.4 The runtime must NOT be able to move a quota.
  IF pg_catalog.has_function_privilege(
       'uellix_app',
       'uellix_capability.stripe_apply_subscription(text,text,text,text,text,text,integer,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_app can execute stripe_apply_subscription.';
  END IF;
  IF pg_catalog.has_function_privilege(
       'public', 'uellix_capability.stripe_begin_event(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on stripe_begin_event.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_stripe', 'uellix_capability.stripe_begin_event(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_stripe does not hold EXECUTE on stripe_begin_event.';
  END IF;

  -- 4.5 Cross-capability isolation, both directions.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability'
      AND pg_catalog.left(p.proname, 7) <> 'stripe_'
      AND pg_catalog.has_function_privilege('uellix_stripe', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'uellix_stripe can execute a function outside CAP-03.';
  END IF;

  -- 4.6 The event table cannot grow a payload column by accident.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events'
      AND column_name NOT IN ('event_id','event_type','status','attempts','received_at',
                              'completed_at','failed_at','last_error_code','organization_id')
  ) THEN
    RAISE EXCEPTION 'stripe_webhook_events has an unexpected column.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND pg_catalog.left(policyname, 11) = 'cap_stripe_';
  IF v_policies <> 4 THEN
    RAISE EXCEPTION 'Expected 4 cap_stripe_* policies, found %.', v_policies;
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'stella_0008 changed the policy baseline; expected 105.';
  END IF;

  RAISE NOTICE 'stella_0008 applied: CAP-03 identity present, handler still refusing (503).';
END
$$;
