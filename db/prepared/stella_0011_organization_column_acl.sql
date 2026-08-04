-- db/prepared/stella_0011_organization_column_acl.sql
-- RR-CAP-10 — ORGANIZATION_QUOTA_COLUMN_HARDENING.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_0011_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/STELLA_FABLE_RISK_REGISTER.md (RR-CAP-10)
-- COMMON MODEL:    docs/ops/DATABASE_CAPABILITY_MODEL.md
-- BLOCKS:          CAP-03 (docs/ops/capabilities/CAP_03_STRIPE.md §13)
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE.
--
-- ============================================================================
-- THE DEFECT, STATED AS THE SENTENCE IT FALSIFIES
-- ============================================================================
-- CAP-03's central proposition is "the quota only moves through a signed
-- event". That sentence was false before this package, and it was false for a
-- reason that has nothing to do with CAP-03:
--
--   * the baseline grants `SELECT,INSERT,DELETE,UPDATE ON TABLE
--     public.organizations` — TABLE-level, every column — to `authenticated`,
--     to `service_role` and to `uellix_writer`;
--   * `uellix_app` inherits `uellix_writer`;
--   * `orgs_update_admin_or_super` is a `{public}` policy whose predicate is
--     `current_user_role_in_org(id) IN ('super_admin','organization_admin') OR
--     current_user_is_super_admin()` — a bound on the ROW, with no notion of
--     which column the statement touches.
--
-- So any `organization_admin` could issue, through the ORM, on their own row:
--
--     UPDATE organizations SET stella_monthly_quota = 1000000 WHERE id = <own>;
--
-- and every layer said yes. The ACL said yes because it was table-level; the
-- policy said yes because the row was theirs; nothing looked at the column.
--
-- WHY A POLICY CANNOT FIX THIS, WRITTEN OUT SO NOBODY TRIES.
-- RLS evaluates a ROW, twice: `USING` against the pre-image and `WITH CHECK`
-- against the post-image. It is handed neither the statement's target list nor
-- the other image, so there is no expression in a policy that means "this
-- column changed". Column control is ACL, or it is a trigger. It is not a
-- policy. (A trigger would also work and is strictly more expressive; the ACL
-- is chosen because it is declarative, visible in `\dp`, and cannot be
-- disabled by `session_replication_role`.)
--
-- ============================================================================
-- WHERE THE COLUMN LIST COMES FROM
-- ============================================================================
-- NOT invented, and not "everything that looked harmless". Every `UPDATE` of
-- `public.organizations` in this repository, found by reading the ORM call
-- sites rather than by reasoning about the schema:
--
--   app/actions/onboarding.ts:36     country, sector, base_currency,
--                                    onboarding_completed, updated_at
--   app/actions/organization.ts:35   white_label_enabled, brand_color,
--                                    logo_url, updated_at
--   lib/admin/organizations.ts:40    status, updated_at            [super_admin]
--   lib/admin/stella-services.ts:83  stella_monthly_quota,
--                                    stella_plan_label, updated_at [super_admin]
--   app/api/webhooks/stripe/route.ts stripe_*, quota, label        [CAP-03]
--
-- and nothing else. There is no other `db.update(organizations)` and no raw
-- SQL `UPDATE organizations` anywhere under `app/`, `lib/` or `db/migrations/`.
--
-- THREE CONSEQUENCES THAT ARE EASY TO GET WRONG:
--
--   1. `name`, `slug` and `legal_name` are INSERT-only in practice. They are
--      written once, by `app/app/onboarding/actions.ts:99`, and never updated.
--      They are therefore NOT in the runtime UPDATE grant. This is a real
--      narrowing, not bookkeeping: RR-CAP-02-D assumed the organisation could
--      rename itself after a certificate published its name, and under this
--      package it cannot. Adding a rename feature means adding the column here,
--      in a visible diff, with that risk re-examined.
--
--   2. `status` is a PLATFORM decision. `setOrganizationStatus` requires
--      `requireAdminAccess()`, but it reaches the database through the same
--      `uellix_app` connection as every organisation admin — so leaving it in
--      the runtime grant would let a suspended organisation's own admin set
--      itself back to 'active'. It moves behind the definer with the quota.
--
--   3. `white_label_enabled` STAYS in the runtime grant, and this is a
--      judgement that is written down rather than buried. It is an
--      entitlement-SHAPED flag, and RR-CAP-10 names "feature flags" among what
--      an organisation admin must not move. But nothing in this codebase gates
--      white-labelling by plan — `app/actions/organization.ts` checks the ROLE
--      and no plan at all — so today it is a branding toggle, not an
--      entitlement, and revoking it would break the organisation settings page
--      to protect a boundary that does not exist yet. The day white-labelling
--      becomes plan-gated it must move to the definer, and that is recorded as
--      a residual risk rather than assumed to be remembered.
--
-- ============================================================================
-- WHY THIS PACKAGE ALSO CREATES A DEFINER
-- ============================================================================
-- An ACL cannot distinguish a platform super_admin from an organisation admin,
-- because they are the same DATABASE role: both arrive as `uellix_app`, which
-- inherits `uellix_writer`. The distinction lives in `auth.uid()` and in
-- `organization_members`, which is application identity, not connection
-- identity.
--
-- So revoking the administrative columns from `uellix_writer` necessarily
-- breaks `lib/admin/stella-services.ts` and `lib/admin/organizations.ts` unless
-- the legitimate path is moved somewhere the caller's identity can be checked.
-- That somewhere is a SECURITY DEFINER function, and the mechanism is the one
-- CAP-02 documents as a HAZARD, used deliberately here: `auth.uid()` is a
-- session GUC that SECURITY DEFINER does not reset, so
-- `current_user_is_super_admin()` inside the definer resolves to the CALLER.
--
-- Two independent checks, on purpose:
--   * the function body refuses a non-super-admin caller;
--   * `cap_platform_only_super_admin` is a RESTRICTIVE policy that refuses the
--     same caller at the RLS layer, so a body rewritten without the check
--     still cannot move a quota.
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0011_organization_column_acl.sql
--
-- ============================================================================
-- A CODE CHANGE MUST LAND *BEFORE* THIS PACKAGE IS APPLIED  (RR-CAP-10-A)
-- ============================================================================
-- `lib/admin/stella-services.ts` and `lib/admin/organizations.ts` still issue
-- `db.update(organizations).set({...})` directly. The moment this package is
-- applied those two statements start failing with 42501 — the platform admin
-- pages for quota and for suspend/reactivate stop working — until they are
-- rewritten to call the two functions below.
--
-- This unit does NOT make that change: the capability packages are prepared,
-- not applied, and shipping application code that calls a function which does
-- not exist yet would break the running product instead. It is the same
-- ordering constraint RR-CAP-02-B records for the public PDF route, and it is
-- registered as RR-CAP-10-A rather than left to be discovered during a
-- maintenance window.
--
-- The replacement calls, for whoever writes them:
--   SELECT uellix_capability.admin_set_stella_service($1::uuid, $2::int, $3::text);
--   SELECT uellix_capability.admin_set_organization_status($1::uuid, $2::text);
-- Both already write the audit row, so `logAuditAction` at those two call sites
-- becomes a DUPLICATE and must be removed with the same edit.
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
--   * It does NOT touch `service_role`. That role is Supabase-internal, holds
--     BYPASSRLS, and reaches far beyond this schema; narrowing it is RR-CAP-7
--     territory and out of scope for a capability package. Stated, not fixed:
--     anything holding the service-role key can still move a quota.
--   * It does NOT change the INSERT grant. Organisation creation writes `name`,
--     `slug`, `legal_name` and `status` once, and must keep doing so.
--   * It does NOT add a plan gate to anything. What is entitled to what is a
--     product decision, not an ACL.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0011 must run as a superuser; current_user is %.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0011 requires stella_0004 (uellix_owner is absent).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN
    RAISE EXCEPTION 'stella_0011 requires stella_0004 (uellix_writer is absent).';
  END IF;

  -- The column set is asserted by NAME, not by count. A count of twenty is
  -- satisfied by twenty columns with a renamed quota, and the grant below would
  -- then silently omit a column that still exists under another name.
  IF EXISTS (
    SELECT unnest(ARRAY['id','name','slug','legal_name','country','sector','status',
                        'created_at','updated_at','stella_monthly_quota','stella_plan_label',
                        'logo_url','brand_color','white_label_enabled','base_currency',
                        'onboarding_completed','stripe_customer_id','stripe_subscription_id',
                        'stripe_price_id']) AS c
    EXCEPT
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
  ) THEN
    RAISE EXCEPTION 'stella_0011: public.organizations is missing a column this package grants or withholds by name.';
  END IF;

  -- A column added upstream since this package was written would land in
  -- NEITHER list, and the safe side of that is "not writable by the runtime" —
  -- which is what happens, because the grant enumerates. Refusing outright
  -- makes the decision visible instead of silent.
  IF EXISTS (
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
    EXCEPT
    SELECT unnest(ARRAY['id','name','slug','legal_name','country','sector','status',
                        'created_at','updated_at','stella_monthly_quota','stella_plan_label',
                        'logo_url','brand_color','white_label_enabled','base_currency',
                        'onboarding_completed','stripe_customer_id','stripe_subscription_id',
                        'stripe_price_id'])
  ) THEN
    RAISE EXCEPTION 'stella_0011: public.organizations has a column this package does not classify. Classify it as runtime-writable or administrative before applying.';
  END IF;

  IF (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'organizations') IS NOT TRUE THEN
    RAISE EXCEPTION 'stella_0011 requires RLS enabled on public.organizations.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'current_user_is_super_admin'
  ) THEN
    RAISE EXCEPTION 'stella_0011 requires public.current_user_is_super_admin(); the definer has no way to tell a platform admin from a tenant admin without it.';
  END IF;

  -- The audit trail the definer writes into must already be append-only, or
  -- "the quota only moves with a record" is unsupported.
  IF (SELECT count(*) FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'audit_logs'
         AND NOT t.tgisinternal
         AND t.tgname IN ('trg_audit_logs_append_only','trg_audit_logs_no_truncate')) <> 2 THEN
    RAISE EXCEPTION 'stella_0011 requires audit_logs to carry both append-only triggers (stella_0002b).';
  END IF;
