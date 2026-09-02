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
    CHECK (status IN ('received','processing','completed','failed','ignored')),
  CONSTRAINT stripe_webhook_events_error_code_check
    CHECK (last_error_code IS NULL
           OR last_error_code IN ('signature','org_not_resolved','price_unmapped',
                                  'internal','not_applicable'))
);

-- 2.1bis. The claimed Stripe identity (RR-CAP-14).
--
-- These two columns are what turns "an event was claimed" into "an event was
-- claimed FOR THIS ORGANISATION", and they exist because no column list can
-- express that. The `GRANT UPDATE` of six columns bounds WHAT the capability
-- writes; with `cap_stripe_update_orgs` at USING (true) nothing bounded WHOSE
-- row it wrote, so a body rewritten to `WHERE id = <anything>` could move the
-- quota of an organisation the event never mentioned.
--
-- They are NOT a payload. They are the two Stripe-issued identifiers the
-- signed event is addressed to, and they are the only fields of it this
-- capability ever needs. `client_reference_id` is deliberately absent: it is
-- buyer-supplied (see stripe_apply_subscription §3.2), and a value an attacker
-- chooses cannot be the anchor of a tenancy bound.
--
-- ADD COLUMN IF NOT EXISTS rather than a wider CREATE TABLE: the table is
-- CREATE TABLE IF NOT EXISTS, so an operator who applied an earlier revision
-- of this package gets the columns on the next apply instead of a table that
-- silently lacks them. Both are nullable — an event may carry a customer, a
-- subscription, or both — and the policy below requires a NON-NULL match on
-- whichever side it uses, so nullability is not a hole.
ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS stripe_customer_id     text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

COMMENT ON COLUMN public.stripe_webhook_events.stripe_customer_id IS
  'CAP-03 / RR-CAP-14. The Stripe-issued customer id the signed event is addressed to, recorded when the event is CLAIMED. Read by cap_stripe_only_claimed_org to decide which organizations row this capability may touch. Never rewritable: absent from the UPDATE grant.';
COMMENT ON COLUMN public.stripe_webhook_events.stripe_subscription_id IS
  'CAP-03 / RR-CAP-14. The Stripe-issued subscription id the signed event is addressed to, recorded when the event is CLAIMED. Same bound, same immutability.';

COMMENT ON TABLE public.stripe_webhook_events IS
  'CAP-03. One row per Stripe event, keyed by the Stripe event id — the idempotency key. Holds NO payload and no error message, only a fixed error CODE and the two Stripe-issued identifiers the event is addressed to, which are what bound the capability to one organisation (RR-CAP-14). Not append-only (the state machine needs UPDATE) but the capability has no DELETE: it cannot erase what it did.';

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

-- The runtime gets NOTHING on this table, and saying so needs a statement.
-- `ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public GRANT
-- SELECT, INSERT ON TABLES TO uellix_writer` (baseline) fires the moment the
-- table is created in this owner window, at TABLE level, before any of the
-- column-scoped grants below run. ACLs are additive, so without this REVOKE the
-- enumerated grants narrow nothing and uellix_app inherits SELECT+INSERT on the
-- whole event log. Found by adversarial review, 2026-08-04.
REVOKE ALL ON public.stripe_webhook_events FROM uellix_writer, uellix_auditor;

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

