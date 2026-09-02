-- ============================================================================
-- STEP E3 — CREDENTIAL CLOSURE VERIFICATION. READ ONLY. CHANGES NOTHING.
--
-- Runs through the ADMIN connection AFTER `ALTER ROLE uellix_app PASSWORD NULL`.
-- Proves two separate things, and conflating them is the mistake this file
-- exists to prevent:
--
--   1. THE CREDENTIAL IS GONE      appPasswordSchemeAfter IS NULL
--   2. NOTHING ELSE MOVED          role attributes and memberships identical
--                                  to the values measured before provisioning
--
-- (2) matters because the whole justification for provisioning was that it
-- touches rolpassword and nothing else. That claim is only worth making if it
-- is measured on the way out.
--
-- rolpassword is NEVER selected, printed or recorded — only its SCHEME, exactly
-- as tests/database-role-safety.test.ts:415 derives it. stella_0004 §9.3 fixes
-- the semantics: NULL means scram/md5 authentication is IMPOSSIBLE.
--
-- Emitted shapes deliberately mirror artifacts/hosted-chain-posture-probe.sql
-- so the rows can be compared field-for-field against the VERIFIED baseline.
--
-- No INSERT/UPDATE/DELETE/DDL. BEGIN READ ONLY ... ROLLBACK. DO NOT pass -1.
-- ============================================================================

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(
  'schema', 'uellix.hosted.m8.credential-closure/1',
  'note', 'Post-restoration closure evidence. No password value is read, derived or recorded — only its scheme.',
  'measuredBy', 'operator, ADMIN connection, read-only transaction',

  'adminSessionUser', session_user,
  'adminCurrentUser', current_user,

  /* -- (1) THE CREDENTIAL IS GONE. ----------------------------------------- */
  'pgAuthidReadable', pg_catalog.has_table_privilege(
                        current_user, 'pg_catalog.pg_authid', 'SELECT'),
  'appPasswordSchemeAfter', (
    SELECT CASE
             WHEN a.rolpassword IS NULL                THEN NULL
             WHEN a.rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'scram'
             WHEN a.rolpassword LIKE 'md5%'            THEN 'md5'
             ELSE 'other'
           END
    FROM pg_catalog.pg_authid a
    WHERE a.rolname = 'uellix_app'
      AND pg_catalog.has_table_privilege(current_user, 'pg_catalog.pg_authid', 'SELECT')),

  /* -- (2) NOTHING ELSE MOVED. --------------------------------------------- */
  -- Same shape as the posture probe's roleAttributes, for direct comparison
  -- against the baseline measured before any credential existed.
  'roleAttributes', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'name', r.rolname,
             'super', r.rolsuper,
             'inherit', r.rolinherit,
             'canLogin', r.rolcanlogin,
             'bypassRls', r.rolbypassrls,
             'createRole', r.rolcreaterole
           ) ORDER BY r.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_roles r
    WHERE r.rolname LIKE 'uellix\_%'),

  -- Same shape as the posture probe's memberships. Restricted to edges that
  -- touch uellix_app, which are the only ones this lifecycle could have moved.
  'appMemberships', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'role', tgt.rolname,
             'member', mem.rolname,
             'grantor', gr.rolname,
             'setOption', m.set_option,
             'adminOption', m.admin_option,
             'inheritOption', m.inherit_option
           ) ORDER BY tgt.rolname, mem.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles tgt ON tgt.oid = m.roleid
    JOIN pg_catalog.pg_roles mem ON mem.oid = m.member
    JOIN pg_catalog.pg_roles gr  ON gr.oid  = m.grantor
    WHERE tgt.rolname = 'uellix_app' OR mem.rolname = 'uellix_app'),

  -- The credential lifecycle must not have created a login for any role that
  -- had none. Any NOLOGIN uellix_* role carrying a password is a finding.
  'nologinRolesWithPassword', (
    SELECT coalesce(jsonb_agg(a.rolname ORDER BY a.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_authid a
    WHERE a.rolname LIKE 'uellix\_%'
      AND NOT a.rolcanlogin
      AND a.rolpassword IS NOT NULL
      AND pg_catalog.has_table_privilege(current_user, 'pg_catalog.pg_authid', 'SELECT'))
));

ROLLBACK;
