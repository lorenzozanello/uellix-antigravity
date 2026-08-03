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
-- So this package does not restore access. It redefines the capability:
--
--   1. Being `locked` stops being sufficient. Locking is an INTERNAL act —
--      "this no longer changes". Publishing is a SEPARATE, audited act,
--      recorded per report in report_public_disclosures.
--   2. Every visible field is an explicit boolean that someone had to set.
--      All four default to FALSE. A report with a disclosure row and no
--      booleans verifies as authentic and reveals nothing else.
--   3. The read path is LANGUAGE sql + STABLE, so it is structurally unable to
--      write, and its four failure modes return the same empty set because the
--      JOIN produces it — not because a branch chose to.
--
-- Applying this package publishes NOTHING. Until a human approves a
-- disclosure, /verify/<hash> answers 404 for every hash, as it does now.
--
-- ============================================================================
-- WHAT THE ADVERSARIAL REVIEW CHANGED (2026-08-03)
-- ============================================================================
-- * The disclosure table no longer carries its own `organization_id`. It did,
--   and nothing tied it to the report's organisation: no composite FK, no
--   CHECK, and a WITH CHECK that validated only "you are an admin of the org
--   you claim in the row". Foreign-key validation runs as the table owner and
--   bypasses RLS, so an admin of Org A who learned a locked report id from
--   Org B could insert (report_id = B's report, organization_id = A), set the
--   booleans, and publish B's data under B's own name. The organisation is now
--   derived from `sroi_reports` inside the policies, so there is nothing to
--   disagree with.
-- * `approved_by` is pinned to auth.uid() by the INSERT policy and is NOT in
--   the UPDATE grant. The table's COMMENT claims each row is "one human
--   decision with author and timestamp"; that is only true if the author
--   cannot be chosen or rewritten.
-- * The function is created, owned and granted in the SUPERUSER window. See
--   stella_0006's header: `ALTER FUNCTION … OWNER TO R` requires R to hold
--   CREATE on the schema, and `COMMENT ON` / `CREATE OR REPLACE` afterwards
--   require ownership resolved through has_privs_of_role, which INHERIT FALSE
--   denies. Doing it as superuser fixes all three and lets the capability role
--   have ZERO members.
-- * record_verification_hit is the only capability write reachable by fully
--   anonymous traffic and had no timeout at all.
--
-- Runs as superuser. Three windows: (1) role + schema, (2) SET ROLE owner for
-- DDL/grants/policies, (3) superuser for the functions and their ACLs.
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0007_public_verification_capability.sql
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
--   * No password, no LOGIN role, no credential.
--   * Nothing granted to anon, authenticated, service_role or PUBLIC.
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
    RAISE EXCEPTION 'stella_0007 must run as a superuser; current_user is %.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0007 requires stella_0004 (uellix_owner is absent).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_0007 requires stella_0004 (uellix_app is absent).';
  END IF;

  -- The baseline EXCLUDES everything the capability campaign introduces, so the
  -- five packages stay mutually independent: applying stella_0006 first must not
  -- make this precondition fail.
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

COMMENT ON ROLE uellix_cap_verification IS
  'stella_0007 / CAP-02: definer of uellix_capability.verify_report and record_verification_hit. NOLOGIN, ZERO members, subject to RLS. Has no privilege of any kind on evidence, sections, projects or members.';

CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_verification;

-- Neither CAP-02 function calls auth.uid(): verification is anonymous by
-- definition. So this definer, unlike CAP-01's and CAP-05's, gets NO grant on
-- schema auth — and the postcondition asserts it does not have one.

-- ============================================================
-- 2. WINDOW 2 (owner) — tables, grants, policies
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 Publication is an act, not a status.
--
-- No row here means the report is not publicly verifiable, however locked it
-- is. That is the fail-closed default and it is the whole design.
--
-- There is NO organization_id column, deliberately. An earlier revision had
-- one, unconstrained against the report's own organisation, which let an admin
-- of one tenant publish another tenant's report. The organisation is derived
-- from sroi_reports wherever it is needed.
CREATE TABLE IF NOT EXISTS public.report_public_disclosures (
  report_id              uuid        PRIMARY KEY REFERENCES public.sroi_reports(id),
  approved_by            uuid        NOT NULL REFERENCES public.users(id),
  approved_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at             timestamptz,
  revoked_by             uuid        REFERENCES public.users(id),
  public_summary         text,
  show_organization_name boolean     NOT NULL DEFAULT false,
  show_report_title      boolean     NOT NULL DEFAULT false,
  show_headline_ratio    boolean     NOT NULL DEFAULT false,
  show_totals            boolean     NOT NULL DEFAULT false,
  -- Added after the second adversarial round. issued_on and report_variant
  -- were returned UNCONDITIONALLY while the header claimed every visible field
  -- was behind a boolean. The lock date of a private report is a disclosure,
  -- and so is which of funder / methodological / audit was produced.
  show_issued_on         boolean     NOT NULL DEFAULT false,
  show_report_variant    boolean     NOT NULL DEFAULT false,
  disclosure_version     integer     NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.report_public_disclosures IS
  'CAP-02. One row = one human decision to publish one report, with author and timestamp. Absent row = not publicly verifiable. All four visibility booleans default to false: approving a disclosure without setting any of them publishes authenticity and nothing else. approved_by is pinned to auth.uid() by policy and is not updatable.';

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
  'CAP-02. Aggregate verification counter, day x report. Carries NO personal data. NOTE: nothing reads it yet — no function and no grant exposes it to the product. It is collected, not surfaced.';

ALTER TABLE public.capability_verification_hits ENABLE ROW LEVEL SECURITY;

-- 2.3 Definer grants — column-scoped.
--
-- The exclusions matter more than the inclusions. organizations gives up only
-- id and name: not stripe_customer_id, not stripe_subscription_id, not
-- stella_monthly_quota, and not slug. sroi_reports gives up no summary, no
-- created_by, no locked_by. And there is no grant at all on evidence_items,
-- sroi_report_sections, projects, line items or members.


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
GRANT EXECUTE ON FUNCTION public.current_user_org_ids()        TO uellix_cap_verification;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_cap_verification;
GRANT EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) TO uellix_cap_verification;

GRANT SELECT (id, organization_id, calculation_run_id, title, status,
              report_variant, verification_hash, locked_at)
  ON public.sroi_reports TO uellix_cap_verification;

GRANT SELECT (id, name) ON public.organizations TO uellix_cap_verification;

GRANT SELECT (id, sroi_ratio, total_investment, net_social_value, currency)
  ON public.sroi_calculation_runs TO uellix_cap_verification;

GRANT SELECT (report_id, revoked_at, public_summary, show_organization_name,
              show_report_title, show_headline_ratio, show_totals,
              show_issued_on, show_report_variant, disclosure_version)
  ON public.report_public_disclosures TO uellix_cap_verification;

GRANT SELECT, INSERT, UPDATE ON public.capability_verification_hits TO uellix_cap_verification;

-- 2.4 Capability policies.

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

-- 2.5 The INTERNAL side of report_public_disclosures.
--
-- Approving a disclosure is an ordinary, organisation-scoped admin action. It
-- is NOT part of the capability and does not touch uellix_cap_verification.
--
-- These three name `TO uellix_app` explicitly, which departs from the 101
-- pre-existing `{public}` policies and is deliberate. A policy with no TO
-- clause is TO PUBLIC — the exact defect stella_0005c had to repair on the
-- three append-only INSERT policies. Naming the runtime role costs nothing and
-- removes the question.
--
-- The organisation is derived from sroi_reports, never asserted by the caller.
-- The EXISTS subquery is itself evaluated under the caller's RLS, so a report
-- belonging to another tenant is invisible to it and the predicate is false —
-- two independent locks on the same door.
--
-- There is no DELETE policy: a disclosure is revoked (revoked_at), never
-- erased. Who published what, and when, has to stay answerable.

DROP POLICY IF EXISTS disclosures_select_member ON public.report_public_disclosures;
CREATE POLICY disclosures_select_member
ON public.report_public_disclosures FOR SELECT TO uellix_app
USING (
  EXISTS (
    SELECT 1 FROM public.sroi_reports r
     WHERE r.id = public.report_public_disclosures.report_id
       AND (r.organization_id = ANY(public.current_user_org_ids())
            OR public.current_user_is_super_admin())
  )
);

DROP POLICY IF EXISTS disclosures_insert_admin ON public.report_public_disclosures;
CREATE POLICY disclosures_insert_admin
ON public.report_public_disclosures FOR INSERT TO uellix_app
WITH CHECK (
  approved_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.sroi_reports r
     WHERE r.id = public.report_public_disclosures.report_id
       AND (public.current_user_role_in_org(r.organization_id)
              IN ('super_admin', 'organization_admin')
            OR public.current_user_is_super_admin())
  )
);

