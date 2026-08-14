-- ============================================================================
-- STEP A0 — CREDENTIAL AUTHORITY PRE-CHECK. READ ONLY. CHANGES NOTHING.
--
-- Runs through the ADMIN connection, BEFORE any credential-changing command.
-- It answers two questions, and the second is the one that is easy to forget:
--
--   1. May this principal set uellix_app's password at all?
--   2. Will we be able to PROVE we removed it again afterwards?
--
-- (2) matters because a credential lifecycle you cannot verify closing is a
-- lifecycle you should not open. Restoration evidence reads pg_authid, which
-- is not readable by every principal, so readability is measured HERE rather
-- than discovered at step E with a live credential outstanding.
--
-- ---------------------------------------------------------------------------
-- THE AUTHORITY RULE (PostgreSQL 16+), AND WHY CREATEROLE ALONE IS NOT ENOUGH
-- ---------------------------------------------------------------------------
-- ALTER ROLE <r> PASSWORD requires SUPERUSER, or CREATEROLE *plus* ADMIN OPTION
-- on <r>. PG16 removed the old behaviour where CREATEROLE could alter any
-- non-superuser role. docs/ops/staging/STELLA_MANAGED_SUPABASE_COMPATIBILITY.md
-- §4.4 records the local consequence: a non-superuser CREATEROLE receives
-- ADMIN OPTION automatically over each role it CREATES — which is why the
-- bootstrap's creator holds it over uellix_app — but that is a fact to be
-- MEASURED on this database, not inherited from the document.
--
-- No INSERT/UPDATE/DELETE/DDL. One BEGIN READ ONLY ... ROLLBACK, one SELECT.
-- DO NOT pass -1: this file opens its own transaction.
--
-- NOTE: rolpassword itself is NEVER selected, printed or recorded. Only its
-- SCHEME is derived, exactly as tests/database-role-safety.test.ts:415 does.
-- NULL means scram/md5 authentication is impossible (stella_0004 §9.3).
-- ============================================================================

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(
  'schema', 'uellix.hosted.m8.credential-authority/1',
  'note', 'Read-only authority pre-check. No password value is read, derived or recorded — only its scheme.',
  'measuredBy', 'operator, ADMIN connection, read-only transaction',

  /* -- WHO is asking. ------------------------------------------------------ */
  'adminSessionUser', session_user,
  'adminCurrentUser', current_user,
  'adminIsSuper', (
    SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),
  'adminCanCreateRole', (
    SELECT r.rolcreaterole FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),

  /* -- ADMIN OPTION on uellix_app, measured fresh. -------------------------- */
  'adminHasAdminOptionOnApp', coalesce((
    SELECT m.admin_option
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles tgt ON tgt.oid = m.roleid
    JOIN pg_catalog.pg_roles mem ON mem.oid = m.member
    WHERE tgt.rolname = 'uellix_app' AND mem.rolname = current_user), false),

  /* -- THE TARGET. --------------------------------------------------------- */
  'appRoleExists', (
    SELECT true FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_app'),
  'appCanLogin', (
    SELECT r.rolcanlogin FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_app'),
  'appIsSuper', (
    SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_app'),

  /* -- CAN WE PROVE THE CLOSE? --------------------------------------------- */
  -- Asked before reading, so a denied read reports as false instead of
  -- aborting the probe.
  'pgAuthidReadable', pg_catalog.has_table_privilege(
                        current_user, 'pg_catalog.pg_authid', 'SELECT'),

  -- Scheme only, never the hash. Expected NULL right now: uellix_app has never
  -- carried a credential on this project.
  'appPasswordSchemeBefore', (
    SELECT CASE
             WHEN a.rolpassword IS NULL                THEN NULL
             WHEN a.rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'scram'
             WHEN a.rolpassword LIKE 'md5%'            THEN 'md5'
             ELSE 'other'
           END
    FROM pg_catalog.pg_authid a
    WHERE a.rolname = 'uellix_app'
      AND pg_catalog.has_table_privilege(current_user, 'pg_catalog.pg_authid', 'SELECT')),

  /* -- THE VERDICT, derived here rather than asserted by an operator. ------- */
  'authorityToSetAppPassword', (
    SELECT coalesce(me.rolsuper, false)
        OR (coalesce(me.rolcreaterole, false) AND coalesce((
              SELECT m.admin_option
              FROM pg_catalog.pg_auth_members m
              JOIN pg_catalog.pg_roles tgt ON tgt.oid = m.roleid
              JOIN pg_catalog.pg_roles mem ON mem.oid = m.member
              WHERE tgt.rolname = 'uellix_app' AND mem.rolname = current_user), false))
    FROM pg_catalog.pg_roles me WHERE me.rolname = current_user)
));

ROLLBACK;
