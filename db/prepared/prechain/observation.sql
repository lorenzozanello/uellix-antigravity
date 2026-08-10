-- ============================================================================
-- PRECHAIN AUTHORITY OBSERVATION — READ ONLY.
--
-- COMMIT 5.1. One probe, one round trip, for the three questions the PG 17.6
-- engine certification could not answer from repository evidence:
--
--   E-01  who OWNS the eight objects the governed chain depends on before T1,
--         and what uellix_owner already holds on them;
--   E-02  what the installer principal actually is on this project — its
--         attributes, and the membership topology around it;
--   E-04  what `createrole_self_grant` is set to, because it decides whether
--         the automatic membership PostgreSQL creates carries SET.
--
-- WHY THESE THREE TOGETHER. Each one alone changes the remediation, and a
-- second round trip would mean deciding one of them from a guess in between.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS CANNOT DO
-- ---------------------------------------------------------------------------
-- It runs inside `BEGIN READ ONLY` and ends in ROLLBACK. There is no INSERT, no
-- UPDATE, no DELETE, no DDL and no GRANT anywhere below. It reads pg_catalog
-- and information_schema only; it reads no table of the product, so it cannot
-- see a single row of user data.
--
-- It records no credential and no connection string. A Supabase project ref is
-- public in every URL the project serves and is required, so that an
-- observation cannot later be attributed to a database it did not come from.
--
--   psql "<MIGRATOR OR POSTGRES URL>" -X -q -A -t -v ON_ERROR_STOP=1 \
--        -v uellix_project_ref=<ref> -f db/prepared/prechain/observation.sql
--
-- Save the single JSON line it prints to
-- artifacts/hosted-prechain-observation.json.
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
  'note',
    'READ ONLY. No credential, connection string or user data is recorded. Every value was measured by this query.',
  'targetProjectRef', :'uellix_project_ref',
  'measuredBy',
    'operator, inside a READ ONLY transaction, from db/prepared/prechain/observation.sql',

  -- E-02 (a). Who is asking, and what can they do.
  'session', jsonb_build_object(
    'currentUser', current_user,
    'sessionUser', session_user,
    'createroleSelfGrant', current_setting('createrole_self_grant'),
    'serverVersion', current_setting('server_version'),
    'serverVersionNum', current_setting('server_version_num')
  ),

  -- E-02 (b). Every principal the authority model names, with its attributes.
  'roles', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'name', r.rolname,
             'isSuper', r.rolsuper,
             'canLogin', r.rolcanlogin,
             'createRole', r.rolcreaterole,
             'createDb', r.rolcreatedb,
             'inherit', r.rolinherit,
             'bypassRls', r.rolbypassrls
           ) ORDER BY r.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_roles r
    WHERE r.rolname IN ('postgres','uellix_owner','uellix_migrator','uellix_app',
                        'uellix_writer','uellix_auditor','uellix_cap_grounding',
                        'uellix_cap_stella_quota','uellix_cap_stella_ticket',
                        'supabase_admin','supabase_auth_admin','authenticator')
  ),

  -- E-02 (c) and E-04. Membership rows WITH grantor and all three options.
  -- The grantor is what tells a provider row from one the chain issued (lab
  -- M2), and the options are what decide whether a row confers SET at all.
  'memberships', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'role', r.rolname,
             'member', m.rolname,
             'grantor', g.rolname,
             'adminOption', am.admin_option,
             'inheritOption', am.inherit_option,
             'setOption', am.set_option
           ) ORDER BY r.rolname, m.rolname, g.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
    JOIN pg_catalog.pg_roles g ON g.oid = am.grantor
    WHERE r.rolname LIKE 'uellix\_%' OR m.rolname LIKE 'uellix\_%'
  ),

  -- E-01 (a). The SIX tables the chain depends on, with owner and with what
  -- uellix_owner holds on each — INCLUDING the grant option, which is the
  -- distinction the engine refused on.
  'tables', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'relation', n.nspname || '.' || c.relname,
             'owner', pg_catalog.pg_get_userbyid(c.relowner),
             'ownerHasSelect',
               pg_catalog.has_table_privilege('uellix_owner', c.oid, 'SELECT'),
             'ownerHasSelectWithGrant',
               pg_catalog.has_table_privilege('uellix_owner', c.oid, 'SELECT WITH GRANT OPTION'),
             'ownerHasInsertWithGrant',
               pg_catalog.has_table_privilege('uellix_owner', c.oid, 'INSERT WITH GRANT OPTION'),
             'ownerHasUpdateWithGrant',
               pg_catalog.has_table_privilege('uellix_owner', c.oid, 'UPDATE WITH GRANT OPTION'),
             'ownerHasReferences',
               pg_catalog.has_table_privilege('uellix_owner', c.oid, 'REFERENCES')
           ) ORDER BY c.relname), '[]'::jsonb)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('organizations','projects','evidence_items','users','stella_interactions')
  ),

  -- E-01 (b). The three functions, by FULL signature: owner, EXECUTE, and
  -- EXECUTE WITH GRANT OPTION separately.
  'functions', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'signature', p.oid::regprocedure::text,
             'owner', pg_catalog.pg_get_userbyid(p.proowner),
             'securityDefiner', p.prosecdef,
             'config', COALESCE(array_to_string(p.proconfig, '|'), ''),
             'ownerHasExecute',
               pg_catalog.has_function_privilege('uellix_owner', p.oid, 'EXECUTE'),
             'ownerHasExecuteWithGrant',
               pg_catalog.has_function_privilege('uellix_owner', p.oid, 'EXECUTE WITH GRANT OPTION')
           ) ORDER BY p.oid::regprocedure::text), '[]'::jsonb)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('current_user_org_ids','current_user_is_super_admin',
                        'uellix_forbid_mutation','uellix_auth_uid')
  ),

  -- E-01 (c). Schema owners, and whether uellix_owner may create in them.
  'schemas', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'schema', n.nspname,
             'owner', pg_catalog.pg_get_userbyid(n.nspowner),
             'ownerHasCreate', pg_catalog.has_schema_privilege('uellix_owner', n.oid, 'CREATE'),
             'ownerHasUsage', pg_catalog.has_schema_privilege('uellix_owner', n.oid, 'USAGE')
           ) ORDER BY n.nspname), '[]'::jsonb)
    FROM pg_catalog.pg_namespace n
    WHERE n.nspname IN ('public','auth','storage','uellix_bootstrap',
                        'uellix_grounding','uellix_stella','uellix_stella_ops')
  ),

  -- PRECHAIN sanity: none of the three capability roles should exist yet.
  'capabilityRolesPresent', (
    SELECT COALESCE(jsonb_agg(r.rolname ORDER BY r.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_roles r
    WHERE r.rolname IN ('uellix_cap_grounding','uellix_cap_stella_quota','uellix_cap_stella_ticket')
  )
)) AS prechain_observation;

ROLLBACK;
