-- ============================================================================
-- stella_hosted_0007_runtime_table_acl_contract.sql
-- The TABLE half of the runtime cutover, which the hosted path never received.
-- ============================================================================
--
-- PREPARED ONLY — NOT A MIGRATION. FORWARD-ONLY: no rollback file, typed in
-- db/hosted/forward-only-packages.ts.
--
-- PRECHAIN ADMINISTRATIVE UNIT. NOT a member of HOSTED_CHAIN.
--
-- ----------------------------------------------------------------------------
-- WHAT BROKE, AND WHY IT ONLY BECAME VISIBLE AFTER stella_hosted_0006
-- ----------------------------------------------------------------------------
-- Measured on the hosted staging project through the deployed application,
-- after 0006 had closed the FUNCTION half:
--
--     42501  permission denied for table users
--
-- raised twice on the login path — once by syncUserProfile
-- (lib/auth/session.ts:303, INSERT ... ON CONFLICT DO UPDATE) and once by
-- loadCurrentUserWithinContext (lib/auth/database-context.ts:190, SELECT).
--
-- The runtime is `uellix_app`, which inherits `uellix_writer`. MEASURED on the
-- hosted project: uellix_writer holds ZERO table privileges in schema public —
-- 0 SELECT, 0 INSERT, 0 UPDATE, 0 DELETE, across all 39 tables.
--
-- THE ERROR WAS MASKED, WHICH IS WHY 0006 DID NOT FIND IT. The check query in
-- db/identity-context.ts:190 calls public.current_user_is_super_admin() BEFORE
-- any business statement runs. While the runtime lacked EXECUTE on that
-- function, every request died there, and no request ever reached a table. The
-- table-layer 42501 was unreachable behind the function-layer 42501, so the
-- observation that produced 0006 could only name a function. Closing the first
-- error is what made the second one observable. Both are the SAME defect:
--
--   stella_0004_role_separation.sql is LOCAL-ONLY, and the hosted substitute
--   (stella_hosted_0001 §5d) derives its object set from the CHAIN's authority
--   plan — what the INSTALLER touches — via prechain-requirements.ts. The
--   application runtime was never in that derivation. 0006 repaired §6b-bis
--   (the three RLS helper EXECUTE grants). §6a, §6b and §6c — the table
--   privileges — were left behind by the same omission.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS NOT §6a/§6b COPIED VERBATIM
-- ----------------------------------------------------------------------------
-- Two packages that are INSTALLED ON THE HOSTED CHAIN have superseded parts of
-- stella_0004 §6 since it was written. Copying the canon unamended would
-- REGRESS both. The rule this package applies is one sentence:
--
--     the hosted contract is stella_0004 §6, amended ONLY where a package
--     installed after it says otherwise.
--
-- Every amendment below traces to an installed package, never to this author's
-- judgement:
--
--   stella_0017_governed_stella_consumption (HOSTED_CHAIN, INSTALLED) §339/§342
--     REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions
--       FROM uellix_writer;   ... and FROM uellix_app;
--     That is R6-INT: the ledger is charged through the governed ticket
--     protocol as uellix_cap_stella_quota, never by a standing runtime INSERT.
--     stella_0004 §6a lists the table as append-only SELECT+INSERT; the
--     amended contract is SELECT and nothing else. Granting INSERT here would
--     re-open a closed vulnerability and sell two units against a cap of one.
--     db/prepared-package-order.ts:224 already states the end state in words:
--     "uellix_writer holds no INSERT on stella_interactions".
--
--   grounding_0002_document_versions / grounding_0003_evidence_chunks
--     (HOSTED_CHAIN, INSTALLED)
--     REVOKE ALL ON public.evidence_document_versions FROM uellix_writer;
--     REVOKE ALL ON public.evidence_chunks           FROM uellix_writer;
--     GRANT SELECT ON ... TO uellix_app;      -- DIRECT, not through the writer
--     Those two tables are CAPABILITY-ONLY: the runtime reads them as itself
--     and writes them only through uellix_grounding SECURITY DEFINER functions.
--     They are postdated to stella_0004, are absent from its lists, and this
--     package grants NOTHING on them. It asserts their posture instead, in §0.7
--     and again in §5, so a future edit that quietly added them would fail.
--
-- ----------------------------------------------------------------------------
-- THE CONTRACT, AS THREE CLASSES AND AN EXCLUSION
-- ----------------------------------------------------------------------------
--   APPEND_ONLY      SELECT, INSERT                     3 tables
--   GOVERNED_READ    SELECT                             1 table  (amended)
--   OPERATIONAL      SELECT, INSERT, UPDATE, DELETE    33 tables
--   CAPABILITY_ONLY  nothing for uellix_writer          2 tables (asserted)
--
--   uellix_auditor   SELECT on all 37, and nothing else — stella_0004 §6c.
--   uellix_app       NO direct grant on any of the 37. It reaches every one of
--                    them through GRANT uellix_writer TO uellix_app WITH
--                    INHERIT TRUE, issued by stella_hosted_0001 §3. §5 asserts
--                    the EFFECTIVE privilege, not merely the grant.
--
-- NOTHING STRUCTURAL, EVER. No TRUNCATE, REFERENCES, TRIGGER or MAINTAIN
-- reaches any runtime role, on any table — asserted across ALL of schema
-- public in §0.6 and §5, not only across the 37 this package names. No
-- ownership moves. No policy is created, dropped or altered. No role is
-- created. No schema privilege is granted. No DDL of any kind.
--
-- RLS REMAINS THE ROW BOUNDARY. A table privilege is necessary and NOT
-- sufficient: every one of these tables has RLS enabled, and the policies
-- decide which rows the grant reaches. This package changes no policy, so the
-- row-level answer for every principal is exactly what it was before it ran.
--
-- ----------------------------------------------------------------------------
-- TWO OWNERS, AND WHY THERE IS A SET ROLE
-- ----------------------------------------------------------------------------
-- MEASURED on the hosted project: 36 of the 37 contract tables are owned by
-- `postgres`; public.stella_interactions is owned by `uellix_owner`
-- (transferred by stella_hosted_0001). GRANT requires ownership or a grant
-- option, and postgres holds NEITHER on that one table —
-- pg_has_role(postgres, uellix_owner, 'USAGE') is false and
-- has_table_privilege(postgres, ..., 'SELECT WITH GRANT OPTION') is false.
--
-- postgres CAN, however, `SET ROLE uellix_owner`: stella_hosted_0001 grants the
-- membership WITH INHERIT FALSE, SET TRUE, which is the same door
-- stella_hosted_0003 used to transfer the Storage helpers. §4 therefore issues
-- that single grant under `SET LOCAL ROLE uellix_owner` and returns
-- immediately. The role change is LOCAL to this transaction and is asserted to
-- have been given back in §5.
--
-- ----------------------------------------------------------------------------
-- public.stella_suggestion_decisions — DECLARED CONDITIONAL, NOT IGNORED
-- ----------------------------------------------------------------------------
-- stella_0004 §6a names 5 append-only tables. Only 4 exist on hosted. The fifth
-- is absent for a reason that is a matter of record rather than drift:
--
--   * no unit of db/migrations creates it, and it appears nowhere in
--     db/hosted/baseline-manifest.ts (the 50 baseline units);
--   * the only forward script that creates it is
--     db/prepared/stella_0003_suggestion_decisions.sql, which is not in
--     db/hosted/hosted-package-manifest.ts and has never been applied hosted;
--   * its writer is gated behind STELLA_DECISIONS_PERSISTENCE_ENABLED, whose
--     code default is false (lib/stella/config.ts:36, strict === 'true') and
--     which is observed false on the hosted project.
--
-- CLASSIFICATION: PACKAGE_NOT_INSTALLED. So this package must not fail because
-- it is missing, and must not pretend it does not exist either. §3 grants the
-- append-only pair IF AND ONLY IF the table is present, through a fixed literal
-- — the construct stella_0002b established for exactly this — and raises a
-- NOTICE naming it when it is absent. On hosted today that branch does not run.
--
-- ----------------------------------------------------------------------------
-- IT REFUSES A THIRD STATE RATHER THAN NORMALISING IT
-- ----------------------------------------------------------------------------
-- Unlike stella_0004 §6, this package issues NO convergence REVOKE. That is
-- deliberate and it is the difference between a stack you control from a known
-- prior state and an environment whose posture nobody has measured. The
-- measured hosted prestate is EMPTY — the writer holds nothing — so there is
-- nothing legitimate to take back, and any privilege found instead was put
-- there by something outside this repository. Silently revoking it would erase
-- the evidence; silently keeping it would ship a widening nobody reviewed. So:
--
--   MISSING_RUNTIME_ACL     the writer holds nothing on any contract table
--   CANONICAL_RUNTIME_ACL   the writer holds exactly the contract, everywhere
--   UNEXPECTED_RUNTIME_ACL  anything else — REFUSED, including a PARTIAL state
--
-- and, as hard security refusals evaluated before any of the above:
--   a structural privilege held by a runtime role, anywhere in public;
--   UPDATE or DELETE held on an append-only table;
--   any privilege held on a CAPABILITY_ONLY table by the writer;
--   a direct grant to uellix_app on a contract table;
--   a relation in public owned by a runtime role.
--
-- RUN AS ONE TRANSACTION, AS THE OWNING ADMINISTRATIVE IDENTITY:
--   psql "$ADMIN_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- IDEMPOTENT AND POST-STATE AWARE. Re-granting a held privilege changes
-- nothing, so a second application over CANONICAL_RUNTIME_ACL is a no-op whose
-- ACL is byte-identical afterwards. No project reference appears in this file.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (administrative window)
-- ============================================================
DO $$
DECLARE
  v_missing text;
  v_bad     text;
  v_full    int := 0;
  v_empty   int := 0;
  v_total   int := 0;
  r         record;
