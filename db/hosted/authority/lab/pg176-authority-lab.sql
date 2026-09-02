-- db/hosted/authority/lab/pg176-authority-lab.sql
-- COMMIT 3 — the disposable PostgreSQL 17.6 laboratory.
--
-- WHY THIS FILE EXISTS
-- The authority primitives make claims about what PostgreSQL does with role
-- membership, and this repository has been wrong about exactly that before:
-- Train 5A assumed a CREATEROLE installer could SET ROLE into a role it had
-- just created, and PostgreSQL 16+ grants ADMIN OPTION without set_option, so
-- the whole chain aborted on the first package. Assumptions about role
-- mechanics get measured here or they do not get made.
--
-- HOW IT IS RUN
--   image     public.ecr.aws/supabase/postgres:17.6.1.143
--   network   none
--   mounts    none
--   lifetime  destroyed immediately afterwards
--
-- It is never pointed at a development database. Every statement below CREATEs
-- and DROPs roles, and a role name collision in a real database would be a
-- silent, destructive edit to something in use.

\set ON_ERROR_STOP on

SELECT current_setting('server_version')     AS server_version,
       current_setting('server_version_num') AS server_version_num;
SELECT current_setting('createrole_self_grant', true) AS createrole_self_grant;

-- ---------------------------------------------------------------------------
-- Cast: the shapes the hosted chain actually uses.
-- ---------------------------------------------------------------------------
CREATE ROLE lab_owner     NOLOGIN NOINHERIT;
CREATE ROLE lab_cap       NOLOGIN NOINHERIT;
CREATE ROLE lab_provider  NOLOGIN CREATEROLE;
CREATE ROLE lab_installer LOGIN NOINHERIT CREATEROLE PASSWORD 'lab';

-- ===========================================================================
-- M1 — what a membership row actually contains
-- ===========================================================================
\echo '--- M1 membership row shape ---'
GRANT lab_owner TO lab_installer WITH INHERIT FALSE, SET TRUE;

SELECT 'M1' AS measurement,
       roleid::regrole  AS role,
       member::regrole  AS member,
       grantor::regrole AS grantor,
       admin_option, inherit_option, set_option
FROM pg_auth_members
WHERE roleid = 'lab_owner'::regrole
ORDER BY grantor::regrole::text;

-- ===========================================================================
-- M2 — can a provider-granted membership and a temporary one COEXIST?
-- ===========================================================================
-- This is the question that decides whether the cleanup primitive may revoke
-- unconditionally. If two grantors can hold two rows, an unconditional revoke
-- would destroy a membership the provider owns and this code did not create.
\echo '--- M2 provider + temporary membership coexistence ---'
GRANT lab_owner TO lab_provider WITH ADMIN OPTION;

-- MEASURED, and it is the Train 5A failure in miniature: creating a role gives
-- the creator ADMIN OPTION and set_option = FALSE (see M1), so `postgres`
-- cannot SET ROLE into a role it just created until it grants itself SET. The
-- first draft of this lab omitted this line and died with
-- `permission denied to set role "lab_provider"` — which is the same error the
-- chain hit in staging, reproduced here in four statements.
GRANT lab_provider TO postgres WITH INHERIT FALSE, SET TRUE;

SET ROLE lab_provider;
GRANT lab_owner TO lab_installer WITH SET TRUE;
RESET ROLE;

SELECT 'M2' AS measurement,
       count(*) AS membership_rows_for_installer,
       string_agg(grantor::regrole::text, ',' ORDER BY grantor::regrole::text) AS grantors
FROM pg_auth_members
WHERE roleid = 'lab_owner'::regrole AND member = 'lab_installer'::regrole;

-- ===========================================================================
-- M3 — is REVOKE ... GRANTED BY scoped to one grantor's row?
-- ===========================================================================
\echo '--- M3 scoped revoke ---'
-- M3a. An UNQUALIFIED revoke, issued by one of the two grantors. The question
-- the cleanup primitive depends on: does it remove every row, or only the
-- issuer's? If it removed both, cleanup could never be made safe, because the
-- installer would have no way to stand down without destroying a membership the
-- provider owns and this code never created.
REVOKE lab_owner FROM lab_installer;

SELECT 'M3a' AS measurement,
       count(*) AS rows_remaining,
       string_agg(grantor::regrole::text, ',' ORDER BY grantor::regrole::text) AS grantors_remaining
FROM pg_auth_members
WHERE roleid = 'lab_owner'::regrole AND member = 'lab_installer'::regrole;

-- M3b. MEASURED on the first run of this lab: `REVOKE ... GRANTED BY r` is
-- refused unless the revoker holds the PRIVILEGES of r — membership with
-- INHERIT FALSE is not enough. That is a safety property, not an obstacle: an
-- installer cannot reach a provider's membership row even by naming it. A
-- grantor revoking its own row always can, because a role always holds its own
-- privileges.
SET ROLE lab_provider;
REVOKE lab_owner FROM lab_installer GRANTED BY lab_provider;
RESET ROLE;

SELECT 'M3b' AS measurement,
       count(*) AS rows_remaining,
       coalesce(string_agg(grantor::regrole::text, ','), '(none)') AS grantors_remaining
FROM pg_auth_members
WHERE roleid = 'lab_owner'::regrole AND member = 'lab_installer'::regrole;

-- Restore the installer's own membership for the measurements that follow.
GRANT lab_owner TO lab_installer WITH INHERIT FALSE, SET TRUE;

