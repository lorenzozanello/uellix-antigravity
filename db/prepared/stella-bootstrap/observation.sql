-- ============================================================================
-- GENERATED — DO NOT EDIT. PHASE_STELLA_BOOTSTRAP postconditions.
-- Regenerate with `pnpm s1:observation:generate`; `pnpm s1:observation:verify`
-- compares bytes.
--
-- READ ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Runs inside a READ ONLY
-- transaction and rolls back.
--
--   & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f db/prepared/stella-bootstrap/observation.sql
--
-- WHY THIS EXISTS SEPARATELY FROM THE PACKAGE'S OWN §6. stella_hosted_0001
-- verifies itself before COMMIT, which is worth having — a failure rolls it
-- back. But it is the package auditing itself from inside the transaction that
-- built the state. This reads what is actually there afterwards, which is the
-- same doctrine §2.9 of the provisioning runbook states for the whole hosted
-- plan: no journal, because a journal says what was attempted and a measurement
-- says what is.
--
-- THE SAME PROBE CLOSES S1 AND CHECKPOINT A1. Exactly one fact differs — the
-- sentinel ROW, absent for S1 and present for A1 — so the row COUNT is reported
-- and the verdict is parameterised in code rather than duplicated here.
-- ============================================================================
\if :{?uellix_project_ref}
\else
\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\echo 'An unattributed observation could describe any database, including production.'
\quit
\endif

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(
  'targetProjectRef', :'uellix_project_ref',
  'measuredBy', 'operator, psql session pooler, inside a READ ONLY transaction, from db/prepared/stella-bootstrap/observation.sql',
  'note', 'Project refs are not secret. No credential, connection string or user data is recorded here. Every value below was measured by this query.',

  'bootstrapSchemaOwner', (
    SELECT pg_catalog.pg_get_userbyid(n.nspowner)
    FROM pg_catalog.pg_namespace n WHERE n.nspname = 'uellix_bootstrap'),

  'roles', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name', r.rolname, 'canLogin', r.rolcanlogin, 'isSuper', r.rolsuper,
      'bypassRls', r.rolbypassrls, 'createRole', r.rolcreaterole,
      'createDb', r.rolcreatedb, 'replication', r.rolreplication
    ) ORDER BY r.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_roles r WHERE r.rolname IN ('uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor')),

  'memberships', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'role', gr.rolname, 'member', mr.rolname,
      'inheritOption', m.inherit_option, 'setOption', m.set_option
    ) ORDER BY gr.rolname, mr.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
    JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
    WHERE gr.rolname IN ('uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor') AND mr.rolname IN ('uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor')),

  -- Reachability, not the grant list: a future path through a third role is
  -- exactly what reading pg_auth_members would miss.
  'appReachesOwner', pg_catalog.pg_has_role('uellix_app', 'uellix_owner', 'MEMBER'),
  'appReachesMigrator', pg_catalog.pg_has_role('uellix_app', 'uellix_migrator', 'MEMBER'),

  'ledgerOwner', (
    SELECT pg_catalog.pg_get_userbyid(c.relowner)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'stella_interactions'),

  -- EFFECTIVE acl. A NULL proacl carries the DEFAULT acl, and for functions
  -- that default grants EXECUTE to PUBLIC: exploding a NULL would read the
  -- widest possible state as "nobody holds anything" (S1-DEFECT-002).
  'functions', (
    SELECT coalesce(jsonb_agg(f ORDER BY f->>'signature'), '[]'::jsonb) FROM (
      -- regprocedure, NOT pg_get_function_identity_arguments. The latter KEEPS
      -- the parameter names — it renders assert_hosted_capabilities as
      -- `(p_package text)` — so the contract and the probe never matched and
      -- the function reported as ABSENT against a database where it existed.
      -- Measured; no textual test could have seen it, because the fixtures used
      -- the contract's spelling on both sides.
      --
      -- regprocedure emits bare types, and with an empty search_path it always
      -- qualifies the schema. It is also the spelling the package itself uses
      -- in to_regprocedure(), so there is one form of a signature here.
      SELECT jsonb_build_object(
        'signature', p.oid::regprocedure::text,
        'owner', pg_catalog.pg_get_userbyid(p.proowner),
        'securityDefiner', p.prosecdef,
        'config', to_jsonb(coalesce(p.proconfig, ARRAY[]::text[])),
        'executeGrantees', (
          SELECT coalesce(jsonb_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                                  ELSE a.grantee::regrole::text END), '[]'::jsonb)
          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.privilege_type = 'EXECUTE')
      ) AS f
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid::regprocedure::text IN (
      'public.uellix_auth_uid()',
      'uellix_bootstrap.assert_hosted_capabilities(text)',
      'uellix_bootstrap.hosted_capability_report()')
    ) AS fns),

  'schemaPublicGrants', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grantee', r.rolname,
      'usage', pg_catalog.has_schema_privilege(r.rolname, 'public', 'USAGE'),
      'create', pg_catalog.has_schema_privilege(r.rolname, 'public', 'CREATE')
    ) ORDER BY r.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_roles r WHERE r.rolname IN ('uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor')),

  'sentinelTablePresent', (
    SELECT count(*) > 0 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'uellix_bootstrap' AND c.relname = 'staging_sentinel'),

  -- The COUNT and nothing else. Selecting the row would put a project ref in
  -- two artefacts and invite them to disagree; the row's own CHECK constraints
  -- already govern its content.
  'sentinelRowCount', (
    SELECT CASE WHEN to_regclass('uellix_bootstrap.staging_sentinel') IS NULL THEN 0
                ELSE (SELECT count(*) FROM uellix_bootstrap.staging_sentinel) END)
));

ROLLBACK;
