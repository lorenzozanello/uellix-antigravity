-- db/prepared/stella_0010_organization_bootstrap_capability.sql
-- CAP-05 — self-serve organisation bootstrap, as a transactional capability.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_0010_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md
-- COMMON MODEL:    docs/ops/DATABASE_CAPABILITY_MODEL.md
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. THE CAPABILITY IS NOT ENABLED.
-- app/app/onboarding/actions.ts is unchanged and still fails closed.
--
-- ============================================================================
-- WHY A DEFINER FUNCTION AND NOT A TECHNICAL BOOTSTRAP IDENTITY
-- ============================================================================
-- CAP-03 needs a LOGIN role because Stripe has no human subject. CAP-05 is the
-- opposite case, and the asymmetry is the justification rather than an
-- inconsistency:
--
-- A technical bootstrap role would be a role able to create organisations and
-- memberships WITHOUT a subject. Its credential, leaked, would let an attacker
-- fabricate organisations and attach anyone to anything. This function cannot
-- run at all without auth.uid(): the subject comes from the JWT the session
-- already verified, never from a parameter and never from a credential. The
-- capability is bound to the requester's identity by construction.
--
-- It also answers, precisely, the objection recorded in members_insert_admin:
--
--   "No self-insert exception needed here — that would allow any user to join
--    any org."
--
-- Correct, and this is not that. The organization_id inserted into
-- organization_members is the id of the row this same transaction just
-- created — not a value the caller can name — and the policy admits only the
-- founding admin role. members_insert_admin and orgs_insert_super_admin are
-- left untouched.
--
-- Runs as superuser for the CREATE ROLE window; see stella_0006's header.
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0010_organization_bootstrap_capability.sql
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
--   * No password, no LOGIN role, no technical identity.
--   * Nothing granted to anon, authenticated, service_role or PUBLIC.
--   * The definer gets NO grant on organizations.stella_monthly_quota,
--     stella_plan_label or any stripe_* column, so the bootstrap CANNOT choose
--     a plan, a quota or a billing flag. That is enforced by the grant, not by
--     trusting the body not to try.
--   * No UPDATE or DELETE on organizations or organization_members: the
--     capability can create, never modify.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0010 must run as a superuser (it creates a role); current_user is %.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0010 requires stella_0004 (uellix_owner is absent).';
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

  -- The slug uniqueness this design relies on for its atomic ON CONFLICT.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'organizations'
      AND c.contype = 'u' AND c.conname = 'organizations_slug_unique'
  ) THEN
    RAISE EXCEPTION 'stella_0010 requires the UNIQUE constraint on organizations.slug.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('organizations','organization_members','signup_allowlist','audit_logs','users')
      AND c.relrowsecurity IS FALSE
  ) THEN
    RAISE EXCEPTION 'stella_0010 requires RLS enabled on the five tables it touches.';
  END IF;
END
$$;

-- ============================================================
-- 1. WINDOW 1 (superuser) — role and schema
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap') THEN
    EXECUTE 'CREATE ROLE uellix_cap_bootstrap';
  END IF;
END
$$;

ALTER ROLE uellix_cap_bootstrap
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

GRANT uellix_cap_bootstrap TO uellix_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

COMMENT ON ROLE uellix_cap_bootstrap IS
  'stella_0010 / CAP-05: definer of uellix_capability.bootstrap_organization. NOLOGIN, no memberships. Can CREATE an organisation and its founding membership; cannot UPDATE or DELETE either, and has no grant on any plan, quota or billing column.';

CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_bootstrap;

