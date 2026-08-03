-- db/prepared/stella_0007_public_verification_capability.sql
-- CAP-02 — verify a locked report by hash, as a read-only capability.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_0007_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_02_PUBLIC_VERIFICATION.md
-- COMMON MODEL:    docs/ops/DATABASE_CAPABILITY_MODEL.md
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. THE CAPABILITY IS NOT ENABLED.
--
-- ============================================================================
-- THE POINT OF THIS PACKAGE
-- ============================================================================
-- lib/reports/public-verify.ts does not return a public view. For anyone
-- holding the hash it returns the FULL rows of sroi_reports, projects,
-- organizations (stripe ids included) and sroi_calculation_runs, plus every
-- section, every evidence_item OF THE PROJECT, the methodology matrix and the
-- taxonomy crosswalks. It is closed today only because RLS refuses the reads.
--
-- So this package does not restore access. It redefines what public
-- verification means:
--
--   1. Being `locked` stops being sufficient. Locking is an INTERNAL act —
--      "this no longer changes". Publishing is a SEPARATE, audited act,
--      recorded per report in report_public_disclosures.
--   2. Every visible field is an explicit boolean that someone had to set.
--      All four default to FALSE. A report with a disclosure row and no
--      booleans verifies as authentic and reveals nothing else.
--   3. The read path is LANGUAGE sql + STABLE, so it is structurally unable
--      to write and has exactly one execution path — which is also what makes
--      the four failure modes indistinguishable.
--
-- Applying this package publishes NOTHING. Until a human approves a
-- disclosure, /verify/<hash> answers 404 for every hash, as it does now.
--
-- Runs as superuser for the CREATE ROLE window; see stella_0006's header for
-- why uellix_owner cannot do it. Three windows, same shape as stella_0006.
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0007_public_verification_capability.sql
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
--   * No password, no LOGIN role, no credential.
--   * Nothing granted to anon, authenticated, service_role, PUBLIC or
--     uellix_writer.
--   * The definer gets NO privilege whatsoever on evidence_items,
--     sroi_report_sections, projects, line items, members or stella_*.
--   * No pre-existing policy, grant, column or trigger is altered.
--   * No CASCADE, no dynamic SQL beyond the fixed-literal CREATE ROLE.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0007 must run as a superuser (it creates a role); current_user is %.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0007 requires stella_0004 (uellix_owner is absent).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_0007 requires stella_0004 (uellix_app is absent).';
  END IF;

  -- The baseline EXCLUDES everything the capability campaign introduces, so the
  -- five packages stay mutually independent: applying stella_0006 first must not
  -- make this precondition fail. Pinning the raw global total would have coupled
  -- them into an implicit ordering the design explicitly does not have.
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

  -- left() rather than LIKE: `LIKE 'cap_%'` would treat the underscore as a
  -- single-character wildcard, and escaping it correctly is exactly the kind of
  -- detail that silently rots. This says what it means.
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

  -- The hash lookup must be single-row by construction, not by luck.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'sroi_reports'
      AND c.contype = 'u' AND c.conname = 'sroi_reports_verification_hash_unique'
  ) THEN
    RAISE EXCEPTION 'stella_0007 requires the UNIQUE constraint on sroi_reports.verification_hash.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('sroi_reports','organizations','sroi_calculation_runs')
      AND c.relrowsecurity IS FALSE
  ) THEN
    RAISE EXCEPTION 'stella_0007 requires RLS enabled on sroi_reports, organizations and sroi_calculation_runs.';
  END IF;
END
$$;

-- ============================================================
-- 1. WINDOW 1 (superuser) — role and schema
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    EXECUTE 'CREATE ROLE uellix_cap_verification';
  END IF;
END
$$;

ALTER ROLE uellix_cap_verification
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

GRANT uellix_cap_verification TO uellix_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

COMMENT ON ROLE uellix_cap_verification IS
  'stella_0007 / CAP-02: definer of uellix_capability.verify_report and record_verification_hit. NOLOGIN, no memberships, subject to RLS. Has no privilege of any kind on evidence, sections, projects or members.';

CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_verification;

