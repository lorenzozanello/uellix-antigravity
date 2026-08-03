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
-- and tests/stripe-webhook-route.test.ts must stay green.
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
-- any kind on any relation in public.
--
-- NOTE ON A CLAIM THIS PACKAGE DOES NOT MAKE. uellix_stripe does inherit USAGE
-- on schema public, because the schema's ACL carries an entry for PUBLIC
-- (measured: `=U/pg_database_owner`) and PostgreSQL ACLs are additive — there
-- is no per-role deny. Removing it would mean REVOKE USAGE ON SCHEMA public
-- FROM PUBLIC, which reaches Supabase-internal roles and is out of scope for a
-- capability package (RR-CAP-7). Naming a relation one has no privilege on
-- buys nothing; the postconditions prove the privilege side.
--
-- ============================================================================
-- WHAT THE ADVERSARIAL REVIEW CHANGED (2026-08-03)
-- ============================================================================
-- * `stripe_apply_subscription` used to mark an unresolvable event `failed`
--   and then RAISE — in the same transaction, so the UPDATE was rolled back by
--   the RAISE. The row stayed `processing`, `last_error_code` stayed NULL, and
--   every Stripe retry for fifteen minutes got `in_progress` → 5xx. The
--   mitigation reintroduced the silent-loss failure the whole handler exists
--   to avoid. Marking a failure is now the handler's job, through
--   `stripe_fail_event`, which is a SEPARATE transaction and already correct.
-- * The cross-tenant guard covered one case out of three. It only fired for
--   `match_kind = 'organization'` AND only when the target already carried a
--   DIFFERENT customer id — so an organisation that had never subscribed could
--   be claimed outright, and the `customer`/`subscription` branches never
--   checked that `p_stripe_customer_id` agreed with what they resolved on.
-- * `pg_catalog.coalesce(...)` does not exist. COALESCE is a grammar
--   production, not a function; there is no pg_proc row with that name, so the
--   over-qualified form fails at RUN time — inside a webhook.
-- * The function lifecycle moved to the superuser window. See stella_0006's
--   header for the ownership-transfer mechanics.
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0008_stripe_webhook_identity.sql
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
--   * It does NOT set a password. uellix_stripe is created LOGIN with no
--     password; the operator sets one out of band as UELLIX_STRIPE_DATABASE_URL,
--     available to the webhook handler alone.
--   * It grants uellix_stripe no membership, no BYPASSRLS, no CREATEROLE, no
--     CREATE, and no relation privilege whatsoever.
--   * It grants uellix_app NOTHING here: the runtime must not move a quota.
--   * It stores no Stripe payload, ever.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0008 must run as a superuser; current_user is %.', current_user;
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
-- transaction would hold organizations rows against every other writer, and a
-- long statement is never correct here. These also bound the orphan-processing
-- window (RR-CAP-03-A).
ALTER ROLE uellix_stripe SET statement_timeout = '10s';
ALTER ROLE uellix_stripe SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE uellix_stripe SET search_path = 'uellix_capability';

COMMENT ON ROLE uellix_stripe IS
  'stella_0008 / CAP-03: connection identity for the Stripe webhook handler ONLY. Holds EXECUTE on three functions and no relation privilege anywhere. Its credential is set out of band and must not be shared with any other webhook or service.';

-- 1.2 The definer. ZERO members: the ownership transfer happens as superuser,
-- so nothing ever needs to be a member of it. This matters because SET ROLE
-- authorisation is TRANSITIVE — a membership in uellix_owner would have made
-- the capability reachable from uellix_migrator, which is a LOGIN role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_stripe') THEN
    EXECUTE 'CREATE ROLE uellix_cap_stripe';
  END IF;
END
$$;

ALTER ROLE uellix_cap_stripe
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

COMMENT ON ROLE uellix_cap_stripe IS
  'stella_0008 / CAP-03: definer of the three uellix_capability.stripe_* functions. NOLOGIN, ZERO members, subject to RLS. Reaches only the five billing columns of organizations, the webhook event table, and audit_logs.';

CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_stripe;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_stripe;