-- 2.3bis. The RESTRICTIVE companions CAP-03 never had (RR-CAP-14).
--
-- CAP-01, CAP-02, CAP-04 and CAP-05 all carry them; the argument that
-- justifies them was simply never applied here. It applies verbatim: the 105
-- {public} baseline policies are PERMISSIVE and combine with OR, they apply to
-- this definer too, and their predicates resolve auth.uid() to the CALLER
-- because SECURITY DEFINER does not reset a session GUC. So the two USING
-- (true) policies above were not the bound they looked like — the only bound
-- was the column grant, which says which FIELDS, never which ROWS.
--
-- THE PREDICATE, AND WHY EACH CONJUNCT IS THERE.
--
--   e.event_id = current_setting(…)  THE event being applied, not merely some
--                                    event. Two adversarial reviewers found the
--                                    same hole independently: an uncorrelated
--                                    EXISTS means that while org B's event is in
--                                    flight, a transaction handling org A's
--                                    event satisfies RLS for B's row. The GUC is
--                                    set by stripe_apply_subscription AFTER it
--                                    has validated the claim, and it is
--                                    transaction-local, so a body that forgets
--                                    to set it reads '' and matches NOTHING —
--                                    fail-closed, not fail-open.
--   e.status = 'processing'          the event must have been CLAIMED, by
--                                    stripe_begin_event, in this transaction's
--                                    view. An unclaimed event reaches nothing.
--   e.received_at > now() - 15 min   the SAME lease stripe_begin_event uses to
--                                    decide re-claimability. Without it a worker
--                                    that died mid-flight leaves a row in
--                                    'processing' that nothing sweeps, and that
--                                    organisation stays writable FOREVER. The
--                                    role-level statement_timeout bounds the
--                                    session, never the row.
--   e.stripe_customer_id IS NOT NULL the claimed identity must exist. Without
--                                    this, NULL = NULL is NULL, not true — but
--                                    stating it makes the intent checkable
--                                    rather than a property of three-valued
--                                    logic nobody re-derives.
--   e.<id> = organizations.<id>      the row must ALREADY carry the identity
--                                    the event is addressed to. This is the
--                                    whole tenancy bound: organisation B's row
--                                    carries B's customer id, so an event
--                                    addressed to A cannot reach it, whatever
--                                    the function body says.
--
-- WHAT THIS DOES *NOT* CLOSE, STATED PLAINLY (RR-CAP-14-A). The database cannot
-- verify a Stripe signature — that check lives in the Node handler — so anything
-- holding the `uellix_stripe` credential can claim an event for a customer id it
-- chose and then apply a change for it. No policy can distinguish that from a
-- genuine delivery, because both arrive through the same three functions with
-- the same arguments. The credential IS the trust boundary, and this package has
-- always said so. What the bound below adds is everything short of that: an
-- organisation with no Stripe link is unreachable, a rewritten body cannot reach
-- a row no claimed event is addressed to, and a transaction handling one event
-- cannot reach the organisation of another.
--
-- CONSEQUENCES, STATED SO THEY ARE NOT DISCOVERED LATER:
--   * An organisation with NO Stripe link (both columns NULL) is unreachable.
--     That is correct and intentional — first-time binding is DP-CAP-15 and
--     must happen through an authenticated first-party flow, never through a
--     webhook (§3.2).
--   * The SELECT bound is not decoration: stripe_apply_subscription resolves
--     the organisation BY SCANNING organizations for the match value, so with
--     USING (true) the definer could read the billing columns of every
--     customer. Under this policy the scan returns only rows a claimed event
--     is addressed to, which is exactly the row it is looking for. The
--     "exactly one" check in the body and the RLS bound now agree by
--     construction instead of by coincidence.
--   * WITH CHECK repeats USING because the UPDATE rewrites
--     stripe_subscription_id: the POST-image must still be a row the claimed
--     event is addressed to, or the capability could rename a row out of its
--     own reach on the way past.
DROP POLICY IF EXISTS cap_stripe_only_claimed_read ON public.organizations;
CREATE POLICY cap_stripe_only_claimed_read
ON public.organizations AS RESTRICTIVE FOR SELECT TO uellix_cap_stripe
USING (
  EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE e.event_id = NULLIF(pg_catalog.current_setting('app.stripe_event_id', true), '')
       AND e.status = 'processing'
       AND e.received_at > pg_catalog.now() - interval '15 minutes'
       AND ( (e.stripe_customer_id IS NOT NULL
              AND e.stripe_customer_id = public.organizations.stripe_customer_id)
          OR (e.stripe_subscription_id IS NOT NULL
              AND e.stripe_subscription_id = public.organizations.stripe_subscription_id) )
  )
);

