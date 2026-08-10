-- db/hosted/authority/lab/pg176-transfer-lab.sql
-- COMMIT 3.3 — the ownership-transfer lifecycle, measured.
--
-- WHY THIS FILE EXISTS
-- The first ownerTransferPrimitive could not execute a single one of the 27
-- ownership transfers, and nothing in the test suite could have told us:
-- every check was about the SHAPE of the emitted SQL, and the SQL was
-- well-formed. It was PostgreSQL that refused it, and only PostgreSQL could
-- have said so. Two independent checks are involved and the primitive
-- satisfied neither:
--
--   "must be owner of function"      -> pg_proc_ownercheck -> has_privs_of_role
--                                       which requires INHERIT, not membership
--   "must be able to SET ROLE <new>" -> the EXECUTING role must be a member of
--                                       the incoming owner
--
-- The installer holds uellix_owner with INHERIT FALSE on purpose, so it can
-- never satisfy the first. uellix_owner is not a member of any capability role,
-- so it can never satisfy the second. The measured resolution (case G) gives
-- the SECOND condition to the owner, temporarily, and leaves the first where it
-- already was.
--
-- HOW IT IS RUN
--   image     public.ecr.aws/supabase/postgres:17.6.1.143
--   network   none
--   mounts    none
--   lifetime  destroyed immediately afterwards
--
-- The topology mirrors the real chain: a provider role holds a membership this
-- code did not create and must not disturb; the installer holds CREATEROLE and
-- creates the capability role, so it holds ADMIN OPTION on it (lab M1); the
-- owner owns the schema and the routine.

\set ON_ERROR_STOP on

SELECT current_setting('server_version') AS server_version,
       current_setting('server_version_num') AS server_version_num,
       coalesce(current_setting('createrole_self_grant', true), '(unset)') AS createrole_self_grant;

-- ---------------------------------------------------------------------------
-- Topology
-- ---------------------------------------------------------------------------
CREATE ROLE lab_provider NOLOGIN NOINHERIT CREATEROLE;
CREATE ROLE lab_owner    NOLOGIN NOINHERIT;
CREATE ROLE lab_inst     NOLOGIN NOINHERIT CREATEROLE;
CREATE ROLE lab_app      NOLOGIN;              -- runtime; must never gain a path
CREATE ROLE lab_writer   NOLOGIN;              -- runtime; must never gain a path

-- The session needs SET on both to act as them; in the real chain the session
-- user IS the installer, so this is lab scaffolding, not part of the model.
GRANT lab_owner TO postgres WITH INHERIT FALSE, SET TRUE;
GRANT lab_inst  TO postgres WITH INHERIT FALSE, SET TRUE;

-- The PROVIDER row: a membership this code did not create. It must survive.
GRANT lab_provider TO postgres WITH INHERIT FALSE, SET TRUE;
SET ROLE lab_provider;
CREATE ROLE lab_provider_cap NOLOGIN NOINHERIT;
GRANT lab_provider_cap TO lab_inst WITH INHERIT FALSE, SET TRUE;
RESET ROLE;

-- The installer's persistent membership in the owner: INHERIT FALSE, on purpose.
GRANT lab_owner TO lab_inst WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA lab_s AUTHORIZATION lab_owner;
SET ROLE lab_owner;
CREATE FUNCTION lab_s.f() RETURNS int LANGUAGE sql AS 'SELECT 1';
CREATE FUNCTION lab_s.g() RETURNS int LANGUAGE sql AS 'SELECT 2';
-- Left owned by lab_owner for the failure-point section. One function is
-- enough: every failure-point transaction rolls back, so it returns to
-- lab_owner each time and the next probe starts from the same state.
CREATE FUNCTION lab_s.h() RETURNS int LANGUAGE sql AS 'SELECT 3';
RESET ROLE;

-- The installer creates the capability role, so it holds ADMIN OPTION on it.
SET ROLE lab_inst;
CREATE ROLE lab_cap       NOLOGIN NOINHERIT;
CREATE ROLE lab_other_cap NOLOGIN NOINHERIT;   -- an unrelated capability role
RESET ROLE;

-- ===========================================================================
-- BEFORE
-- ===========================================================================
\echo '--- T-BEFORE reachability and privileges ---'
SELECT 'T-BEFORE' AS phase,
       pg_has_role('lab_inst',   'lab_cap',       'SET') AS installer_to_cap,
       pg_has_role('lab_owner',  'lab_cap',       'SET') AS owner_to_cap,
       pg_has_role('lab_app',    'lab_cap',       'SET') AS app_to_cap,
       pg_has_role('lab_writer', 'lab_cap',       'SET') AS writer_to_cap,
       pg_has_role('lab_inst',   'lab_other_cap', 'SET') AS installer_to_other_cap,
       has_schema_privilege('lab_cap', 'lab_s', 'CREATE') AS cap_schema_create,
       pg_get_userbyid((SELECT proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'lab_s' AND p.proname = 'f')) AS f_owner;