-- ============================================================
-- 2. WINDOW 2 (owner)
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 The idempotency ledger.
--
-- The composite PRIMARY KEY matters: an idempotency key belongs to a subject,
-- so one user's key cannot collide with another's. An attacker who guessed a
-- key could at worst interfere with their OWN attempts.
CREATE TABLE IF NOT EXISTS public.capability_bootstrap_attempts (
  user_id         uuid        NOT NULL REFERENCES public.users(id),
  idempotency_key uuid        NOT NULL,
  organization_id uuid        REFERENCES public.organizations(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (user_id, idempotency_key)
);

COMMENT ON TABLE public.capability_bootstrap_attempts IS
  'CAP-05. Idempotency ledger for organisation bootstrap. Keyed by (user_id, idempotency_key) so a key belongs to its subject. A failed attempt rolls back with the transaction, freeing its key for a retry.';

ALTER TABLE public.capability_bootstrap_attempts ENABLE ROW LEVEL SECURITY;

-- 2.2 The capability.
CREATE OR REPLACE FUNCTION uellix_capability.bootstrap_organization(
  p_idempotency_key uuid,
  p_name            text,
  p_slug            text,
  p_legal_name      text,
  p_country         text,
  p_sector          text
) RETURNS TABLE (organization_id uuid, slug text)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  -- A fixed array, not a table. A table would be configurable, and therefore a
  -- target; this list changes only through a reviewed migration. Every entry
  -- is a real route of the application or a name that would be confusing as an
  -- organisation slug.
  c_reserved constant text[] := ARRAY[
    'app','api','admin','www','auth','login','logout','signup','onboarding',
    'verify','invite','dashboard','settings','billing','support','help',
    'status','static','public','assets','_next','favicon','robots','sitemap',
    'uellix','stella','null','undefined','new','edit','delete'
  ];
  v_subject   uuid;
  v_email     text;
  v_domain    text;
  v_name      text;
  v_slug      text;
  v_org_id    uuid;
  v_member_id uuid;
  v_existing  uuid;
BEGIN
  SET LOCAL lock_timeout = '3s';

  -- The subject NEVER arrives as a parameter. This is what makes a technical
  -- bootstrap identity unnecessary — and unsafe by comparison.
  v_subject := auth.uid();
  IF v_subject IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Idempotent replay: the same key from the same subject returns the same
  -- organisation and writes nothing. This is the retry-after-timeout path.
  SELECT a.organization_id INTO v_existing
    FROM public.capability_bootstrap_attempts a
   WHERE a.user_id = v_subject AND a.idempotency_key = p_idempotency_key
     FOR UPDATE;

  IF FOUND AND v_existing IS NOT NULL THEN
    RETURN QUERY
      SELECT o.id, o.slug::text FROM public.organizations o WHERE o.id = v_existing;
    RETURN;
  END IF;

  -- One active membership per subject. This is the SECOND, independent defence
  -- against a duplicate organisation: the idempotency key covers a resubmitted
  -- form, this covers a fresh one.
  IF EXISTS (
    SELECT 1 FROM public.organization_members m
     WHERE m.user_id = v_subject AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  SELECT pg_catalog.lower(pg_catalog.btrim(u.email)) INTO v_email
    FROM public.users u WHERE u.id = v_subject;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;
  v_domain := pg_catalog.split_part(v_email, '@', 2);

  -- The allowlist is the gate (DP-CAP-12). The definer can read it; an
  -- ordinary user cannot, which is why the current server action fails one
  -- step before it even reaches the insert.
  IF NOT EXISTS (
    SELECT 1 FROM public.signup_allowlist s
     WHERE (s.type = 'email'  AND s.pattern = v_email)
        OR (s.type = 'domain' AND s.pattern = v_domain)
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  v_name := pg_catalog.btrim(pg_catalog.coalesce(p_name, ''));
  IF pg_catalog.length(v_name) < 2 OR pg_catalog.length(v_name) > 255 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  v_slug := pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(p_slug, '')));
  -- Anchored, bounded, and it cannot start or end with a hyphen. The current
  -- action accepts ^[a-z0-9-]+$, which admits '-', '---' and 'api'.
  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$' OR v_slug = ANY(c_reserved) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Atomic, not check-then-act. The current action SELECTs for the slug and
  -- then INSERTs, so two concurrent submissions both pass the check and the
  -- second dies on the constraint with an opaque error.
  INSERT INTO public.organizations (name, slug, legal_name, country, sector, status)
  VALUES (
    v_name,
    v_slug,
    pg_catalog.nullif(pg_catalog.left(pg_catalog.btrim(pg_catalog.coalesce(p_legal_name, '')), 255), ''),
    pg_catalog.nullif(pg_catalog.upper(pg_catalog.left(pg_catalog.btrim(pg_catalog.coalesce(p_country, '')), 2)), ''),
    pg_catalog.nullif(pg_catalog.btrim(pg_catalog.coalesce(p_sector, '')), ''),
    'active'
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_org_id;

  -- The ONE distinguishable error in this capability, and it is justified: the
  -- slug space is public by design (organisations are addressable by slug), so
  -- hiding "taken" would degrade usability to conceal something that is not
  -- concealed. Revisit if DP-CAP-12 changes the URL model.
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'organization slug is already taken' USING ERRCODE = 'U0002';
  END IF;

  -- Neither the user nor the role is a parameter. The organization_id is the
  -- row created two statements ago — not a value the caller can name.
  INSERT INTO public.organization_members
    (organization_id, user_id, role, status, joined_at)
  VALUES
    (v_org_id, v_subject, 'organization_admin', 'active', pg_catalog.now())
  RETURNING id INTO v_member_id;

  -- Initial configuration. There is no separate settings table in this schema:
  -- an organisation's configuration IS its own columns, and every one this
  -- capability does not name takes the column DEFAULT — quota included. That
  -- is the mechanism by which the bootstrap cannot pick a plan: it has no
  -- grant on those columns at all, so naming them would fail.

  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES
    (v_org_id, v_subject, 'organization', v_org_id, 'organization.created',
     pg_catalog.jsonb_build_object('name', v_name, 'slug', v_slug));

  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES
    (v_org_id, v_subject, 'organization_member', v_member_id, 'membership.created',
     pg_catalog.jsonb_build_object('userId', v_subject, 'role', 'organization_admin'));

  INSERT INTO public.capability_bootstrap_attempts
    (user_id, idempotency_key, organization_id, completed_at)
  VALUES
    (v_subject, p_idempotency_key, v_org_id, pg_catalog.now())
  ON CONFLICT (user_id, idempotency_key)
  DO UPDATE SET organization_id = EXCLUDED.organization_id,
                completed_at    = EXCLUDED.completed_at;

  RETURN QUERY SELECT v_org_id, v_slug;
END
$$;

ALTER FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text)
  OWNER TO uellix_cap_bootstrap;

COMMENT ON FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text) IS
  'CAP-05. Creates one organisation, its founding admin membership and two audit rows in ONE transaction — there is no partial organisation. Subject comes from auth.uid(); owner, role, plan and quota are not parameters. U0001 uniform refusal, U0002 for a taken slug only.';