DROP POLICY IF EXISTS disclosures_update_admin ON public.report_public_disclosures;
CREATE POLICY disclosures_update_admin
ON public.report_public_disclosures FOR UPDATE TO uellix_app
USING (
  EXISTS (
    SELECT 1 FROM public.sroi_reports r
     WHERE r.id = public.report_public_disclosures.report_id
       AND (public.current_user_role_in_org(r.organization_id)
              IN ('super_admin', 'organization_admin')
            OR public.current_user_is_super_admin())
  )
)
WITH CHECK (
  -- revoked_by is pinned exactly as approved_by is. The table COMMENT claims
  -- each row records a human decision with its author; that has to hold for
  -- the revocation too, or an admin can record a colleague as the revoker.
  (revoked_by IS NULL OR revoked_by = auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.sroi_reports r
     WHERE r.id = public.report_public_disclosures.report_id
       AND (public.current_user_role_in_org(r.organization_id)
              IN ('super_admin', 'organization_admin')
            OR public.current_user_is_super_admin())
  )
);

-- The runtime's DML surface on the new table, column-scoped.
--
-- report_id, approved_by and approved_at are INSERT-only: once a disclosure is
-- recorded, which report it is about and who approved it cannot be rewritten.
-- Without that, "one human decision with author and timestamp" would be a
-- claim the table could not keep.
GRANT SELECT ON public.report_public_disclosures TO uellix_writer;
GRANT INSERT (report_id, approved_by, public_summary, show_organization_name,
              show_report_title, show_headline_ratio, show_totals,
              show_issued_on, show_report_variant, disclosure_version)
  ON public.report_public_disclosures TO uellix_writer;