DROP POLICY IF EXISTS cap_stripe_only_claimed_org ON public.organizations;
CREATE POLICY cap_stripe_only_claimed_org
ON public.organizations AS RESTRICTIVE FOR UPDATE TO uellix_cap_stripe
USING (
  EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE e.event_id = NULLIF(pg_catalog.current_setting('app.stripe_event_id', true), '')
       AND e.status = 'processing'
       AND e.received_at > pg_catalog.now() - interval '15 minutes'
       AND ( (e.stripe_customer_id IS NOT NULL
              AND e.stripe_customer_id = public.organizations.stripe_customer_id)
          OR (e.stripe_subscription_id IS NOT NULL
              AND e.stripe_subscription_id = public.organizations.stripe_subscription_id) )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE e.event_id = NULLIF(pg_catalog.current_setting('app.stripe_event_id', true), '')
       AND e.status = 'processing'
       AND e.received_at > pg_catalog.now() - interval '15 minutes'
       AND ( (e.stripe_customer_id IS NOT NULL
              AND e.stripe_customer_id = public.organizations.stripe_customer_id)
          OR (e.stripe_subscription_id IS NOT NULL
              AND e.stripe_subscription_id = public.organizations.stripe_subscription_id) )
  )
);

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
-- The signature gained the two Stripe identifiers in the RR-CAP-14 revision.
-- The claim is the ONLY moment at which the capability learns, from a
-- signature-verified event, which organisation the event is addressed to; if
-- it is not recorded here it cannot be enforced anywhere. Dropping the old
-- two-argument form is part of the package rather than a manual step, because
-- leaving it behind would leave a way to claim an event with NO identity — and
-- an event claimed with both columns NULL matches no organisation, so the
-- consequence would be a webhook that fails 100% of the time after a partial
-- upgrade, not a security hole. Removing it makes the state unreachable.
DROP FUNCTION IF EXISTS uellix_capability.stripe_begin_event(text, text);