-- 2.3 Definer grants — column-scoped.
--
-- Note what is ABSENT from the INSERT list: stella_monthly_quota,
-- stella_plan_label and every stripe_* column. The bootstrap literally cannot
-- name them, so "cannot choose a plan, permission or administrative flag" is a
-- property of the ACL rather than a promise about the body.
GRANT SELECT (id, slug) ON public.organizations TO uellix_cap_bootstrap;
GRANT INSERT (name, slug, legal_name, country, sector, status)
  ON public.organizations TO uellix_cap_bootstrap;
-- No UPDATE, no DELETE: it can create, never modify.

GRANT SELECT (user_id, status) ON public.organization_members TO uellix_cap_bootstrap;
GRANT INSERT (organization_id, user_id, role, status, joined_at)
  ON public.organization_members TO uellix_cap_bootstrap;

GRANT SELECT (id, email) ON public.users TO uellix_cap_bootstrap;
GRANT SELECT (type, pattern) ON public.signup_allowlist TO uellix_cap_bootstrap;

GRANT INSERT (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  ON public.audit_logs TO uellix_cap_bootstrap;

GRANT SELECT, INSERT, UPDATE ON public.capability_bootstrap_attempts TO uellix_cap_bootstrap;

-- 2.4 Policies.

DROP POLICY IF EXISTS cap_bootstrap_select_orgs ON public.organizations;
CREATE POLICY cap_bootstrap_select_orgs
ON public.organizations FOR SELECT TO uellix_cap_bootstrap
USING (true);

DROP POLICY IF EXISTS cap_bootstrap_insert_orgs ON public.organizations;
CREATE POLICY cap_bootstrap_insert_orgs
ON public.organizations FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (status = 'active');

DROP POLICY IF EXISTS cap_bootstrap_select_members ON public.organization_members;
CREATE POLICY cap_bootstrap_select_members
ON public.organization_members FOR SELECT TO uellix_cap_bootstrap
USING (true);

-- The direct answer to members_insert_admin's objection: only the founding
-- admin role, only active, and only into a row this transaction created.
DROP POLICY IF EXISTS cap_bootstrap_insert_members ON public.organization_members;
CREATE POLICY cap_bootstrap_insert_members
ON public.organization_members FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (role = 'organization_admin' AND status = 'active');

DROP POLICY IF EXISTS cap_bootstrap_select_users ON public.users;
CREATE POLICY cap_bootstrap_select_users
ON public.users FOR SELECT TO uellix_cap_bootstrap
USING (true);

DROP POLICY IF EXISTS cap_bootstrap_select_allowlist ON public.signup_allowlist;
CREATE POLICY cap_bootstrap_select_allowlist
ON public.signup_allowlist FOR SELECT TO uellix_cap_bootstrap
USING (true);

DROP POLICY IF EXISTS cap_bootstrap_insert_audit ON public.audit_logs;
CREATE POLICY cap_bootstrap_insert_audit
ON public.audit_logs FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (
  actor_user_id IS NOT NULL
  AND entity_type IN ('organization','organization_member')
  AND action IN ('organization.created','membership.created')
);

DROP POLICY IF EXISTS cap_bootstrap_rw_attempts ON public.capability_bootstrap_attempts;
CREATE POLICY cap_bootstrap_rw_attempts
ON public.capability_bootstrap_attempts FOR ALL TO uellix_cap_bootstrap
USING (true) WITH CHECK (true);

RESET ROLE;

-- ============================================================
-- 3. WINDOW 3 (superuser) — function ACL
-- ============================================================

REVOKE ALL ON FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text) TO uellix_app;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
DECLARE
  v_policies integer;