-- ============================================================
-- 2. WINDOW 2 (owner) — event table, grants, policies
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 The idempotency store.
--
-- event_id is the PRIMARY KEY, and that single fact replaces the current
-- check-then-act (a SELECT on audit_logs.reason followed by a write, with no
-- constraint behind it and a window wide enough for two concurrent Stripe
-- deliveries to both pass). Two deliveries now contend for one key.
--
-- There is NO payload column, and never should be: the Stripe event carries
-- payment and customer data that Stripe already custodies and the application
-- does not need. last_error_code is a CODE, not a message — a PostgreSQL error
-- message can quote a row value.
--
-- `status` has no DEFAULT: every insert goes straight to 'processing' (there is
-- exactly one insert, in stripe_begin_event), so a 'received' default would be
-- a state nothing can reach. It stays in the CHECK as a reserved value.
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id        text        PRIMARY KEY,
  event_type      text        NOT NULL,
  status          text        NOT NULL,
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
  'CAP-03. One row per Stripe event, keyed by the Stripe event id — the idempotency key. Holds NO payload and no error message, only a fixed error CODE. Not append-only (the state machine needs UPDATE) but the capability has no DELETE: it cannot erase what it did.';

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status
  ON public.stripe_webhook_events (status, received_at);

-- 2.2 Definer grants — column-scoped.
--
-- SELECT on organizations gives up the five billing columns and the id. NOT
-- name, NOT slug, NOT status, NOT country: the capability cannot produce a
-- customer list even if its body tried.

-- The pre-existing SELECT/INSERT/UPDATE policies on the tables this capability
-- touches are `{public}` — they apply to EVERY role, this definer included —
-- and their USING clauses call the three SECURITY DEFINER helpers. stella_0004
-- revoked EXECUTE on those helpers from PUBLIC, so without these three grants
-- the definer raises «permission denied for function current_user_org_ids»
-- (42501) while evaluating a policy that would have been irrelevant to it.
--
-- Discovered by dry run, not by review: the failure is invisible to every
-- static check, because the policy that breaks belongs to another role.
--
-- The grants are safe by construction. The helpers are SECURITY DEFINER owned
-- by uellix_owner, so they run with ITS privileges and read the CALLER's
-- memberships from auth.uid(); invoked from a capability definer with no JWT
-- they return the empty set. `uellix_writer` and `uellix_auditor` already hold
-- the same EXECUTE.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids()        TO uellix_cap_stripe;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_cap_stripe;
GRANT EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) TO uellix_cap_stripe;

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

-- 2.3 Policies.

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
-- 3. WINDOW 3 (superuser) — the functions, their owners, their ACLs
-- ============================================================

-- 3.1 Claim an event.
--
-- Returns 'claimed' | 'duplicate' | 'in_progress'. The handler proceeds only on
-- 'claimed'; 'duplicate' is a 200 with no work; 'in_progress' is a 5xx so
-- Stripe retries.
--
-- The processing lease: a row stuck in 'processing' because a worker died
-- between begin and apply would otherwise reject every retry forever, and
-- Stripe would eventually give up — the silent loss the current handler
-- refuses to commit. Fifteen minutes is a lease, not a lock (RR-CAP-03-A).
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
  SET LOCAL lock_timeout = '3s';

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

EXCEPTION
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  WHEN OTHERS THEN
    RAISE LOG 'stripe_begin_event refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.stripe_begin_event(text, text) OWNER TO uellix_cap_stripe;

-- 3.2 Apply a subscription change. ONE transaction, five steps.
--
-- This closes the current handler's worst defect: today the UPDATE of
-- organizations and the INSERT into audit_logs are separate statements, so a
-- failure between them leaves a quota changed with no record of why.
--
-- It does NOT mark the event failed. An UPDATE followed by a RAISE in the same
-- transaction is rolled back BY that RAISE — the row would stay 'processing'
-- with a NULL error code, and every retry would get 'in_progress' until the
-- lease expired. Marking a failure is the handler's job, through
-- stripe_fail_event, in its own transaction.
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
  v_org_id       uuid;
  v_org_ids      uuid[];
  v_org_customer text;
  v_org_sub      text;
  v_before       jsonb;