-- ===========================================================================
-- M4 — transitive SET reachability: false -> true -> false
-- ===========================================================================
-- The claim under test: membership in an intermediate role with SET TRUE makes
-- every role THAT role can SET reachable too. If it does, a window that grants
-- membership in one harmless-looking role can reach an owner role transitively,
-- and a review that only read the direct grants would not have seen it.
\echo '--- M4 transitive SET reachability ---'
CREATE ROLE lab_middle NOLOGIN NOINHERIT;

SELECT 'M4a' AS measurement, 'before any grant' AS state,
       pg_has_role('lab_installer', 'lab_middle', 'SET')   AS can_set_middle,
       pg_has_role('lab_installer', 'lab_cap', 'SET')      AS can_set_cap;

GRANT lab_cap    TO lab_middle    WITH SET TRUE;
GRANT lab_middle TO lab_installer WITH SET TRUE;

SELECT 'M4b' AS measurement, 'after chained grants' AS state,
       pg_has_role('lab_installer', 'lab_middle', 'SET')   AS can_set_middle,
       pg_has_role('lab_installer', 'lab_cap', 'SET')      AS can_set_cap;

REVOKE lab_middle FROM lab_installer;

SELECT 'M4c' AS measurement, 'after revoking the intermediate' AS state,
       pg_has_role('lab_installer', 'lab_middle', 'SET')   AS can_set_middle,
       pg_has_role('lab_installer', 'lab_cap', 'SET')      AS can_set_cap;

-- ===========================================================================
-- M5 — temporary schema CREATE lifecycle
-- ===========================================================================
-- Does an object created while CREATE was held SURVIVE the revoke, and does the
-- role provably lose the ability to create more? Both halves matter: the first
-- is why the temporary grant is safe, the second is why it must be revoked.
\echo '--- M5 temporary schema CREATE lifecycle ---'
CREATE SCHEMA lab_schema AUTHORIZATION lab_owner;
GRANT lab_cap TO lab_installer WITH SET TRUE;
-- The lab session runs as `postgres`, which created lab_cap and therefore holds
-- ADMIN OPTION with set_option = FALSE (M1). It needs SET explicitly, exactly
-- as the hosted bootstrap needs it for uellix_owner.
GRANT lab_cap TO postgres WITH INHERIT FALSE, SET TRUE;

SELECT 'M5a' AS measurement, has_schema_privilege('lab_cap', 'lab_schema', 'CREATE') AS cap_has_create;

-- MEASURED: the temporary CREATE grant cannot be issued by the installer. The
-- schema is owned by lab_owner, and an unqualified GRANT from a role that only
-- HOLDS MEMBERSHIP in the owner (INHERIT FALSE) is refused with
-- `permission denied for schema lab_schema`. So the grant that opens a
-- capability window must itself be issued INSIDE an owner window — the temp
-- schema CREATE lifecycle is nested, not sequential, and a primitive that
-- issued it as the installer would fail at apply time.
SET ROLE lab_owner;
GRANT CREATE ON SCHEMA lab_schema TO lab_cap;
RESET ROLE;

SELECT 'M5b' AS measurement, has_schema_privilege('lab_cap', 'lab_schema', 'CREATE') AS cap_has_create;

SET ROLE lab_cap;
CREATE FUNCTION lab_schema.made_by_cap() RETURNS int LANGUAGE sql AS 'SELECT 1';
RESET ROLE;

SET ROLE lab_owner;
REVOKE CREATE ON SCHEMA lab_schema FROM lab_cap;
RESET ROLE;

SELECT 'M5c' AS measurement,
       has_schema_privilege('lab_cap', 'lab_schema', 'CREATE') AS cap_has_create,
       -- Looked up through pg_namespace rather than by a `::regprocedure` cast:
       -- the cast needs USAGE on the schema, which the installer deliberately
       -- does not hold, and the measurement must not require a privilege the
       -- real installer would not have.
       (SELECT pg_get_userbyid(p.proowner)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'lab_schema' AND p.proname = 'made_by_cap') AS surviving_owner;

-- The second half: with CREATE revoked, a further creation must fail.
DO $$
BEGIN
  SET LOCAL ROLE lab_cap;
  BEGIN
    EXECUTE 'CREATE FUNCTION lab_schema.should_fail() RETURNS int LANGUAGE sql AS ''SELECT 1''';
    RAISE NOTICE 'M5d: UNEXPECTED — creation succeeded after CREATE was revoked';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'M5d: creation refused after revoke, SQLSTATE 42501 as expected';
  END;
END $$;

-- ===========================================================================
-- M6 — RESET ROLE is not a stack
-- ===========================================================================
-- The primitive must never assume nesting: `SET ROLE a; SET ROLE b; RESET ROLE`
-- returns to the SESSION role, not to `a`. A cleanup that assumed a stack would
-- leave the session elevated and believe it had stood down.
\echo '--- M6 RESET ROLE semantics ---'
SET ROLE lab_owner;
SET ROLE lab_cap;
SELECT 'M6a' AS measurement, current_user AS current_user_after_two_sets, session_user;
RESET ROLE;
SELECT 'M6b' AS measurement, current_user AS current_user_after_reset, session_user;

-- ===========================================================================
-- M7 — direct SET transitions, and what CURRENT_USER resolves to mid-window
-- ===========================================================================
-- RT-09's premise: inside an owner window, CURRENT_USER is the ELEVATED role.
-- A membership statement naming CURRENT_USER would therefore grant to whoever
-- the window happens to be acting as — which is never what the text appears to
-- say when it is read outside the window.
\echo '--- M7 CURRENT_USER inside a window ---'
SET ROLE lab_owner;
SELECT 'M7' AS measurement,
       current_user  AS current_user_in_window,
       session_user  AS session_user_in_window,
       current_role  AS current_role_in_window;
RESET ROLE;

\echo '--- lab complete ---'