END
$$;

-- ============================================================
-- 1. WINDOW 1 (superuser) — the definer role and the schema
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_platform') THEN
    EXECUTE 'CREATE ROLE uellix_cap_platform';
  END IF;
END
$$;

-- ZERO members, NOLOGIN, and no attribute that would let it escape RLS. Same
-- construction as the other four definers: SET ROLE authorisation is
-- transitive, so a membership here would make the capability reachable from
-- whatever holds that membership.
ALTER ROLE uellix_cap_platform
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

COMMENT ON ROLE uellix_cap_platform IS
  'stella_0011 / RR-CAP-10: definer of the two uellix_capability.admin_* functions. NOLOGIN, ZERO members, subject to RLS. Reaches exactly three columns of organizations (status, stella_monthly_quota, stella_plan_label) plus updated_at, and audit_logs INSERT. Its RESTRICTIVE policy requires the CALLER to be a platform super_admin.';

CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_platform;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;

-- The definer calls auth.uid(), and resolving it requires USAGE on schema auth
-- for the DEFINER — the caller's own USAGE does not carry over.
GRANT USAGE ON SCHEMA auth TO uellix_cap_platform;

-- ============================================================
-- 2. WINDOW 2 (owner) — the ACL change, and the definer's surface
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 THE REPAIR. Table-level UPDATE goes, column-level UPDATE arrives.
--
-- REVOKE first, unconditionally, for BOTH principals. `authenticated` is the
-- one that gets forgotten — it is the role PostgREST uses, so a table-level
-- UPDATE there is a write surface reachable from a browser with nothing but a
-- user's own JWT, entirely outside the ORM this repository reasons about.
--
-- `anon` and `PUBLIC` are named too. Neither holds UPDATE in the measured
-- baseline; including them makes the statement a convergence step rather than
-- a description of one particular database.
REVOKE UPDATE ON public.organizations FROM authenticated, uellix_writer, anon, PUBLIC;