BEGIN
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap must be NOLOGIN.';
  END IF;

  -- 4.1 This package must not have created a LOGIN identity of any kind.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_bootstrap' OR rolname = 'uellix_cap_bootstrap' AND rolcanlogin
  ) THEN
    RAISE EXCEPTION 'stella_0010 must not create a LOGIN bootstrap identity.';
  END IF;

  -- 4.2 The plan/quota/billing exclusion — the requirement stated as an ACL
  -- fact rather than as a claim about the function body.
  IF pg_catalog.has_column_privilege(
       'uellix_cap_bootstrap', 'public.organizations', 'stella_monthly_quota', 'INSERT')
     OR pg_catalog.has_column_privilege(
       'uellix_cap_bootstrap', 'public.organizations', 'stella_plan_label', 'INSERT')
     OR pg_catalog.has_column_privilege(
       'uellix_cap_bootstrap', 'public.organizations', 'stripe_customer_id', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap can set a plan, quota or billing column.';
  END IF;

  -- 4.3 Create-only.
  IF pg_catalog.has_any_column_privilege(
       'uellix_cap_bootstrap', 'public.organizations'::regclass, 'UPDATE')
     OR pg_catalog.has_any_column_privilege(
       'uellix_cap_bootstrap', 'public.organization_members'::regclass, 'UPDATE')
     OR pg_catalog.has_table_privilege(
       'uellix_cap_bootstrap', 'public.organizations', 'DELETE')
     OR pg_catalog.has_table_privilege(
       'uellix_cap_bootstrap', 'public.organization_members', 'DELETE') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap can modify or delete an existing organisation or membership.';
  END IF;

  -- 4.4 Nothing outside CAP-05.
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    WHERE t.schemaname = 'public'
      AND t.tablename IN ('projects','sroi_reports','sroi_calculation_runs','evidence_items',
                          'stella_interactions','invitations','marketing_leads',
                          'stripe_webhook_events')
      AND pg_catalog.has_any_column_privilege(
            'uellix_cap_bootstrap',
            ('public.' || pg_catalog.quote_ident(t.tablename))::regclass, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap can read a table outside CAP-05.';
  END IF;

  -- 4.5 ACL and cross-capability isolation.
  IF pg_catalog.has_function_privilege(
       'public',
       'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on bootstrap_organization.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_app',
       'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_app does not hold EXECUTE on bootstrap_organization.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE pg_catalog.left(r.rolname, 11) = 'uellix_cap_'
      AND r.rolname <> 'uellix_cap_bootstrap'
      AND pg_catalog.has_function_privilege(
            r.rolname,
            'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'another capability role can execute bootstrap_organization.';
  END IF;

  -- 4.6 The historic policies this capability deliberately does not touch.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'members_insert_admin'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'orgs_insert_super_admin'
  ) THEN
    RAISE EXCEPTION 'stella_0010 removed a pre-existing policy it must leave alone.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND pg_catalog.left(policyname, 14) = 'cap_bootstrap_';
  IF v_policies <> 8 THEN
    RAISE EXCEPTION 'Expected 8 cap_bootstrap_* policies, found %.', v_policies;
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'stella_0010 changed the policy baseline; expected 105.';
  END IF;

  RAISE NOTICE 'stella_0010 applied: CAP-05 capability present, onboarding action still failing closed.';
END
$$;