BEGIN
  SET LOCAL lock_timeout = '3s';

  IF p_match_kind NOT IN ('customer','subscription','organization')
     OR p_match_value IS NULL
     OR p_quota IS NULL OR p_quota < 0 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- The event must be one we claimed. Without this, anything that reached the
  -- function could apply a change no signed event ever asked for.
  IF NOT EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE e.event_id = p_event_id AND e.status = 'processing'
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Resolve EXACTLY one organisation. Zero or many is a failure, not a
  -- best-effort pick.
  --
  -- array_agg, not min: PostgreSQL has NO min()/max() aggregate for uuid, so
  -- `min(o.id)` raises 42883 «function pg_catalog.min(uuid) does not exist».
  -- Measured in the dry run — it is a run-time failure, invisible at CREATE
  -- FUNCTION, and it would have surfaced inside a live webhook. array_agg is
  -- polymorphic and takes uuid without complaint.
  SELECT pg_catalog.array_agg(o.id) INTO v_org_ids
    FROM public.organizations o
   WHERE (p_match_kind = 'customer'     AND o.stripe_customer_id     = p_match_value)
      OR (p_match_kind = 'subscription' AND o.stripe_subscription_id = p_match_value)
      OR (p_match_kind = 'organization' AND o.id::text               = p_match_value);

  IF v_org_ids IS NULL OR pg_catalog.array_length(v_org_ids, 1) <> 1 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;
  v_org_id := v_org_ids[1];

  SELECT o.stripe_customer_id, o.stripe_subscription_id
    INTO v_org_customer, v_org_sub
    FROM public.organizations o
   WHERE o.id = v_org_id;

  -- The tenancy guard, in all THREE branches.
  --
  -- An earlier revision guarded only the 'organization' branch, and only when
  -- the target already carried a DIFFERENT customer id — so an organisation
  -- that had never subscribed could be claimed outright by any
  -- client_reference_id, and the other two branches would silently repoint an
  -- established organisation's customer id to whatever the caller passed.
  --
  --   * 'organization' comes from checkout's client_reference_id, which is
  --     chosen by whoever created the session. It is an ASSERTION. Refuse it
  --     for any organisation that already has billing attached at all.
  --   * 'customer' resolved by cus_X may only carry cus_X.
  --   * 'subscription' may only act on the organisation whose customer id
  --     already matches what the event says.
  IF p_match_kind = 'organization' THEN
    IF v_org_customer IS NOT NULL OR v_org_sub IS NOT NULL THEN
      RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
    END IF;
  ELSIF p_match_kind = 'customer' THEN
    IF p_stripe_customer_id IS DISTINCT FROM p_match_value THEN
      RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
    END IF;
  ELSE
    IF p_stripe_customer_id IS NOT NULL
       AND v_org_customer IS DISTINCT FROM p_stripe_customer_id THEN
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

  -- COALESCE, not pg_catalog.coalesce: COALESCE is a grammar production, not a
  -- function. There is no pg_proc row with that name, so the over-qualified
  -- form fails «function pg_catalog.coalesce(...) does not exist» — at RUN
  -- time, because plpgsql does not resolve SQL expressions at CREATE FUNCTION.
  -- Being grammar rather than a name, it is immune to search_path anyway.
  UPDATE public.organizations
     SET stripe_customer_id     = COALESCE(p_stripe_customer_id, stripe_customer_id),
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

EXCEPTION
  -- 23505 from organizations_stripe_subscription_id_unique would otherwise
  -- reach the caller as «Key (stripe_subscription_id)=(sub_…) already exists» —
  -- a Stripe payload value inside an error string, which the handler then logs
  -- whole. Collapse it; log the SQLSTATE only, never SQLERRM.
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  WHEN OTHERS THEN
    RAISE LOG 'stripe_apply_subscription refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.stripe_apply_subscription(text, text, text, text, text, text, integer, text)
  OWNER TO uellix_cap_stripe;

-- 3.3 Record a failure, in its OWN transaction.
--
-- The handler calls this from its catch block after stripe_apply_subscription
-- has raised and rolled back. The code is validated against a fixed list, so it
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

EXCEPTION
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  WHEN OTHERS THEN
    RAISE LOG 'stripe_fail_event refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.stripe_fail_event(text, text) OWNER TO uellix_cap_stripe;

COMMENT ON FUNCTION uellix_capability.stripe_begin_event(text, text) IS
  'CAP-03. Atomically claims one Stripe event. Returns claimed | duplicate | in_progress.';
COMMENT ON FUNCTION uellix_capability.stripe_apply_subscription(text, text, text, text, text, text, integer, text) IS
  'CAP-03. Applies one subscription change in ONE transaction: organisation update, audit row, event completion. Does not mark failures — see stripe_fail_event, which needs its own transaction to survive.';