-- DELETE goes with it. Today the absence of any DELETE policy on organizations
-- makes RLS refuse it anyway — but the whole argument of this package is that
-- ACL is the durable layer and policy is not, and destroying an organisation
-- row is strictly worse than moving its quota. Leaving the privilege in place
-- while arguing that policies cannot be trusted would be inconsistent. There is
-- no `db.delete(organizations)` anywhere in the repository; the product uses a
-- three-tier pause/archive/soft-delete on `status`, which now goes through the
-- platform definer.
REVOKE DELETE ON public.organizations FROM authenticated, uellix_writer, anon, PUBLIC;

-- The eight columns the runtime actually writes. Enumerated, alphabetical, one
-- per line, so that adding one is a diff a reviewer cannot skim past.
GRANT UPDATE (
  base_currency,
  brand_color,
  country,
  logo_url,
  onboarding_completed,
  sector,
  updated_at,
  white_label_enabled
) ON public.organizations TO uellix_writer;

-- `authenticated` gets NOTHING back, and that is a change from the first draft
-- of this package, made after adversarial review pointed out the contradiction.
--
-- The paragraph above justifies the REVOKE by saying `authenticated` is
-- PostgREST's role, so a table-level UPDATE there is reachable from a browser
-- with nothing but a user's own JWT, ENTIRELY OUTSIDE the ORM this repository
-- reasons about. The eight columns were then derived exclusively from ORM call
-- sites — every one of which reaches the database as `uellix_app`. Re-granting
-- them to `authenticated` restored exactly the browser-direct write surface the
-- package exists to close, minus three columns, for a principal with no call
-- site anywhere in the repository. `base_currency` is the sharpest case: it is
-- an input to the FX/NPV engine, and the re-grant let an organisation admin
-- rewrite it over PostgREST with no application-layer validation at all.
--
-- Verified before removing it: there is no `supabase.from('organizations')`
-- write anywhere under app/, lib/ or components/ — only three reads in
-- tests/integration/rls.test.ts.