SELECT 'T-BEFORE-provider' AS phase, count(*) AS provider_rows
FROM pg_auth_members
WHERE roleid = 'lab_provider_cap'::regrole AND member = 'lab_inst'::regrole;

-- ===========================================================================
-- DURING — the case-G lifecycle, in the pinned order
-- ===========================================================================
\echo '--- T-DURING: installer grants the TARGET to the OWNER ---'
SET ROLE lab_inst;
GRANT lab_cap TO lab_owner WITH INHERIT FALSE, SET TRUE;
RESET ROLE;

-- (A) the exact temporary row
SELECT 'A-temp-row' AS measurement,
       roleid::regrole AS role, member::regrole AS member, grantor::regrole AS grantor,
       admin_option, inherit_option, set_option
FROM pg_auth_members
WHERE roleid = 'lab_cap'::regrole AND member = 'lab_owner'::regrole;

-- (B, C) reachability while the lifecycle is open
SELECT 'B-during' AS measurement,
       pg_has_role('lab_inst',   'lab_cap',       'SET') AS installer_to_cap,
       pg_has_role('lab_owner',  'lab_cap',       'SET') AS owner_to_cap,
       pg_has_role('lab_app',    'lab_cap',       'SET') AS app_to_cap,
       pg_has_role('lab_writer', 'lab_cap',       'SET') AS writer_to_cap,
       pg_has_role('lab_inst',   'lab_other_cap', 'SET') AS installer_to_other_cap;

-- (D) the provider row is untouched
SELECT 'D-provider-during' AS measurement, count(*) AS provider_rows,
       string_agg(grantor::regrole::text, ',') AS grantors
FROM pg_auth_members
WHERE roleid = 'lab_provider_cap'::regrole AND member = 'lab_inst'::regrole;

\echo '--- owner phase: schema CREATE, then the transfers, then revoke ---'
SET ROLE lab_owner;
GRANT CREATE ON SCHEMA lab_s TO lab_cap;
SELECT 'E-create-during' AS measurement,
       has_schema_privilege('lab_cap', 'lab_s', 'CREATE') AS cap_schema_create;

-- (F) the transfers themselves, in canonical order
ALTER FUNCTION lab_s.f() OWNER TO lab_cap;
ALTER FUNCTION lab_s.g() OWNER TO lab_cap;

REVOKE CREATE ON SCHEMA lab_s FROM lab_cap;
RESET ROLE;