GRANT UPDATE (revoked_at, revoked_by, public_summary, show_organization_name,
              show_report_title, show_headline_ratio, show_totals,
              show_issued_on, show_report_variant, disclosure_version, updated_at)
  ON public.report_public_disclosures TO uellix_writer;

-- RESTRICTIVE companions. Everything above is PERMISSIVE, and permissive
-- policies are combined with OR — including the 105 {public} baseline
-- policies, which apply to this definer too. Their predicates call
-- current_user_role_in_org() / current_user_is_super_admin(), which read
-- auth.uid() — a SESSION GUC that SECURITY DEFINER does not reset — so
-- inside the definer they resolve to the CALLER, not to the empty set. An
-- org-admin caller would therefore satisfy the baseline policy and OR away
-- every bound the permissive cap_* policies above appear to impose.
--
-- A RESTRICTIVE policy is ANDed with the permissive result and cannot be
-- OR-ed away. These are what make the documented bounds true; without them
-- the only real bound was the column ACL.
DROP POLICY IF EXISTS cap_verification_only_locked ON public.sroi_reports;
CREATE POLICY cap_verification_only_locked
ON public.sroi_reports AS RESTRICTIVE FOR SELECT TO uellix_cap_verification
USING (status = 'locked');

DROP POLICY IF EXISTS cap_verification_only_live ON public.report_public_disclosures;
CREATE POLICY cap_verification_only_live
ON public.report_public_disclosures AS RESTRICTIVE FOR SELECT TO uellix_cap_verification
USING (revoked_at IS NULL);

RESET ROLE;

-- ============================================================
-- 3. WINDOW 3 (superuser) — the functions, their owners, their ACLs
-- ============================================================

-- 3.1 The read capability.
--
-- LANGUAGE sql and STABLE, both load-bearing:
--   * STABLE makes the function structurally unable to write. The public read
--     path cannot be turned into a write path by a later edit — the planner
--     refuses it.
--   * A single SELECT has no branches, so the four failure modes (unknown
--     hash, not locked, no disclosure, revoked disclosure) all return the same
--     empty set as a property of the JOIN rather than of a convention the
--     caller has to honour. Timing is NOT equalised — see RR-CAP-02-E.
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
    -- locked_at is `timestamp WITHOUT time zone` and already naive UTC, so a
    -- cast is all that is needed. `AT TIME ZONE 'UTC'` on a NAIVE operand does
    -- the opposite of what it does twelve lines below on a timestamptz one: it
    -- produces a timestamptz, and the ::date then renders it in the session
    -- TimeZone. A report locked at 23:30 UTC would publish as the next day in
    -- Madrid and the previous one in Los Angeles.
    CASE WHEN d.show_issued_on THEN r.locked_at::date END,
    CASE WHEN d.show_report_variant THEN r.report_variant::text END,
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
  'CAP-02. Read-only. Returns at most one row, containing only fields an approved disclosure marks visible. Unknown hash, unlocked report, missing disclosure and revoked disclosure are indistinguishable by RESULT: all four return the empty set. Timing is not equalised (RR-CAP-02-E).';