COMMENT ON COLUMN public.organizations.stella_monthly_quota IS
  'RR-CAP-10. Administrative. NOT in the runtime UPDATE grant: an organisation admin cannot write it, by ACL. It moves through uellix_capability.admin_set_stella_service (platform super_admin, audited) or through CAP-03 (a signature-verified Stripe event) — and, unaudited, through service_role, which retains table-level UPDATE and BYPASSRLS and is out of scope for a capability package (RR-CAP-7, RR-CAP-10-C).';
COMMENT ON COLUMN public.organizations.stella_plan_label IS
  'RR-CAP-10. Administrative. Same paths as stella_monthly_quota, including the same service_role residual.';
COMMENT ON COLUMN public.organizations.status IS
  'RR-CAP-10. Administrative. Written once at creation, then only through uellix_capability.admin_set_organization_status. Leaving it in the runtime grant would let a suspended organisation''s own admin reactivate itself.';

-- 2.2 The definer's surface. Three columns plus updated_at, and audit_logs.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids()         TO uellix_cap_platform;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin()  TO uellix_cap_platform;
GRANT EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) TO uellix_cap_platform;

GRANT SELECT (id, name, status, stella_monthly_quota, stella_plan_label)
  ON public.organizations TO uellix_cap_platform;

GRANT UPDATE (status, stella_monthly_quota, stella_plan_label, updated_at)
  ON public.organizations TO uellix_cap_platform;

-- No stripe_* column, in either direction. Billing identifiers belong to
-- CAP-03; a platform admin moving a quota has no business rewriting which
-- Stripe customer an organisation is.
GRANT INSERT (organization_id, actor_user_id, entity_type, entity_id, action,
              before_json, after_json, reason)
  ON public.audit_logs TO uellix_cap_platform;

-- 2.3 Policies.

DROP POLICY IF EXISTS cap_platform_select_orgs ON public.organizations;
CREATE POLICY cap_platform_select_orgs
ON public.organizations FOR SELECT TO uellix_cap_platform
USING (true);

