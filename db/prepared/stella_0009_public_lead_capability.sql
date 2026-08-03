-- db/prepared/stella_0009_public_lead_capability.sql
-- CAP-04 — public lead capture, as a write-only capability.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_0009_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_04_PUBLIC_LEADS.md
-- COMMON MODEL:    docs/ops/DATABASE_CAPABILITY_MODEL.md
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. THE CAPABILITY IS NOT ENABLED.
-- LEAD_CAPTURE_POLICY_AVAILABLE stays false; the route still answers 503.
--
-- ============================================================================
-- THIS PACKAGE REDUCES NET PRIVILEGE. THAT IS THE POINT.
-- ============================================================================
-- app/api/marketing/lead/route.ts diagnoses the outage correctly and then
-- proposes the wrong fix. Measured on this stack:
--
--   marketing_leads grants: uellix_writer -> SELECT, INSERT, UPDATE, DELETE
--
-- The runtime ALREADY HOLDS the privilege. What stops it is that all three
-- policies name roles it is not (`{anon}`, `{authenticated}`), so none applies
-- and RLS denies by default. The route's option (a) — "an INSERT policy for
-- {public} on this table" — would restore the endpoint AND hand the entire
-- runtime public write access to a table it can also read and delete from.
--
-- So this package goes the other way:
--
--   * a narrow definer with INSERT on six named columns and NOTHING else —
--     no SELECT, so the capability that writes leads cannot enumerate them;
--   * the ONLY policy on the table for writing is TO that definer;
--   * uellix_writer's four privileges on marketing_leads are REVOKED, so the
--     runtime cannot touch the table by any route at all;
--   * the two dead PostgREST-era policies are dropped, because an unused
--     policy is not harmless — it is an authorisation waiting for a role.
--
-- `super_admins_read_marketing_leads` is left INTACT. It is also broken (it is
-- TO authenticated and the runtime is not), but repairing an administrative
-- READ path is a different capability with a different threat model, and
-- folding it in here is exactly the grouping this campaign forbids. Tracked as
-- RR-CAP-6.
--
-- Runs as superuser for the CREATE ROLE window; see stella_0006's header.
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0009_public_lead_capability.sql
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
--   * No password, no LOGIN role.
--   * Nothing granted to anon, authenticated, service_role or PUBLIC.
--   * No column for ip, user agent, referer or fingerprint — and the
--     postcondition refuses one.
--   * No write to audit_logs: a lead is personal data and audit_logs is
--     append-only, so a lead written there could never be erased.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
DECLARE
  v_dupes integer;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0009 must run as a superuser (it creates a role); current_user is %.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0009 requires stella_0004 (uellix_owner is absent).';
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

  -- The stable baseline: 107 policies at stella_0005c, minus the two this
  -- package retires. Excluding them by NAME rather than counting 107 or 105
  -- keeps the predicate identical in all five packages and independent of
  -- whether THIS one has run.
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

  -- The unique index cannot be created over existing duplicates. Report the
  -- COUNT only: a duplicated lead e-mail is still someone's e-mail address.
  SELECT count(*) INTO v_dupes
    FROM (SELECT 1 FROM public.marketing_leads
           GROUP BY pg_catalog.lower(email), source HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'stella_0009 cannot create the unique index: % duplicate (lower(email), source) groups exist. Resolve them first.',
      v_dupes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'marketing_leads' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'stella_0009 requires RLS enabled on marketing_leads.';
  END IF;
END
$$;

-- ============================================================
-- 1. WINDOW 1 (superuser) — role and schema
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_lead') THEN
    EXECUTE 'CREATE ROLE uellix_cap_lead';
  END IF;
END
$$;

ALTER ROLE uellix_cap_lead
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

GRANT uellix_cap_lead TO uellix_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

COMMENT ON ROLE uellix_cap_lead IS
  'stella_0009 / CAP-04: definer of uellix_capability.submit_lead. Holds INSERT on six named columns of marketing_leads and NOTHING else — deliberately no SELECT, so the capability that writes leads cannot read them.';

CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_lead;

-- ============================================================
-- 2. WINDOW 2 (owner)
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 Schema.
--
-- lead_status exists so the initial state is a column default AND a policy
-- check AND a function constant — three layers for one invariant, which is
-- what you want when the layer that rots is the one a future edit touches.
--
-- consent_version is created NULLABLE on purpose. Making it NOT NULL requires
-- deciding what consent text is shown (DP-CAP-09), and that decision is legal,
-- not technical, so it is not invented here. The column exists so answering it
-- later needs no further migration.
ALTER TABLE public.marketing_leads
  ADD COLUMN IF NOT EXISTS lead_status     varchar(20) NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS consent_version varchar(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'marketing_leads_status_check'
      AND conrelid = 'public.marketing_leads'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.marketing_leads ADD CONSTRAINT marketing_leads_status_check CHECK (lead_status IN (''new'',''contacted'',''qualified'',''discarded''))';
  END IF;
END
$$;

COMMENT ON COLUMN public.marketing_leads.consent_version IS
  'CAP-04: version identifier of the consent text the submitter was shown. Nullable until DP-CAP-09 fixes that text; a NULL means the lead predates a recorded consent, which is the truth rather than a default.';

-- The index that makes duplicate submissions indistinguishable from new ones:
-- ON CONFLICT DO NOTHING needs it, and without it the endpoint would answer
-- differently for a known e-mail and become a membership oracle.
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_leads_email_source
  ON public.marketing_leads (pg_catalog.lower(email), source);

-- 2.2 The capability.
--
-- RETURNS void is a security decision, not a style one: with no return value
-- there is no channel through which the function can reveal whether the row
-- already existed, whether the insert happened, or how many rows there are.
-- Combined with ON CONFLICT DO NOTHING and no RETURNING, the definer never
-- needs SELECT — so it is never granted.
CREATE OR REPLACE FUNCTION uellix_capability.submit_lead(
  p_email        text,
  p_company_name text,
  p_sroi_result  text,
  p_source       text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_email   text;
  v_company text;
  v_sroi    text;
BEGIN
  -- Normalised HERE, not only in Zod. Uniqueness is defined over the
  -- normalised value, so normalising in two places with two implementations
  -- would produce duplicates that the index cannot see.
  v_email := pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(p_email, '')));

  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     OR pg_catalog.length(v_email) > 255 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- A FIXED list, not free text. Today `source` is a client-controlled
  -- varchar(100) that ends up in reports; an allow-list closes content
  -- injection into whatever consumes it downstream.
  IF p_source IS NULL
     OR p_source NOT IN ('sroi_calculator','landing_hero','pricing','demo_request','contact_form') THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  v_company := pg_catalog.nullif(
                 pg_catalog.left(pg_catalog.btrim(pg_catalog.coalesce(p_company_name, '')), 255), '');
  v_sroi    := pg_catalog.nullif(
                 pg_catalog.left(pg_catalog.btrim(pg_catalog.coalesce(p_sroi_result, '')), 50), '');

  -- lead_status is a CONSTANT here. It is not a parameter, so nobody outside
  -- can mark a lead as contacted or qualified.
  INSERT INTO public.marketing_leads
    (email, company_name, sroi_result, source, lead_status, consent_version)
  VALUES
    (v_email, v_company, v_sroi, p_source, 'new', NULL)
  ON CONFLICT (pg_catalog.lower(email), source) DO NOTHING;
END
$$;

ALTER FUNCTION uellix_capability.submit_lead(text, text, text, text) OWNER TO uellix_cap_lead;

COMMENT ON FUNCTION uellix_capability.submit_lead(text, text, text, text) IS
  'CAP-04. Write-only public lead capture. RETURNS void and never reads, so a duplicate submission is indistinguishable from a new one. Its definer has INSERT on six columns and no SELECT anywhere.';

-- 2.3 Definer grants. INSERT on six columns. Nothing else, anywhere.
GRANT INSERT (email, company_name, sroi_result, source, lead_status, consent_version)
  ON public.marketing_leads TO uellix_cap_lead;

-- 2.4 Retire the dead PostgREST-era policies.
--
-- They describe a write path that no longer exists (anon/authenticated writing
-- through PostgREST). Leaving them would keep a door open for a role that does
-- not use it today but would the day PostgREST came back. Same lesson as
-- stella_0005c: an unused policy is an authorisation waiting for a role.
DROP POLICY IF EXISTS anon_insert_marketing_leads          ON public.marketing_leads;
DROP POLICY IF EXISTS authenticated_insert_marketing_leads ON public.marketing_leads;

-- 2.5 The only write policy on the table.
DROP POLICY IF EXISTS cap_lead_insert ON public.marketing_leads;
CREATE POLICY cap_lead_insert
ON public.marketing_leads FOR INSERT TO uellix_cap_lead
WITH CHECK (lead_status = 'new');

-- 2.6 Take the runtime's privilege away.
--
-- This is the statement that makes the package a net REDUCTION. After it,
-- uellix_app (which inherits from uellix_writer) cannot select, insert, update
-- or delete a marketing lead by any route: not through the ORM, not through a
-- future endpoint, not by accident.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads FROM uellix_writer;

RESET ROLE;

-- ============================================================
-- 3. WINDOW 3 (superuser) — function ACL
-- ============================================================

REVOKE ALL ON FUNCTION uellix_capability.submit_lead(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_capability.submit_lead(text, text, text, text) TO uellix_app;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
DECLARE
  v_policies integer;
BEGIN
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_lead') THEN
    RAISE EXCEPTION 'uellix_cap_lead must be NOLOGIN.';
  END IF;

  -- 4.1 The defining property: the writer cannot read.
  IF pg_catalog.has_any_column_privilege(
       'uellix_cap_lead', 'public.marketing_leads'::regclass, 'SELECT') THEN
    RAISE EXCEPTION 'uellix_cap_lead can SELECT marketing_leads; it must not.';
  END IF;
  IF pg_catalog.has_any_column_privilege(
       'uellix_cap_lead', 'public.marketing_leads'::regclass, 'UPDATE')
     OR pg_catalog.has_table_privilege(
       'uellix_cap_lead', 'public.marketing_leads', 'DELETE') THEN
    RAISE EXCEPTION 'uellix_cap_lead can modify or delete leads; it must only insert.';
  END IF;

  -- 4.2 The runtime is out.
  IF pg_catalog.has_any_column_privilege(
       'uellix_writer', 'public.marketing_leads'::regclass, 'INSERT')
     OR pg_catalog.has_any_column_privilege(
       'uellix_writer', 'public.marketing_leads'::regclass, 'SELECT')
     OR pg_catalog.has_any_column_privilege(
       'uellix_writer', 'public.marketing_leads'::regclass, 'UPDATE')
     OR pg_catalog.has_table_privilege(
       'uellix_writer', 'public.marketing_leads', 'DELETE') THEN
    RAISE EXCEPTION 'uellix_writer still holds a privilege on marketing_leads.';
  END IF;

  -- 4.3 The definer reaches nothing else.
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    WHERE t.schemaname = 'public' AND t.tablename <> 'marketing_leads'
      AND (pg_catalog.has_any_column_privilege(
             'uellix_cap_lead', ('public.' || pg_catalog.quote_ident(t.tablename))::regclass, 'SELECT')
        OR pg_catalog.has_any_column_privilege(
             'uellix_cap_lead', ('public.' || pg_catalog.quote_ident(t.tablename))::regclass, 'INSERT'))
  ) THEN
    RAISE EXCEPTION 'uellix_cap_lead can reach a table outside CAP-04.';
  END IF;

  -- 4.4 No personal-data column crept into the table.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketing_leads'
      AND column_name IN ('ip','ip_address','client_ip','user_agent','referer','referrer','fingerprint')
  ) THEN
    RAISE EXCEPTION 'marketing_leads has a column this design forbids (ip / user agent / referer / fingerprint).';
  END IF;

  -- 4.5 ACL.
  IF pg_catalog.has_function_privilege(
       'public', 'uellix_capability.submit_lead(text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on submit_lead.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_app', 'uellix_capability.submit_lead(text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_app does not hold EXECUTE on submit_lead.';
  END IF;

  -- 4.6 The table's policy set: cap_lead_insert plus the retained super-admin
  -- read. Exactly two, so the retired pair really is gone and nothing else
  -- appeared.
  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'marketing_leads';
  IF v_policies <> 2 THEN
    RAISE EXCEPTION 'Expected exactly 2 policies on marketing_leads, found %.', v_policies;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'marketing_leads'
      AND policyname = 'super_admins_read_marketing_leads'
  ) THEN
    RAISE EXCEPTION 'super_admins_read_marketing_leads was removed; this package must not touch it (RR-CAP-6).';
  END IF;

  -- 4.7 The baseline is untouched.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'stella_0009 changed the policy baseline; expected 105.';
  END IF;

  RAISE NOTICE 'stella_0009 applied: CAP-04 capability present, route still refusing (503). Net privilege REDUCED.';
END
$$;
