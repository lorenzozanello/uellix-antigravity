-- ============================================================================
-- GENERATED — DO NOT EDIT. CHECKPOINT B0 observation.
-- Regenerate with `pnpm b0:observation:generate`; `pnpm b0:observation:verify`
-- compares bytes. The rowCounts arms come from the corpus, so this file cannot
-- drift from the manifest.
--
-- READ ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Every statement runs in
-- its own READ ONLY transaction that rolls back.
--
--   & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -f db/prepared/checkpoint-b0/observation.sql
--
-- The output is the BaselineObservation the eighteen canonical postconditions
-- consume. `projectRef` is supplied by the operator through -v, the same way
-- the journal wrappers take it: nothing server-side reports a Supabase project
-- ref, so it cannot be derived in band.
--
-- environmentSecretNames is emitted as null ON PURPOSE. B0-14 is not a question
-- PostgreSQL can answer, and null means NOT INVENTORIED — which B0-14 fails.
-- ============================================================================
\if :{?uellix_project_ref}
\else
\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\echo 'An unattributed observation could describe any database.'
\quit
\endif

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(

  'projectRef', :'uellix_project_ref',

  'schemas', (SELECT coalesce(jsonb_agg(nspname ORDER BY nspname), '[]'::jsonb)
              FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\_%'),

  'tables', (SELECT coalesce(jsonb_agg(schemaname || '.' || tablename ORDER BY schemaname, tablename), '[]'::jsonb)
             FROM pg_catalog.pg_tables WHERE schemaname = 'public'),

  'columns', (SELECT coalesce(jsonb_object_agg(tbl, cols), '{}'::jsonb) FROM (
                SELECT table_schema || '.' || table_name AS tbl,
                       jsonb_agg(column_name ORDER BY column_name) AS cols
                FROM information_schema.columns WHERE table_schema = 'public'
                GROUP BY 1) c),

  'constraints', (SELECT coalesce(jsonb_agg(conname ORDER BY conname), '[]'::jsonb)
                  FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
                  WHERE n.nspname = 'public'),

  'functions', (SELECT coalesce(jsonb_agg(DISTINCT n.nspname || '.' || p.proname), '[]'::jsonb)
                FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'),

  'triggers', (SELECT coalesce(jsonb_agg(DISTINCT tgname), '[]'::jsonb)
               FROM pg_catalog.pg_trigger WHERE NOT tgisinternal),

  'rlsEnabledTables', (SELECT coalesce(jsonb_agg(n.nspname || '.' || c.relname ORDER BY n.nspname, c.relname), '[]'::jsonb)
                       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                       WHERE c.relkind IN ('r','p') AND c.relrowsecurity AND n.nspname = 'public'),

  'policies', (SELECT coalesce(jsonb_agg(schemaname || '.' || tablename || '.' || policyname
                        ORDER BY schemaname, tablename, policyname), '[]'::jsonb)
               FROM pg_catalog.pg_policies WHERE schemaname IN ('public','storage')),

  'roles', (SELECT coalesce(jsonb_agg(rolname ORDER BY rolname), '[]'::jsonb) FROM pg_catalog.pg_roles),

  -- B0-10: exactly what that check asks — anon and PUBLIC table privileges in
  -- public. Effective ACL, so a relation never REVOKEd reports what it grants.
  'grants', (SELECT coalesce(jsonb_agg(g ORDER BY g), '[]'::jsonb) FROM (
               SELECT COALESCE(pg_catalog.pg_get_userbyid(a.grantee), 'PUBLIC') || ':' || a.privilege_type
                      || ':' || n.nspname || '.' || c.relname AS g
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
               WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
                 AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) = 'anon')) x),

  -- B0-17: the effect unit 042 has and the per-unit runner could not check.
  -- coalesce(proacl, acldefault(...)) so a NULL proacl reads as the implicit
  -- PUBLIC EXECUTE it really is, instead of as "no privilege".
  'functionGrants', (SELECT coalesce(jsonb_agg(g ORDER BY g), '[]'::jsonb) FROM (
                       SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                   ELSE pg_catalog.pg_get_userbyid(a.grantee) END
                              || ':' || a.privilege_type || ':' || n.nspname || '.' || p.proname AS g
                       FROM pg_catalog.pg_proc p
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                       WHERE n.nspname = 'public' AND a.privilege_type = 'EXECUTE') y),

  'rowCounts', (SELECT coalesce(jsonb_object_agg(t, n), '{}'::jsonb) FROM (
    SELECT 'public.assumption_object_links' AS t, count(*) AS n FROM "public"."assumption_object_links"
    UNION ALL
    SELECT 'public.audit_logs' AS t, count(*) AS n FROM "public"."audit_logs"
    UNION ALL
    SELECT 'public.counterfactual_assessments' AS t, count(*) AS n FROM "public"."counterfactual_assessments"
    UNION ALL
    SELECT 'public.domain_object_versions' AS t, count(*) AS n FROM "public"."domain_object_versions"
    UNION ALL
    SELECT 'public.evidence_items' AS t, count(*) AS n FROM "public"."evidence_items"
    UNION ALL
    SELECT 'public.evidence_sufficiency_determinations' AS t, count(*) AS n FROM "public"."evidence_sufficiency_determinations"
    UNION ALL
    SELECT 'public.evidence_tombstones' AS t, count(*) AS n FROM "public"."evidence_tombstones"
    UNION ALL
    SELECT 'public.evidence_versions' AS t, count(*) AS n FROM "public"."evidence_versions"
    UNION ALL
    SELECT 'public.financial_proxies' AS t, count(*) AS n FROM "public"."financial_proxies"
    UNION ALL
    SELECT 'public.financial_proxy_versions' AS t, count(*) AS n FROM "public"."financial_proxy_versions"
    UNION ALL
    SELECT 'public.funders' AS t, count(*) AS n FROM "public"."funders"
    UNION ALL
    SELECT 'public.fx_rates' AS t, count(*) AS n FROM "public"."fx_rates"
    UNION ALL
    SELECT 'public.governed_model_registry' AS t, count(*) AS n FROM "public"."governed_model_registry"
    UNION ALL
    SELECT 'public.impact_narratives' AS t, count(*) AS n FROM "public"."impact_narratives"
    UNION ALL
    SELECT 'public.indicators' AS t, count(*) AS n FROM "public"."indicators"
    UNION ALL
    SELECT 'public.invitations' AS t, count(*) AS n FROM "public"."invitations"
    UNION ALL
    SELECT 'public.marketing_leads' AS t, count(*) AS n FROM "public"."marketing_leads"
    UNION ALL
    SELECT 'public.methodological_assumptions' AS t, count(*) AS n FROM "public"."methodological_assumptions"
    UNION ALL
    SELECT 'public.methodology_review_matrix' AS t, count(*) AS n FROM "public"."methodology_review_matrix"
    UNION ALL
    SELECT 'public.methodology_review_matrix_items' AS t, count(*) AS n FROM "public"."methodology_review_matrix_items"
    UNION ALL
    SELECT 'public.organization_members' AS t, count(*) AS n FROM "public"."organization_members"
    UNION ALL
    SELECT 'public.organizations' AS t, count(*) AS n FROM "public"."organizations"
    UNION ALL
    SELECT 'public.outcome_funder_allocations' AS t, count(*) AS n FROM "public"."outcome_funder_allocations"
    UNION ALL
    SELECT 'public.outcome_monetization_dispositions' AS t, count(*) AS n FROM "public"."outcome_monetization_dispositions"
    UNION ALL
    SELECT 'public.outcome_proxy_assignments' AS t, count(*) AS n FROM "public"."outcome_proxy_assignments"
    UNION ALL
    SELECT 'public.outcome_taxonomy_mappings' AS t, count(*) AS n FROM "public"."outcome_taxonomy_mappings"
    UNION ALL
    SELECT 'public.outcomes' AS t, count(*) AS n FROM "public"."outcomes"
    UNION ALL
    SELECT 'public.portfolios' AS t, count(*) AS n FROM "public"."portfolios"
    UNION ALL
    SELECT 'public.project_investments' AS t, count(*) AS n FROM "public"."project_investments"
    UNION ALL
    SELECT 'public.projects' AS t, count(*) AS n FROM "public"."projects"
    UNION ALL
    SELECT 'public.proxy_material_fields_registry' AS t, count(*) AS n FROM "public"."proxy_material_fields_registry"
    UNION ALL
    SELECT 'public.proxy_sources' AS t, count(*) AS n FROM "public"."proxy_sources"
    UNION ALL
    SELECT 'public.signup_allowlist' AS t, count(*) AS n FROM "public"."signup_allowlist"
    UNION ALL
    SELECT 'public.sroi_assignment_inputs' AS t, count(*) AS n FROM "public"."sroi_assignment_inputs"
    UNION ALL
    SELECT 'public.sroi_calculation_line_items' AS t, count(*) AS n FROM "public"."sroi_calculation_line_items"
    UNION ALL
    SELECT 'public.sroi_calculation_runs' AS t, count(*) AS n FROM "public"."sroi_calculation_runs"
    UNION ALL
    SELECT 'public.sroi_filter_sets' AS t, count(*) AS n FROM "public"."sroi_filter_sets"
    UNION ALL
    SELECT 'public.sroi_report_sections' AS t, count(*) AS n FROM "public"."sroi_report_sections"
    UNION ALL
    SELECT 'public.sroi_reports' AS t, count(*) AS n FROM "public"."sroi_reports"
    UNION ALL
    SELECT 'public.sroi_run_review_items' AS t, count(*) AS n FROM "public"."sroi_run_review_items"
    UNION ALL
    SELECT 'public.sroi_run_reviews' AS t, count(*) AS n FROM "public"."sroi_run_reviews"
    UNION ALL
    SELECT 'public.stakeholder_groups' AS t, count(*) AS n FROM "public"."stakeholder_groups"
    UNION ALL
    SELECT 'public.stella_interactions' AS t, count(*) AS n FROM "public"."stella_interactions"
    UNION ALL
    SELECT 'public.taxonomy_catalogs' AS t, count(*) AS n FROM "public"."taxonomy_catalogs"
    UNION ALL
    SELECT 'public.taxonomy_codes' AS t, count(*) AS n FROM "public"."taxonomy_codes"
    UNION ALL
    SELECT 'public.theory_of_change_links' AS t, count(*) AS n FROM "public"."theory_of_change_links"
    UNION ALL
    SELECT 'public.theory_of_change_nodes' AS t, count(*) AS n FROM "public"."theory_of_change_nodes"
    UNION ALL
    SELECT 'public.users' AS t, count(*) AS n FROM "public"."users"
  ) r),

  'extensions', (SELECT coalesce(jsonb_agg(extname ORDER BY extname), '[]'::jsonb) FROM pg_catalog.pg_extension),

  'storageBuckets', (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM storage.buckets),

  'storagePolicies', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'schemaname', schemaname, 'tablename', tablename, 'policyname', policyname,
                          'roles', roles::text, 'cmd', cmd, 'qual', qual, 'withCheck', with_check)
                          ORDER BY policyname), '[]'::jsonb)
                      FROM pg_catalog.pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'),

  -- B0-18: the SET, which no single-unit check ever looks at.
  'journal', (SELECT jsonb_build_object(
                'packages',     coalesce((SELECT jsonb_agg(package_id ORDER BY id) FROM uellix_provisioning.applied_units), '[]'::jsonb),
                'environments', coalesce((SELECT jsonb_agg(DISTINCT environment) FROM uellix_provisioning.applied_units), '[]'::jsonb),
                'projectRefs',  coalesce((SELECT jsonb_agg(DISTINCT project_ref) FROM uellix_provisioning.applied_units), '[]'::jsonb),
                'statuses',     coalesce((SELECT jsonb_agg(DISTINCT status) FROM uellix_provisioning.applied_units), '[]'::jsonb))),

  'environmentSecretNames', NULL
));

ROLLBACK;