DROP POLICY IF EXISTS cap_platform_update_orgs ON public.organizations;
CREATE POLICY cap_platform_update_orgs
ON public.organizations FOR UPDATE TO uellix_cap_platform
USING (true) WITH CHECK (true);

-- The RESTRICTIVE pair. This is the half of the repair that does not depend on
-- the function bodies being right.
--
-- `current_user_is_super_admin()` reads auth.uid(), which SECURITY DEFINER does
-- not reset, so inside the definer it answers about the CALLER — the human
-- whose JWT reached the server. An organisation admin who found a way to reach
-- these functions still fails here, and so does a rewritten body that forgot
-- to check.
--
-- Note the direction of the argument versus CAP-02's: there the caller's
-- identity leaking into the definer was the HAZARD that made permissive
-- policies useless; here it is the mechanism, used on purpose, in a
-- RESTRICTIVE policy that can only ever narrow.
DROP POLICY IF EXISTS cap_platform_only_super_admin_read ON public.organizations;
CREATE POLICY cap_platform_only_super_admin_read
ON public.organizations AS RESTRICTIVE FOR SELECT TO uellix_cap_platform
USING (public.current_user_is_super_admin());

DROP POLICY IF EXISTS cap_platform_only_super_admin ON public.organizations;
CREATE POLICY cap_platform_only_super_admin
ON public.organizations AS RESTRICTIVE FOR UPDATE TO uellix_cap_platform
USING (public.current_user_is_super_admin())
WITH CHECK (public.current_user_is_super_admin());

-- actor_user_id IS NOT NULL and equal to auth.uid(): the mirror of
-- cap_stripe_insert_audit, which mandates NULL. A platform decision has a
-- human behind it and must not be attributable to nobody; a Stripe event has
-- none and must not be attributed to somebody.
DROP POLICY IF EXISTS cap_platform_insert_audit ON public.audit_logs;
CREATE POLICY cap_platform_insert_audit
ON public.audit_logs FOR INSERT TO uellix_cap_platform
WITH CHECK (
  actor_user_id = auth.uid()
  AND actor_user_id IS NOT NULL
  AND entity_type = 'organization'
  AND pg_catalog.left(action, 9) = 'platform.'
);

RESET ROLE;

-- ============================================================
-- 3. WINDOW 3 (superuser) — the functions, their owners, their ACLs
-- ============================================================

-- 3.1 Move a Stella plan and quota.
--
-- Replaces the direct `db.update(organizations).set({stellaMonthlyQuota, ...})`
-- in lib/admin/stella-services.ts. The UPDATE and the audit row are now ONE
-- statement pair in ONE transaction: the previous code wrote them as two
-- awaited calls, so a failure between them left a quota moved with no record.
CREATE OR REPLACE FUNCTION uellix_capability.admin_set_stella_service(
  p_organization_id uuid,
  p_quota           integer,
  p_plan_label      text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_before jsonb;
BEGIN
  SET LOCAL lock_timeout = '3s';

  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- NULL IS A VALUE HERE, NOT AN ABSENCE, and a previous revision of this
  -- package got that wrong. An adversarial reviewer read `stella_monthly_quota`
  -- as nullable-with-DEFAULT-0 and called a NULL argument a three-valued state;
  -- the reviewer was reasoning from the schema, and the schema is not where the
  -- meaning lives. `lib/stella/quota.ts:36` is explicit:
  --
  --     // null quota means unlimited (no cap assigned/enforced)
  --     if (quota === null) return { allowed: true, used: 0, quota: null }
  --
  -- so NULL is the platform's way of granting UNLIMITED Stella usage, the admin
  -- form offers it as an empty field, and refusing it here removed a capability
  -- the product has — a functional regression wearing the costume of a
  -- hardening. Only a NEGATIVE quota is nonsense, and only that is refused.
  IF p_organization_id IS NULL
     OR (p_quota IS NOT NULL AND p_quota < 0)
     OR pg_catalog.length(p_plan_label) > 100 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
           'quota', o.stella_monthly_quota,
           'label', o.stella_plan_label)
    INTO v_before
    FROM public.organizations o
   WHERE o.id = p_organization_id;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  UPDATE public.organizations
     SET stella_monthly_quota = p_quota,
         stella_plan_label    = p_plan_label,
         updated_at           = pg_catalog.now()
   WHERE id = p_organization_id;

  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action,
     before_json, after_json, reason)
  VALUES
    (p_organization_id, auth.uid(), 'organization', p_organization_id,
     'platform.stella_service.updated',
     v_before,
     pg_catalog.jsonb_build_object('quota', p_quota, 'label', p_plan_label),
     'platform_admin');