SELECT 'F-transfer' AS measurement,
       (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lab_s' AND p.proname = 'f') AS f_owner,
       (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lab_s' AND p.proname = 'g') AS g_owner;

\echo '--- installer cleanup: revoke the temporary membership ---'
SET ROLE lab_inst;
REVOKE lab_cap FROM lab_owner;
RESET ROLE;

-- ===========================================================================
-- AFTER
-- ===========================================================================
\echo '--- T-AFTER ---'
SELECT 'G-cleanup' AS measurement,
       (SELECT count(*) FROM pg_auth_members
        WHERE roleid = 'lab_cap'::regrole AND member = 'lab_owner'::regrole) AS temp_membership_rows,
       has_schema_privilege('lab_cap', 'lab_s', 'CREATE') AS cap_schema_create,
       pg_has_role('lab_inst',  'lab_cap', 'SET') AS installer_to_cap,
       pg_has_role('lab_owner', 'lab_cap', 'SET') AS owner_to_cap,
       pg_has_role('lab_app',   'lab_cap', 'SET') AS app_to_cap;

SELECT 'D-provider-after' AS measurement, count(*) AS provider_rows,
       string_agg(grantor::regrole::text, ',') AS grantors
FROM pg_auth_members
WHERE roleid = 'lab_provider_cap'::regrole AND member = 'lab_inst'::regrole;

SELECT 'H-current-role' AS measurement, current_user, session_user;

-- ===========================================================================
-- ROLLBACK and FAILURE POINTS
-- ===========================================================================
-- Seven transactions, each aborting one step later in the lifecycle. After each
-- ROLLBACK the persistent state is PROBED — not inferred from the fact that the
-- transaction ended. A lifecycle that left a membership row or a schema grant
-- behind on one of these paths would be invisible to any check that only looked
-- at the emitted SQL.
\echo '--- FAILURE POINTS 1..7, each rolled back and then probed ---'

-- Each of these RAISEs on purpose, so psql must not stop on the first one.
\set ON_ERROR_STOP off

-- 1. fail right after the membership grant
BEGIN;
  SET LOCAL ROLE lab_inst;
  GRANT lab_cap TO lab_owner WITH INHERIT FALSE, SET TRUE;
  DO $$ BEGIN RAISE EXCEPTION 'fail-point 1'; END $$;
ROLLBACK;

-- 2. fail after entering the owner phase
BEGIN;
  SET LOCAL ROLE lab_inst;
  GRANT lab_cap TO lab_owner WITH INHERIT FALSE, SET TRUE;
  SET LOCAL ROLE lab_owner;
  DO $$ BEGIN RAISE EXCEPTION 'fail-point 2'; END $$;
ROLLBACK;

-- 3. fail after the temporary schema CREATE
BEGIN;
  SET LOCAL ROLE lab_inst;
  GRANT lab_cap TO lab_owner WITH INHERIT FALSE, SET TRUE;
  SET LOCAL ROLE lab_owner;
  GRANT CREATE ON SCHEMA lab_s TO lab_cap;
  DO $$ BEGIN RAISE EXCEPTION 'fail-point 3'; END $$;
ROLLBACK;

-- 4. fail after the FIRST transfer, with a second one still pending
BEGIN;
  SET LOCAL ROLE lab_inst;
  GRANT lab_cap TO lab_owner WITH INHERIT FALSE, SET TRUE;
  SET LOCAL ROLE lab_owner;
  GRANT CREATE ON SCHEMA lab_s TO lab_cap;
  ALTER FUNCTION lab_s.h() OWNER TO lab_cap;
  DO $$ BEGIN RAISE EXCEPTION 'fail-point 4'; END $$;
ROLLBACK;

-- 5. fail after revoking the temporary schema CREATE
BEGIN;
  SET LOCAL ROLE lab_inst;
  GRANT lab_cap TO lab_owner WITH INHERIT FALSE, SET TRUE;
  SET LOCAL ROLE lab_owner;
  GRANT CREATE ON SCHEMA lab_s TO lab_cap;
  ALTER FUNCTION lab_s.h() OWNER TO lab_cap;
  REVOKE CREATE ON SCHEMA lab_s FROM lab_cap;
  DO $$ BEGIN RAISE EXCEPTION 'fail-point 5'; END $$;
ROLLBACK;

-- 6. fail after returning to the installer
BEGIN;
  SET LOCAL ROLE lab_inst;
  GRANT lab_cap TO lab_owner WITH INHERIT FALSE, SET TRUE;
  SET LOCAL ROLE lab_owner;
  GRANT CREATE ON SCHEMA lab_s TO lab_cap;
  ALTER FUNCTION lab_s.h() OWNER TO lab_cap;
  REVOKE CREATE ON SCHEMA lab_s FROM lab_cap;
  SET LOCAL ROLE lab_inst;
  DO $$ BEGIN RAISE EXCEPTION 'fail-point 6'; END $$;
ROLLBACK;

-- 7. fail immediately before the membership revoke — the worst case, because
--    everything the lifecycle acquired is still held at the moment it dies
BEGIN;
  SET LOCAL ROLE lab_inst;
  GRANT lab_cap TO lab_owner WITH INHERIT FALSE, SET TRUE;
  SET LOCAL ROLE lab_owner;
  GRANT CREATE ON SCHEMA lab_s TO lab_cap;
  ALTER FUNCTION lab_s.h() OWNER TO lab_cap;
  REVOKE CREATE ON SCHEMA lab_s FROM lab_cap;
  SET LOCAL ROLE lab_inst;
  DO $$ BEGIN RAISE EXCEPTION 'fail-point 7'; END $$;
ROLLBACK;

\set ON_ERROR_STOP on

SELECT 'ROLLBACK-probe' AS measurement,
       (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lab_s' AND p.proname = 'h') AS h_owner_after_rollbacks,
       (SELECT count(*) FROM pg_auth_members
        WHERE roleid = 'lab_cap'::regrole AND member = 'lab_owner'::regrole) AS temp_membership_rows,
       has_schema_privilege('lab_cap', 'lab_s', 'CREATE') AS cap_schema_create,
       (SELECT count(*) FROM pg_auth_members
        WHERE roleid = 'lab_provider_cap'::regrole AND member = 'lab_inst'::regrole) AS provider_rows,
       pg_has_role('lab_inst', 'lab_cap', 'SET') AS installer_to_cap,
       current_user;

\echo '--- lab complete ---'