CREATE OR REPLACE FUNCTION uellix_capability.stripe_begin_event(
  p_event_id               text,
  p_event_type             text,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_claimed  boolean := false;
  v_status   text;
  v_customer text;
  v_sub      text;
BEGIN
  SET LOCAL lock_timeout = '3s';

  IF p_event_id IS NULL OR pg_catalog.length(p_event_id) = 0
     OR pg_catalog.length(p_event_id) > 255
     OR p_event_type IS NULL OR pg_catalog.length(p_event_type) > 255
     OR pg_catalog.length(p_stripe_customer_id) > 255
     OR pg_catalog.length(p_stripe_subscription_id) > 255 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- At least one identity, or the claim buys nothing: an event recorded with
  -- both columns NULL satisfies no branch of cap_stripe_only_claimed_org, so
  -- it could never apply anything. Refusing here turns a guaranteed later
  -- failure into an immediate, named one.
  -- COALESCE(length(x), 0) rather than `x IS NOT NULL`: the empty string is
  -- not NULL and would satisfy a null-check while matching no organisation,
  -- which is the same dead claim by another spelling.
  IF COALESCE(pg_catalog.length(p_stripe_customer_id), 0) = 0
     AND COALESCE(pg_catalog.length(p_stripe_subscription_id), 0) = 0 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  INSERT INTO public.stripe_webhook_events AS e
    (event_id, event_type, status, attempts, stripe_customer_id, stripe_subscription_id)
  VALUES (p_event_id, p_event_type, 'processing', 1,
          p_stripe_customer_id, p_stripe_subscription_id)
  ON CONFLICT (event_id) DO UPDATE
     SET status          = 'processing',
         attempts        = e.attempts + 1,
         received_at     = pg_catalog.now(),
         failed_at       = NULL,
         -- Cleared with failed_at. A re-claimed event carrying the previous
         -- attempt's code would keep it through to 'completed', and the CHECK
         -- permits that, so nothing else would catch the misreport.
         last_error_code = NULL
   WHERE (e.status IN ('failed','received')
          OR (e.status = 'processing'
              AND e.received_at < pg_catalog.now() - interval '15 minutes'))
     -- A retry of the SAME event carries the SAME identifiers, so this costs a
     -- legitimate retry nothing. What it forbids is re-claiming an existing
     -- event id under a different address — the one edit that would otherwise
     -- let a claim be pointed at another tenant's row. The identity columns are
     -- absent from the UPDATE grant as well, so this is two locks, not one.
     AND e.stripe_customer_id     IS NOT DISTINCT FROM p_stripe_customer_id
     AND e.stripe_subscription_id IS NOT DISTINCT FROM p_stripe_subscription_id
  RETURNING true INTO v_claimed;

  IF v_claimed THEN
    RETURN 'claimed';
  END IF;

  -- The ON CONFLICT matched nothing to update, so the row exists in a state we
  -- may not take. Distinguishing the two is safe: the caller is Stripe, which
  -- already knows it sent this event.
  SELECT e.status, e.stripe_customer_id, e.stripe_subscription_id
    INTO v_status, v_customer, v_sub
    FROM public.stripe_webhook_events e
   WHERE e.event_id = p_event_id;

  -- An existing event whose recorded address differs from the one presented is
  -- not a duplicate and not an in-flight retry: it is the same event id
  -- claiming to be about someone else. Refuse rather than report a state.
  IF v_status IS NOT NULL
     AND (v_customer IS DISTINCT FROM p_stripe_customer_id
          OR v_sub   IS DISTINCT FROM p_stripe_subscription_id) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  IF v_status = 'completed' THEN
    RETURN 'duplicate';
  END IF;

  RETURN 'in_progress';

EXCEPTION
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  -- OTHERS does NOT match query_canceled (57014) or assert_failure: PL/pgSQL
  -- excludes both. A statement_timeout firing mid-call would therefore reach
  -- the caller as 57014 with PostgreSQL's own message, straight through the
  -- uniform-refusal argument. uellix_stripe carries statement_timeout as a
  -- ROLE setting, so this is not hypothetical for CAP-03.
  WHEN query_canceled THEN
    RAISE LOG 'capability call cancelled (57014)';
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  -- CONTENTION IS NOT A CLIENT ERROR, and collapsing it into U0001 was how an
  -- event got LOST — the one failure this whole package exists to prevent.
  --
  -- `SET LOCAL lock_timeout = '3s'` above means two concurrent deliveries of
  -- the same event id can end with the loser raising 55P03. Under U0001 the
  -- handler cannot tell that from a malformed event and, if it answers 4xx,
  -- Stripe stops retrying and the subscription change never lands. The three
  -- codes below are TRANSIENT by definition and leave the row untouched (the
  -- subtransaction rolled back), so the honest answer is the one the state
  -- machine already has for "somebody else is on it": 'in_progress', which the
  -- handler maps to a 5xx and Stripe retries with backoff.
  --
  -- Enumerated, never `WHEN OTHERS`: an unexpected error must still fail. A
  -- handler that answered 'in_progress' to everything would turn a permanent
  -- defect into an infinite retry loop, which is the same silent loss wearing
  -- the opposite mask.
  --
  -- 57014 is deliberately NOT in this list. It is raised by statement_timeout,
  -- which uellix_stripe carries as a ROLE setting; catching it and continuing
  -- risks re-firing immediately on the next statement, and PostgreSQL's own
  -- guidance is not to swallow it. It stays a uniform refusal.
  WHEN lock_not_available THEN
    RAISE LOG 'stripe_begin_event contended on the event row (55P03)';
    RETURN 'in_progress';
  WHEN serialization_failure THEN
    RAISE LOG 'stripe_begin_event lost a serialisation conflict (40001)';
    RETURN 'in_progress';
  WHEN deadlock_detected THEN
    RAISE LOG 'stripe_begin_event chosen as deadlock victim (40P01)';
    RETURN 'in_progress';
  WHEN OTHERS THEN
    RAISE LOG 'stripe_begin_event refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.stripe_begin_event(text, text, text, text) OWNER TO uellix_cap_stripe;

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

  -- Two match kinds, not three. `organization` is gone, and its removal is the
  -- point of this revision rather than a simplification.
  --
  -- That branch resolved the organisation from `session.client_reference_id`,
  -- which is chosen by whoever creates the checkout session — a Stripe Payment
  -- Link accepts it as a buyer-supplied parameter, and this repository contains
  -- no server-side checkout.sessions.create that would constrain it. CAP-03 §1.1
  -- already classified that value as an assertion to check, and two rounds of
  -- adversarial review reached opposite conclusions about how to check it: one
  -- said the guard was too strict (an organisation that cancels and
  -- re-subscribes is refused forever, because stripe_customer_id is never
  -- cleared), the other that it was too loose (an organisation that has NEVER
  -- subscribed has NULL billing columns, so the guard passes and any
  -- client_reference_id can claim it).
  --
  -- Both are right, and that is the answer: no predicate over the CURRENT row
  -- can distinguish a legitimate first subscription from a hostile claim,
  -- because the only evidence either way is the attacker-supplied field itself.
  -- So the capability refuses to be the place where an organisation is bound to
  -- a Stripe customer for the first time. That binding must be recorded by a
  -- first-party, authenticated flow BEFORE any webhook arrives — which is
  -- DP-CAP-15, and is not decided here. Until it is, checkout.session.completed
  -- has no path through this function, and the handler must not invent one.
  IF p_match_kind NOT IN ('customer','subscription')
     OR p_match_value IS NULL
     OR p_quota IS NULL OR p_quota < 0 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- The event must be one we claimed, AND it must be the event that carries the
  -- address we are about to match on. The first half was here from the start;
  -- the second half was missing, and both adversarial reviewers found the same
  -- consequence: the two identity columns RR-CAP-14 added were read by the
  -- policy and ignored by the function, so a handler that picked the wrong
  -- identifier out of a multi-object Stripe payload (invoice.customer vs
  -- subscription.customer is a real shape) wrote the wrong tenant's quota with
  -- every layer saying yes.
  IF NOT EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE e.event_id = p_event_id
       AND e.status = 'processing'
       AND e.received_at > pg_catalog.now() - interval '15 minutes'
       AND ( (p_match_kind = 'customer'
              AND e.stripe_customer_id IS NOT NULL
              AND e.stripe_customer_id = p_match_value)
          OR (p_match_kind = 'subscription'
              AND e.stripe_subscription_id IS NOT NULL
              AND e.stripe_subscription_id = p_match_value) )
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Publish WHICH event this transaction is applying, so the RESTRICTIVE
  -- policies can be correlated to it. is_local => true: the setting dies with
  -- the transaction, so it cannot leak into the next request on the same
  -- pooled connection. It is set only AFTER the check above passes, so it can
  -- never name an event this call has not just validated.
  PERFORM pg_catalog.set_config('app.stripe_event_id', p_event_id, true);

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
      OR (p_match_kind = 'subscription' AND o.stripe_subscription_id = p_match_value);

  IF v_org_ids IS NULL OR pg_catalog.array_length(v_org_ids, 1) <> 1 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;
  v_org_id := v_org_ids[1];

  SELECT o.stripe_customer_id, o.stripe_subscription_id
    INTO v_org_customer, v_org_sub
    FROM public.organizations o
   WHERE o.id = v_org_id;

  -- The tenancy guard. Both branches now require the SAME thing: that every
  -- identifier the event carries agrees with the row it resolved to. An earlier
  -- revision wrote the subscription branch as "if the caller told us a customer,
  -- it must match" — which is no guard at all when the caller tells us nothing,
  -- and it left `stripe_subscription_id = p_stripe_subscription_id` free to
  -- write a value unrelated to the subscription the row was found BY.
  IF p_match_kind = 'customer' THEN
    IF p_stripe_customer_id IS DISTINCT FROM p_match_value
       OR v_org_customer    IS DISTINCT FROM p_match_value THEN
      RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
    END IF;
  ELSE
    IF p_stripe_subscription_id IS DISTINCT FROM p_match_value
       OR v_org_sub             IS DISTINCT FROM p_match_value
       OR p_stripe_customer_id  IS NULL
       OR v_org_customer        IS DISTINCT FROM p_stripe_customer_id THEN
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
         -- COALESCE, like the line above it. A bare assignment let any
         -- customer-addressed event with a NULL subscription argument silently
         -- DETACH the organisation's subscription — after which the
         -- subscription branch of the policy stops matching it and DP-CAP-15
         -- forbids a webhook from re-binding it. Found by both reviewers.
         stripe_subscription_id = COALESCE(p_stripe_subscription_id, stripe_subscription_id),
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
  -- OTHERS does NOT match query_canceled (57014) or assert_failure: PL/pgSQL
  -- excludes both. A statement_timeout firing mid-call would therefore reach
  -- the caller as 57014 with PostgreSQL's own message, straight through the
  -- uniform-refusal argument. uellix_stripe carries statement_timeout as a
  -- ROLE setting, so this is not hypothetical for CAP-03.
  WHEN query_canceled THEN
    RAISE LOG 'capability call cancelled (57014)';
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  -- CONTENTION HERE IS RETRYABLE TOO, and an adversarial reviewer pointed out
  -- that patching only stripe_begin_event made this WORSE rather than better:
  -- stella_0011 added a new concurrent writer to exactly these columns
  -- (admin_set_stella_service holds the organizations row for the rest of the
  -- admin request's transaction), so a platform admin saving a quota while a
  -- Stripe event arrives for the same organisation was newly able to turn a
  -- transient lock into a permanent U0001 — and, by this file's own reasoning,
  -- a 4xx answer makes Stripe drop the delivery.
  --
  -- A DISTINCT SQLSTATE, not 'in_progress': this function RETURNS void, so it
  -- has no channel for a status. U0003 means "contended, retry"; U0001 keeps
  -- meaning "refused, do not retry". The handler maps U0003 to 5xx and must NOT
  -- mark the event failed — though marking it failed would also be safe, since
  -- a 'failed' event is re-claimable.
  WHEN lock_not_available OR serialization_failure OR deadlock_detected THEN
    RAISE LOG 'stripe_apply_subscription contended with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request contended' USING ERRCODE = 'U0003';
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
  IF p_error_code NOT IN ('signature','org_not_resolved','price_unmapped',
                          'internal','not_applicable') THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- 'not_applicable' lands in 'ignored', not 'failed'. stripe_begin_event moves
  -- a row to 'processing' BEFORE the handler knows whether it acts on that
  -- event type; without a terminal state for the ones it ignores, those rows
  -- would sit in 'processing' forever and idx_stripe_webhook_events_status
  -- could no longer tell a dead worker from routine traffic.
  UPDATE public.stripe_webhook_events
     SET status          = CASE WHEN p_error_code = 'not_applicable'
                                THEN 'ignored' ELSE 'failed' END,
         failed_at       = CASE WHEN p_error_code = 'not_applicable'
                                THEN NULL ELSE pg_catalog.now() END,
         completed_at    = CASE WHEN p_error_code = 'not_applicable'
                                THEN pg_catalog.now() ELSE NULL END,
         last_error_code = p_error_code
   WHERE event_id = p_event_id AND status = 'processing';

EXCEPTION
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  -- OTHERS does NOT match query_canceled (57014) or assert_failure: PL/pgSQL
  -- excludes both. A statement_timeout firing mid-call would therefore reach
  -- the caller as 57014 with PostgreSQL's own message, straight through the
  -- uniform-refusal argument. uellix_stripe carries statement_timeout as a
  -- ROLE setting, so this is not hypothetical for CAP-03.
  WHEN query_canceled THEN
    RAISE LOG 'capability call cancelled (57014)';
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  WHEN OTHERS THEN
    RAISE LOG 'stripe_fail_event refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.stripe_fail_event(text, text) OWNER TO uellix_cap_stripe;

COMMENT ON FUNCTION uellix_capability.stripe_begin_event(text, text, text, text) IS
  'CAP-03. Atomically claims one Stripe event. Returns claimed | duplicate | in_progress.';
COMMENT ON FUNCTION uellix_capability.stripe_apply_subscription(text, text, text, text, text, text, integer, text) IS
  'CAP-03. Applies one subscription change in ONE transaction: organisation update, audit row, event completion. Does not mark failures — see stripe_fail_event, which needs its own transaction to survive.';
COMMENT ON FUNCTION uellix_capability.stripe_fail_event(text, text) IS
  'CAP-03. Marks a claimed event failed with a fixed error CODE. Called by the handler AFTER stripe_apply_subscription has raised and rolled back.';

-- EXECUTE goes to uellix_stripe and to NOBODY else. That uellix_app cannot
-- call these is as important as that uellix_stripe can: it is what stops any
-- application endpoint from moving a quota.
REVOKE ALL ON FUNCTION uellix_capability.stripe_begin_event(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_capability.stripe_apply_subscription(text, text, text, text, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_capability.stripe_fail_event(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION uellix_capability.stripe_begin_event(text, text, text, text) TO uellix_stripe;
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
       'public', 'uellix_capability.stripe_begin_event(text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on stripe_begin_event.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_stripe', 'uellix_capability.stripe_begin_event(text,text,text,text)', 'EXECUTE') THEN
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
                              'completed_at','failed_at','last_error_code','organization_id',
                              -- RR-CAP-14. The two Stripe-issued identifiers the signed
                              -- event is addressed to. They are an ADDRESS, not a payload:
                              -- the forbidden-name check three lines below still refuses
                              -- payload, body, raw, signature and request.
                              'stripe_customer_id','stripe_subscription_id')
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
  IF v_policies <> 6 THEN
    RAISE EXCEPTION 'Expected 6 cap_stripe_* policies (4 permissive + 2 restrictive), found %.', v_policies;
  END IF;

  -- RR-CAP-14. Named and typed, not counted: CAP-03 was the one capability with
  -- no RESTRICTIVE policy at all, and a count of six is satisfied by six
  -- permissive ones.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'organizations'
                    AND policyname = 'cap_stripe_only_claimed_org'
                    AND permissive = 'RESTRICTIVE' AND cmd = 'UPDATE')
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'organizations'
                       AND policyname = 'cap_stripe_only_claimed_read'
                       AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'the RR-CAP-14 row bounds are absent; a Stripe event could reach an organisation it is not addressed to.';
  END IF;

  -- The claimed address must exist and must NOT be rewritable. Both halves
  -- matter: a column the capability can rewrite is not an anchor, it is a
  -- parameter.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stripe_webhook_events'
         AND column_name IN ('stripe_customer_id','stripe_subscription_id')) <> 2 THEN
    RAISE EXCEPTION 'stripe_webhook_events does not carry the claimed Stripe identity; cap_stripe_only_claimed_org would match nothing.';
  END IF;
  IF pg_catalog.has_column_privilege('uellix_cap_stripe', 'public.stripe_webhook_events',
                                     'stripe_customer_id', 'UPDATE')
     OR pg_catalog.has_column_privilege('uellix_cap_stripe', 'public.stripe_webhook_events',
                                        'stripe_subscription_id', 'UPDATE') THEN
    RAISE EXCEPTION 'the capability can rewrite the claimed Stripe identity; the tenancy bound would be self-asserted.';
  END IF;

  -- The default-privilege leak, asserted rather than assumed.
  IF pg_catalog.has_any_column_privilege('uellix_writer', 'public.stripe_webhook_events'::regclass, 'INSERT')
     OR pg_catalog.has_any_column_privilege('uellix_writer', 'public.stripe_webhook_events'::regclass, 'SELECT') THEN
    RAISE EXCEPTION 'uellix_writer holds a privilege on stripe_webhook_events; the owner default ACL was not taken back.';
  END IF;

  -- The row bound must be correlated to ONE event, not to any event in flight.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND policyname = 'cap_stripe_only_claimed_org'
       AND qual LIKE '%app.stripe_event_id%'
       AND with_check LIKE '%app.stripe_event_id%'
  ) THEN
    RAISE EXCEPTION 'cap_stripe_only_claimed_org is not correlated to the event being applied; a concurrent event would authorise a cross-tenant write.';
  END IF;

  -- The pre-RR-CAP-14 two-argument claim must be gone, not merely shadowed: it
  -- records no identity, so an event claimed through it is addressed to nobody
  -- and the RESTRICTIVE bound would silently refuse every subsequent apply.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'uellix_capability' AND p.proname = 'stripe_begin_event'
       AND p.pronargs = 2
  ) THEN
    RAISE EXCEPTION 'the two-argument stripe_begin_event survives; an event could be claimed with no Stripe address.';
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