EXCEPTION
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  WHEN query_canceled THEN
    RAISE LOG 'capability call cancelled (57014)';
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  -- Contended, not refused. The mirror of CAP-03's U0003: a Stripe webhook
  -- holding this organisation's row must not make the admin screen say
  -- "update failed" with no hint that retrying would work.
  WHEN lock_not_available OR serialization_failure OR deadlock_detected THEN
    RAISE LOG 'admin capability contended with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request contended' USING ERRCODE = 'U0003';
  WHEN OTHERS THEN
    RAISE LOG 'admin_set_stella_service refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.admin_set_stella_service(uuid, integer, text)
  OWNER TO uellix_cap_platform;

COMMENT ON FUNCTION uellix_capability.admin_set_stella_service(uuid, integer, text) IS
  'RR-CAP-10. The ONLY non-Stripe path to stella_monthly_quota / stella_plan_label. Refuses any caller that is not a platform super_admin, twice: in the body and through cap_platform_only_super_admin. Writes the quota change and its audit row in one transaction.';

-- 3.2 Suspend or reactivate an organisation.
CREATE OR REPLACE FUNCTION uellix_capability.admin_set_organization_status(
  p_organization_id uuid,
  p_status          text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_before text;
BEGIN
  SET LOCAL lock_timeout = '3s';

  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- A fixed list, not a length check. `status` has no CHECK constraint in the
  -- baseline, so an unvalidated parameter here would let a platform admin
  -- invent a state the application does not handle.
  IF p_organization_id IS NULL OR p_status NOT IN ('active','suspended') THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  SELECT o.status INTO v_before
    FROM public.organizations o
   WHERE o.id = p_organization_id;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  UPDATE public.organizations
     SET status     = p_status,
         updated_at = pg_catalog.now()
   WHERE id = p_organization_id;

  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action,
     before_json, after_json, reason)
  VALUES
    (p_organization_id, auth.uid(), 'organization', p_organization_id,
     'platform.organization.status_changed',
     pg_catalog.jsonb_build_object('status', v_before),
     pg_catalog.jsonb_build_object('status', p_status),
     'platform_admin');

EXCEPTION
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  WHEN query_canceled THEN
    RAISE LOG 'capability call cancelled (57014)';
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  -- Contended, not refused. The mirror of CAP-03's U0003: a Stripe webhook
  -- holding this organisation's row must not make the admin screen say
  -- "update failed" with no hint that retrying would work.
  WHEN lock_not_available OR serialization_failure OR deadlock_detected THEN
    RAISE LOG 'admin capability contended with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request contended' USING ERRCODE = 'U0003';
  WHEN OTHERS THEN
    RAISE LOG 'admin_set_organization_status refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.admin_set_organization_status(uuid, text)
  OWNER TO uellix_cap_platform;

COMMENT ON FUNCTION uellix_capability.admin_set_organization_status(uuid, text) IS
  'RR-CAP-10. The ONLY path to organizations.status after creation. Refuses any caller that is not a platform super_admin, and refuses any status outside (active, suspended).';