-- 3.2 The counter, separate on purpose.
--
-- Keeping it out of verify_report is what lets verify_report be STABLE. It
-- also means the read path survives a broken counter: the endpoint calls this
-- AFTER answering and ignores its result.
--
-- This is the ONLY capability write reachable by fully anonymous traffic, and
-- its ON CONFLICT … DO UPDATE serialises every visitor of a given certificate
-- onto one row per day. Without the two timeouts a distributed flood against a
-- single published hash would queue unboundedly on one heap page. It swallows
-- lock_not_available and query_canceled because it is best-effort by contract.
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
  -- lock_timeout only. `SET LOCAL statement_timeout` inside a function that is
  -- ALREADY RUNNING is inert: the timer is armed once, in
  -- start_xact_command(), before the top-level statement begins, and assigning
  -- the GUC afterwards does not re-arm it. lock_timeout is different — it is
  -- read at each lock acquisition — so the contention bound is real; a claim
  -- of "two timeouts" was not. A statement bound belongs on the role or the
  -- pool, where it is armed at statement start.
  SET LOCAL lock_timeout = '1s';

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

EXCEPTION
  -- Best-effort means best-effort: a contended counter must never turn a
  -- successful verification into an error, and an error here must never carry
  -- a DETAIL back to an anonymous caller.
  --
  -- query_canceled is listed SEPARATELY because PL/pgSQL excludes it from
  -- OTHERS. Without this arm a cancellation would escape the one function in
  -- the campaign whose contract is that it can never fail.
  WHEN query_canceled THEN
    RAISE LOG 'record_verification_hit cancelled (57014)';
    RETURN;
  WHEN OTHERS THEN
    RAISE LOG 'record_verification_hit skipped with SQLSTATE %', SQLSTATE;
    RETURN;
END
$$;

ALTER FUNCTION uellix_capability.record_verification_hit(text) OWNER TO uellix_cap_verification;

COMMENT ON FUNCTION uellix_capability.record_verification_hit(text) IS
  'CAP-02. Best-effort aggregate counter. Records day x report and nothing else. Silent no-op for any hash verify_report would also refuse, and silent on any error.';

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
  v_extra    text;