BEGIN
  -- 0.1 PostgreSQL 17. MAINTAIN is a PG17 privilege and §0.6 asks for it by
  --     name, so the floor is stated rather than assumed.
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: PostgreSQL 17 or newer is required; this server reports %.',
      current_setting('server_version');
  END IF;

  -- 0.2 THE GRANTEES AND THE RUNTIME. All three, by name.
  SELECT string_agg(t.r, ', ' ORDER BY t.r) INTO v_missing
  FROM (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app'), ('uellix_owner')) AS t(r)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t.r);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: role(s) % do not exist. Apply stella_hosted_0001_managed_role_bootstrap.sql first.', v_missing;
  END IF;

  -- 0.3 THE INHERITANCE THIS PACKAGE RELIES ON, asserted and NOT created.
  --     Granting to the writer while uellix_app cannot inherit from it would
  --     satisfy every check about the writer and leave the product exactly as
  --     dead as it is now.
  IF NOT pg_catalog.pg_has_role('uellix_app', 'uellix_writer', 'USAGE') THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: uellix_app is not an inheriting member of uellix_writer, so a grant to the writer would never reach the runtime. That membership is issued by stella_hosted_0001 §3 (GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE); this package asserts it and will not stand in for it.';
  END IF;

  IF NOT (SELECT rolinherit FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: uellix_app carries NOINHERIT, so membership in uellix_writer confers no privilege without an explicit SET ROLE the runtime never issues.';
  END IF;

  -- 0.3b THE OTHER HALF OF THE CUTOVER MUST ALREADY BE IN PLACE.
  --      Almost every policy in this schema calls public.current_user_org_ids()
  --      or public.current_user_is_super_admin(), and evaluating a policy
  --      requires the INVOKING role to hold EXECUTE on every function the
  --      predicate names. A table privilege granted without them does not
  --      return zero rows — it fails outright with "permission denied for
  --      function current_user_org_ids", which is the state
  --      stella_hosted_0006 was written to close. Applying this package first
  --      would therefore certify a contract that still cannot serve a request,
  --      so the ORDER is enforced here rather than by whatever loop applies
  --      the units.
  SELECT string_agg(t.sig, ', ' ORDER BY t.sig) INTO v_missing
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  WHERE to_regprocedure(t.sig) IS NULL
     OR NOT has_function_privilege('uellix_app', t.sig, 'EXECUTE');

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: uellix_app cannot execute %. Every RLS policy on the tables this package grants calls those helpers, and a policy whose predicate names a function the invoker cannot execute FAILS rather than filtering — so these table privileges would buy nothing. Apply stella_hosted_0006_runtime_rls_helper_contract.sql first.', v_missing;
  END IF;

  -- 0.4 THE 37 CONTRACT TABLES EXIST. Named, never discovered: a package that
  --     granted on whatever it happened to find would have no contract.
  SELECT string_agg(t.tbl, ', ' ORDER BY t.tbl) INTO v_missing
  FROM (VALUES
    ('public.audit_logs'), ('public.sroi_calculation_line_items'), ('public.sroi_calculation_runs'),
    ('public.stella_interactions'),
    ('public.evidence_items'), ('public.financial_proxies'), ('public.funders'),
    ('public.fx_rates'), ('public.impact_narratives'), ('public.indicators'),
    ('public.invitations'), ('public.marketing_leads'), ('public.methodology_review_matrix'),
    ('public.methodology_review_matrix_items'), ('public.organization_members'), ('public.organizations'),
    ('public.outcome_funder_allocations'), ('public.outcome_proxy_assignments'), ('public.outcome_taxonomy_mappings'),
    ('public.outcomes'), ('public.portfolios'), ('public.project_investments'),
    ('public.projects'), ('public.proxy_sources'), ('public.signup_allowlist'),
    ('public.sroi_assignment_inputs'), ('public.sroi_filter_sets'), ('public.sroi_report_sections'),
    ('public.sroi_reports'), ('public.sroi_run_review_items'), ('public.sroi_run_reviews'),
    ('public.stakeholder_groups'), ('public.taxonomy_catalogs'), ('public.taxonomy_codes'),
    ('public.theory_of_change_links'), ('public.theory_of_change_nodes'), ('public.users')
  ) AS t(tbl)
  WHERE to_regclass(t.tbl) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: contract table(s) % do not exist. These are baseline objects; apply the fifty baseline units first. (public.stella_suggestion_decisions is deliberately NOT in this list — see the header.)', v_missing;
  END IF;

  -- 0.5 THE EXECUTOR CAN ACTUALLY GRANT. Ownership, or membership in the owner.
  --     Checked per table rather than assumed from "apply as postgres", because
  --     stella_hosted_0001 moved one of the 37 to uellix_owner and a package
  --     that discovered that halfway through would have granted 36 of 37.
  SELECT string_agg(t.tbl || ' (owned by ' || pg_catalog.pg_get_userbyid(c.relowner) || ')', ', ' ORDER BY t.tbl)
    INTO v_bad
  FROM (VALUES
    ('public.audit_logs'), ('public.sroi_calculation_line_items'), ('public.sroi_calculation_runs'),
    ('public.stella_interactions'),
    ('public.evidence_items'), ('public.financial_proxies'), ('public.funders'),
    ('public.fx_rates'), ('public.impact_narratives'), ('public.indicators'),
    ('public.invitations'), ('public.marketing_leads'), ('public.methodology_review_matrix'),
    ('public.methodology_review_matrix_items'), ('public.organization_members'), ('public.organizations'),
    ('public.outcome_funder_allocations'), ('public.outcome_proxy_assignments'), ('public.outcome_taxonomy_mappings'),
    ('public.outcomes'), ('public.portfolios'), ('public.project_investments'),
    ('public.projects'), ('public.proxy_sources'), ('public.signup_allowlist'),
    ('public.sroi_assignment_inputs'), ('public.sroi_filter_sets'), ('public.sroi_report_sections'),
    ('public.sroi_reports'), ('public.sroi_run_review_items'), ('public.sroi_run_reviews'),
    ('public.stakeholder_groups'), ('public.taxonomy_catalogs'), ('public.taxonomy_codes'),
    ('public.theory_of_change_links'), ('public.theory_of_change_nodes'), ('public.users')
  ) AS t(tbl)
  JOIN pg_class c ON c.oid = to_regclass(t.tbl)
  WHERE NOT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
    AND NOT pg_catalog.pg_has_role(current_user, c.relowner, 'SET');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: the current session (%) can neither act as nor SET ROLE to the owner of %. GRANT requires ownership; on managed Supabase apply this as the identity that owns the baseline tables.',
      current_user, v_bad;
  END IF;

  -- 0.5b THE ONE TABLE THAT NEEDS SET ROLE. §4 spells `SET LOCAL ROLE
  --     uellix_owner` statically, so the precondition is stated statically too:
  --     if that door is shut the package refuses HERE, with the reason, rather
  --     than failing three hundred lines later inside a GRANT.
  IF pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = to_regclass('public.stella_interactions')))
       <> current_user
     AND NOT pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET') THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: public.stella_interactions is owned by uellix_owner and this session can neither act as it nor SET ROLE to it. stella_hosted_0001 grants that membership WITH INHERIT FALSE, SET TRUE; without it the governed-read half of this contract cannot be issued.';
  END IF;

  -- 0.6 SECURITY REFUSALS, evaluated BEFORE the prestate is classified. Any one
  --     of these describes a database somebody changed outside this repository.

  --     (a) No structural privilege anywhere in public, for any runtime role.
  --         Swept across the WHOLE schema, not only the 37: a widening on a
  --         table this package does not name is still a widening.
  SELECT string_agg(x.tbl || ' -> ' || x.role || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.role, x.priv)
    INTO v_bad
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, g.r AS role, p.priv AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS g(r)
    CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND has_table_privilege(g.r, c.oid, p.priv)
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: a runtime role already holds a STRUCTURAL privilege in schema public: %. No package in this repository grants TRUNCATE, REFERENCES, TRIGGER or MAINTAIN to uellix_writer, uellix_auditor or uellix_app. This package will not add privileges on top of a posture nobody explained.', v_bad;
  END IF;

  --     (b) No runtime role owns anything in public. Ownership outranks every
  --         grant this package could make or withhold.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relowner IN ('uellix_writer'::regrole, 'uellix_auditor'::regrole, 'uellix_app'::regrole);

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: a runtime role OWNS relation(s) % in schema public. An owner is not constrained by the grants this package issues, so the contract it would certify would not be the contract in force.', v_bad;
  END IF;

  --     (c) No UPDATE or DELETE on an append-only table, and none on the
  --         governed-read one. This is the append-only guarantee stated on the
  --         grant layer, where stella_0002/0002b state it on the trigger layer.
  SELECT string_agg(x.tbl || ' -> ' || x.role || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.role, x.priv)
    INTO v_bad
  FROM (
    SELECT t.tbl, g.r AS role, p.priv
    FROM (VALUES
      ('public.audit_logs'), ('public.sroi_calculation_line_items'),
      ('public.sroi_calculation_runs'), ('public.stella_interactions')
    ) AS t(tbl)
    CROSS JOIN (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS g(r)
    CROSS JOIN (VALUES ('UPDATE'), ('DELETE')) AS p(priv)
    WHERE has_table_privilege(g.r, t.tbl, p.priv)
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: a runtime role already holds UPDATE or DELETE on an append-only table: %. stella_0004 §6a grants SELECT and INSERT and never more, and stella_0017 withdrew even the INSERT on public.stella_interactions. Resolve this deliberately; this package does not normalise it away.', v_bad;
  END IF;

  --     (d) INSERT on the governed-read table, specifically. Separated from (c)
  --         because it is the R6-INT regression by name: an INSERT here means
  --         either stella_0017 was rolled back or something re-granted it.
  SELECT string_agg(g.r, ', ' ORDER BY g.r) INTO v_bad
  FROM (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS g(r)
  WHERE has_table_privilege(g.r, 'public.stella_interactions', 'INSERT');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: % already hold(s) INSERT on public.stella_interactions. stella_0017_governed_stella_consumption revoked exactly that from every runtime principal (R6-INT); the ledger is charged through uellix_stella_ops.complete_operation_ticket as uellix_cap_stella_quota. A database where the grant is back is one this package must not build on.', v_bad;
  END IF;

  --     (e) The two CAPABILITY_ONLY tables. grounding_0002 and grounding_0003
  --         revoke ALL from uellix_writer by name and grant SELECT to uellix_app
  --         DIRECTLY. This package grants nothing on them and refuses if the
  --         writer has somehow acquired something.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO v_bad
  FROM (
    SELECT t.tbl, p.priv
    FROM (VALUES ('public.evidence_chunks'), ('public.evidence_document_versions')) AS t(tbl)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
    WHERE to_regclass(t.tbl) IS NOT NULL
      AND has_table_privilege('uellix_writer', t.tbl, p.priv)
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: uellix_writer holds % on a capability-only table. grounding_0002_document_versions and grounding_0003_evidence_chunks revoke ALL from the writer by name and grant SELECT to uellix_app directly; the writer is not the route to those tables and this package does not make it one.', v_bad;
  END IF;

  --     (f) No DIRECT grant to uellix_app on a contract table. The runtime holds
  --         its privileges through the writer and nowhere else, so the audit
  --         surface stays one role's grants rather than 37 ACLs.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO v_bad
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, a.privilege_type AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
    aclexplode(c.relacl) a
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.grantee = 'uellix_app'::regrole
      AND c.relname NOT IN ('evidence_chunks', 'evidence_document_versions')
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: uellix_app holds a DIRECT table grant: %. stella_0004 §6 ends by revoking exactly this, so that one principal cannot hold one privilege by two routes with only one of them measured. The two grounding tables are the declared exception and are excluded from this check.', v_bad;
  END IF;

  -- 0.7 THE PRESTATE, classified across all 37 at once. A table is FULL when
  --     uellix_writer holds exactly its class, EMPTY when it holds none of the
  --     four DML privileges, and anything else makes the whole database
  --     UNEXPECTED — including a database where 36 are right and one is not.
  FOR r IN
    SELECT t.tbl, t.want,
           (CASE WHEN has_table_privilege('uellix_writer', t.tbl, 'SELECT') THEN 'S' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', t.tbl, 'INSERT') THEN 'I' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', t.tbl, 'UPDATE') THEN 'U' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', t.tbl, 'DELETE') THEN 'D' ELSE '' END) AS got
    FROM (VALUES
      ('public.audit_logs', 'SI'), ('public.sroi_calculation_line_items', 'SI'),
      ('public.sroi_calculation_runs', 'SI'),
      ('public.stella_interactions', 'S'),
      ('public.evidence_items', 'SIUD'), ('public.financial_proxies', 'SIUD'), ('public.funders', 'SIUD'),
      ('public.fx_rates', 'SIUD'), ('public.impact_narratives', 'SIUD'), ('public.indicators', 'SIUD'),
      ('public.invitations', 'SIUD'), ('public.marketing_leads', 'SIUD'), ('public.methodology_review_matrix', 'SIUD'),
      ('public.methodology_review_matrix_items', 'SIUD'), ('public.organization_members', 'SIUD'), ('public.organizations', 'SIUD'),
      ('public.outcome_funder_allocations', 'SIUD'), ('public.outcome_proxy_assignments', 'SIUD'), ('public.outcome_taxonomy_mappings', 'SIUD'),
      ('public.outcomes', 'SIUD'), ('public.portfolios', 'SIUD'), ('public.project_investments', 'SIUD'),
      ('public.projects', 'SIUD'), ('public.proxy_sources', 'SIUD'), ('public.signup_allowlist', 'SIUD'),
      ('public.sroi_assignment_inputs', 'SIUD'), ('public.sroi_filter_sets', 'SIUD'), ('public.sroi_report_sections', 'SIUD'),
      ('public.sroi_reports', 'SIUD'), ('public.sroi_run_review_items', 'SIUD'), ('public.sroi_run_reviews', 'SIUD'),
      ('public.stakeholder_groups', 'SIUD'), ('public.taxonomy_catalogs', 'SIUD'), ('public.taxonomy_codes', 'SIUD'),
      ('public.theory_of_change_links', 'SIUD'), ('public.theory_of_change_nodes', 'SIUD'), ('public.users', 'SIUD')
    ) AS t(tbl, want)
  LOOP
    v_total := v_total + 1;
    IF r.got = r.want THEN
      v_full := v_full + 1;
    ELSIF r.got = '' THEN
      v_empty := v_empty + 1;
    ELSE
      RAISE EXCEPTION 'stella_hosted_0007 aborted: % carries a privilege set this package cannot account for — uellix_writer holds "%" where the contract is "%". The only postures it knows are the pre-cutover one (no privilege at all) and the canonical one. Resolve it deliberately, then re-run.',
        r.tbl, r.got, r.want;
    END IF;
  END LOOP;

  IF v_full <> v_total AND v_empty <> v_total THEN
    RAISE EXCEPTION 'stella_hosted_0007 aborted: the 37 contract tables are in MIXED states (% canonical, % empty, of %). This package converges all of them together or none; a partial posture was produced by something outside this repository and must be explained before it is normalised.',
      v_full, v_empty, v_total;
  END IF;

  PERFORM set_config('stella_hosted_0007.prestate',
    CASE WHEN v_full = v_total THEN 'CANONICAL_RUNTIME_ACL' ELSE 'MISSING_RUNTIME_ACL' END, true);

  -- 0.8 CAPTURE, for §5 to compare against. Transaction-local.
  --     The ACL of every public table PROJECTED ONTO THE ROLES THIS PACKAGE DOES
  --     NOT NAME. uellix_writer and uellix_auditor are expected to move; nobody
  --     else is, and that is the claim worth measuring.
  PERFORM set_config('stella_hosted_0007.foreign_acl',
    (SELECT coalesce(string_agg(
        n.nspname || '.' || c.relname || '|' || a.grantee::regrole::text || '|' || a.privilege_type,
        E'\n' ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND a.grantee::regrole::text NOT IN ('uellix_writer', 'uellix_auditor')), true);

  PERFORM set_config('stella_hosted_0007.owners',
    (SELECT string_agg(c.relname || '|' || pg_catalog.pg_get_userbyid(c.relowner), E'\n' ORDER BY c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'), true);

  PERFORM set_config('stella_hosted_0007.policies',
    (SELECT coalesce(md5(string_agg(
        schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' ||
        permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' ||
        coalesce(with_check, ''), E'\n'
        ORDER BY schemaname, tablename, policyname)), '')
     FROM pg_policies), true);

  PERFORM set_config('stella_hosted_0007.roles',
    (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles), true);

  PERFORM set_config('stella_hosted_0007.rls',
    (SELECT coalesce(string_agg(c.relname || '|' || c.relrowsecurity::text || c.relforcerowsecurity::text,
        E'\n' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'), true);

  --     The functions the RUNTIME must never reach, restated on the hosted side
  --     exactly as stella_0004 §9.8 states it locally.
  PERFORM set_config('stella_hosted_0007.writers',
    (SELECT coalesce(string_agg(t.sig || '|' || t.r || '|' ||
        has_function_privilege(t.r, t.sig, 'EXECUTE')::text, E'\n' ORDER BY t.sig, t.r), '')
     FROM (VALUES
       ('public.handle_new_user()', 'uellix_app'),
       ('public.handle_new_user()', 'uellix_writer'),
       ('public.handle_update_user()', 'uellix_app'),
       ('public.handle_update_user()', 'uellix_writer')
     ) AS t(sig, r)
     WHERE to_regprocedure(t.sig) IS NOT NULL), true);

  RAISE NOTICE 'stella_hosted_0007: prestate = %', current_setting('stella_hosted_0007.prestate', true);
END $$;

-- ============================================================
-- 1. APPEND_ONLY — SELECT, INSERT. No UPDATE, no DELETE, ever.
-- ============================================================
-- stella_0004 §6a, minus public.stella_interactions (moved to §4 by
-- stella_0017) and minus public.stella_suggestion_decisions (conditional, §3).
-- The two SROI tables also need SELECT for their own INSERT ... RETURNING —
-- lib/pipeline/sroi-calculation.ts:970 and :1010 — which the class grants
-- anyway.
GRANT SELECT, INSERT ON
  public.audit_logs,
  public.sroi_calculation_line_items,
  public.sroi_calculation_runs
TO uellix_writer;

-- ============================================================
-- 2. OPERATIONAL — full DML, nothing structural.
-- ============================================================
-- stella_0004 §6b verbatim, all 33. No REVOKE accompanies it: §0.6 already
-- refused every posture a convergence REVOKE would have been for.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.evidence_items, public.financial_proxies, public.funders,
  public.fx_rates, public.impact_narratives, public.indicators,
  public.invitations, public.marketing_leads, public.methodology_review_matrix,
  public.methodology_review_matrix_items, public.organization_members, public.organizations,
  public.outcome_funder_allocations, public.outcome_proxy_assignments, public.outcome_taxonomy_mappings,
  public.outcomes, public.portfolios, public.project_investments,
  public.projects, public.proxy_sources, public.signup_allowlist,
  public.sroi_assignment_inputs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.taxonomy_catalogs, public.taxonomy_codes,
  public.theory_of_change_links, public.theory_of_change_nodes, public.users
TO uellix_writer;

-- ============================================================
-- 3. AUDITOR — SELECT, and nothing else.
-- ============================================================
-- stella_0004 §6c, over the 36 postgres-owned contract tables. The 37th is in
-- §4 with the writer's, because it needs the same SET ROLE.
GRANT SELECT ON
  public.audit_logs, public.evidence_items, public.financial_proxies,
  public.funders, public.fx_rates, public.impact_narratives,
  public.indicators, public.invitations, public.marketing_leads,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_members,
  public.organizations, public.outcome_funder_allocations, public.outcome_proxy_assignments,
  public.outcome_taxonomy_mappings, public.outcomes, public.portfolios,
  public.project_investments, public.projects, public.proxy_sources,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.taxonomy_catalogs, public.taxonomy_codes,
  public.theory_of_change_links, public.theory_of_change_nodes, public.users
TO uellix_auditor;

-- ============================================================
-- 4. GOVERNED_READ — the one table owned by uellix_owner
-- ============================================================
-- SELECT and NOTHING ELSE, for both roles. stella_0017 withdrew INSERT from
-- every runtime principal and the ledger is charged through the ticket
-- protocol; the runtime still READS its own history —
-- lib/projects/service.ts:183, lib/admin/stella-services.ts:41,
-- app/app/organization/billing/page.tsx:22.
--
-- Issued under SET LOCAL ROLE because postgres owns neither this table nor a
-- grant option on it. LOCAL: it is undone by the enclosing COMMIT or ROLLBACK
-- whatever happens, and §5 asserts the session came back.
SET LOCAL ROLE uellix_owner;

GRANT SELECT ON public.stella_interactions TO uellix_writer, uellix_auditor;

RESET ROLE;

-- ============================================================
-- 5. The conditional fifth append-only table
-- ============================================================
-- Present only where stella_0003_suggestion_decisions.sql has been applied,
-- which is no hosted environment today. A fixed literal, the construct
-- stella_0002b established for deferring PARSING rather than composing SQL:
-- nothing here is built from a value, and the statement is visible in full.
DO $$
BEGIN
  IF to_regclass('public.stella_suggestion_decisions') IS NULL THEN
    RAISE NOTICE 'stella_hosted_0007: public.stella_suggestion_decisions is ABSENT and that is the expected posture — no baseline unit creates it, it is not in db/hosted/hosted-package-manifest.ts, and its writer is gated behind STELLA_DECISIONS_PERSISTENCE_ENABLED (default false). Classification: PACKAGE_NOT_INSTALLED. Its append-only grant is deliberately NOT issued.';
  ELSE
    IF has_table_privilege('uellix_writer', 'public.stella_suggestion_decisions', 'UPDATE')
       OR has_table_privilege('uellix_writer', 'public.stella_suggestion_decisions', 'DELETE') THEN
      RAISE EXCEPTION 'stella_hosted_0007 aborted: uellix_writer holds UPDATE or DELETE on public.stella_suggestion_decisions, which stella_0004 §6a classifies append-only. This package will not add privileges on top of a widening nobody explained.';
    END IF;
    EXECUTE 'GRANT SELECT, INSERT ON public.stella_suggestion_decisions TO uellix_writer';
    EXECUTE 'GRANT SELECT ON public.stella_suggestion_decisions TO uellix_auditor';
    RAISE NOTICE 'stella_hosted_0007: public.stella_suggestion_decisions is PRESENT; the append-only pair was granted to uellix_writer and SELECT to uellix_auditor.';
  END IF;
END $$;

-- ============================================================
-- 6. Postconditions — the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  captured text;
  observed text;
  problem  text;
BEGIN
  -- (1) THE SESSION CAME BACK. §4 changed role; if it had not been given back,
  --     every measurement below would describe uellix_owner's privileges
  --     instead of the executor's, and the package would end leaving a
  --     transaction in a role nobody asked for.
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: the session is still acting as % rather than %. §4 issues RESET ROLE immediately after its single grant.',
      current_user, session_user;
  END IF;

  -- (2) THE CONTRACT, PER TABLE, EXACTLY. Not "at least": a table that gained a
  --     privilege its class does not carry fails here just as loudly as one
  --     that is missing one.
  SELECT string_agg(x.tbl || ' has "' || x.got || '" want "' || x.want || '"', ', ' ORDER BY x.tbl)
    INTO problem
  FROM (
    SELECT t.tbl, t.want,
           (CASE WHEN has_table_privilege('uellix_writer', t.tbl, 'SELECT') THEN 'S' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', t.tbl, 'INSERT') THEN 'I' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', t.tbl, 'UPDATE') THEN 'U' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', t.tbl, 'DELETE') THEN 'D' ELSE '' END) AS got
    FROM (VALUES
      ('public.audit_logs', 'SI'), ('public.sroi_calculation_line_items', 'SI'),
      ('public.sroi_calculation_runs', 'SI'),
      ('public.stella_interactions', 'S'),
      ('public.evidence_items', 'SIUD'), ('public.financial_proxies', 'SIUD'), ('public.funders', 'SIUD'),
      ('public.fx_rates', 'SIUD'), ('public.impact_narratives', 'SIUD'), ('public.indicators', 'SIUD'),
      ('public.invitations', 'SIUD'), ('public.marketing_leads', 'SIUD'), ('public.methodology_review_matrix', 'SIUD'),
      ('public.methodology_review_matrix_items', 'SIUD'), ('public.organization_members', 'SIUD'), ('public.organizations', 'SIUD'),
      ('public.outcome_funder_allocations', 'SIUD'), ('public.outcome_proxy_assignments', 'SIUD'), ('public.outcome_taxonomy_mappings', 'SIUD'),
      ('public.outcomes', 'SIUD'), ('public.portfolios', 'SIUD'), ('public.project_investments', 'SIUD'),
      ('public.projects', 'SIUD'), ('public.proxy_sources', 'SIUD'), ('public.signup_allowlist', 'SIUD'),
      ('public.sroi_assignment_inputs', 'SIUD'), ('public.sroi_filter_sets', 'SIUD'), ('public.sroi_report_sections', 'SIUD'),
      ('public.sroi_reports', 'SIUD'), ('public.sroi_run_review_items', 'SIUD'), ('public.sroi_run_reviews', 'SIUD'),
      ('public.stakeholder_groups', 'SIUD'), ('public.taxonomy_catalogs', 'SIUD'), ('public.taxonomy_codes', 'SIUD'),
      ('public.theory_of_change_links', 'SIUD'), ('public.theory_of_change_nodes', 'SIUD'), ('public.users', 'SIUD')
    ) AS t(tbl, want)
  ) x
  WHERE x.got <> x.want;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: the writer contract does not hold: %.', problem;
  END IF;

  -- (3) THE RUNTIME, SEPARATELY, AND BY INHERITANCE. The assertion that matters:
  --     it measures the EFFECTIVE privilege of uellix_app, so a database whose
  --     membership had been dropped fails here instead of shipping a contract
  --     that reaches nobody.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO problem
  FROM (
    SELECT t.tbl, p.priv
    FROM (VALUES
      ('public.users'), ('public.organizations'), ('public.organization_members'),
      ('public.projects'), ('public.evidence_items'), ('public.audit_logs')
    ) AS t(tbl)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT')) AS p(priv)
    WHERE NOT has_table_privilege('uellix_app', t.tbl, p.priv)
  ) x;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: uellix_app cannot reach %. The grant went to uellix_writer and the runtime inherits it; if this fails the membership is not doing what §0.3 measured.', problem;
  END IF;

  IF NOT has_table_privilege('uellix_app', 'public.users', 'UPDATE') THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: uellix_app cannot UPDATE public.users, so syncUserProfile''s INSERT ... ON CONFLICT DO UPDATE would still fail on the second login of every user.';
  END IF;

  IF has_table_privilege('uellix_app', 'public.stella_interactions', 'INSERT') THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: uellix_app can INSERT into public.stella_interactions. That is the R6-INT regression; the ledger is charged through the governed ticket protocol and this package grants SELECT on that table and nothing else.';
  END IF;

  -- (4) NOTHING STRUCTURAL, ANYWHERE IN public, FOR ANY RUNTIME ROLE.
  SELECT string_agg(x.tbl || ' -> ' || x.role || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.role, x.priv)
    INTO problem
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, g.r AS role, p.priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS g(r)
    CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND has_table_privilege(g.r, c.oid, p.priv)
  ) x;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: a runtime role holds a structural privilege: %. This package names SELECT, INSERT, UPDATE and DELETE and no other privilege.', problem;
  END IF;

  -- (5) THE AUDITOR READS AND DOES NOT WRITE.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO problem
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, p.priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND has_table_privilege('uellix_auditor', c.oid, p.priv)
  ) x;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: uellix_auditor holds a WRITE privilege: %. stella_0004 §6c grants SELECT and only SELECT.', problem;
  END IF;

  -- (6) NO DIRECT GRANT TO uellix_app, still.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO problem
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, a.privilege_type AS priv
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.grantee = 'uellix_app'::regrole
      AND c.relname NOT IN ('evidence_chunks', 'evidence_document_versions')
  ) x;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: uellix_app gained a DIRECT table grant: %. Every privilege it holds must arrive through uellix_writer.', problem;
  END IF;

  -- (7) THE CAPABILITY-ONLY TABLES ARE UNTOUCHED.
  IF (SELECT count(*) FROM (
        SELECT 1 FROM (VALUES ('public.evidence_chunks'), ('public.evidence_document_versions')) AS t(tbl)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
        WHERE to_regclass(t.tbl) IS NOT NULL
          AND has_table_privilege('uellix_writer', t.tbl, p.priv)) z) <> 0 THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: uellix_writer gained a privilege on a capability-only table. This package names neither of them in any GRANT.';
  END IF;

  -- (8) EVERY OTHER GRANTEE EXACTLY WHERE IT WAS. authenticated, anon, PUBLIC,
  --     postgres, service_role, uellix_app, uellix_migrator, uellix_owner and
  --     the capability roles, as a delta over EVERY table in public rather than
  --     a hand-picked canary list.
  captured := current_setting('stella_hosted_0007.foreign_acl', true);
  IF captured IS NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: §0 recorded no ACL projection, so "nothing else moved" cannot be evaluated. The blocks must run in ONE transaction — apply with psql -1.';
  END IF;

  SELECT coalesce(string_agg(
      n.nspname || '.' || c.relname || '|' || a.grantee::regrole::text || '|' || a.privilege_type,
      E'\n' ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type), '')
    INTO observed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND a.grantee::regrole::text NOT IN ('uellix_writer', 'uellix_auditor');

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: the ACL changed for a role other than uellix_writer and uellix_auditor. This package grants to those two and to nobody else, and revokes from no one.';
  END IF;

  -- (9) NO OWNER MOVED.
  captured := current_setting('stella_hosted_0007.owners', true);
  SELECT string_agg(c.relname || '|' || pg_catalog.pg_get_userbyid(c.relowner), E'\n' ORDER BY c.relname)
    INTO observed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: a table owner changed. This package issues no ALTER TABLE ... OWNER TO, and its SET LOCAL ROLE changes who GRANTS, never who owns.';
  END IF;

  -- (10) NO POLICY REWRITTEN, and RLS still enabled exactly where it was. A
  --      table privilege is only half the gate; if this package had disturbed
  --      the other half it would have widened far more than its ACL.
  captured := current_setting('stella_hosted_0007.policies', true);
  SELECT coalesce(md5(string_agg(
      schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' ||
      permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' ||
      coalesce(with_check, ''), E'\n'
      ORDER BY schemaname, tablename, policyname)), '')
    INTO observed
  FROM pg_policies;

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: a row-level security policy changed. This package creates, drops and replaces none.';
  END IF;

  captured := current_setting('stella_hosted_0007.rls', true);
  SELECT coalesce(string_agg(c.relname || '|' || c.relrowsecurity::text || c.relforcerowsecurity::text,
      E'\n' ORDER BY c.relname), '')
    INTO observed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: ROW LEVEL SECURITY was enabled or disabled on a table while this package ran. It issues no ALTER TABLE ... ROW LEVEL SECURITY.';
  END IF;

  -- (11) NO WRITE PATH THROUGH A FUNCTION — stella_0004 §9.8, hosted.
  captured := current_setting('stella_hosted_0007.writers', true);
  SELECT coalesce(string_agg(t.sig || '|' || t.r || '|' ||
      has_function_privilege(t.r, t.sig, 'EXECUTE')::text, E'\n' ORDER BY t.sig, t.r), '')
    INTO observed
  FROM (VALUES
    ('public.handle_new_user()', 'uellix_app'),
    ('public.handle_new_user()', 'uellix_writer'),
    ('public.handle_update_user()', 'uellix_app'),
    ('public.handle_update_user()', 'uellix_writer')
  ) AS t(sig, r)
  WHERE to_regprocedure(t.sig) IS NOT NULL;

  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: the runtime''s EXECUTE on handle_new_user/handle_update_user changed. This package names neither.';
  END IF;

  SELECT string_agg(t.sig || ' -> ' || t.r, ', ' ORDER BY t.sig, t.r) INTO problem
  FROM (VALUES
    ('public.handle_new_user()', 'uellix_app'),
    ('public.handle_new_user()', 'uellix_writer'),
    ('public.handle_update_user()', 'uellix_app'),
    ('public.handle_update_user()', 'uellix_writer')
  ) AS t(sig, r)
  WHERE to_regprocedure(t.sig) IS NOT NULL
    AND has_function_privilege(t.r, t.sig, 'EXECUTE');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: the runtime can execute %. No package in this repository grants that.', problem;
  END IF;

  -- (12) NO ROLE CREATED OR DROPPED, AND NO ATTRIBUTE GAINED.
  captured := current_setting('stella_hosted_0007.roles', true);
  SELECT string_agg(rolname, ',' ORDER BY rolname) INTO observed FROM pg_roles;
  IF observed IS DISTINCT FROM captured THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: the role set changed. This package issues no CREATE ROLE and no DROP ROLE.';
  END IF;

  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO problem
  FROM pg_roles
  WHERE rolname IN ('uellix_app', 'uellix_writer', 'uellix_auditor')
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication);

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0007 FAILED verification: runtime role(s) % carry a forbidden attribute. This package issues no ALTER ROLE.', problem;
  END IF;

  RAISE NOTICE 'stella_hosted_0007: verification passed — prestate %; uellix_writer holds SELECT+INSERT on 3 append-only tables, SELECT on public.stella_interactions, full DML on 33 operational tables and nothing structural anywhere; uellix_auditor reads all 37 and writes none; uellix_app reaches them by inheritance with no direct grant of its own; every other grantee, every owner, every policy, the RLS flags, the role set and the runtime''s (absent) EXECUTE on the two trigger functions are byte-identical to what this transaction opened with.',
    current_setting('stella_hosted_0007.prestate', true);
END $$;