REVOKE ALL ON FUNCTION uellix_capability.admin_set_stella_service(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_capability.admin_set_organization_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_capability.admin_set_stella_service(uuid, integer, text) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_capability.admin_set_organization_status(uuid, text) TO uellix_app;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
DECLARE
  v_policies integer;
  v_extra    text;
  v_col      text;
  v_role     text;
BEGIN
  -- 4.1 The defect itself, asserted from both sides.
  --
  -- has_table_privilege(..., 'UPDATE') is TRUE when the role holds UPDATE on
  -- ANY column, so it cannot be used here. has_column_privilege is the only
  -- form that answers the question this package exists to answer.
  -- Every principal that could hold it, not just the two the repair names. The
  -- REVOKE calls `anon` and PUBLIC a "convergence step"; nothing asserted it
  -- converged until this loop did.
  FOREACH v_role IN ARRAY ARRAY['uellix_writer','uellix_app','authenticated','anon',
                                'uellix_auditor','uellix_cap_bootstrap']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN CONTINUE; END IF;
    FOREACH v_col IN ARRAY ARRAY['stella_monthly_quota','stella_plan_label','status',
                                 'stripe_customer_id','stripe_subscription_id','stripe_price_id',
                                 'id','name','slug','legal_name','created_at']
    LOOP
      IF pg_catalog.has_column_privilege(v_role, 'public.organizations', v_col, 'UPDATE') THEN
        RAISE EXCEPTION '% can still UPDATE organizations.%; RR-CAP-10 is not closed.', v_role, v_col;
      END IF;
    END LOOP;
  END LOOP;

  -- `authenticated` must hold UPDATE on NO column at all. The loop above only
  -- covers the administrative ones, and the whole point of removing the
  -- re-grant is that this principal has no call site.
  IF pg_catalog.has_any_column_privilege('authenticated', 'public.organizations'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated retains an UPDATE column on organizations; it has no call site in the application.';
  END IF;
  IF pg_catalog.has_table_privilege('uellix_writer', 'public.organizations', 'DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.organizations', 'DELETE') THEN
    RAISE EXCEPTION 'DELETE on organizations survives for a runtime principal.';
  END IF;

  -- The path this package does NOT close, made visible in the operator's
  -- terminal rather than only in a header comment. A WARNING, not an
  -- EXCEPTION: narrowing service_role reaches Supabase-internal roles and is
  -- RR-CAP-7 territory, so refusing to apply over it would be refusing to
  -- close RR-CAP-10 at all.
  IF pg_catalog.has_column_privilege('service_role', 'public.organizations',
                                     'stella_monthly_quota', 'UPDATE') THEN
    RAISE WARNING 'RR-CAP-10-C: service_role retains table-level UPDATE on organizations and holds BYPASSRLS. Anything with the Supabase service key can still move a quota, and it writes no audit row. Out of scope here; tracked as RR-CAP-10-C.';
  END IF;

  -- uellix_app inherits uellix_writer, so it must be checked in its own right:
  -- a direct grant to uellix_app would not show up in the two loops above.
  IF pg_catalog.has_column_privilege('uellix_app', 'public.organizations', 'stella_monthly_quota', 'UPDATE') THEN
    RAISE EXCEPTION 'uellix_app can UPDATE organizations.stella_monthly_quota; the runtime must not move a quota.';
  END IF;

  -- 4.2 …and the legitimate writes still work. A repair that only revokes is
  -- indistinguishable from an outage.
  FOREACH v_col IN ARRAY ARRAY['base_currency','brand_color','country','logo_url',
                               'onboarding_completed','sector','updated_at','white_label_enabled']
  LOOP
    IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organizations', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'uellix_writer lost UPDATE on organizations.%, which the runtime writes; onboarding or settings would break.', v_col;
    END IF;
  END LOOP;

  -- 4.3 Creation still works: the INSERT grant is untouched.
  IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organizations', 'slug', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_writer lost INSERT on organizations.slug; organisations could not be created.';
  END IF;

  -- 4.4 The definer.
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_platform') THEN
    RAISE EXCEPTION 'uellix_cap_platform must be NOLOGIN.';
  END IF;
  IF (SELECT rolbypassrls OR rolcreaterole OR rolcreatedb OR rolsuper
        FROM pg_roles WHERE rolname = 'uellix_cap_platform') THEN
    RAISE EXCEPTION 'uellix_cap_platform has a forbidden role attribute.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'uellix_cap_platform')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_platform has a member; it must have none.';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'uellix_capability'
         AND p.proname IN ('admin_set_stella_service','admin_set_organization_status')
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND pg_get_userbyid(p.proowner) = 'uellix_cap_platform'
         AND (p.proconfig @> ARRAY['search_path=']::text[]
           OR p.proconfig @> ARRAY['search_path=""']::text[])) <> 2 THEN
    RAISE EXCEPTION 'the two admin_* functions are not both SECURITY DEFINER owned by uellix_cap_platform with an EMPTY search_path.';
  END IF;

  -- The definer reaches exactly the administrative columns, and nothing else.
  FOREACH v_col IN ARRAY ARRAY['id','created_at','name','slug','legal_name','country','sector',
                               'base_currency','white_label_enabled','brand_color','logo_url',
                               'onboarding_completed','stripe_customer_id',
                               'stripe_subscription_id','stripe_price_id']
  LOOP
    IF pg_catalog.has_column_privilege('uellix_cap_platform', 'public.organizations', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'uellix_cap_platform can UPDATE organizations.%, which is outside RR-CAP-10.', v_col;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m','f')
      AND c.relname NOT IN ('organizations','audit_logs')
      AND pg_catalog.has_any_column_privilege('uellix_cap_platform', c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_platform can read a relation outside RR-CAP-10.';
  END IF;

  IF pg_catalog.has_table_privilege('uellix_cap_platform', 'public.organizations', 'DELETE')
     OR pg_catalog.has_table_privilege('uellix_cap_platform', 'public.organizations', 'INSERT')
     OR pg_catalog.has_table_privilege('uellix_cap_platform', 'public.audit_logs', 'UPDATE')
     OR pg_catalog.has_table_privilege('uellix_cap_platform', 'public.audit_logs', 'DELETE') THEN
    RAISE EXCEPTION 'uellix_cap_platform holds a privilege beyond "move three columns and record it".';
  END IF;

  IF NOT pg_catalog.has_schema_privilege('uellix_cap_platform', 'auth', 'USAGE') THEN
    RAISE EXCEPTION 'uellix_cap_platform cannot use schema auth; auth.uid() would fail inside the definer and every call would be unattributable.';
  END IF;

  -- 4.5 The policies, named and typed.
  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND pg_catalog.left(policyname, 13) = 'cap_platform_';
  IF v_policies <> 5 THEN
    RAISE EXCEPTION 'Expected 5 cap_platform_* policies (3 permissive + 2 restrictive), found %.', v_policies;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'organizations'
                    AND policyname = 'cap_platform_only_super_admin'
                    AND permissive = 'RESTRICTIVE' AND cmd = 'UPDATE')
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'organizations'
                       AND policyname = 'cap_platform_only_super_admin_read'
                       AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'the RESTRICTIVE platform-admin bounds are absent; a rewritten function body would be the only thing standing between a tenant admin and the quota.';
  END IF;

  -- 4.6 EXECUTE is held by uellix_app and nobody else.
  SELECT pg_catalog.string_agg(r.rolname, ', ') INTO v_extra
    FROM pg_roles r
   WHERE NOT r.rolsuper
     AND r.rolname NOT IN ('uellix_app', 'uellix_cap_platform')
     AND (pg_catalog.has_function_privilege(
            r.rolname, 'uellix_capability.admin_set_stella_service(uuid,integer,text)', 'EXECUTE')
       OR pg_catalog.has_function_privilege(
            r.rolname, 'uellix_capability.admin_set_organization_status(uuid,text)', 'EXECUTE'));
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected roles hold EXECUTE on a platform-admin function: %', v_extra;
  END IF;
  IF pg_catalog.has_function_privilege(
       'public', 'uellix_capability.admin_set_stella_service(uuid,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on admin_set_stella_service.';
  END IF;

  -- 4.7 Baselines unchanged: this package adds no table and no baseline policy.
  IF (SELECT count(*) FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN ('report_public_disclosures','capability_verification_hits',
                               'stripe_webhook_events','capability_bootstrap_attempts')) <> 38 THEN
    RAISE EXCEPTION 'stella_0011 changed the non-capability table baseline; expected 38.';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'stella_0011 changed the policy baseline; expected 105.';
  END IF;

  RAISE NOTICE 'stella_0011 applied: organizations UPDATE is column-scoped; quota, plan and status moved behind the platform definer.';
END
$$;
