-- ============================================================================
-- stella_0021_current_schema_runtime_acl_contract.sql
-- The runtime ACL contract for the CURRENT schema, as one closed world.
-- ============================================================================
--
-- PREPARED ONLY — NOT A MIGRATION. FORWARD-ONLY: no rollback file, typed in
-- db/hosted/forward-only-packages.ts.
--
-- PRECHAIN ADMINISTRATIVE UNIT. NOT a member of HOSTED_CHAIN.
--
-- AUTHORITY. Every class, every member and every refusal below is frozen by
-- docs/ops/staging/CURRENT_SCHEMA_RUNTIME_ACL_SUCCESSOR_AUTHORITY_v1.0.0.json
-- (SECTION_2 the nineteen, SECTION_2B the amended legacy thirty-eight,
-- SECTION_3 the conditional and excluded members, SECTION_4 the role contract,
-- SECTION_5 the EXECUTE half, SECTION_7 the package itself, SECTION_8 the
-- frozen class privilege sets, SECTION_10 the closed world). Nothing here is
-- this author's judgement; where the authority and a convenient default
-- disagree, the authority wins and the package refuses.
--
-- ----------------------------------------------------------------------------
-- WHAT IS BROKEN, AND WHY stella_0004 CANNOT REPAIR IT
-- ----------------------------------------------------------------------------
-- stella_0004_role_separation.sql classifies THIRTY-EIGHT public tables and
-- grants the runtime its privileges on them. Since it was written, migrations
-- have added twenty more, and stella_0004's §0 allowlist is CLOSED by design —
-- "an unknown table must not silently receive operational grants", its own
-- line 227. So on the current schema it does not grant the missing twenty: it
-- REFUSES, at its section-0 unclassified-table precondition, and the runtime
-- receives
--
--     42501  permission denied for table <one of the nineteen>
--
-- on every one of them. It would also refuse on four further G2-prestate
-- counts it asserts (38 tables / 105 policies / 10 triggers / 8 functions;
-- the current build measures more of each). It is a package written FOR a
-- schema that no longer exists.
--
-- Editing it is forbidden and not merely discouraged: its sha256 is pinned in
-- tests/prepared-stella-sql.test.ts, tests/stella-r3-5-pg17-certification.ts
-- and db/r3-5-pg17-certification-inputs.ts, so a byte change breaks a
-- CERTIFIED PG17 engine certification rather than a unit test. The hosted path
-- reached the same conclusion and did the same thing: it published
-- stella_hosted_0006 (the EXECUTE half) and stella_hosted_0007 (the table
-- half) as forward-only prechain units and left stella_0004 byte-identical.
-- This package is the current-schema successor in that same shape.
--
-- ----------------------------------------------------------------------------
-- IT IS A CLOSED WORLD, WHICH IS THE WHOLE POINT
-- ----------------------------------------------------------------------------
-- The twenty-table gap existed because a migration could add a public table and
-- nothing turned red. So this package does not grant on "the tables it knows
-- about" and leave the rest unexamined. §0.7 sweeps EVERY relation in schema
-- public and refuses on any one that is neither a classified member, nor a
-- declared conditional member, nor a named exclusion. There is no default
-- class, no auto-SELECT and no "assume read-only". A new migration-created
-- table makes this package REFUSE until an authority classifies it.
--
--     U   every public table the governed sources create
--     C   the nine class arrays + the conditional member + the six exclusions
--
-- and the contract is U == C, each name exactly once. The DB-free twin of the
-- same claim is tests/database-runtime-acl-closed-world.test.ts, which derives
-- U from db/migrations/** and db/schema.ts and never from this file.
--
-- ----------------------------------------------------------------------------
-- THE CONTRACT, AS NINE CLASSES, ONE CONDITIONAL AND SIX EXCLUSIONS
-- ----------------------------------------------------------------------------
--   THE NINETEEN THAT WERE UNCLASSIFIED (authority SECTION_2)
--     APPEND_ONLY               SELECT, INSERT                    8 tables
--     OPERATIONAL_INSERT_UPDATE SELECT, INSERT, UPDATE            6 tables
--     READ_ONLY                 SELECT                            4 tables
--     NO_RUNTIME_ACCESS         nothing                           1 table
--
--   THE THIRTY-EIGHT, AT THEIR AMENDED END-STATE (authority SECTION_2B)
--     OPERATIONAL_legacy        SELECT, INSERT, UPDATE, DELETE   33 tables
--     APPEND_ONLY_legacy        SELECT, INSERT                    3 tables
--     GOVERNED_READ_legacy      SELECT                            1 table
--     CONDITIONAL_APPEND_ONLY   SELECT, INSERT (if present)       1 table
--
--   ADDED BY MIGRATION 0073 (authority SECTION_3)
--     NO_RUNTIME_ACCESS_CE3     nothing                           1 table
--
--   EXCLUDED, GRANTED NOTHING, POSTURE ASSERTED (authority SECTION_3)
--     evidence_document_versions, evidence_chunks, report_public_disclosures,
--     capability_verification_hits, stripe_webhook_events,
--     capability_bootstrap_attempts                               6 tables
--
--   ARITHMETIC, and it is checked in §0.8 rather than asserted here:
--     8 + 6 + 4 + 1 = 19      the previously unclassified
--     33 + 3 + 1 + 1 = 38     the legacy canon, amended
--     19 + 38 + 1 = 58        the whole closed world
--
--   uellix_auditor  SELECT on 55 of the 58 (56 with the conditional present),
--                   and NOTHING on the three NO_RUNTIME_ACCESS tables. A grant
--                   on a table whose RLS admits no row is an authorisation
--                   waiting for a policy, so it is refused by construction.
--   uellix_app      NO direct grant on ANY of them. It reaches every privilege
--                   through GRANT uellix_writer TO uellix_app WITH INHERIT
--                   TRUE (stella_0001:180). §10 revokes any direct grant it
--                   may have acquired, and §12 asserts the EFFECTIVE privilege
--                   rather than merely the grant.
--
-- ----------------------------------------------------------------------------
-- WHY OPERATIONAL_INSERT_UPDATE IS A NEW CLASS AND NOT "OPERATIONAL"
-- ----------------------------------------------------------------------------
-- Six current tables need UPDATE and do not need DELETE. Each carries a FOR
-- UPDATE policy in its creating migration AND at least one db.update() runtime
-- consumer; none carries a DELETE policy and none has a delete consumer. The
-- legacy OPERATIONAL class is SELECT+INSERT+UPDATE+DELETE, so folding the six
-- into it would grant DELETE to a runtime that never issues it — an
-- authorisation waiting for a verb. The class is therefore NEW, named for
-- exactly what it grants, and never aliased to OPERATIONAL.
--
-- NO CLASS OF THE NINETEEN CARRIES DELETE. That is measured, not stylistic:
-- zero DELETE policies and zero delete consumers exist for any of them.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS NOT stella_0004 §6 COPIED VERBATIM
-- ----------------------------------------------------------------------------
-- ONE package installed on a chain has narrowed that text, and copying the
-- canon unamended would REGRESS it:
--
--   stella_0017_governed_stella_consumption (HOSTED_CHAIN, INSTALLED) :290-299
--     REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions
--     FROM uellix_writer / uellix_app / uellix_reader / uellix_auditor.
--     stella_0004 §6a lists it append-only SELECT+INSERT; the amended contract
--     is SELECT and nothing else, and writes reach it only through the
--     stella_0017 SECURITY DEFINER capability. Granting INSERT here would
--     re-open a closed vulnerability and sell two units against a cap of one.
--     db/prepared-package-order.ts:224 already states the end state in words.
--
-- And exactly ONE table a reader will expect to see amended, and which is NOT:
--
--   public.marketing_leads STAYS OPERATIONAL (SELECT, INSERT, UPDATE, DELETE).
--     db/prepared/stella_0009_public_lead_capability.sql:265 WOULD revoke those
--     four IF IT WERE APPLIED. It is DESIGN and NOT INSTALLED — db/prepared/
--     README.md records Estado "DISEÑO — no aplicado", it is absent from
--     db/hosted/hosted-package-manifest.ts, absent from every chain in
--     db/prepared-package-order.ts, and absent from the AMENDMENTS table of
--     tests/hosted/prechain-ownership.test.ts. A REVOKE inside an unapplied
--     file is a no-op, and freezing the revoked posture would make this package
--     REJECT on every target where stella_hosted_0007 is applied, because §0.10
--     refuses a SUPERSET and the package would meet SIUD where its own contract
--     declared nothing. AMENDED means INSTALLED.
--
-- ----------------------------------------------------------------------------
-- IT CONVERGES DOWNWARD AND REFUSES UPWARD
-- ----------------------------------------------------------------------------
-- Every class is GRANT + a convergence REVOKE of exactly that class's forbidden
-- verbs, the §6a/§6b idiom of stella_0004. So a posture that is NARROWER than
-- the contract is widened to it, and a previously-wider posture produced by a
-- previous run of this same package is taken back.
--
-- A posture that is WIDER than the contract is NOT silently narrowed. §0.10
-- refuses it:
--
--     OVERPRIVILEGED PRESTATE — uellix_writer holds "SIUD" on <table> where
--     the contract is "SI".
--
-- The difference matters. A surplus this package did not create was put there
-- by something outside this repository; silently revoking it erases the
-- evidence, and silently keeping it ships a widening nobody reviewed. This is
-- stella_hosted_0006's "mixed posture" doctrine, applied per table.
--
-- ----------------------------------------------------------------------------
-- A TABLE PRIVILEGE IS NECESSARY AND NOT SUFFICIENT
-- ----------------------------------------------------------------------------
-- Evaluating a row-level-security policy requires the INVOKING role to hold
-- EXECUTE on every function the policy predicate calls, and almost every policy
-- in this schema calls public.current_user_org_ids() or
-- public.current_user_is_super_admin(). Without EXECUTE a SELECT by uellix_app
-- does not return zero rows — it fails outright with "permission denied for
-- function current_user_org_ids". So §11 carries the EXECUTE half ITSELF rather
-- than depending on a package that cannot run here: on the current-schema
-- local/CI build stella_0004 refuses and stella_hosted_0006 is hosted-family,
-- so the runtime holds NO EXECUTE on the three helpers today.
--
-- EXACTLY THREE SIGNATURES, TO EXACTLY TWO ROLES. The two functions that WRITE
-- (handle_new_user, handle_update_user), the two evidence-object helpers and
-- the mutation guard are deliberately excluded, which is what makes "no
-- indirect write path through a function" a checkable claim. §12 asserts the
-- exclusion by name, and asserts that PUBLIC holds no EXECUTE on the three —
-- acldefault('f') is EXECUTE TO PUBLIC for a new function, so that claim must
-- be made against the live catalog and not against "proacl IS NULL".
--
-- RLS REMAINS THE ROW BOUNDARY. This package creates, alters and drops no
-- policy, and enables, disables and forces row level security nowhere, so the
-- row-level answer for every principal is exactly what it was before it ran.
--
-- NOTHING STRUCTURAL, EVER. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN reach no
-- runtime role on any public table — asserted across ALL of schema public in
-- §0.9 and again in §12, not only across the 58 this package names. TRUNCATE is
-- not governed by RLS, which is why it is named rather than merely ungranted.
-- MAINTAIN is PG17+ and is named so a PG17 default cannot leak it.
--
-- NOTHING HERE IS COMPOSED. No CREATE, ALTER or DROP of any relation, column,
-- index, type, function or schema. No INSERT, UPDATE, DELETE or TRUNCATE of any
-- business row. No CREATE ROLE, no GRANT <role> TO <role>, no ALTER DEFAULT
-- PRIVILEGES, no schema privilege, no ALTER ... OWNER TO. Every grant names one
-- table and one closed verb set, as a fixed literal. The one deferred-PARSING
-- construct is the conditional member's fixed literal in §10, the form
-- stella_0002b established, and it composes nothing.
--
-- RUN AS ONE TRANSACTION, AS AN IDENTITY THAT CAN GRANT ON THE CONTRACT TABLES:
--   psql "$ADMIN_URL" -X -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- The -1 is a courtesy and not the safety net: §0 asserts the whole inventory
-- before touching anything and §12 asserts the end state, both with RAISE
-- EXCEPTION, so a forgotten flag still cannot leave a half-granted database.
--
-- IDEMPOTENT. Re-granting a held privilege changes nothing and the convergence
-- REVOKEs are already satisfied, so a second application over the canonical
-- posture is a no-op whose ACL is byte-identical afterwards. No project
-- reference appears in this file.
--
-- Source of truth: docs/adr/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions — the whole inventory, before anything moves
-- ============================================================
DO $$
DECLARE
  -- The nineteen that stella_0004 never classified (authority SECTION_2).
  append_only            text[] := ARRAY[
    'account_legal_acceptances','assumption_object_links','domain_object_versions',
    'evidence_sufficiency_determinations','evidence_tombstones',
    'organization_commercial_acceptances','readiness_assessments','sensitivity_scenarios'
  ];
  operational_iu         text[] := ARRAY[
    'counterfactual_assessments','evidence_versions','financial_proxy_versions',
    'methodological_assumptions','outcome_monetization_dispositions','sensitivity_candidates'
  ];
  read_only              text[] := ARRAY[
    'governed_model_registry','legal_instrument_versions','legal_instruments',
    'proxy_material_fields_registry'
  ];
  no_runtime_access      text[] := ARRAY['commercial_accounts'];

  -- The thirty-eight, at their AMENDED end-state (authority SECTION_2B).
  operational_legacy     text[] := ARRAY[
    'evidence_items','financial_proxies','funders','fx_rates','impact_narratives',
    'indicators','invitations','marketing_leads','methodology_review_matrix',
    'methodology_review_matrix_items','organization_members','organizations',
    'outcome_funder_allocations','outcome_proxy_assignments','outcome_taxonomy_mappings',
    'outcomes','portfolios','project_investments','projects','proxy_sources',
    'signup_allowlist','sroi_assignment_inputs','sroi_filter_sets','sroi_report_sections',
    'sroi_reports','sroi_run_review_items','sroi_run_reviews','stakeholder_groups',
    'taxonomy_catalogs','taxonomy_codes','theory_of_change_links','theory_of_change_nodes',
    'users'
  ];
  append_only_legacy     text[] := ARRAY[
    'audit_logs','sroi_calculation_line_items','sroi_calculation_runs'
  ];
  governed_read_legacy   text[] := ARRAY['stella_interactions'];
  conditional_append_only text[] := ARRAY['stella_suggestion_decisions'];

  -- Added by db/migrations/0073 (authority SECTION_3).
  no_runtime_access_ce3  text[] := ARRAY['entitlement_grants'];

  -- Prepared-chain-created public tables that are NOT members of the closed
  -- world. This package grants NOTHING on them and asserts their posture.
  capability_only        text[] := ARRAY[
    'capability_bootstrap_attempts','capability_verification_hits','evidence_chunks',
    'evidence_document_versions','report_public_disclosures','stripe_webhook_events'
  ];

  -- The tables that MUST exist. The conditional member is excluded by name.
  mandatory_tables       text[] := append_only || operational_iu || read_only
                                   || no_runtime_access || operational_legacy
                                   || append_only_legacy || governed_read_legacy
                                   || no_runtime_access_ce3;
  -- The closed world: every name this contract accounts for.
  classified_tables      text[] := mandatory_tables || conditional_append_only;
  -- Everything the sweep in §0.7 is allowed to find.
  accounted_tables       text[] := classified_tables || capability_only;

  helper_signatures      text[] := ARRAY[
    'public.current_user_org_ids()',
    'public.current_user_is_super_admin()',
    'public.current_user_role_in_org(uuid)'
  ];

  v_missing text;
  v_bad     text;
  v_dupe    text;
  r         record;
BEGIN
  -- 0.1 POSTGRESQL 17. MAINTAIN is a PG17 privilege, §0.9 asks for it by name
  --     and every convergence REVOKE below names it, so the floor is STATED
  --     rather than assumed. On an older server this raises here, before any
  --     statement that could not be parsed is ever reached.
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'stella_0021 aborted: PostgreSQL 17 or newer is required; this server reports %. MAINTAIN is a PG17 privilege and this package both revokes and asserts it by name.',
      current_setting('server_version');
  END IF;

  -- 0.2 THE THREE RUNTIME ROLES EXIST. Named, never discovered.
  SELECT string_agg(t.r, ', ' ORDER BY t.r) INTO v_missing
  FROM (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS t(r)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t.r);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: runtime role(s) % do not exist. Apply db/prepared/stella_0001_role_topology_bootstrap.sql (local/CI, after stella_local_0000) or stella_hosted_0001_managed_role_bootstrap.sql (hosted) first. This package creates no role.', v_missing;
  END IF;

  -- 0.3 THE INHERITANCE THIS PACKAGE RELIES ON, asserted and NOT created.
  --     Granting to the writer while uellix_app cannot inherit from it would
  --     satisfy every check about the writer and leave the product exactly as
  --     dead as it is now.
  IF NOT pg_catalog.pg_has_role('uellix_app', 'uellix_writer', 'USAGE') THEN
    RAISE EXCEPTION 'stella_0021 aborted: uellix_app is not an inheriting member of uellix_writer, so a grant to the writer would never reach the runtime. That membership is issued by stella_0001 §180 (GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE, ADMIN FALSE); this package asserts it and will not stand in for it.';
  END IF;

  --     ASSERTED ON THE MEMBERSHIP, NOT ON THE ROLE ATTRIBUTE, and the
  --     difference is measured rather than stylistic. stella_0001:81 creates
  --     uellix_app NOINHERIT, so pg_roles.rolinherit is FALSE on a correctly
  --     configured database; the inheritance comes from :180's GRANT
  --     uellix_writer TO uellix_app WITH INHERIT TRUE, which since PostgreSQL
  --     16 stores a PER-MEMBERSHIP inherit_option in pg_auth_members that
  --     overrides the role-level attribute for that one grant. MEASURED on the
  --     pinned disposable substrate: rolinherit = false AND
  --     pg_has_role('uellix_app','uellix_writer','USAGE') = true, together.
  --     A check written against rolinherit would therefore REFUSE the exact
  --     topology this package requires — so the membership is what is asserted,
  --     and the role attribute is deliberately not.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.member = 'uellix_app'::regrole
      AND m.roleid = 'uellix_writer'::regrole
      AND m.inherit_option
  ) THEN
    RAISE EXCEPTION 'stella_0021 aborted: uellix_app''s membership in uellix_writer does not carry INHERIT, so the grant confers no privilege without an explicit SET ROLE the runtime never issues. stella_0001:180 issues it as WITH INHERIT TRUE, SET FALSE; note that uellix_app is NOINHERIT at the ROLE level by design, so the membership option is the only thing that makes the contract reach the runtime.';
  END IF;

  -- 0.4 NO SUPERUSER, NO BYPASSRLS, on any of the three. A role that bypasses
  --     RLS makes every row-level claim in this schema unmeasurable, and every
  --     negative control that passes against it passes vacuously.
  SELECT string_agg(rolname || CASE WHEN rolsuper THEN ' (SUPERUSER)' ELSE '' END
                             || CASE WHEN rolbypassrls THEN ' (BYPASSRLS)' ELSE '' END,
                    ', ' ORDER BY rolname) INTO v_bad
  FROM pg_roles
  WHERE rolname IN ('uellix_writer', 'uellix_auditor', 'uellix_app')
    AND (rolsuper OR rolbypassrls);

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: runtime role(s) % hold SUPERUSER or BYPASSRLS. stella_0001:81-83 creates all three NOSUPERUSER NOBYPASSRLS; a database where that is no longer true is one where the grants this package issues are not what constrains the runtime.', v_bad;
  END IF;

  -- 0.5 THE THREE RLS HELPERS EXIST AND ARE SECURITY DEFINER. §11 grants
  --     EXECUTE on exactly these; a missing one means the policy layer this
  --     package's grants are meant to serve cannot be evaluated at all, and a
  --     NON-definer one means the grant would buy a different thing than the
  --     contract says.
  SELECT string_agg(t.sig, ', ' ORDER BY t.sig) INTO v_missing
  FROM unnest(helper_signatures) AS t(sig)
  WHERE to_regprocedure(t.sig) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: RLS helper(s) % do not exist. They are baseline objects, created by db/migrations/0031_rls_core.sql; apply the baseline units first. This package creates no function.', v_missing;
  END IF;

  SELECT string_agg(t.sig, ', ' ORDER BY t.sig) INTO v_bad
  FROM unnest(helper_signatures) AS t(sig)
  JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
  WHERE NOT p.prosecdef;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: RLS helper(s) % are not SECURITY DEFINER. Every policy predicate in this schema calls them as the invoking runtime role; an INVOKER-rights helper would read the catalog as uellix_app and answer differently, so the EXECUTE grant §11 issues would not buy the contract this package certifies.', v_bad;
  END IF;

  -- 0.6 EVERY MANDATORY CONTRACT TABLE EXISTS. Named, never discovered: a
  --     package that granted on whatever it happened to find would have no
  --     contract. public.stella_suggestion_decisions is deliberately NOT in
  --     this list — it is the declared conditional member, §10.
  SELECT string_agg('public.' || t.tbl, ', ' ORDER BY t.tbl) INTO v_missing
  FROM unnest(mandatory_tables) AS t(tbl)
  WHERE to_regclass('public.' || t.tbl) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: contract table(s) % do not exist. All fifty-seven are created by db/migrations/** and are baseline objects — including public.entitlement_grants, created by db/migrations/0073_commercial_account_ce3_entitlement_grants.sql, whose merge is a hard precondition of this package (authority SECTION_11). Apply the baseline units first.', v_missing;
  END IF;

  -- 0.7 THE CLOSED WORLD. Swept across schema public, and this is the check the
  --     twenty-table gap existed for: a relation that is neither classified,
  --     nor the declared conditional member, nor a named exclusion REFUSES.
  --     There is no default class and no auto-SELECT.
  SELECT string_agg('public.' || c.relname, ', ' ORDER BY c.relname) INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT (c.relname = ANY (accounted_tables));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: UNCLASSIFIED public relation(s) %. This package is a CLOSED WORLD over every table in schema public: a relation it cannot name is one no authority has assigned a privilege class, and the default for an unknown relation is REFUSE, never SELECT. Classify it in docs/ops/staging/CURRENT_SCHEMA_RUNTIME_ACL_SUCCESSOR_AUTHORITY_v1.0.0.json and publish a successor; do not widen this file.', v_bad;
  END IF;

  -- 0.7b NO UNEXPECTED NON-TABLE RELKIND. This contract classifies no view,
  --      materialised view, sequence or foreign table, so ANY of them refuses.
  --      stella_0004:449 states the same sweep for the schema it certified.
  -- relkind is pg_catalog."char", not text, and `text || "char"` is an
  -- AMBIGUOUS operator rather than a coercion — measured, it aborts the whole
  -- package with 42725 "operator is not unique". The cast is explicit.
  SELECT string_agg('public.' || c.relname || ' (relkind ' || c.relkind::text || ')', ', ' ORDER BY c.relname)
    INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind NOT IN ('r', 'p', 'i', 'I', 'c', 't');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: schema public holds relation(s) % of a kind this contract does not classify. The governed sources create no view, materialised view, sequence or foreign table in public, so one that exists was produced by something outside this repository and its privilege posture has never been adjudicated. A future authority may add a classified list; this package refuses rather than ignoring it.', v_bad;
  END IF;

  -- 0.8 CLASSIFICATION INTEGRITY, stated from the CONTRACT side. Every name in
  --     exactly one class array: a duplicate is two contracts for one table and
  --     a phantom is a class member no source creates. The stella_0004 §0 idiom.
  SELECT string_agg(x.relname, ', ' ORDER BY x.relname) INTO v_dupe
  FROM (
    SELECT t.relname FROM unnest(classified_tables) AS t(relname)
    GROUP BY t.relname HAVING count(*) > 1
  ) x;

  IF v_dupe IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: table(s) % appear in more than one privilege class. A table has exactly one class or the contract does not say what the runtime may do to it.', v_dupe;
  END IF;

  IF array_length(classified_tables, 1) <> 58 THEN
    RAISE EXCEPTION 'stella_0021 aborted: the class arrays hold % names where the frozen closed world is 58 (19 previously-unclassified + 38 legacy + 1 from migration 0073). An arithmetic that no longer reproduces means a class array was edited without an authority that says so.',
      array_length(classified_tables, 1);
  END IF;

  IF array_length(append_only, 1) + array_length(operational_iu, 1)
     + array_length(read_only, 1) + array_length(no_runtime_access, 1) <> 19
     OR array_length(operational_legacy, 1) + array_length(append_only_legacy, 1)
        + array_length(governed_read_legacy, 1) + array_length(conditional_append_only, 1) <> 38 THEN
    RAISE EXCEPTION 'stella_0021 aborted: the class arithmetic does not reproduce. Authority SECTION_2 freezes 8 + 6 + 4 + 1 = 19 and SECTION_2B freezes 33 + 3 + 1 + 1 = 38; this file measures % and %.',
      array_length(append_only, 1) + array_length(operational_iu, 1)
        + array_length(read_only, 1) + array_length(no_runtime_access, 1),
      array_length(operational_legacy, 1) + array_length(append_only_legacy, 1)
        + array_length(governed_read_legacy, 1) + array_length(conditional_append_only, 1);
  END IF;

  -- 0.9 SECURITY REFUSALS, evaluated BEFORE any prestate is accepted. Each one
  --     describes a database somebody changed outside this repository.

  --     (a) No STRUCTURAL privilege anywhere in public, for any runtime role.
  --         Swept across the WHOLE schema, not only the 58: a widening on a
  --         table this package does not name is still a widening.
  SELECT string_agg(x.tbl || ' -> ' || x.role || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.role, x.priv)
    INTO v_bad
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, g.r AS role, p.priv AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS g(r)
    CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND has_table_privilege(g.r, c.oid, p.priv)
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: a runtime role already holds a STRUCTURAL privilege in schema public: %. No package in this repository grants TRUNCATE, REFERENCES, TRIGGER or MAINTAIN to uellix_writer, uellix_auditor or uellix_app, and TRUNCATE in particular is not governed by RLS. This package will not add privileges on top of a posture nobody explained.', v_bad;
  END IF;

  --     (b) No runtime role OWNS anything in public. Ownership outranks every
  --         grant this package could make or withhold.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relowner IN ('uellix_writer'::regrole, 'uellix_auditor'::regrole, 'uellix_app'::regrole);

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: a runtime role OWNS relation(s) % in schema public. An owner is not constrained by the grants this package issues, so the contract it would certify would not be the contract in force.', v_bad;
  END IF;

  --     (c) The six CAPABILITY-ONLY tables. Their creating packages revoke ALL
  --         from uellix_writer by name; this package grants nothing on them and
  --         refuses if the writer has somehow acquired something.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO v_bad
  FROM (
    SELECT 'public.' || t.tbl AS tbl, p.priv
    FROM unnest(capability_only) AS t(tbl)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
    WHERE to_regclass('public.' || t.tbl) IS NOT NULL
      -- public.report_public_disclosures is the ONE declared exception:
      -- stella_0007:414 grants it SELECT to uellix_writer. It is admitted by
      -- VERB rather than dropped from the sweep, so an INSERT, UPDATE or
      -- DELETE on it still refuses here. Excluding the whole table would have
      -- made the one capability table a runtime CAN read the one this check
      -- could never speak about.
      AND NOT (t.tbl = 'report_public_disclosures' AND p.priv = 'SELECT')
      AND has_table_privilege('uellix_writer', 'public.' || t.tbl, p.priv)
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: uellix_writer holds % on a capability-only table. grounding_0002:513-515, grounding_0003:625-627, stella_0007:411-412, stella_0008:304 and stella_0010:271 revoke ALL from the writer by name; the writer is not the route to those tables and this package does not make it one. (public.report_public_disclosures is the one declared exception — stella_0007:414 grants it SELECT to uellix_writer — and is excluded from this check by name.)', v_bad;
  END IF;

  --     (d) No DIRECT grant to uellix_app on a table of the closed world. The
  --         runtime holds its privileges through the writer and nowhere else,
  --         so the audit surface stays one role's grants rather than 58 ACLs.
  --         The grounding pair's direct app SELECT is that capability's own
  --         contract and is excluded by name.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO v_bad
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, a.privilege_type AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
    aclexplode(c.relacl) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND a.grantee = 'uellix_app'::regrole
      AND c.relname NOT IN ('evidence_chunks', 'evidence_document_versions')
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: uellix_app holds a DIRECT table grant: %. stella_0004 §6 ends by revoking exactly this, so that one principal cannot hold one privilege by two routes with only one of them measured. The two grounding tables are the declared exception and are excluded from this check.', v_bad;
  END IF;

  -- 0.10 THE PRESTATE, PER TABLE. EMPTY or a SUBSET of the class converges; a
  --      SUPERSET is an OVERPRIVILEGED PRESTATE and REFUSES. A surplus this
  --      package did not create was produced by something outside this
  --      repository: silently revoking it erases the evidence, and silently
  --      keeping it ships a widening nobody reviewed.
  FOR r IN
    SELECT t.tbl, t.want,
           (CASE WHEN has_table_privilege('uellix_writer', 'public.' || t.tbl, 'SELECT') THEN 'S' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', 'public.' || t.tbl, 'INSERT') THEN 'I' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', 'public.' || t.tbl, 'UPDATE') THEN 'U' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', 'public.' || t.tbl, 'DELETE') THEN 'D' ELSE '' END) AS got
    FROM (
      SELECT unnest(append_only)             AS tbl, 'SI'   AS want
      UNION ALL SELECT unnest(append_only_legacy),      'SI'
      UNION ALL SELECT unnest(operational_iu),          'SIU'
      UNION ALL SELECT unnest(read_only),               'S'
      UNION ALL SELECT unnest(governed_read_legacy),    'S'
      UNION ALL SELECT unnest(operational_legacy),      'SIUD'
      UNION ALL SELECT unnest(no_runtime_access),       ''
      UNION ALL SELECT unnest(no_runtime_access_ce3),   ''
    ) AS t(tbl, want)
    WHERE to_regclass('public.' || t.tbl) IS NOT NULL
  LOOP
    -- A SUBSET converges; a verb the class does not carry does not. Each arm is
    -- parenthesised rather than left to AND/OR precedence: the grouping is the
    -- whole meaning of this check, and a reader should not have to derive it.
    IF (strpos(r.want, 'S') = 0 AND strpos(r.got, 'S') > 0)
       OR (strpos(r.want, 'I') = 0 AND strpos(r.got, 'I') > 0)
       OR (strpos(r.want, 'U') = 0 AND strpos(r.got, 'U') > 0)
       OR (strpos(r.want, 'D') = 0 AND strpos(r.got, 'D') > 0) THEN
      RAISE EXCEPTION 'stella_0021 aborted: OVERPRIVILEGED PRESTATE — uellix_writer holds "%" on public.% where the contract is "%". A privilege this package does not grant was put there by something outside this repository. It is REFUSED rather than silently narrowed, so the surplus survives to be explained; resolve it deliberately, then re-run.',
        r.got, r.tbl, CASE WHEN r.want = '' THEN '(nothing)' ELSE r.want END;
    END IF;
  END LOOP;

  -- 0.11 THE AUDITOR'S PRESTATE. SELECT where the contract says SELECT, and
  --      NOTHING on the three NO_RUNTIME_ACCESS tables. Any write privilege
  --      anywhere is a superset and refuses on the same doctrine.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO v_bad
  FROM (
    SELECT 'public.' || t.tbl AS tbl, p.priv
    FROM unnest(classified_tables) AS t(tbl)
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
    WHERE to_regclass('public.' || t.tbl) IS NOT NULL
      AND has_table_privilege('uellix_auditor', 'public.' || t.tbl, p.priv)
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: OVERPRIVILEGED PRESTATE — uellix_auditor holds write privilege(s) %. stella_0001:84 sets default_transaction_read_only on that role, but a session default is not a grant; the auditor is SELECT-only on the grant layer too and this package refuses to build on a database where it is not.', v_bad;
  END IF;

  SELECT string_agg('public.' || t.tbl, ', ' ORDER BY t.tbl) INTO v_bad
  FROM (
    SELECT unnest(no_runtime_access) AS tbl
    UNION ALL SELECT unnest(no_runtime_access_ce3)
  ) AS t(tbl)
  WHERE to_regclass('public.' || t.tbl) IS NOT NULL
    AND has_table_privilege('uellix_auditor', 'public.' || t.tbl, 'SELECT');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: OVERPRIVILEGED PRESTATE — uellix_auditor holds SELECT on NO_RUNTIME_ACCESS table(s) %. public.commercial_accounts carries FORCE ROW LEVEL SECURITY and zero policies, and public.entitlement_grants is reachable only through the CE-3 SECURITY DEFINER evaluator (CE-3 SC-13). A grant on a table whose RLS admits no row is an authorisation waiting for a policy.', v_bad;
  END IF;

  -- 0.12 THE EXECUTOR CAN ACTUALLY GRANT. Ownership, or membership in the
  --      owner. Checked PER TABLE rather than inferred from "apply as the
  --      admin", because a package that discovered a second owner halfway
  --      through would have granted fifty-seven of fifty-eight.
  SELECT string_agg('public.' || t.tbl || ' (owned by ' || pg_catalog.pg_get_userbyid(c.relowner) || ')', ', ' ORDER BY t.tbl)
    INTO v_bad
  FROM unnest(classified_tables) AS t(tbl)
  JOIN pg_class c ON c.oid = to_regclass('public.' || t.tbl)
  WHERE NOT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
    AND NOT pg_catalog.pg_has_role(current_user, c.relowner, 'SET');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 aborted: the current session (%) can neither act as nor SET ROLE to the owner of %. GRANT requires ownership or a grant option; apply this as the identity that owns the baseline tables. This package issues no ALTER ... OWNER TO and takes no durable role change to work around it.',
      current_user, v_bad;
  END IF;

  -- 0.13 CAPTURE, for §12 to compare against. Transaction-local. The ACL of
  --      every public table PROJECTED ONTO THE ROLES THIS PACKAGE DOES NOT
  --      NAME: uellix_writer and uellix_auditor are expected to move, nobody
  --      else is, and that is the claim worth measuring.
  PERFORM set_config('stella_0021.foreign_acl',
    (SELECT coalesce(string_agg(
        n.nspname || '.' || c.relname || '|' || a.grantee::regrole::text || '|' || a.privilege_type,
        E'\n' ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND a.grantee::regrole::text NOT IN ('uellix_writer', 'uellix_auditor')), true);

  PERFORM set_config('stella_0021.owners',
    (SELECT string_agg(c.relname || '|' || pg_catalog.pg_get_userbyid(c.relowner), E'\n' ORDER BY c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')), true);

  PERFORM set_config('stella_0021.policies',
    (SELECT coalesce(md5(string_agg(
        schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' ||
        permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' ||
        coalesce(with_check, ''), E'\n'
        ORDER BY schemaname, tablename, policyname)), '')
     FROM pg_policies), true);

  PERFORM set_config('stella_0021.rls',
    (SELECT coalesce(string_agg(c.relname || '|' || c.relrowsecurity::text || c.relforcerowsecurity::text,
        E'\n' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')), true);

  PERFORM set_config('stella_0021.roles',
    (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles), true);

  --      The six EXCLUDED tables, captured in FULL — every grantee including
  --      uellix_writer and uellix_auditor, which the projection above drops by
  --      design. They are the tables this package must leave byte-identical,
  --      so they are the one place where the writer's own ACL is the claim.
  PERFORM set_config('stella_0021.capability_acl',
    (SELECT coalesce(string_agg(
        c.relname || '|' || a.grantee::regrole::text || '|' || a.privilege_type,
        E'\n' ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND c.relname = ANY (capability_only)), true);

  RAISE NOTICE 'stella_0021: preconditions satisfied over % classified tables (58 frozen), % capability-only exclusions.',
    array_length(classified_tables, 1), array_length(capability_only, 1);
END $$;

-- ============================================================
-- 1. APPEND_ONLY — SELECT, INSERT. No UPDATE, no DELETE, ever.
-- ============================================================
-- Authority SECTION_2 APPEND_ONLY, the eight of the nineteen whose creating
-- migration installs SELECT and INSERT policies and nothing else, and whose
-- only runtime consumers insert. None carries a DELETE policy and none has a
-- delete consumer, so a DELETE grant would be an authorisation waiting for a
-- verb nobody issues.
GRANT SELECT, INSERT ON
  public.account_legal_acceptances,
  public.assumption_object_links,
  public.domain_object_versions,
  public.evidence_sufficiency_determinations,
  public.evidence_tombstones,
  public.organization_commercial_acceptances,
  public.readiness_assessments,
  public.sensitivity_scenarios
TO uellix_writer;

-- Convergence: if a previous run of this package widened these, take it back.
-- A widening this package did NOT create was already refused in §0.10.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.account_legal_acceptances,
  public.assumption_object_links,
  public.domain_object_versions,
  public.evidence_sufficiency_determinations,
  public.evidence_tombstones,
  public.organization_commercial_acceptances,
  public.readiness_assessments,
  public.sensitivity_scenarios
FROM uellix_writer;

-- ============================================================
-- 2. OPERATIONAL_INSERT_UPDATE — SELECT, INSERT, UPDATE. Never DELETE.
-- ============================================================
-- Authority SECTION_8: a DELIBERATE NEW CLASS, never aliased to OPERATIONAL.
-- Each of the six carries a FOR UPDATE policy in its creating migration AND at
-- least one db.update() runtime consumer; none carries a DELETE policy and none
-- has a delete consumer. The verb set is measured from two layers written
-- independently — policy authors and service authors — not inferred from a name.
GRANT SELECT, INSERT, UPDATE ON
  public.counterfactual_assessments,
  public.evidence_versions,
  public.financial_proxy_versions,
  public.methodological_assumptions,
  public.outcome_monetization_dispositions,
  public.sensitivity_candidates
TO uellix_writer;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.counterfactual_assessments,
  public.evidence_versions,
  public.financial_proxy_versions,
  public.methodological_assumptions,
  public.outcome_monetization_dispositions,
  public.sensitivity_candidates
FROM uellix_writer;

-- ============================================================
-- 3. READ_ONLY — SELECT. The runtime reads these and never writes them.
-- ============================================================
-- Authority SECTION_2 READ_ONLY. The two registries are SEEDED by migrations
-- under the migrator identity and never by the runtime; the two legal-instrument
-- tables carry a SELECT policy and nothing else.
--
-- RECORDED, so a later refusal is not mistaken for a defect (authority F-ACL-1):
-- lib/pipeline/governed-model-registry.ts:96 EXPORTS an insert function, and it
-- has ZERO non-test call sites. If a future request path ever invokes it as
-- uellix_app it will fail with 42501 BY DESIGN — registry versioning is a
-- governed administrative act (FIBC-003), not a runtime writer act. Widening
-- this class is a separate authority act, never an inference from a call site.
GRANT SELECT ON
  public.governed_model_registry,
  public.legal_instrument_versions,
  public.legal_instruments,
  public.proxy_material_fields_registry
TO uellix_writer;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.governed_model_registry,
  public.legal_instrument_versions,
  public.legal_instruments,
  public.proxy_material_fields_registry
FROM uellix_writer;

-- ============================================================
-- 4. NO_RUNTIME_ACCESS — nothing, for anyone, and the REVOKE says so
-- ============================================================
-- public.commercial_accounts (authority SECTION_2): ENABLE + FORCE ROW LEVEL
-- SECURITY with ZERO policies, and zero references to the commercialAccounts
-- symbol in any non-test file. tests/postgres/ce1-commercial-account.pg.test.ts
-- PG-3 already asserts uellix_app is denied every verb on it; this package
-- leaves that posture byte-identical and asserts it, and never grants on it.
--
-- public.entitlement_grants (authority SECTION_3): reachable ONLY through the
-- CE-3 governed SECURITY DEFINER evaluator, owned by uellix_owner with
-- rolbypassrls false, under a single narrow policy. CE-3 SC-13: "No policy,
-- grant or role created by CE-3 may confer membership, a role, or any tenant
-- read beyond entitlement_grants itself." This package touches no EXECUTE on
-- that evaluator — that contract belongs to CE-3 and stella_hosted_0009 — and
-- issues no grant here. The statement below is a NEGATIVE-space assertion that
-- is exactly CE-3's own requirement.
--
-- There is no GRANT in this section. The REVOKE is the whole contract, and it
-- converges a database where a previous run of this package, or a platform
-- default, left something behind.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.commercial_accounts,
  public.entitlement_grants
FROM uellix_writer, uellix_auditor, uellix_app;

-- ============================================================
-- 5. OPERATIONAL_legacy — SELECT, INSERT, UPDATE, DELETE. 33 tables.
-- ============================================================
-- stella_0004 §6b (:668-680) at its AMENDED end-state, which for these
-- thirty-three is the unamended one: NO package installed on any chain narrows
-- a single member. stella_hosted_0007 re-asserts the identical thirty-three-name
-- set as SIUD both pre-apply (:413-423) and post-apply (:621-631).
--
-- public.marketing_leads IS A MEMBER, and that is the substance of the
-- authority's R2 material correction. stella_0009:265 would revoke these four
-- IF IT WERE APPLIED; it is DESIGN and NOT INSTALLED, and a REVOKE inside an
-- unapplied file is a no-op. Freezing the revoked posture would falsify the
-- derivation AND make this package refuse at §0.10 on every target where
-- stella_hosted_0007 is applied.
--
-- This is the ONLY class that carries DELETE, inherited verbatim for tables
-- that already hold it. It is NOT extended to any of the nineteen.
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

REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
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
FROM uellix_writer;

-- ============================================================
-- 6. APPEND_ONLY_legacy — SELECT, INSERT. 3 tables.
-- ============================================================
-- stella_0004 §6a (:650-656) names five. public.stella_interactions moved to
-- GOVERNED_READ by stella_0017 (§7) and public.stella_suggestion_decisions is
-- the conditional member (§10); these three are what remains.
--
-- The two SROI tables need SELECT for their own INSERT ... RETURNING —
-- lib/pipeline/sroi-calculation.ts:970 and :1010 — which the class grants anyway.
GRANT SELECT, INSERT ON
  public.audit_logs,
  public.sroi_calculation_line_items,
  public.sroi_calculation_runs
TO uellix_writer;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.audit_logs,
  public.sroi_calculation_line_items,
  public.sroi_calculation_runs
FROM uellix_writer;

-- ============================================================
-- 7. GOVERNED_READ_legacy — SELECT, and the INSERT stays withdrawn
-- ============================================================
-- The ONLY chain-installed amendment to stella_0004 §6.
-- stella_0017_governed_stella_consumption:290-299 revoked INSERT, UPDATE,
-- DELETE and TRUNCATE on public.stella_interactions from every runtime
-- principal (R6-INT): the ledger is charged through the governed ticket
-- protocol as uellix_cap_stella_quota, never by a standing runtime INSERT.
-- Re-granting INSERT here would re-open a closed vulnerability and sell two
-- units against a cap of one. The runtime still READS its own history —
-- lib/projects/service.ts:183, lib/admin/stella-services.ts:41,
-- app/app/organization/billing/page.tsx:22.
GRANT SELECT ON public.stella_interactions TO uellix_writer;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.stella_interactions
FROM uellix_writer;

-- ============================================================
-- 8. AUDITOR — SELECT on 55 of the 58, and nothing else
-- ============================================================
-- stella_0004 §6c (:720-734) extended over the nineteen, minus the three
-- NO_RUNTIME_ACCESS tables (§4), which the auditor does not read either. The
-- conditional member's auditor SELECT is issued in §10 with its writer pair.
GRANT SELECT ON
  public.account_legal_acceptances, public.assumption_object_links, public.audit_logs,
  public.counterfactual_assessments, public.domain_object_versions, public.evidence_items,
  public.evidence_sufficiency_determinations, public.evidence_tombstones, public.evidence_versions,
  public.financial_proxies, public.financial_proxy_versions, public.funders,
  public.fx_rates, public.governed_model_registry, public.impact_narratives,
  public.indicators, public.invitations, public.legal_instrument_versions,
  public.legal_instruments, public.marketing_leads, public.methodological_assumptions,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_commercial_acceptances,
  public.organization_members, public.organizations, public.outcome_funder_allocations,
  public.outcome_monetization_dispositions, public.outcome_proxy_assignments, public.outcome_taxonomy_mappings,
  public.outcomes, public.portfolios, public.project_investments,
  public.projects, public.proxy_material_fields_registry, public.proxy_sources,
  public.readiness_assessments, public.sensitivity_candidates, public.sensitivity_scenarios,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.stella_interactions, public.taxonomy_catalogs,
  public.taxonomy_codes, public.theory_of_change_links, public.theory_of_change_nodes,
  public.users
TO uellix_auditor;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.account_legal_acceptances, public.assumption_object_links, public.audit_logs,
  public.counterfactual_assessments, public.domain_object_versions, public.evidence_items,
  public.evidence_sufficiency_determinations, public.evidence_tombstones, public.evidence_versions,
  public.financial_proxies, public.financial_proxy_versions, public.funders,
  public.fx_rates, public.governed_model_registry, public.impact_narratives,
  public.indicators, public.invitations, public.legal_instrument_versions,
  public.legal_instruments, public.marketing_leads, public.methodological_assumptions,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_commercial_acceptances,
  public.organization_members, public.organizations, public.outcome_funder_allocations,
  public.outcome_monetization_dispositions, public.outcome_proxy_assignments, public.outcome_taxonomy_mappings,
  public.outcomes, public.portfolios, public.project_investments,
  public.projects, public.proxy_material_fields_registry, public.proxy_sources,
  public.readiness_assessments, public.sensitivity_candidates, public.sensitivity_scenarios,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.stella_interactions, public.taxonomy_catalogs,
  public.taxonomy_codes, public.theory_of_change_links, public.theory_of_change_nodes,
  public.users
FROM uellix_auditor;

-- ============================================================
-- 9. uellix_app holds NOTHING directly, and this is the convergence
-- ============================================================
-- Authority SECTION_4: every table privilege in this package is granted TO
-- uellix_writer (or, for the auditor class, TO uellix_auditor). uellix_app
-- reaches tables ONLY through the inherited membership, so the audit surface
-- stays one role's grants rather than fifty-eight ACLs. §0.9(d) already refused
-- a direct grant this package did not create; this REVOKE converges one a
-- previous run of this package could have left behind.
REVOKE ALL ON
  public.account_legal_acceptances, public.assumption_object_links, public.audit_logs,
  public.counterfactual_assessments, public.domain_object_versions, public.evidence_items,
  public.evidence_sufficiency_determinations, public.evidence_tombstones, public.evidence_versions,
  public.financial_proxies, public.financial_proxy_versions, public.funders,
  public.fx_rates, public.governed_model_registry, public.impact_narratives,
  public.indicators, public.invitations, public.legal_instrument_versions,
  public.legal_instruments, public.marketing_leads, public.methodological_assumptions,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_commercial_acceptances,
  public.organization_members, public.organizations, public.outcome_funder_allocations,
  public.outcome_monetization_dispositions, public.outcome_proxy_assignments, public.outcome_taxonomy_mappings,
  public.outcomes, public.portfolios, public.project_investments,
  public.projects, public.proxy_material_fields_registry, public.proxy_sources,
  public.readiness_assessments, public.sensitivity_candidates, public.sensitivity_scenarios,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.stella_interactions, public.taxonomy_catalogs,
  public.taxonomy_codes, public.theory_of_change_links, public.theory_of_change_nodes,
  public.users
FROM uellix_app;

-- ============================================================
-- 10. The conditional member — present on local/CI, absent on hosted
-- ============================================================
-- public.stella_suggestion_decisions is created by NO migration and NO baseline
-- unit. It is created by db/prepared/stella_0003_suggestion_decisions.sql:369
-- (a Stella chain package) and, on a baseline-only provision, by the
-- G2-ENVIRONMENT PREREQUISITE SHIM in tests/postgres/disposable-db.ts, because
-- db/migrations/0044_fib_audit_hardening_supersession.sql re-installs a trigger
-- on it. stella_hosted_0007 classifies it PACKAGE_NOT_INSTALLED on hosted.
--
-- So it MUST NOT make this package fail when absent, and MUST NOT be pretended
-- away when present. A fixed literal — the construct stella_0002b established
-- for deferring PARSING rather than composing SQL: nothing is built from a
-- value and each statement is visible in full. §0.7 counts it as a KNOWN
-- CONDITIONAL member, so its absence is not an unknown relation and its
-- presence is not a surplus.
DO $$
BEGIN
  IF to_regclass('public.stella_suggestion_decisions') IS NULL THEN
    RAISE NOTICE 'stella_0021: public.stella_suggestion_decisions is ABSENT and that is a DECLARED posture, not drift — no migration and no baseline unit creates it, and stella_hosted_0007 classifies it PACKAGE_NOT_INSTALLED. Classification: CONDITIONAL_APPEND_ONLY, not issued.';
  ELSE
    EXECUTE 'GRANT SELECT, INSERT ON public.stella_suggestion_decisions TO uellix_writer';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.stella_suggestion_decisions FROM uellix_writer';
    EXECUTE 'GRANT SELECT ON public.stella_suggestion_decisions TO uellix_auditor';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.stella_suggestion_decisions FROM uellix_auditor';
    EXECUTE 'REVOKE ALL ON public.stella_suggestion_decisions FROM uellix_app';
    RAISE NOTICE 'stella_0021: public.stella_suggestion_decisions is PRESENT; the append-only pair was granted to uellix_writer, SELECT to uellix_auditor, and uellix_app holds nothing directly. This converges to the end state stella_0003:520-521/:543 already produces.';
  END IF;
END $$;

-- ============================================================
-- 11. The EXECUTE half — three signatures, two roles, nothing else
-- ============================================================
-- Authority SECTION_5. A table privilege alone does not serve a request: every
-- policy predicate in this schema calls these, and a policy whose predicate
-- names a function the invoker cannot execute FAILS rather than filtering.
-- On the current-schema local/CI build the runtime holds NO EXECUTE on any of
-- them, because stella_0004 refuses at its section 0 and stella_hosted_0006 is
-- a hosted-family package; so this package carries the half itself rather than
-- depending on a package that cannot run here.
--
-- EXACTLY THREE. public.handle_new_user(), public.handle_update_user(),
-- public.can_read_evidence_object(text,uuid),
-- public.can_write_evidence_object(text,uuid) and
-- public.uellix_forbid_mutation() are deliberately EXCLUDED — the two that
-- WRITE above all — which is what makes "no indirect write path through a
-- function" a checkable claim rather than a slogan. §12 asserts the exclusion
-- by name. Nothing is granted TO PUBLIC, anon, authenticated or service_role.
GRANT EXECUTE ON FUNCTION
  public.current_user_org_ids(),
  public.current_user_is_super_admin(),
  public.current_user_role_in_org(uuid)
TO uellix_writer, uellix_auditor;

-- ============================================================
-- 12. Postconditions — the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  problem  text;
  captured text;
  observed text;
BEGIN
  -- (1) NO ROLE CHANGE OUTLIVED THE PACKAGE. This file issues no SET ROLE, so
  --     this is a claim about what it did NOT do; asserting it costs one
  --     comparison and makes a future edit that added one visible here.
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: the session is acting as % rather than %. This package issues no SET ROLE and no ALTER ... OWNER TO; a session that changed identity inside it did so through an edit nobody reviewed.',
      current_user, session_user;
  END IF;

  -- (2) THE WRITER'S CONTRACT, PER TABLE, EXACTLY. Not "at least": a table that
  --     GAINED a privilege its class does not carry fails here just as loudly
  --     as one that is missing one.
  SELECT string_agg(x.tbl || ' has "' || x.got || '" want "' || x.want || '"', ', ' ORDER BY x.tbl)
    INTO problem
  FROM (
    SELECT t.tbl, t.want,
           (CASE WHEN has_table_privilege('uellix_writer', 'public.' || t.tbl, 'SELECT') THEN 'S' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', 'public.' || t.tbl, 'INSERT') THEN 'I' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', 'public.' || t.tbl, 'UPDATE') THEN 'U' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_writer', 'public.' || t.tbl, 'DELETE') THEN 'D' ELSE '' END) AS got
    FROM (VALUES
      ('account_legal_acceptances','SI'), ('assumption_object_links','SI'), ('domain_object_versions','SI'),
      ('evidence_sufficiency_determinations','SI'), ('evidence_tombstones','SI'),
      ('organization_commercial_acceptances','SI'), ('readiness_assessments','SI'), ('sensitivity_scenarios','SI'),
      ('counterfactual_assessments','SIU'), ('evidence_versions','SIU'), ('financial_proxy_versions','SIU'),
      ('methodological_assumptions','SIU'), ('outcome_monetization_dispositions','SIU'), ('sensitivity_candidates','SIU'),
      ('governed_model_registry','S'), ('legal_instrument_versions','S'), ('legal_instruments','S'),
      ('proxy_material_fields_registry','S'),
      ('commercial_accounts',''), ('entitlement_grants',''),
      ('audit_logs','SI'), ('sroi_calculation_line_items','SI'), ('sroi_calculation_runs','SI'),
      ('stella_interactions','S'),
      ('evidence_items','SIUD'), ('financial_proxies','SIUD'), ('funders','SIUD'),
      ('fx_rates','SIUD'), ('impact_narratives','SIUD'), ('indicators','SIUD'),
      ('invitations','SIUD'), ('marketing_leads','SIUD'), ('methodology_review_matrix','SIUD'),
      ('methodology_review_matrix_items','SIUD'), ('organization_members','SIUD'), ('organizations','SIUD'),
      ('outcome_funder_allocations','SIUD'), ('outcome_proxy_assignments','SIUD'), ('outcome_taxonomy_mappings','SIUD'),
      ('outcomes','SIUD'), ('portfolios','SIUD'), ('project_investments','SIUD'),
      ('projects','SIUD'), ('proxy_sources','SIUD'), ('signup_allowlist','SIUD'),
      ('sroi_assignment_inputs','SIUD'), ('sroi_filter_sets','SIUD'), ('sroi_report_sections','SIUD'),
      ('sroi_reports','SIUD'), ('sroi_run_review_items','SIUD'), ('sroi_run_reviews','SIUD'),
      ('stakeholder_groups','SIUD'), ('taxonomy_catalogs','SIUD'), ('taxonomy_codes','SIUD'),
      ('theory_of_change_links','SIUD'), ('theory_of_change_nodes','SIUD'), ('users','SIUD')
    ) AS t(tbl, want)
  ) x
  WHERE x.got <> x.want;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: the writer contract does not hold — %.', problem;
  END IF;

  -- (3) THE SAME CLAIM ABOUT THE RUNTIME, not merely about the writer. This is
  --     the EFFECTIVE privilege through inheritance, which is the thing that
  --     actually serves a request; asserting only the writer would certify a
  --     contract a NOINHERIT edit could silently empty.
  SELECT string_agg(x.tbl || ' app has "' || x.got || '" want "' || x.want || '"', ', ' ORDER BY x.tbl)
    INTO problem
  FROM (
    SELECT t.tbl, t.want,
           (CASE WHEN has_table_privilege('uellix_app', 'public.' || t.tbl, 'SELECT') THEN 'S' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_app', 'public.' || t.tbl, 'INSERT') THEN 'I' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_app', 'public.' || t.tbl, 'UPDATE') THEN 'U' ELSE '' END ||
            CASE WHEN has_table_privilege('uellix_app', 'public.' || t.tbl, 'DELETE') THEN 'D' ELSE '' END) AS got
    FROM (VALUES
      ('account_legal_acceptances','SI'), ('assumption_object_links','SI'), ('domain_object_versions','SI'),
      ('evidence_sufficiency_determinations','SI'), ('evidence_tombstones','SI'),
      ('organization_commercial_acceptances','SI'), ('readiness_assessments','SI'), ('sensitivity_scenarios','SI'),
      ('counterfactual_assessments','SIU'), ('evidence_versions','SIU'), ('financial_proxy_versions','SIU'),
      ('methodological_assumptions','SIU'), ('outcome_monetization_dispositions','SIU'), ('sensitivity_candidates','SIU'),
      ('governed_model_registry','S'), ('legal_instrument_versions','S'), ('legal_instruments','S'),
      ('proxy_material_fields_registry','S'),
      ('commercial_accounts',''), ('entitlement_grants',''),
      ('stella_interactions','S')
    ) AS t(tbl, want)
  ) x
  WHERE x.got <> x.want;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: the EFFECTIVE runtime privilege does not match the contract — %. uellix_app holds no direct grant, so this measures the inherited membership that actually serves a request.', problem;
  END IF;

  -- (4) NO STRUCTURAL PRIVILEGE, ANYWHERE IN PUBLIC, FOR ANY RUNTIME ROLE.
  --     Across the WHOLE schema, exactly as §0.9(a) asked before the grants.
  SELECT string_agg(x.tbl || ' -> ' || x.role || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.role, x.priv)
    INTO problem
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, g.r AS role, p.priv AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('uellix_writer'), ('uellix_auditor'), ('uellix_app')) AS g(r)
    CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND has_table_privilege(g.r, c.oid, p.priv)
  ) x;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: a runtime role holds a STRUCTURAL privilege after apply: %. Every class REVOKEs all four by name, so this can only be a table the contract does not cover — which §0.7 refuses — or an edit that dropped a REVOKE.', problem;
  END IF;

  -- (5) uellix_app HOLDS NO DIRECT TABLE GRANT. The grounding pair is the one
  --     declared exception and its posture is asserted to be EXACTLY SELECT.
  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO problem
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, a.privilege_type AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
    aclexplode(c.relacl) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND a.grantee = 'uellix_app'::regrole
      AND c.relname NOT IN ('evidence_chunks', 'evidence_document_versions')
  ) x;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: uellix_app holds a DIRECT table grant after apply: %. Every grant this package issues names uellix_writer or uellix_auditor.', problem;
  END IF;

  SELECT string_agg(x.tbl || ' (' || x.priv || ')', ', ' ORDER BY x.tbl, x.priv) INTO problem
  FROM (
    SELECT n.nspname || '.' || c.relname AS tbl, a.privilege_type AS priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
    aclexplode(c.relacl) a
    WHERE n.nspname = 'public'
      AND c.relname IN ('evidence_chunks', 'evidence_document_versions')
      AND a.grantee = 'uellix_app'::regrole
      AND a.privilege_type <> 'SELECT'
  ) x;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: the grounding capability tables grant uellix_app more than SELECT: %. grounding_0002:533-534 and grounding_0003:636-637 grant SELECT and nothing else; this package grants nothing on them at all.', problem;
  END IF;

  -- (6) THE EXECUTE HALF, EXACTLY. Three signatures TRUE for the two roles,
  --     the five excluded functions FALSE for both, and PUBLIC holding none.
  --     acldefault('f') is EXECUTE TO PUBLIC for a NEW function, which is why
  --     this is asserted against the live catalog and not against proacl IS NULL.
  SELECT string_agg(t.sig || ' -> ' || t.r, ', ' ORDER BY t.sig, t.r) INTO problem
  FROM (VALUES
    ('public.current_user_org_ids()', 'uellix_writer'),
    ('public.current_user_org_ids()', 'uellix_auditor'),
    ('public.current_user_is_super_admin()', 'uellix_writer'),
    ('public.current_user_is_super_admin()', 'uellix_auditor'),
    ('public.current_user_role_in_org(uuid)', 'uellix_writer'),
    ('public.current_user_role_in_org(uuid)', 'uellix_auditor')
  ) AS t(sig, r)
  WHERE NOT has_function_privilege(t.r, t.sig, 'EXECUTE');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: the RLS helper EXECUTE grant is missing for %. Without it a SELECT by the runtime does not return zero rows — it fails outright with "permission denied for function current_user_org_ids", and every table privilege this package issued would buy nothing.', problem;
  END IF;

  SELECT string_agg(t.sig || ' -> ' || t.r, ', ' ORDER BY t.sig, t.r) INTO problem
  FROM (VALUES
    ('public.handle_new_user()', 'uellix_writer'),
    ('public.handle_new_user()', 'uellix_auditor'),
    ('public.handle_new_user()', 'uellix_app'),
    ('public.handle_update_user()', 'uellix_writer'),
    ('public.handle_update_user()', 'uellix_auditor'),
    ('public.handle_update_user()', 'uellix_app'),
    ('public.can_read_evidence_object(text,uuid)', 'uellix_writer'),
    ('public.can_read_evidence_object(text,uuid)', 'uellix_auditor'),
    ('public.can_write_evidence_object(text,uuid)', 'uellix_writer'),
    ('public.can_write_evidence_object(text,uuid)', 'uellix_auditor'),
    ('public.uellix_forbid_mutation()', 'uellix_writer'),
    ('public.uellix_forbid_mutation()', 'uellix_auditor')
  ) AS t(sig, r)
  WHERE to_regprocedure(t.sig) IS NOT NULL
    AND has_function_privilege(t.r, t.sig, 'EXECUTE');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: a runtime role can EXECUTE an EXCLUDED function: %. The two that WRITE are excluded so that "no indirect write path through a function" is a checkable claim; this package grants EXECUTE on exactly three signatures.', problem;
  END IF;

  SELECT string_agg(t.sig, ', ' ORDER BY t.sig) INTO problem
  FROM (VALUES
    ('public.current_user_org_ids()'),
    ('public.current_user_is_super_admin()'),
    ('public.current_user_role_in_org(uuid)')
  ) AS t(sig)
  WHERE has_function_privilege('public', t.sig, 'EXECUTE');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: PUBLIC holds EXECUTE on RLS helper(s) %. acldefault for a function is EXECUTE TO PUBLIC, and stella_0004:563-568 revokes it; a helper the world can execute makes the grant this package issues meaningless as a control.', problem;
  END IF;

  -- (7) NOTHING THIS PACKAGE DOES NOT NAME HAS MOVED. The ACL projected onto
  --     every role OTHER than the two it grants to, the owners, the policies
  --     and the RLS flags, all compared against §0.13's capture. This is what
  --     makes "creates no policy, moves no owner, touches no other principal"
  --     a measurement rather than a promise.
  captured := current_setting('stella_0021.foreign_acl', true);
  SELECT coalesce(string_agg(
      n.nspname || '.' || c.relname || '|' || a.grantee::regrole::text || '|' || a.privilege_type,
      E'\n' ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type), '')
    INTO observed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND a.grantee::regrole::text NOT IN ('uellix_writer', 'uellix_auditor');

  IF captured IS DISTINCT FROM observed THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: the ACL of a principal this package does not name CHANGED. Only uellix_writer and uellix_auditor are granted to, and uellix_app is only ever revoked from; any other movement is an effect nobody reviewed.';
  END IF;

  captured := current_setting('stella_0021.owners', true);
  SELECT string_agg(c.relname || '|' || pg_catalog.pg_get_userbyid(c.relowner), E'\n' ORDER BY c.relname)
    INTO observed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');

  IF captured IS DISTINCT FROM observed THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: an OWNER in schema public changed. This package issues no ALTER ... OWNER TO.';
  END IF;

  captured := current_setting('stella_0021.policies', true);
  SELECT coalesce(md5(string_agg(
      schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' ||
      permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' ||
      coalesce(with_check, ''), E'\n'
      ORDER BY schemaname, tablename, policyname)), '')
    INTO observed
  FROM pg_policies;

  IF captured IS DISTINCT FROM observed THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: a POLICY changed. RLS remains the row boundary and this package creates, alters and drops none — a table privilege is necessary and NOT sufficient, and the row-level answer for every principal must be exactly what it was before this ran.';
  END IF;

  captured := current_setting('stella_0021.rls', true);
  SELECT coalesce(string_agg(c.relname || '|' || c.relrowsecurity::text || c.relforcerowsecurity::text,
      E'\n' ORDER BY c.relname), '')
    INTO observed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');

  IF captured IS DISTINCT FROM observed THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: a ROW LEVEL SECURITY flag changed. This package issues no ENABLE, DISABLE or FORCE.';
  END IF;

  captured := current_setting('stella_0021.roles', true);
  SELECT string_agg(rolname, ',' ORDER BY rolname) INTO observed FROM pg_roles;

  IF captured IS DISTINCT FROM observed THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: the ROLE set changed. This package creates, drops and alters no role.';
  END IF;

  --     The six EXCLUDED tables, compared in FULL rather than projected. The
  --     foreign_acl check above drops uellix_writer and uellix_auditor by
  --     design, because those two are expected to move everywhere else; on
  --     these six they are expected NOT to, and that is the claim.
  captured := current_setting('stella_0021.capability_acl', true);
  SELECT coalesce(string_agg(
      c.relname || '|' || a.grantee::regrole::text || '|' || a.privilege_type,
      E'\n' ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type), '')
    INTO observed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
  WHERE n.nspname = 'public'
    AND c.relname IN ('capability_bootstrap_attempts', 'capability_verification_hits',
                      'evidence_chunks', 'evidence_document_versions',
                      'report_public_disclosures', 'stripe_webhook_events');

  IF captured IS DISTINCT FROM observed THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: the ACL of a CAPABILITY-ONLY table changed. Those six are created by prepared-chain packages, are not members of the closed world, and this package grants and revokes nothing on them — it asserts their posture and leaves their bytes alone.';
  END IF;

  -- (8) THE RUNTIME ROLES STILL HOLD NEITHER SUPERUSER NOR BYPASSRLS. Measured
  --     AFTER as well as before, so the claim is about the end state and not
  --     only about what was true when the package started.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO problem
  FROM pg_roles
  WHERE rolname IN ('uellix_writer', 'uellix_auditor', 'uellix_app')
    AND (rolsuper OR rolbypassrls);

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0021 FAILED verification: runtime role(s) % hold SUPERUSER or BYPASSRLS after apply.', problem;
  END IF;

  RAISE NOTICE 'stella_0021: CANONICAL_RUNTIME_ACL — the closed world of 58 public tables holds exactly its contract, the runtime reaches it by inheritance alone, the three RLS helpers are executable by uellix_writer and uellix_auditor and by nobody else, and no policy, owner, role or RLS flag moved.';
END $$;