BEGIN
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    RAISE EXCEPTION 'uellix_cap_verification must be NOLOGIN.';
  END IF;
  IF (SELECT rolbypassrls OR rolcreaterole OR rolcreatedb OR rolsuper
        FROM pg_roles WHERE rolname = 'uellix_cap_verification') THEN
    RAISE EXCEPTION 'uellix_cap_verification has a forbidden role attribute.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'uellix_cap_verification')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_verification has a member; it must have none.';
  END IF;

  -- verify_report must be STABLE ('s'). This is the assertion that the public
  -- read path cannot write. Both functions must carry an EMPTY search_path —
  -- enumerated, not prefix-matched: a prefix match would also accept
  -- `search_path=public, pg_temp`, the configuration the model forbids.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'verify_report'
      AND p.provolatile = 's'
      AND p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'uellix_cap_verification'
      AND (p.proconfig @> ARRAY['search_path=']::text[]
        OR p.proconfig @> ARRAY['search_path=""']::text[])
  ) THEN
    RAISE EXCEPTION 'verify_report is not a STABLE SECURITY DEFINER owned by uellix_cap_verification with an EMPTY search_path.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'record_verification_hit'
      AND p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'uellix_cap_verification'
      AND (p.proconfig @> ARRAY['search_path=']::text[]
        OR p.proconfig @> ARRAY['search_path=""']::text[])
  ) THEN
    RAISE EXCEPTION 'record_verification_hit is not a SECURITY DEFINER owned by uellix_cap_verification with an EMPTY search_path.';
  END IF;

  -- Neither function calls auth.uid(), so the definer must NOT hold auth.
  IF pg_catalog.has_schema_privilege('uellix_cap_verification', 'auth', 'USAGE') THEN
    RAISE EXCEPTION 'uellix_cap_verification holds USAGE on schema auth; CAP-02 has no use for it.';
  END IF;

  -- The exclusion that defines this capability. pg_class filtered by relkind
  -- rather than pg_tables: pg_tables omits views, materialised views, foreign
  -- tables and sequences, and a view with a PUBLIC grant would be a read path
  -- pg_tables could not see.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m','f')
      AND c.relname NOT IN ('sroi_reports','organizations','sroi_calculation_runs',
                            'report_public_disclosures','capability_verification_hits')
      AND pg_catalog.has_any_column_privilege('uellix_cap_verification', c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_verification can read a relation outside CAP-02.';
  END IF;

  -- Column-level exclusions on the relations it CAN read.
  IF pg_catalog.has_column_privilege(
       'uellix_cap_verification', 'public.organizations', 'stripe_customer_id', 'SELECT')
     OR pg_catalog.has_column_privilege(
       'uellix_cap_verification', 'public.organizations', 'slug', 'SELECT') THEN
    RAISE EXCEPTION 'uellix_cap_verification can read an organizations column outside (id, name).';
  END IF;
  IF pg_catalog.has_column_privilege(
       'uellix_cap_verification', 'public.sroi_reports', 'summary', 'SELECT') THEN
    RAISE EXCEPTION 'uellix_cap_verification can read sroi_reports.summary.';
  END IF;

  -- EXECUTE is held by exactly one non-superuser role besides the owner.
  -- Enumerating pg_roles rather than matching a name pattern is what makes this
  -- order-independent: it covers uellix_stripe, and any future role, without
  -- having to know that role exists.
  SELECT pg_catalog.string_agg(r.rolname, ', ') INTO v_extra
    FROM pg_roles r
   WHERE NOT r.rolsuper
     AND r.rolname NOT IN ('uellix_app', 'uellix_cap_verification')
     AND (pg_catalog.has_function_privilege(
            r.rolname, 'uellix_capability.verify_report(text)', 'EXECUTE')
       OR pg_catalog.has_function_privilege(
            r.rolname, 'uellix_capability.record_verification_hit(text)', 'EXECUTE'));
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected roles hold EXECUTE on a CAP-02 function: %', v_extra;
  END IF;

  IF pg_catalog.has_function_privilege(
       'public', 'uellix_capability.verify_report(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on verify_report.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_app', 'uellix_capability.verify_report(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_app does not hold EXECUTE on verify_report.';
  END IF;

  -- The disclosure table must not carry an organisation the caller could
  -- assert. The organisation is derived from sroi_reports, always.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'report_public_disclosures'
      AND column_name = 'organization_id'
  ) THEN
    RAISE EXCEPTION 'report_public_disclosures carries an organization_id; it must derive the org from sroi_reports.';
  END IF;

  -- The approver cannot be rewritten after the fact.
  IF pg_catalog.has_column_privilege(
       'uellix_writer', 'public.report_public_disclosures', 'approved_by', 'UPDATE')
     OR pg_catalog.has_column_privilege(
       'uellix_writer', 'public.report_public_disclosures', 'report_id', 'UPDATE') THEN
    RAISE EXCEPTION 'the runtime can rewrite who approved a disclosure, or which report it is about.';
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
                          'show_headline_ratio','show_totals',
                          'show_issued_on','show_report_variant')
      AND column_default IS DISTINCT FROM 'false'
  ) THEN
    RAISE EXCEPTION 'a report_public_disclosures visibility flag does not default to false.';
  END IF;


  -- The three RLS helpers must be executable, or every read this capability
  -- makes dies at 42501 while evaluating somebody else's {public} policy.
  IF NOT (pg_catalog.has_function_privilege('uellix_cap_verification', 'public.current_user_org_ids()', 'EXECUTE')
      AND pg_catalog.has_function_privilege('uellix_cap_verification', 'public.current_user_is_super_admin()', 'EXECUTE')
      AND pg_catalog.has_function_privilege('uellix_cap_verification', 'public.current_user_role_in_org(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'uellix_cap_verification cannot execute the RLS helper functions; every policy-guarded read would fail with 42501.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND pg_catalog.left(policyname, 17) = 'cap_verification_';
  IF v_policies <> 7 THEN
    RAISE EXCEPTION 'Expected 7 cap_verification_* policies (5 permissive + 2 restrictive), found %.', v_policies;
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 17) = 'cap_verification_'
         AND permissive = 'RESTRICTIVE') <> 2 THEN
    RAISE EXCEPTION 'the two RESTRICTIVE cap_verification_* policies are missing; a locked-but-unpublished report could be read through a baseline policy.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND pg_catalog.left(policyname, 12) = 'disclosures_';
  IF v_policies <> 3 THEN
    RAISE EXCEPTION 'Expected 3 internal disclosures_* policies, found %.', v_policies;
  END IF;

  IF (SELECT count(*) FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN ('report_public_disclosures','capability_verification_hits',
                               'stripe_webhook_events','capability_bootstrap_attempts')) <> 38 THEN
    RAISE EXCEPTION 'stella_0007 changed the non-capability table baseline; expected 38.';
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'stella_0007 changed the policy baseline; expected 105.';
  END IF;

  RAISE NOTICE 'stella_0007 applied: CAP-02 capability present, zero reports published.';
END
$$;