COMMENT ON FUNCTION uellix_capability.stripe_fail_event(text, text) IS
  'CAP-03. Marks a claimed event failed with a fixed error CODE. Called by the handler AFTER stripe_apply_subscription has raised and rolled back.';

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
  v_extra    text;
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
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'uellix_cap_stripe')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_stripe has a member; it must have none.';
  END IF;

  -- 4.2 THE claim of this capability: zero privilege on every RELATION in
  -- public, in all four DML modes.
  --
  -- Two functions, not one, and the split is not cosmetic: DELETE and TRUNCATE
  -- are TABLE-level privileges with no column-level form, so
  -- has_any_column_privilege(..., 'DELETE') does not return false — it raises
  -- «unrecognized privilege type». An earlier revision used it and the
  -- postcondition aborted the whole package. Only SELECT, INSERT, UPDATE and
  -- REFERENCES exist per column.
  --
  -- pg_class filtered by relkind, not pg_tables: pg_tables omits views,
  -- materialised views, foreign tables and sequences, and a view with a PUBLIC
  -- grant would be a read path pg_tables cannot see.
  SELECT count(*) INTO v_leaks
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) AS m(mode)
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r','p','v','m','f')
     AND pg_catalog.has_any_column_privilege('uellix_stripe', c.oid, m.mode);
  IF v_leaks <> 0 THEN
    RAISE EXCEPTION 'uellix_stripe holds % relation/column privileges in public; it must hold none.', v_leaks;
  END IF;

  SELECT count(*) INTO v_leaks
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('DELETE'),('TRUNCATE'),('TRIGGER')) AS m(mode)
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r','p','v','m','f')
     AND pg_catalog.has_table_privilege('uellix_stripe', c.oid, m.mode);
  IF v_leaks <> 0 THEN
    RAISE EXCEPTION 'uellix_stripe holds % table-level privileges in public; it must hold none.', v_leaks;
  END IF;

  -- 4.3 The definer must not reach anything outside billing.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m','f')
      AND c.relname NOT IN ('organizations','stripe_webhook_events','audit_logs')
      AND pg_catalog.has_any_column_privilege('uellix_cap_stripe', c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_stripe can read a relation outside CAP-03.';
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

  -- 4.4 All three functions are SECURITY DEFINER, owned by the definer, with
  -- an EMPTY search_path — enumerated, not prefix-matched.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'uellix_capability'
         AND pg_catalog.left(p.proname, 7) = 'stripe_'
         AND p.prosecdef
         AND pg_get_userbyid(p.proowner) = 'uellix_cap_stripe'
         AND (p.proconfig @> ARRAY['search_path=']::text[]
           OR p.proconfig @> ARRAY['search_path=""']::text[])) <> 3 THEN
    RAISE EXCEPTION 'the three stripe_* functions are not all SECURITY DEFINER owned by uellix_cap_stripe with an EMPTY search_path.';
  END IF;

  -- 4.5 The runtime must NOT be able to move a quota, and no unexpected role
  -- may execute any of the three. Enumerating pg_roles keeps this
  -- order-independent.
  SELECT pg_catalog.string_agg(DISTINCT r.rolname, ', ') INTO v_extra
    FROM pg_roles r
    JOIN pg_proc p ON true
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'uellix_capability'
     AND pg_catalog.left(p.proname, 7) = 'stripe_'
     AND NOT r.rolsuper
     AND r.rolname NOT IN ('uellix_stripe', 'uellix_cap_stripe')
     AND pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected roles hold EXECUTE on a CAP-03 function: %', v_extra;
  END IF;

  IF pg_catalog.has_function_privilege(
       'public', 'uellix_capability.stripe_begin_event(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on stripe_begin_event.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_stripe', 'uellix_capability.stripe_begin_event(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_stripe does not hold EXECUTE on stripe_begin_event.';
  END IF;

  -- 4.6 uellix_stripe can execute nothing outside CAP-03, including functions
  -- that other capability packages may add later.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability'
      AND pg_catalog.left(p.proname, 7) <> 'stripe_'
      AND pg_catalog.has_function_privilege('uellix_stripe', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'uellix_stripe can execute a function outside CAP-03.';
  END IF;

  -- 4.7 The event table cannot grow a payload column by accident.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events'
      AND column_name NOT IN ('event_id','event_type','status','attempts','received_at',
                              'completed_at','failed_at','last_error_code','organization_id')
  ) THEN
    RAISE EXCEPTION 'stripe_webhook_events has an unexpected column.';
  END IF;


  -- The three RLS helpers must be executable, or every read this capability
  -- makes dies at 42501 while evaluating somebody else's {public} policy.
  IF NOT (pg_catalog.has_function_privilege('uellix_cap_stripe', 'public.current_user_org_ids()', 'EXECUTE')
      AND pg_catalog.has_function_privilege('uellix_cap_stripe', 'public.current_user_is_super_admin()', 'EXECUTE')
      AND pg_catalog.has_function_privilege('uellix_cap_stripe', 'public.current_user_role_in_org(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'uellix_cap_stripe cannot execute the RLS helper functions; every policy-guarded read would fail with 42501.';
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