-- ============================================================
-- 2. WINDOW 2 (owner) — tables, functions, grants, policies
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 Publication is an act, not a status.
--
-- No row here means the report is not publicly verifiable, however locked it
-- is. That is the fail-closed default and it is the whole design.
CREATE TABLE IF NOT EXISTS public.report_public_disclosures (
  report_id              uuid        PRIMARY KEY REFERENCES public.sroi_reports(id),
  organization_id        uuid        NOT NULL REFERENCES public.organizations(id),
  approved_by            uuid        NOT NULL REFERENCES public.users(id),
  approved_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at             timestamptz,
  revoked_by             uuid        REFERENCES public.users(id),
  public_summary         text,
  show_organization_name boolean     NOT NULL DEFAULT false,
  show_report_title      boolean     NOT NULL DEFAULT false,
  show_headline_ratio    boolean     NOT NULL DEFAULT false,
  show_totals            boolean     NOT NULL DEFAULT false,
  disclosure_version     integer     NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.report_public_disclosures IS
  'CAP-02. One row = one human decision to publish one report, with author and timestamp. Absent row = not publicly verifiable. All four visibility booleans default to false: approving a disclosure without setting any of them publishes authenticity and nothing else.';

ALTER TABLE public.report_public_disclosures ENABLE ROW LEVEL SECURITY;

-- 2.2 Aggregate counter. Day x report, and nothing else.
--
-- There is no ip, no user agent, no referer, no session, and no column into
-- which one could later be slipped without a migration that says so out loud.
CREATE TABLE IF NOT EXISTS public.capability_verification_hits (
  report_id uuid    NOT NULL REFERENCES public.sroi_reports(id),
  hit_date  date    NOT NULL,
  hit_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (report_id, hit_date)
);

COMMENT ON TABLE public.capability_verification_hits IS
  'CAP-02. Aggregate verification counter, day x report. Deliberately carries NO personal data: answers "how often was this certificate checked" and cannot answer "by whom".';

ALTER TABLE public.capability_verification_hits ENABLE ROW LEVEL SECURITY;

-- 2.3 The read capability.
--
-- LANGUAGE sql and STABLE, both load-bearing:
--   * STABLE makes the function structurally unable to write. The public read
--     path cannot be turned into a write path by a later edit — the planner
--     refuses it. Same class of guarantee as the read-only audit connection.
--   * A single SELECT has no branches, so every failure mode (unknown hash,
--     not locked, no disclosure, revoked disclosure) executes the same plan
--     and returns the same empty set. Indistinguishability is a property of
--     the JOIN, not a convention the caller has to honour.
--
-- issued_on is a DATE, not a timestamp: locked_at at microsecond precision is
-- a near-unique identifier that would let two independently verified reports
-- be correlated to the same issuer.

CREATE OR REPLACE FUNCTION uellix_capability.verify_report(p_hash text)
RETURNS TABLE (
  verified           boolean,
  organization_name  text,
  report_title       text,
  public_summary     text,
  issued_on          date,
  report_variant     text,
  disclosure_version integer,
  headline_ratio     numeric,
  total_investment   numeric,
  net_social_value   numeric,
  currency           text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
  SET search_path = ''
AS $$
  SELECT
    true,
    CASE WHEN d.show_organization_name THEN o.name::text END,
    CASE WHEN d.show_report_title      THEN r.title::text END,
    d.public_summary,
    (r.locked_at AT TIME ZONE 'UTC')::date,
    r.report_variant::text,
    d.disclosure_version,
    CASE WHEN d.show_headline_ratio THEN run.sroi_ratio END,
    CASE WHEN d.show_totals THEN run.total_investment END,
    CASE WHEN d.show_totals THEN run.net_social_value END,
    CASE WHEN d.show_totals THEN run.currency::text END
  FROM public.sroi_reports r
  JOIN public.report_public_disclosures d ON d.report_id = r.id
  JOIN public.organizations o ON o.id = r.organization_id
  LEFT JOIN public.sroi_calculation_runs run ON run.id = r.calculation_run_id
  WHERE r.verification_hash = p_hash
    AND r.status = 'locked'
    AND d.revoked_at IS NULL
$$;

ALTER FUNCTION uellix_capability.verify_report(text) OWNER TO uellix_cap_verification;

COMMENT ON FUNCTION uellix_capability.verify_report(text) IS
  'CAP-02. Read-only. Returns at most one row, containing only fields an approved disclosure marks visible. Unknown hash, unlocked report, missing disclosure and revoked disclosure are indistinguishable: all four return the empty set.';

-- 2.4 The counter, separate on purpose.
--
-- Keeping it out of verify_report is what lets verify_report be STABLE. It
-- also means the read path survives a broken counter: the endpoint calls this
-- AFTER answering and ignores its result.
CREATE OR REPLACE FUNCTION uellix_capability.record_verification_hit(p_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_report_id uuid;
BEGIN
  SELECT r.id INTO v_report_id
    FROM public.sroi_reports r
    JOIN public.report_public_disclosures d ON d.report_id = r.id
   WHERE r.verification_hash = p_hash
     AND r.status = 'locked'
     AND d.revoked_at IS NULL;

  -- Silent no-op for anything unverifiable. This function must never tell a
  -- caller apart from verify_report's answer, so it reports nothing at all.
  IF v_report_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.capability_verification_hits (report_id, hit_date, hit_count)
  VALUES (v_report_id, (pg_catalog.now() AT TIME ZONE 'UTC')::date, 1)
  ON CONFLICT (report_id, hit_date)
  DO UPDATE SET hit_count = public.capability_verification_hits.hit_count + 1;
END
$$;

ALTER FUNCTION uellix_capability.record_verification_hit(text) OWNER TO uellix_cap_verification;

COMMENT ON FUNCTION uellix_capability.record_verification_hit(text) IS
  'CAP-02. Best-effort aggregate counter. Records day x report and nothing else. Silent no-op for any hash verify_report would also refuse.';

-- 2.5 Definer grants — column-scoped.
--
-- The exclusions matter more than the inclusions. organizations gives up only
-- id and name: not stripe_customer_id, not stripe_subscription_id, not
-- stella_monthly_quota. sroi_reports gives up no summary, no created_by, no
-- locked_by. And there is no grant at all on evidence_items,
-- sroi_report_sections, projects, line items or members — a body that tried to
-- read them would fail at run time under this owner.

GRANT SELECT (id, organization_id, calculation_run_id, title, status,
              report_variant, verification_hash, locked_at)
  ON public.sroi_reports TO uellix_cap_verification;

GRANT SELECT (id, name) ON public.organizations TO uellix_cap_verification;

GRANT SELECT (id, sroi_ratio, total_investment, net_social_value, currency)
  ON public.sroi_calculation_runs TO uellix_cap_verification;

GRANT SELECT ON public.report_public_disclosures TO uellix_cap_verification;

GRANT SELECT, INSERT, UPDATE ON public.capability_verification_hits TO uellix_cap_verification;

-- 2.6 Capability policies.

DROP POLICY IF EXISTS cap_verification_select_reports ON public.sroi_reports;
CREATE POLICY cap_verification_select_reports
ON public.sroi_reports FOR SELECT TO uellix_cap_verification
USING (status = 'locked');

DROP POLICY IF EXISTS cap_verification_select_disclosures ON public.report_public_disclosures;
CREATE POLICY cap_verification_select_disclosures
ON public.report_public_disclosures FOR SELECT TO uellix_cap_verification
USING (revoked_at IS NULL);

DROP POLICY IF EXISTS cap_verification_select_orgs ON public.organizations;
CREATE POLICY cap_verification_select_orgs
ON public.organizations FOR SELECT TO uellix_cap_verification
USING (true);

DROP POLICY IF EXISTS cap_verification_select_runs ON public.sroi_calculation_runs;
CREATE POLICY cap_verification_select_runs
ON public.sroi_calculation_runs FOR SELECT TO uellix_cap_verification
USING (true);

DROP POLICY IF EXISTS cap_verification_write_hits ON public.capability_verification_hits;
CREATE POLICY cap_verification_write_hits
ON public.capability_verification_hits FOR ALL TO uellix_cap_verification
USING (true) WITH CHECK (true);

-- 2.7 The INTERNAL side of report_public_disclosures.
--
-- Approving a disclosure is an ordinary, organisation-scoped admin action and
-- uses the ordinary model: the same helpers every other table uses. It is NOT
-- part of the capability and does not touch uellix_cap_verification.
--
-- These three name `TO uellix_app` explicitly, which departs from the 101
-- pre-existing `{public}` policies and is deliberate. A policy with no TO
-- clause is TO PUBLIC — the exact defect stella_0005c had to repair on the
-- three append-only INSERT policies. Here it would be inert in practice (the
-- USING clauses evaluate false without auth.uid(), so uellix_cap_verification
-- would gain nothing), but "inert in practice" is the argument that was wrong
-- last time: `authenticated` held a grant nobody had accounted for, and the
-- policy was what turned it into a write path. Naming the runtime role costs
-- nothing and removes the question.
--
-- There is no DELETE policy, deliberately: a disclosure is revoked
-- (revoked_at), never erased. Who published what, and when, has to remain
-- answerable after the fact.

DROP POLICY IF EXISTS disclosures_select_member ON public.report_public_disclosures;
CREATE POLICY disclosures_select_member
ON public.report_public_disclosures FOR SELECT TO uellix_app
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);

DROP POLICY IF EXISTS disclosures_insert_admin ON public.report_public_disclosures;
CREATE POLICY disclosures_insert_admin
ON public.report_public_disclosures FOR INSERT TO uellix_app
WITH CHECK (
  public.current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR public.current_user_is_super_admin()
);

DROP POLICY IF EXISTS disclosures_update_admin ON public.report_public_disclosures;
CREATE POLICY disclosures_update_admin
ON public.report_public_disclosures FOR UPDATE TO uellix_app
USING (
  public.current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR public.current_user_is_super_admin()
)
WITH CHECK (
  public.current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin')
  OR public.current_user_is_super_admin()
);

-- The runtime needs the ordinary DML surface on the new table, exactly like
-- every other operational table. It gets it through uellix_writer, which is
-- where the runtime's whole write surface is defined and read.
GRANT SELECT, INSERT, UPDATE ON public.report_public_disclosures TO uellix_writer;

RESET ROLE;

-- ============================================================
-- 3. WINDOW 3 (superuser) — function ACLs
-- ============================================================

REVOKE ALL ON FUNCTION uellix_capability.verify_report(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_capability.record_verification_hit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_capability.verify_report(text) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_capability.record_verification_hit(text) TO uellix_app;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
DECLARE
  v_policies integer;
BEGIN
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    RAISE EXCEPTION 'uellix_cap_verification must be NOLOGIN.';
  END IF;
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    RAISE EXCEPTION 'uellix_cap_verification must be NOBYPASSRLS.';
  END IF;

  -- verify_report must be STABLE. 'i' immutable, 's' stable, 'v' volatile.
  -- This is the assertion that the public read path cannot write.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'verify_report'
      AND p.provolatile = 's'
      AND p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'uellix_cap_verification'
      AND p.proconfig IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%')
  ) THEN
    RAISE EXCEPTION 'verify_report is not a STABLE SECURITY DEFINER owned by uellix_cap_verification with an explicit search_path.';
  END IF;

  -- The exclusion that defines this capability.
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    WHERE t.schemaname = 'public'
      AND t.tablename IN ('evidence_items','sroi_report_sections','projects',
                          'sroi_calculation_line_items','organization_members',
                          'stella_interactions','methodology_review_matrix',
                          'invitations','marketing_leads','audit_logs')
      AND pg_catalog.has_any_column_privilege(
            'uellix_cap_verification',
            ('public.' || pg_catalog.quote_ident(t.tablename))::regclass, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_verification can read a table outside CAP-02.';
  END IF;

  -- Column-level exclusions on the two tables it CAN read.
  IF pg_catalog.has_column_privilege(
       'uellix_cap_verification', 'public.organizations', 'stripe_customer_id', 'SELECT') THEN
    RAISE EXCEPTION 'uellix_cap_verification can read organizations.stripe_customer_id.';
  END IF;
  IF pg_catalog.has_column_privilege(
       'uellix_cap_verification', 'public.sroi_reports', 'summary', 'SELECT') THEN
    RAISE EXCEPTION 'uellix_cap_verification can read sroi_reports.summary.';
  END IF;

  IF pg_catalog.has_function_privilege(
       'public', 'uellix_capability.verify_report(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on verify_report.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_app', 'uellix_capability.verify_report(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_app does not hold EXECUTE on verify_report.';
  END IF;

  -- Cross-capability isolation.
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname LIKE 'uellix\_cap\_%'
      AND r.rolname <> 'uellix_cap_verification'
      AND pg_catalog.has_function_privilege(
            r.rolname, 'uellix_capability.verify_report(text)', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'another capability role can execute verify_report.';
  END IF;

  -- The counter carries no personal data, and cannot start to.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'capability_verification_hits'
      AND column_name NOT IN ('report_id','hit_date','hit_count')
  ) THEN
    RAISE EXCEPTION 'capability_verification_hits has an unexpected column.';
  END IF;

  -- Publishing is opt-in: the four booleans must default to false.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'report_public_disclosures'
      AND column_name IN ('show_organization_name','show_report_title',
                          'show_headline_ratio','show_totals')
      AND column_default IS DISTINCT FROM 'false'
  ) THEN
    RAISE EXCEPTION 'a report_public_disclosures visibility flag does not default to false.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND pg_catalog.left(policyname, 17) = 'cap_verification_';
  IF v_policies <> 5 THEN
    RAISE EXCEPTION 'Expected 5 cap_verification_* policies, found %.', v_policies;
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND pg_catalog.left(policyname, 12) = 'disclosures_';
  IF v_policies <> 3 THEN
    RAISE EXCEPTION 'Expected 3 internal disclosures_* policies, found %.', v_policies;
  END IF;

  -- The baseline is untouched: this package adds two tables and eight policies
  -- and alters none of what was already there.
  IF (SELECT count(*) FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN ('report_public_disclosures','capability_verification_hits',
                               'stripe_webhook_events','capability_bootstrap_attempts')) <> 38 THEN
    RAISE EXCEPTION 'stella_0007 changed the non-capability table baseline; expected 38, found %.',
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
    RAISE EXCEPTION 'stella_0007 changed the non-capability policy baseline; expected 105, found %.',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND pg_catalog.left(policyname, 4) <> 'cap_'
          AND pg_catalog.left(policyname, 12) <> 'disclosures_'
          AND policyname NOT IN ('anon_insert_marketing_leads',
                                 'authenticated_insert_marketing_leads'));
  END IF;

  RAISE NOTICE 'stella_0007 applied: CAP-02 capability present, zero reports published.';
END
$$;
