--
-- PostgreSQL database dump
--

\restrict uellix_baseline_g2

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: _realtime; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA _realtime;


ALTER SCHEMA _realtime OWNER TO postgres;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA auth;


ALTER SCHEMA auth OWNER TO supabase_admin;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: uellix_owner
--

CREATE SCHEMA drizzle;


ALTER SCHEMA drizzle OWNER TO uellix_owner;

--
-- Name: extensions; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA extensions;


ALTER SCHEMA extensions OWNER TO postgres;

--
-- Name: graphql; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA graphql;


ALTER SCHEMA graphql OWNER TO supabase_admin;

--
-- Name: graphql_public; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA graphql_public;


ALTER SCHEMA graphql_public OWNER TO supabase_admin;

--
-- Name: pg_net; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;


--
-- Name: EXTENSION pg_net; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_net IS 'Async HTTP';


--
-- Name: pgbouncer; Type: SCHEMA; Schema: -; Owner: pgbouncer
--

CREATE SCHEMA pgbouncer;


ALTER SCHEMA pgbouncer OWNER TO pgbouncer;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'Uellix application schema. Objects are owned by uellix_owner (prepared stella_0004). Migrations run as uellix_migrator with an explicit SET ROLE uellix_owner; the application runtime holds no ownership. See docs/ops/DATABASE_ROLE_MODEL.md.';


--
-- Name: realtime; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA realtime;


ALTER SCHEMA realtime OWNER TO supabase_admin;

--
-- Name: storage; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA storage;


ALTER SCHEMA storage OWNER TO supabase_admin;

--
-- Name: supabase_functions; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA supabase_functions;


ALTER SCHEMA supabase_functions OWNER TO supabase_admin;

--
-- Name: supabase_migrations; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA supabase_migrations;


ALTER SCHEMA supabase_migrations OWNER TO postgres;

--
-- Name: vault; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA vault;


ALTER SCHEMA vault OWNER TO supabase_admin;

--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: supabase_vault; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;


--
-- Name: EXTENSION supabase_vault; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION supabase_vault IS 'Supabase Vault Extension';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: aal_level; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.aal_level AS ENUM (
    'aal1',
    'aal2',
    'aal3'
);


ALTER TYPE auth.aal_level OWNER TO supabase_auth_admin;

--
-- Name: code_challenge_method; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.code_challenge_method AS ENUM (
    's256',
    'plain'
);


ALTER TYPE auth.code_challenge_method OWNER TO supabase_auth_admin;

--
-- Name: factor_status; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.factor_status AS ENUM (
    'unverified',
    'verified'
);


ALTER TYPE auth.factor_status OWNER TO supabase_auth_admin;

--
-- Name: factor_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.factor_type AS ENUM (
    'totp',
    'webauthn',
    'phone'
);


ALTER TYPE auth.factor_type OWNER TO supabase_auth_admin;

--
-- Name: oauth_authorization_status; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.oauth_authorization_status AS ENUM (
    'pending',
    'approved',
    'denied',
    'expired'
);


ALTER TYPE auth.oauth_authorization_status OWNER TO supabase_auth_admin;

--
-- Name: oauth_client_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.oauth_client_type AS ENUM (
    'public',
    'confidential'
);


ALTER TYPE auth.oauth_client_type OWNER TO supabase_auth_admin;

--
-- Name: oauth_registration_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.oauth_registration_type AS ENUM (
    'dynamic',
    'manual'
);


ALTER TYPE auth.oauth_registration_type OWNER TO supabase_auth_admin;

--
-- Name: oauth_response_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.oauth_response_type AS ENUM (
    'code'
);


ALTER TYPE auth.oauth_response_type OWNER TO supabase_auth_admin;

--
-- Name: one_time_token_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
);


ALTER TYPE auth.one_time_token_type OWNER TO supabase_auth_admin;

--
-- Name: action; Type: TYPE; Schema: realtime; Owner: supabase_admin
--

CREATE TYPE realtime.action AS ENUM (
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'ERROR'
);


ALTER TYPE realtime.action OWNER TO supabase_admin;

--
-- Name: equality_op; Type: TYPE; Schema: realtime; Owner: supabase_admin
--

CREATE TYPE realtime.equality_op AS ENUM (
    'eq',
    'neq',
    'lt',
    'lte',
    'gt',
    'gte',
    'in',
    'like',
    'ilike',
    'is',
    'match',
    'imatch',
    'isdistinct'
);


ALTER TYPE realtime.equality_op OWNER TO supabase_admin;

--
-- Name: user_defined_filter; Type: TYPE; Schema: realtime; Owner: supabase_admin
--

CREATE TYPE realtime.user_defined_filter AS (
	column_name text,
	op realtime.equality_op,
	value text,
	negate boolean
);


ALTER TYPE realtime.user_defined_filter OWNER TO supabase_admin;

--
-- Name: wal_column; Type: TYPE; Schema: realtime; Owner: supabase_admin
--

CREATE TYPE realtime.wal_column AS (
	name text,
	type_name text,
	type_oid oid,
	value jsonb,
	is_pkey boolean,
	is_selectable boolean
);


ALTER TYPE realtime.wal_column OWNER TO supabase_admin;

--
-- Name: wal_rls; Type: TYPE; Schema: realtime; Owner: supabase_admin
--

CREATE TYPE realtime.wal_rls AS (
	wal jsonb,
	is_rls_enabled boolean,
	subscription_ids uuid[],
	errors text[]
);


ALTER TYPE realtime.wal_rls OWNER TO supabase_admin;

--
-- Name: buckettype; Type: TYPE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TYPE storage.buckettype AS ENUM (
    'STANDARD',
    'ANALYTICS',
    'VECTOR'
);


ALTER TYPE storage.buckettype OWNER TO supabase_storage_admin;

--
-- Name: email(); Type: FUNCTION; Schema: auth; Owner: supabase_auth_admin
--

CREATE FUNCTION auth.email() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;


ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;

--
-- Name: FUNCTION email(); Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON FUNCTION auth.email() IS 'Deprecated. Use auth.jwt() -> ''email'' instead.';


--
-- Name: jwt(); Type: FUNCTION; Schema: auth; Owner: supabase_auth_admin
--

CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$;


ALTER FUNCTION auth.jwt() OWNER TO supabase_auth_admin;

--
-- Name: role(); Type: FUNCTION; Schema: auth; Owner: supabase_auth_admin
--

CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;


ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin;

--
-- Name: FUNCTION role(); Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON FUNCTION auth.role() IS 'Deprecated. Use auth.jwt() -> ''role'' instead.';


--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: supabase_auth_admin
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;


ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;

--
-- Name: FUNCTION uid(); Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON FUNCTION auth.uid() IS 'Deprecated. Use auth.jwt() -> ''sub'' instead.';


--
-- Name: grant_pg_cron_access(); Type: FUNCTION; Schema: extensions; Owner: supabase_admin
--

CREATE FUNCTION extensions.grant_pg_cron_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_cron'
  )
  THEN
    grant usage on schema cron to postgres with grant option;

    alter default privileges in schema cron grant all on tables to postgres with grant option;
    alter default privileges in schema cron grant all on functions to postgres with grant option;
    alter default privileges in schema cron grant all on sequences to postgres with grant option;

    alter default privileges for user supabase_admin in schema cron grant all
        on sequences to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on tables to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on functions to postgres with grant option;

    grant all privileges on all tables in schema cron to postgres with grant option;
    revoke all on table cron.job from postgres;
    grant select on table cron.job to postgres with grant option;
  END IF;
END;
$$;


ALTER FUNCTION extensions.grant_pg_cron_access() OWNER TO supabase_admin;

--
-- Name: FUNCTION grant_pg_cron_access(); Type: COMMENT; Schema: extensions; Owner: supabase_admin
--

COMMENT ON FUNCTION extensions.grant_pg_cron_access() IS 'Grants access to pg_cron';


--
-- Name: grant_pg_graphql_access(); Type: FUNCTION; Schema: extensions; Owner: supabase_admin
--

CREATE FUNCTION extensions.grant_pg_graphql_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $_$
begin
    if not exists (
        select 1
        from pg_event_trigger_ddl_commands() ev
        join pg_catalog.pg_extension e on ev.objid = e.oid
        where e.extname = 'pg_graphql'
    ) then
        return;
    end if;

    drop function if exists graphql_public.graphql;
    create or replace function graphql_public.graphql(
        "operationName" text default null,
        query text default null,
        variables jsonb default null,
        extensions jsonb default null
    )
        returns jsonb
        language sql
    as $$
        select graphql.resolve(
            query := query,
            variables := coalesce(variables, '{}'),
            "operationName" := "operationName",
            extensions := extensions
        );
    $$;

    -- Attach the wrapper to the extension so DROP EXTENSION cascades to it,
    -- which in turn triggers set_graphql_placeholder to reinstall the "not enabled" stub.
    alter extension pg_graphql add function graphql_public.graphql(text, text, jsonb, jsonb);

    grant usage on schema graphql to postgres, anon, authenticated, service_role;
    grant execute on function graphql.resolve to postgres, anon, authenticated, service_role;
    grant usage on schema graphql to postgres with grant option;
    grant usage on schema graphql_public to postgres with grant option;
end;
$_$;


ALTER FUNCTION extensions.grant_pg_graphql_access() OWNER TO supabase_admin;

--
-- Name: FUNCTION grant_pg_graphql_access(); Type: COMMENT; Schema: extensions; Owner: supabase_admin
--

COMMENT ON FUNCTION extensions.grant_pg_graphql_access() IS 'Grants access to pg_graphql';


--
-- Name: grant_pg_net_access(); Type: FUNCTION; Schema: extensions; Owner: supabase_admin
--

CREATE FUNCTION extensions.grant_pg_net_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_net'
  )
  THEN
    GRANT USAGE ON SCHEMA net TO supabase_functions_admin, postgres, anon, authenticated, service_role;

    ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;
    ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;

    ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;
    ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;

    REVOKE ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;

    GRANT EXECUTE ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
  END IF;
END;
$$;


ALTER FUNCTION extensions.grant_pg_net_access() OWNER TO supabase_admin;

--
-- Name: FUNCTION grant_pg_net_access(); Type: COMMENT; Schema: extensions; Owner: supabase_admin
--

COMMENT ON FUNCTION extensions.grant_pg_net_access() IS 'Grants access to pg_net';


--
-- Name: pgrst_ddl_watch(); Type: FUNCTION; Schema: extensions; Owner: supabase_admin
--

CREATE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE', 'ALTER TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$;


ALTER FUNCTION extensions.pgrst_ddl_watch() OWNER TO supabase_admin;

--
-- Name: pgrst_drop_watch(); Type: FUNCTION; Schema: extensions; Owner: supabase_admin
--

CREATE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type IN (
      'schema'
    , 'table'
    , 'foreign table'
    , 'view'
    , 'materialized view'
    , 'function'
    , 'trigger'
    , 'type'
    , 'rule'
    )
    AND obj.is_temporary IS false -- no pg_temp objects
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$;


ALTER FUNCTION extensions.pgrst_drop_watch() OWNER TO supabase_admin;

--
-- Name: set_graphql_placeholder(); Type: FUNCTION; Schema: extensions; Owner: supabase_admin
--

CREATE FUNCTION extensions.set_graphql_placeholder() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $_$
    DECLARE
    graphql_is_dropped bool;
    BEGIN
    graphql_is_dropped = (
        SELECT ev.schema_name = 'graphql_public'
        FROM pg_event_trigger_dropped_objects() AS ev
        WHERE ev.schema_name = 'graphql_public'
    );

    IF graphql_is_dropped
    THEN
        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null
        )
            returns jsonb
            language plpgsql
        as $$
            DECLARE
                server_version float;
            BEGIN
                server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

                IF server_version >= 14 THEN
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql extension is not enabled.'
                            )
                        )
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql is only available on projects running Postgres 14 onwards.'
                            )
                        )
                    );
                END IF;
            END;
        $$;
    END IF;

    END;
$_$;


ALTER FUNCTION extensions.set_graphql_placeholder() OWNER TO supabase_admin;

--
-- Name: FUNCTION set_graphql_placeholder(); Type: COMMENT; Schema: extensions; Owner: supabase_admin
--

COMMENT ON FUNCTION extensions.set_graphql_placeholder() IS 'Reintroduces placeholder function for graphql_public.graphql';


--
-- Name: graphql(text, text, jsonb, jsonb); Type: FUNCTION; Schema: graphql_public; Owner: supabase_admin
--

CREATE FUNCTION graphql_public.graphql("operationName" text DEFAULT NULL::text, query text DEFAULT NULL::text, variables jsonb DEFAULT NULL::jsonb, extensions jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
            DECLARE
                server_version float;
            BEGIN
                server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

                IF server_version >= 14 THEN
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql extension is not enabled.'
                            )
                        )
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql is only available on projects running Postgres 14 onwards.'
                            )
                        )
                    );
                END IF;
            END;
        $$;


ALTER FUNCTION graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb) OWNER TO supabase_admin;

--
-- Name: get_auth(text); Type: FUNCTION; Schema: pgbouncer; Owner: supabase_admin
--

CREATE FUNCTION pgbouncer.get_auth(p_usename text) RETURNS TABLE(username text, password text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
begin
    raise debug 'PgBouncer auth request: %', p_usename;

    return query
    select 
        rolname::text, 
        case when rolvaliduntil < now() 
            then null 
            else rolpassword::text 
        end 
    from pg_authid 
    where rolname=$1 and rolcanlogin;
end;
$_$;


ALTER FUNCTION pgbouncer.get_auth(p_usename text) OWNER TO supabase_admin;

--
-- Name: can_read_evidence_object(text, uuid); Type: FUNCTION; Schema: public; Owner: uellix_owner
--

CREATE FUNCTION public.can_read_evidence_object(object_name text, user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    project_id_str text;
    has_access boolean;
BEGIN
    -- Avoid executing if tables do not exist yet (during initial Supabase start)
    IF to_regclass('public.projects') IS NULL OR to_regclass('public.organization_members') IS NULL THEN
        RETURN false;
    END IF;

    -- Extract project ID from path: projectId/evidenceId/filename
    project_id_str := (storage.foldername(object_name))[1];
    IF project_id_str IS NULL OR project_id_str = '' THEN
        RETURN false;
    END IF;

    -- Validate access: any active member of the organization that owns the project
    SELECT EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.organization_members om ON om.organization_id = p.organization_id
        WHERE 
            p.id::text = project_id_str AND
            om.user_id = can_read_evidence_object.user_id AND
            om.status = 'active'
    ) INTO has_access;

    RETURN has_access;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;


ALTER FUNCTION public.can_read_evidence_object(object_name text, user_id uuid) OWNER TO uellix_owner;

--
-- Name: can_write_evidence_object(text, uuid); Type: FUNCTION; Schema: public; Owner: uellix_owner
--

CREATE FUNCTION public.can_write_evidence_object(object_name text, user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    project_id_str text;
    has_access boolean;
BEGIN
    -- Avoid executing if tables do not exist yet (during initial Supabase start)
    IF to_regclass('public.projects') IS NULL OR to_regclass('public.organization_members') IS NULL THEN
        RETURN false;
    END IF;

    -- Extract project ID from path: projectId/evidenceId/filename
    project_id_str := (storage.foldername(object_name))[1];
    IF project_id_str IS NULL OR project_id_str = '' THEN
        RETURN false;
    END IF;

    -- Validate access: active organization_admin or analyst of the organization
    SELECT EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.organization_members om ON om.organization_id = p.organization_id
        WHERE 
            p.id::text = project_id_str AND
            om.user_id = can_write_evidence_object.user_id AND
            om.status = 'active' AND
            om.role IN ('organization_admin', 'analyst')
    ) INTO has_access;

    RETURN has_access;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;


ALTER FUNCTION public.can_write_evidence_object(object_name text, user_id uuid) OWNER TO uellix_owner;

--
-- Name: current_user_is_super_admin(); Type: FUNCTION; Schema: public; Owner: uellix_owner
--

CREATE FUNCTION public.current_user_is_super_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT COALESCE(
    (SELECT u.is_super_admin FROM public.users u WHERE u.id = auth.uid() LIMIT 1),
    false
  );
$$;


ALTER FUNCTION public.current_user_is_super_admin() OWNER TO uellix_owner;

--
-- Name: current_user_org_ids(); Type: FUNCTION; Schema: public; Owner: uellix_owner
--

CREATE FUNCTION public.current_user_org_ids() RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT ARRAY(
    SELECT om.organization_id
    FROM public.organization_members om
    WHERE om.user_id = auth.uid() AND om.status = 'active'
  );
$$;


ALTER FUNCTION public.current_user_org_ids() OWNER TO uellix_owner;

--
-- Name: current_user_role_in_org(uuid); Type: FUNCTION; Schema: public; Owner: uellix_owner
--

CREATE FUNCTION public.current_user_role_in_org(org_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT om.role
  FROM public.organization_members om
  WHERE om.user_id = auth.uid()
    AND om.organization_id = org_id
    AND om.status = 'active'
  LIMIT 1;
$$;


ALTER FUNCTION public.current_user_role_in_org(org_id uuid) OWNER TO uellix_owner;

--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: uellix_owner
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF new.email IS NULL THEN
    RAISE EXCEPTION 'Registro sin email no soportado en Uellix. (ID: %)', new.id;
  END IF;

  INSERT INTO public.users (id, email, full_name, avatar_url, is_super_admin)
  VALUES (
    new.id, 
    new.email, 
    new.raw_user_meta_data->>'full_name', 
    new.raw_user_meta_data->>'avatar_url', 
    false
  )
  ON CONFLICT (id) DO UPDATE SET 
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    avatar_url = EXCLUDED.avatar_url,
    updated_at = now();

  RETURN new;
END;
$$;


ALTER FUNCTION public.handle_new_user() OWNER TO uellix_owner;

--
-- Name: handle_update_user(); Type: FUNCTION; Schema: public; Owner: uellix_owner
--

CREATE FUNCTION public.handle_update_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF new.email IS NULL THEN
    RAISE EXCEPTION 'Actualización a email NULL no soportada en Uellix. (ID: %)', new.id;
  END IF;

  UPDATE public.users 
  SET 
    email = new.email,
    full_name = new.raw_user_meta_data->>'full_name',
    avatar_url = new.raw_user_meta_data->>'avatar_url',
    updated_at = now()
  WHERE id = new.id;

  RETURN new;
END;
$$;


ALTER FUNCTION public.handle_update_user() OWNER TO uellix_owner;

--
-- Name: uellix_forbid_mutation(); Type: FUNCTION; Schema: public; Owner: uellix_owner
--

CREATE FUNCTION public.uellix_forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;


ALTER FUNCTION public.uellix_forbid_mutation() OWNER TO uellix_owner;

--
-- Name: apply_rls(jsonb, integer); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer DEFAULT (1024 * 1024)) RETURNS SETOF realtime.wal_rls
    LANGUAGE plpgsql
    AS $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_
            -- Filter by action early - only get subscriptions interested in this action
            -- action_filter column can be: '*' (all), 'INSERT', 'UPDATE', or 'DELETE'
            and (subs.action_filter = '*' or subs.action_filter = action::text);

    -- Subscription vars
    working_role regrole;
    working_selected_columns text[];
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

    -- Loop record for iterating unique roles (outer loop)
    role_record record;
    -- Loop record for iterating unique selected_columns within a role (inner loop)
    cols_record record;
    -- Subscription ids visible at the role level (before fanning out by selected_columns)
    visible_role_sub_ids uuid[] = '{}';

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for role_record in
        select claims_role
        from (select distinct claims_role from unnest(subscriptions)) t
        order by claims_role::text
    loop
        working_role := role_record.claims_role;

        -- Update `is_selectable` for columns and old_columns (once per role)
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            -- Fan out 400 error per distinct selected_columns for this role
            for cols_record in
                select selected_columns
                from (select distinct selected_columns from unnest(subscriptions) s where s.claims_role = working_role) t
                order by coalesce(array_to_string(selected_columns, ','), '')
            loop
                working_selected_columns := cols_record.selected_columns;
                return next (
                    jsonb_build_object(
                        'schema', wal ->> 'schema',
                        'table', wal ->> 'table',
                        'type', action
                    ),
                    is_rls_enabled,
                    (select array_agg(s.subscription_id) from unnest(subscriptions) as s where s.claims_role = working_role and (s.selected_columns is not distinct from working_selected_columns)),
                    array['Error 400: Bad Request, no primary key']
                )::realtime.wal_rls;
            end loop;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            -- Fan out 401 error per distinct selected_columns for this role
            for cols_record in
                select selected_columns
                from (select distinct selected_columns from unnest(subscriptions) s where s.claims_role = working_role) t
                order by coalesce(array_to_string(selected_columns, ','), '')
            loop
                working_selected_columns := cols_record.selected_columns;
                return next (
                    jsonb_build_object(
                        'schema', wal ->> 'schema',
                        'table', wal ->> 'table',
                        'type', action
                    ),
                    is_rls_enabled,
                    (select array_agg(s.subscription_id) from unnest(subscriptions) as s where s.claims_role = working_role and (s.selected_columns is not distinct from working_selected_columns)),
                    array['Error 401: Unauthorized']
                )::realtime.wal_rls;
            end loop;

        else
            -- Create the prepared statement (once per role)
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            -- Collect all visible subscription IDs for this role (filter check + RLS check)
            visible_role_sub_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or (
                              action = 'DELETE'
                              and realtime.is_visible_through_filters(old_columns, subs.filters)
                            )
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_role_sub_ids = visible_role_sub_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        -- Trim leading and trailing quotes from working_role because set_config
                        -- doesn't recognize the role as valid if they are included
                        set_config('role', trim(both '"' from working_role::text), true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_role_sub_ids = visible_role_sub_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            -- Inner loop: per distinct selected_columns for this role
            for cols_record in
                select selected_columns
                from (select distinct selected_columns from unnest(subscriptions) s where s.claims_role = working_role) t
                order by coalesce(array_to_string(selected_columns, ','), '')
            loop
                working_selected_columns := cols_record.selected_columns;

                output = jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action,
                    'commit_timestamp', to_char(
                        ((wal ->> 'timestamp')::timestamptz at time zone 'utc'),
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                    ),
                    'columns', (
                        select
                            jsonb_agg(
                                jsonb_build_object(
                                    'name', pa.attname,
                                    'type', pt.typname
                                )
                                order by pa.attnum asc
                            )
                        from
                            pg_attribute pa
                            join pg_type pt
                                on pa.atttypid = pt.oid
                            left join (
                                select unnest(conkey) as pkey_attnum
                                from pg_constraint
                                where conrelid = entity_ and contype = 'p'
                            ) pk on pk.pkey_attnum = pa.attnum
                        where
                            attrelid = entity_
                            and attnum > 0
                            and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                            and (working_selected_columns is null or pa.attname = any(working_selected_columns) or pk.pkey_attnum is not null)
                    )
                )
                -- Add "record" key for insert and update
                || case
                    when action in ('INSERT', 'UPDATE') then
                        jsonb_build_object(
                            'record',
                            (
                                select
                                    jsonb_object_agg(
                                        -- if unchanged toast, get column name and value from old record
                                        coalesce((c).name, (oc).name),
                                        case
                                            when (c).name is null then (oc).value
                                            else (c).value
                                        end
                                    )
                                from
                                    unnest(columns) c
                                    full outer join unnest(old_columns) oc
                                        on (c).name = (oc).name
                                where
                                    coalesce((c).is_selectable, (oc).is_selectable)
                                    and (working_selected_columns is null or coalesce((c).name, (oc).name) = any(working_selected_columns) or coalesce((c).is_pkey, (oc).is_pkey))
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            )
                        )
                    else '{}'::jsonb
                end
                -- Add "old_record" key for update and delete
                || case
                    when action = 'UPDATE' then
                        jsonb_build_object(
                                'old_record',
                                (
                                    select jsonb_object_agg((c).name, (c).value)
                                    from unnest(old_columns) c
                                    where
                                        (c).is_selectable
                                        and (working_selected_columns is null or (c).name = any(working_selected_columns) or (c).is_pkey)
                                        and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                )
                            )
                    when action = 'DELETE' then
                        jsonb_build_object(
                            'old_record',
                            (
                                select jsonb_object_agg((c).name, (c).value)
                                from unnest(old_columns) c
                                where
                                    (c).is_selectable
                                    and (working_selected_columns is null or (c).name = any(working_selected_columns) or (c).is_pkey)
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                    and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                            )
                        )
                    else '{}'::jsonb
                end;

                -- Filter visible_role_sub_ids to those matching the current selected_columns group
                visible_to_subscription_ids = coalesce(
                    (
                        select array_agg(s.subscription_id)
                        from unnest(subscriptions) s
                        where s.claims_role = working_role
                          and (s.selected_columns is not distinct from working_selected_columns)
                          and s.subscription_id = any(visible_role_sub_ids)
                    ),
                    '{}'::uuid[]
                );

                return next (
                    output,
                    is_rls_enabled,
                    visible_to_subscription_ids,
                    case
                        when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                        else '{}'
                    end
                )::realtime.wal_rls;
            end loop;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;


ALTER FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) OWNER TO supabase_admin;

--
-- Name: broadcast_changes(text, text, text, text, text, record, record, text); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text DEFAULT 'ROW'::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    -- Declare a variable to hold the JSONB representation of the row
    row_data jsonb := '{}'::jsonb;
BEGIN
    IF level = 'STATEMENT' THEN
        RAISE EXCEPTION 'function can only be triggered for each row, not for each statement';
    END IF;
    -- Check the operation type and handle accordingly
    IF operation = 'INSERT' OR operation = 'UPDATE' OR operation = 'DELETE' THEN
        row_data := jsonb_build_object('old_record', OLD, 'record', NEW, 'operation', operation, 'table', table_name, 'schema', table_schema);
        PERFORM realtime.send (row_data, event_name, topic_name);
    ELSE
        RAISE EXCEPTION 'Unexpected operation type: %', operation;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to process the row: %', SQLERRM;
END;

$$;


ALTER FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text) OWNER TO supabase_admin;

--
-- Name: build_prepared_statement_sql(text, regclass, realtime.wal_column[]); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) RETURNS text
    LANGUAGE sql
    AS $$
      /*
      Builds a sql string that, if executed, creates a prepared statement to
      tests retrive a row from *entity* by its primary key columns.
      Example
          select realtime.build_prepared_statement_sql('public.notes', '{"id"}'::text[], '{"bigint"}'::text[])
      */
          select
      'prepare ' || prepared_statement_name || ' as
          select
              exists(
                  select
                      1
                  from
                      ' || entity || '
                  where
                      ' || string_agg(quote_ident(pkc.name) || '=' || quote_nullable(pkc.value #>> '{}') , ' and ') || '
              )'
          from
              unnest(columns) pkc
          where
              pkc.is_pkey
          group by
              entity
      $$;


ALTER FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) OWNER TO supabase_admin;

--
-- Name: cast(text, regtype); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime."cast"(val text, type_ regtype) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  res jsonb;
begin
  if type_::text = 'bytea' then
    return to_jsonb(val);
  end if;
  execute format('select to_jsonb(%L::'|| type_::text || ')', val) into res;
  return res;
end
$$;


ALTER FUNCTION realtime."cast"(val text, type_ regtype) OWNER TO supabase_admin;

--
-- Name: check_equality_op(realtime.equality_op, regtype, text, text); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
/*
Casts *val_1* and *val_2* as type *type_* and check the *op* condition for truthiness
*/
declare
    op_symbol text = (
        case
            when op = 'eq' then '='
            when op = 'neq' then '!='
            when op = 'lt' then '<'
            when op = 'lte' then '<='
            when op = 'gt' then '>'
            when op = 'gte' then '>='
            when op = 'in' then '= any'
            else 'UNKNOWN OP'
        end
    );
    res boolean;
begin
    execute format(
        'select %L::'|| type_::text || ' ' || op_symbol
        || ' ( %L::'
        || (
            case
                when op = 'in' then type_::text || '[]'
                else type_::text end
        )
        || ')', val_1, val_2) into res;
    return res;
end;
$$;


ALTER FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) OWNER TO supabase_admin;

--
-- Name: check_equality_op(realtime.equality_op, regtype, text, text, boolean); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text, negate boolean) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
declare
    op_symbol text;
    res boolean;
begin
    -- IS DISTINCT FROM / IS NOT DISTINCT FROM: infix, both sides typed literals
    if op = 'isdistinct' then
        execute format(
            'select %L::%s %s %L::%s',
            val_1,
            type_::text,
            case when negate then 'IS NOT DISTINCT FROM' else 'IS DISTINCT FROM' end,
            val_2,
            type_::text
        ) into res;
        return res;
    end if;

    -- IS requires a keyword RHS (NULL, TRUE, FALSE, UNKNOWN), not a typed literal
    if op = 'is' then
        if val_2 not in ('null', 'true', 'false', 'unknown') then
            raise exception 'invalid value for is filter: must be null, true, false, or unknown';
        end if;
        execute format(
            'select %L::%s %s %s',
            val_1,
            type_::text,
            case when negate then 'IS NOT' else 'IS' end,
            upper(val_2)
        ) into res;
        return res;
    end if;

    op_symbol = case
        when op = 'eq'    then '='
        when op = 'neq'   then '!='
        when op = 'lt'    then '<'
        when op = 'lte'   then '<='
        when op = 'gt'    then '>'
        when op = 'gte'   then '>='
        when op = 'in'    then '= any'
        when op = 'like'   then 'LIKE'
        when op = 'ilike'  then 'ILIKE'
        when op = 'match'  then '~'
        when op = 'imatch' then '~*'
        else null
    end;

    if op_symbol is null then
        raise exception 'unsupported equality operator: %', op::text;
    end if;

    execute format(
        'select %L::%s %s (%L::%s)',
        val_1,
        type_::text,
        op_symbol,
        val_2,
        case when op = 'in' then type_::text || '[]' else type_::text end
    ) into res;

    return case when negate then not res else res end;
end;
$$;


ALTER FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text, negate boolean) OWNER TO supabase_admin;

--
-- Name: is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[]); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    select
        filters is null
        or array_length(filters, 1) is null
        or coalesce(
            count(col.name) = count(1)
            and sum(
                realtime.check_equality_op(
                    op:=f.op,
                    type_:=coalesce(col.type_oid::regtype, col.type_name::regtype),
                    val_1:=col.value #>> '{}',
                    val_2:=f.value,
                    negate:=coalesce(f.negate, false)
                )::int
            ) filter (where col.name is not null) = count(col.name),
            false
        )
    from
        unnest(filters) f
        left join unnest(columns) col
            on f.column_name = col.name;
$$;


ALTER FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) OWNER TO supabase_admin;

--
-- Name: list_changes(name, name, integer, integer); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) RETURNS TABLE(wal jsonb, is_rls_enabled boolean, subscription_ids uuid[], errors text[], slot_changes_count bigint)
    LANGUAGE sql
    SET log_min_messages TO 'fatal'
    AS $$
  WITH pub AS (
    SELECT
      concat_ws(
        ',',
        CASE WHEN bool_or(pubinsert) THEN 'insert' ELSE NULL END,
        CASE WHEN bool_or(pubupdate) THEN 'update' ELSE NULL END,
        CASE WHEN bool_or(pubdelete) THEN 'delete' ELSE NULL END
      ) AS w2j_actions,
      coalesce(
        string_agg(
          realtime.quote_wal2json(format('%I.%I', schemaname, tablename)::regclass),
          ','
        ) filter (WHERE ppt.tablename IS NOT NULL),
        ''
      ) AS w2j_add_tables
    FROM pg_publication pp
    LEFT JOIN pg_publication_tables ppt ON pp.pubname = ppt.pubname
    WHERE pp.pubname = publication
    GROUP BY pp.pubname
    LIMIT 1
  ),
  -- MATERIALIZED ensures pg_logical_slot_get_changes is called exactly once
  w2j AS MATERIALIZED (
    SELECT x.*, pub.w2j_add_tables
    FROM pub,
         pg_logical_slot_get_changes(
           slot_name, null, max_changes,
           'include-pk', 'true',
           'include-transaction', 'false',
           'include-timestamp', 'true',
           'include-type-oids', 'true',
           'format-version', '2',
           'actions', pub.w2j_actions,
           'add-tables', pub.w2j_add_tables
         ) x
  ),
  slot_count AS (
    SELECT count(*)::bigint AS cnt
    FROM w2j
    WHERE w2j.w2j_add_tables <> ''
  ),
  rls_filtered AS (
    SELECT xyz.wal, xyz.is_rls_enabled, xyz.subscription_ids, xyz.errors
    FROM w2j,
         realtime.apply_rls(
           wal := w2j.data::jsonb,
           max_record_bytes := max_record_bytes
         ) xyz(wal, is_rls_enabled, subscription_ids, errors)
    WHERE w2j.w2j_add_tables <> ''
      AND xyz.subscription_ids[1] IS NOT NULL
  )
  SELECT rf.wal, rf.is_rls_enabled, rf.subscription_ids, rf.errors, sc.cnt
  FROM rls_filtered rf, slot_count sc

  UNION ALL

  SELECT null, null, null, null, sc.cnt
  FROM slot_count sc
  WHERE NOT EXISTS (SELECT 1 FROM rls_filtered)
$$;


ALTER FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) OWNER TO supabase_admin;

--
-- Name: quote_wal2json(regclass); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.quote_wal2json(entity regclass) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT
    realtime.wal2json_escape_identifier(nsp.nspname::text)
    || '.'
    || realtime.wal2json_escape_identifier(pc.relname::text)
  FROM pg_class pc
  JOIN pg_namespace nsp ON pc.relnamespace = nsp.oid
  WHERE pc.oid = entity
$$;


ALTER FUNCTION realtime.quote_wal2json(entity regclass) OWNER TO supabase_admin;

--
-- Name: send(jsonb, text, text, boolean); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  generated_id uuid;
  final_payload jsonb;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();

    -- Check if payload has an 'id' key, if not, add the generated UUID
    IF payload ? 'id' THEN
      final_payload := payload;
    ELSE
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    END IF;

    -- Set the topic configuration
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);

    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$$;


ALTER FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) OWNER TO supabase_admin;

--
-- Name: send_binary(bytea, text, text, boolean); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.send_binary(payload bytea, event text, topic text, private boolean DEFAULT true) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  generated_id uuid;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();

    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);

    INSERT INTO realtime.messages (id, binary_payload, event, topic, private, extension)
    VALUES (generated_id, payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$$;


ALTER FUNCTION realtime.send_binary(payload bytea, event text, topic text, private boolean) OWNER TO supabase_admin;

--
-- Name: subscription_check_filters(); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.subscription_check_filters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    col_names text[] = coalesce(
            array_agg(a.attname order by a.attnum),
            '{}'::text[]
        )
        from
            pg_catalog.pg_attribute a
        where
            a.attrelid = new.entity
            and a.attnum > 0
            and not a.attisdropped
            and pg_catalog.has_column_privilege(
                (new.claims ->> 'role'),
                a.attrelid,
                a.attnum,
                'SELECT'
            );
    filter realtime.user_defined_filter;
    col_type regtype;
    in_val jsonb;
    selected_col text;
begin
    for filter in select * from unnest(new.filters) loop
        if not filter.column_name = any(col_names) then
            raise exception 'invalid column for filter %', filter.column_name;
        end if;

        col_type = (
            select atttypid::regtype
            from pg_catalog.pg_attribute
            where attrelid = new.entity
                  and attname = filter.column_name
        );
        if col_type is null then
            raise exception 'failed to lookup type for column %', filter.column_name;
        end if;

        if filter.op = 'in'::realtime.equality_op then
            in_val = realtime.cast(filter.value, (col_type::text || '[]')::regtype);
            if coalesce(jsonb_array_length(in_val), 0) > 100 then
                raise exception 'too many values for `in` filter. Maximum 100';
            end if;
        elsif filter.op = 'is'::realtime.equality_op then
            -- `is` requires a keyword RHS rather than a typed literal
            if filter.value not in ('null', 'true', 'false', 'unknown') then
                raise exception 'invalid value for is filter: must be null, true, false, or unknown';
            end if;
            -- IS NULL works for any type, but IS TRUE/FALSE/UNKNOWN require a boolean
            -- operand. Reject the non-null keywords on non-boolean columns here so they
            -- don't abort apply_rls at WAL time.
            if filter.value <> 'null' and col_type <> 'boolean'::regtype then
                raise exception 'is % filter requires a boolean column, got %', filter.value, col_type::text;
            end if;
        elsif filter.op in ('like'::realtime.equality_op, 'ilike'::realtime.equality_op) then
            -- like/ilike apply the text pattern operator (~~); reject column types that
            -- have no such operator instead of failing at WAL time
            if not exists (
                select 1 from pg_catalog.pg_operator
                where oprname = '~~' and oprleft = col_type
            ) then
                raise exception 'operator % requires a text-compatible column type, got %', filter.op::text, col_type::text;
            end if;
        elsif filter.op in ('match'::realtime.equality_op, 'imatch'::realtime.equality_op) then
            -- match/imatch apply the regex operators ~ / ~*; reject column types that have
            -- no such operator (e.g. integer) instead of failing at WAL time, mirroring the
            -- like/ilike guard above.
            if not exists (
                select 1 from pg_catalog.pg_operator
                where oprname = case when filter.op = 'imatch'::realtime.equality_op then '~*' else '~' end
                  and oprleft = col_type
                  and oprright = col_type
                  and oprresult = 'boolean'::regtype
            ) then
                raise exception 'operator % requires a text-compatible column type, got %', filter.op::text, col_type::text;
            end if;
            -- validate the regex eagerly so a bad pattern is rejected here, not inside
            -- apply_rls where it would abort the WAL stream for the entity
            begin
                perform '' ~ filter.value;
            exception when others then
                raise exception 'invalid regular expression for % filter: %', filter.op::text, sqlerrm;
            end;
        else
            -- eq/neq/lt/lte/gt/gte: value must be coercable to the type
            perform realtime.cast(filter.value, col_type);
        end if;
    end loop;

    if new.selected_columns is not null then
        for selected_col in select * from unnest(new.selected_columns) loop
            if not selected_col = any(col_names) then
                raise exception 'invalid column for select %', selected_col;
            end if;
        end loop;
    end if;

    -- Apply consistent order to filters so the unique constraint can't be tricked by a
    -- different filter order. negate is part of the sort key.
    new.filters = coalesce(
        array_agg(f order by f.column_name, f.op, f.value, f.negate),
        '{}'
    ) from unnest(new.filters) f;

    new.selected_columns = (
        select array_agg(c order by c)
        from unnest(new.selected_columns) c
    );

    return new;
end;
$$;


ALTER FUNCTION realtime.subscription_check_filters() OWNER TO supabase_admin;

--
-- Name: to_regrole(text); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.to_regrole(role_name text) RETURNS regrole
    LANGUAGE sql IMMUTABLE
    AS $$ select role_name::regrole $$;


ALTER FUNCTION realtime.to_regrole(role_name text) OWNER TO supabase_admin;

--
-- Name: topic(); Type: FUNCTION; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE FUNCTION realtime.topic() RETURNS text
    LANGUAGE sql STABLE
    AS $$
select nullif(current_setting('realtime.topic', true), '')::text;
$$;


ALTER FUNCTION realtime.topic() OWNER TO supabase_realtime_admin;

--
-- Name: wal2json_escape_identifier(text); Type: FUNCTION; Schema: realtime; Owner: supabase_admin
--

CREATE FUNCTION realtime.wal2json_escape_identifier(name text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  -- Prefix `\`, `,`, `.`, and any whitespace with `\`
  SELECT regexp_replace(name, '([\\,.[:space:]])', '\\\1', 'g')
$$;


ALTER FUNCTION realtime.wal2json_escape_identifier(name text) OWNER TO supabase_admin;

--
-- Name: allow_any_operation(text[]); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.allow_any_operation(expected_operations text[]) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  WITH current_operation AS (
    SELECT storage.operation() AS raw_operation
  ),
  normalized AS (
    SELECT CASE
      WHEN raw_operation LIKE 'storage.%' THEN substr(raw_operation, 9)
      ELSE raw_operation
    END AS current_operation
    FROM current_operation
  )
  SELECT EXISTS (
    SELECT 1
    FROM normalized n
    CROSS JOIN LATERAL unnest(expected_operations) AS expected_operation
    WHERE expected_operation IS NOT NULL
      AND expected_operation <> ''
      AND n.current_operation = CASE
        WHEN expected_operation LIKE 'storage.%' THEN substr(expected_operation, 9)
        ELSE expected_operation
      END
  );
$$;


ALTER FUNCTION storage.allow_any_operation(expected_operations text[]) OWNER TO supabase_storage_admin;

--
-- Name: allow_only_operation(text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.allow_only_operation(expected_operation text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  WITH current_operation AS (
    SELECT storage.operation() AS raw_operation
  ),
  normalized AS (
    SELECT
      CASE
        WHEN raw_operation LIKE 'storage.%' THEN substr(raw_operation, 9)
        ELSE raw_operation
      END AS current_operation,
      CASE
        WHEN expected_operation LIKE 'storage.%' THEN substr(expected_operation, 9)
        ELSE expected_operation
      END AS requested_operation
    FROM current_operation
  )
  SELECT CASE
    WHEN requested_operation IS NULL OR requested_operation = '' THEN FALSE
    ELSE COALESCE(current_operation = requested_operation, FALSE)
  END
  FROM normalized;
$$;


ALTER FUNCTION storage.allow_only_operation(expected_operation text) OWNER TO supabase_storage_admin;

--
-- Name: can_insert_object(text, text, uuid, jsonb); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.can_insert_object(bucketid text, name text, owner uuid, metadata jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "storage"."objects" ("bucket_id", "name", "owner", "metadata") VALUES (bucketid, name, owner, metadata);
  -- hack to rollback the successful insert
  RAISE sqlstate 'PT200' using
  message = 'ROLLBACK',
  detail = 'rollback successful insert';
END
$$;


ALTER FUNCTION storage.can_insert_object(bucketid text, name text, owner uuid, metadata jsonb) OWNER TO supabase_storage_admin;

--
-- Name: enforce_bucket_name_length(); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.enforce_bucket_name_length() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if length(new.name) > 100 then
        raise exception 'bucket name "%" is too long (% characters). Max is 100.', new.name, length(new.name);
    end if;
    return new;
end;
$$;


ALTER FUNCTION storage.enforce_bucket_name_length() OWNER TO supabase_storage_admin;

--
-- Name: extension(text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.extension(name text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    _parts text[];
    _filename text;
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Get the last path segment (the actual filename)
    SELECT _parts[array_length(_parts, 1)] INTO _filename;
    -- Extract extension: reverse, split on '.', then reverse again
    RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$$;


ALTER FUNCTION storage.extension(name text) OWNER TO supabase_storage_admin;

--
-- Name: filename(text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.filename(name text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
_parts text[];
BEGIN
	select string_to_array(name, '/') into _parts;
	return _parts[array_length(_parts,1)];
END
$$;


ALTER FUNCTION storage.filename(name text) OWNER TO supabase_storage_admin;

--
-- Name: foldername(text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.foldername(name text) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    _parts text[];
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Return everything except the last segment
    RETURN _parts[1 : array_length(_parts,1) - 1];
END
$$;


ALTER FUNCTION storage.foldername(name text) OWNER TO supabase_storage_admin;

--
-- Name: get_common_prefix(text, text, text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.get_common_prefix(p_key text, p_prefix text, p_delimiter text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
SELECT CASE
    WHEN position(p_delimiter IN substring(p_key FROM length(p_prefix) + 1)) > 0
    THEN left(p_key, length(p_prefix) + position(p_delimiter IN substring(p_key FROM length(p_prefix) + 1)))
    ELSE NULL
END;
$$;


ALTER FUNCTION storage.get_common_prefix(p_key text, p_prefix text, p_delimiter text) OWNER TO supabase_storage_admin;

--
-- Name: get_size_by_bucket(); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.get_size_by_bucket() RETURNS TABLE(size bigint, bucket_id text)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    return query
        select sum((metadata->>'size')::bigint)::bigint as size, obj.bucket_id
        from "storage".objects as obj
        group by obj.bucket_id;
END
$$;


ALTER FUNCTION storage.get_size_by_bucket() OWNER TO supabase_storage_admin;

--
-- Name: list_multipart_uploads_with_delimiter(text, text, text, integer, text, text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.list_multipart_uploads_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, next_key_token text DEFAULT ''::text, next_upload_token text DEFAULT ''::text) RETURNS TABLE(key text, id text, created_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $_$
BEGIN
    RETURN QUERY EXECUTE
        'SELECT DISTINCT ON(key COLLATE "C") * from (
            SELECT
                CASE
                    WHEN position($2 IN substring(key from length($1) + 1)) > 0 THEN
                        substring(key from 1 for length($1) + position($2 IN substring(key from length($1) + 1)))
                    ELSE
                        key
                END AS key, id, created_at
            FROM
                storage.s3_multipart_uploads
            WHERE
                bucket_id = $5 AND
                key ILIKE $1 || ''%'' AND
                CASE
                    WHEN $4 != '''' AND $6 = '''' THEN
                        CASE
                            WHEN position($2 IN substring(key from length($1) + 1)) > 0 THEN
                                substring(key from 1 for length($1) + position($2 IN substring(key from length($1) + 1))) COLLATE "C" > $4
                            ELSE
                                key COLLATE "C" > $4
                            END
                    ELSE
                        true
                END AND
                CASE
                    WHEN $6 != '''' THEN
                        id COLLATE "C" > $6
                    ELSE
                        true
                    END
            ORDER BY
                key COLLATE "C" ASC, created_at ASC) as e order by key COLLATE "C" LIMIT $3'
        USING prefix_param, delimiter_param, max_keys, next_key_token, bucket_id, next_upload_token;
END;
$_$;


ALTER FUNCTION storage.list_multipart_uploads_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text, next_upload_token text) OWNER TO supabase_storage_admin;

--
-- Name: list_objects_with_delimiter(text, text, text, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.list_objects_with_delimiter(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, start_after text DEFAULT ''::text, next_token text DEFAULT ''::text, sort_order text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, metadata jsonb, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $_$
DECLARE
    v_peek_name TEXT;
    v_current RECORD;
    v_common_prefix TEXT;

    -- Configuration
    v_is_asc BOOLEAN;
    v_prefix TEXT;
    v_start TEXT;
    v_upper_bound TEXT;
    v_file_batch_size INT;

    -- Seek state
    v_next_seek TEXT;
    v_count INT := 0;

    -- Dynamic SQL for batch query only
    v_batch_query TEXT;

BEGIN
    -- ========================================================================
    -- INITIALIZATION
    -- ========================================================================
    v_is_asc := lower(coalesce(sort_order, 'asc')) = 'asc';
    v_prefix := coalesce(prefix_param, '');
    v_start := CASE WHEN coalesce(next_token, '') <> '' THEN next_token ELSE coalesce(start_after, '') END;
    v_file_batch_size := LEAST(GREATEST(max_keys * 2, 100), 1000);

    -- Calculate upper bound for prefix filtering (bytewise, using COLLATE "C")
    IF v_prefix = '' THEN
        v_upper_bound := NULL;
    ELSIF right(v_prefix, 1) = delimiter_param THEN
        v_upper_bound := left(v_prefix, -1) || chr(ascii(delimiter_param) + 1);
    ELSE
        v_upper_bound := left(v_prefix, -1) || chr(ascii(right(v_prefix, 1)) + 1);
    END IF;

    -- Build batch query (dynamic SQL - called infrequently, amortized over many rows)
    IF v_is_asc THEN
        IF v_upper_bound IS NOT NULL THEN
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND o.name COLLATE "C" >= $2 ' ||
                'AND o.name COLLATE "C" < $3 ORDER BY o.name COLLATE "C" ASC LIMIT $4';
        ELSE
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND o.name COLLATE "C" >= $2 ' ||
                'ORDER BY o.name COLLATE "C" ASC LIMIT $4';
        END IF;
    ELSE
        IF v_upper_bound IS NOT NULL THEN
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND o.name COLLATE "C" < $2 ' ||
                'AND o.name COLLATE "C" >= $3 ORDER BY o.name COLLATE "C" DESC LIMIT $4';
        ELSE
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND o.name COLLATE "C" < $2 ' ||
                'ORDER BY o.name COLLATE "C" DESC LIMIT $4';
        END IF;
    END IF;

    -- ========================================================================
    -- SEEK INITIALIZATION: Determine starting position
    -- ========================================================================
    IF v_start = '' THEN
        IF v_is_asc THEN
            v_next_seek := v_prefix;
        ELSE
            -- DESC without cursor: find the last item in range
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_next_seek FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" >= v_prefix AND o.name COLLATE "C" < v_upper_bound
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            ELSIF v_prefix <> '' THEN
                SELECT o.name INTO v_next_seek FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" >= v_prefix
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            ELSE
                SELECT o.name INTO v_next_seek FROM storage.objects o
                WHERE o.bucket_id = _bucket_id
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            END IF;

            IF v_next_seek IS NOT NULL THEN
                v_next_seek := v_next_seek || delimiter_param;
            ELSE
                RETURN;
            END IF;
        END IF;
    ELSE
        -- Cursor provided: determine if it refers to a folder or leaf
        IF EXISTS (
            SELECT 1 FROM storage.objects o
            WHERE o.bucket_id = _bucket_id
              AND o.name COLLATE "C" LIKE v_start || delimiter_param || '%'
            LIMIT 1
        ) THEN
            -- Cursor refers to a folder
            IF v_is_asc THEN
                v_next_seek := v_start || chr(ascii(delimiter_param) + 1);
            ELSE
                v_next_seek := v_start || delimiter_param;
            END IF;
        ELSE
            -- Cursor refers to a leaf object
            IF v_is_asc THEN
                v_next_seek := v_start || delimiter_param;
            ELSE
                v_next_seek := v_start;
            END IF;
        END IF;
    END IF;

    -- ========================================================================
    -- MAIN LOOP: Hybrid peek-then-batch algorithm
    -- Uses STATIC SQL for peek (hot path) and DYNAMIC SQL for batch
    -- ========================================================================
    LOOP
        EXIT WHEN v_count >= max_keys;

        -- STEP 1: PEEK using STATIC SQL (plan cached, very fast)
        IF v_is_asc THEN
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" >= v_next_seek AND o.name COLLATE "C" < v_upper_bound
                ORDER BY o.name COLLATE "C" ASC LIMIT 1;
            ELSE
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" >= v_next_seek
                ORDER BY o.name COLLATE "C" ASC LIMIT 1;
            END IF;
        ELSE
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" < v_next_seek AND o.name COLLATE "C" >= v_prefix
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            ELSIF v_prefix <> '' THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" < v_next_seek AND o.name COLLATE "C" >= v_prefix
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            ELSE
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" < v_next_seek
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            END IF;
        END IF;

        EXIT WHEN v_peek_name IS NULL;

        -- STEP 2: Check if this is a FOLDER or FILE
        v_common_prefix := storage.get_common_prefix(v_peek_name, v_prefix, delimiter_param);

        IF v_common_prefix IS NOT NULL THEN
            -- FOLDER: Emit and skip to next folder (no heap access needed)
            name := rtrim(v_common_prefix, delimiter_param);
            id := NULL;
            updated_at := NULL;
            created_at := NULL;
            last_accessed_at := NULL;
            metadata := NULL;
            RETURN NEXT;
            v_count := v_count + 1;

            -- Advance seek past the folder range
            IF v_is_asc THEN
                v_next_seek := left(v_common_prefix, -1) || chr(ascii(delimiter_param) + 1);
            ELSE
                v_next_seek := v_common_prefix;
            END IF;
        ELSE
            -- FILE: Batch fetch using DYNAMIC SQL (overhead amortized over many rows)
            -- For ASC: upper_bound is the exclusive upper limit (< condition)
            -- For DESC: prefix is the inclusive lower limit (>= condition)
            FOR v_current IN EXECUTE v_batch_query USING _bucket_id, v_next_seek,
                CASE WHEN v_is_asc THEN COALESCE(v_upper_bound, v_prefix) ELSE v_prefix END, v_file_batch_size
            LOOP
                v_common_prefix := storage.get_common_prefix(v_current.name, v_prefix, delimiter_param);

                IF v_common_prefix IS NOT NULL THEN
                    -- Hit a folder: exit batch, let peek handle it
                    v_next_seek := v_current.name;
                    EXIT;
                END IF;

                -- Emit file
                name := v_current.name;
                id := v_current.id;
                updated_at := v_current.updated_at;
                created_at := v_current.created_at;
                last_accessed_at := v_current.last_accessed_at;
                metadata := v_current.metadata;
                RETURN NEXT;
                v_count := v_count + 1;

                -- Advance seek past this file
                IF v_is_asc THEN
                    v_next_seek := v_current.name || delimiter_param;
                ELSE
                    v_next_seek := v_current.name;
                END IF;

                EXIT WHEN v_count >= max_keys;
            END LOOP;
        END IF;
    END LOOP;
END;
$_$;


ALTER FUNCTION storage.list_objects_with_delimiter(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token text, sort_order text) OWNER TO supabase_storage_admin;

--
-- Name: operation(); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.operation() RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN current_setting('storage.operation', true);
END;
$$;


ALTER FUNCTION storage.operation() OWNER TO supabase_storage_admin;

--
-- Name: protect_delete(); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.protect_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Check if storage.allow_delete_query is set to 'true'
    IF COALESCE(current_setting('storage.allow_delete_query', true), 'false') != 'true' THEN
        RAISE EXCEPTION 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
            USING HINT = 'This prevents accidental data loss from orphaned objects.',
                  ERRCODE = '42501';
    END IF;
    RETURN NULL;
END;
$$;


ALTER FUNCTION storage.protect_delete() OWNER TO supabase_storage_admin;

--
-- Name: search(text, text, integer, integer, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.search(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
DECLARE
    v_peek_name TEXT;
    v_current RECORD;
    v_common_prefix TEXT;
    v_delimiter CONSTANT TEXT := '/';

    -- Configuration
    v_limit INT;
    v_prefix TEXT;
    v_prefix_lower TEXT;
    v_is_asc BOOLEAN;
    v_order_by TEXT;
    v_sort_order TEXT;
    v_upper_bound TEXT;
    v_file_batch_size INT;

    -- Dynamic SQL for batch query only
    v_batch_query TEXT;

    -- Seek state
    v_next_seek TEXT;
    v_count INT := 0;
    v_skipped INT := 0;
BEGIN
    -- ========================================================================
    -- INITIALIZATION
    -- ========================================================================
    v_limit := LEAST(coalesce(limits, 100), 1500);
    v_prefix := coalesce(prefix, '') || coalesce(search, '');
    v_prefix_lower := lower(v_prefix);
    v_is_asc := lower(coalesce(sortorder, 'asc')) = 'asc';
    v_file_batch_size := LEAST(GREATEST(v_limit * 2, 100), 1000);

    -- Validate sort column
    CASE lower(coalesce(sortcolumn, 'name'))
        WHEN 'name' THEN v_order_by := 'name';
        WHEN 'updated_at' THEN v_order_by := 'updated_at';
        WHEN 'created_at' THEN v_order_by := 'created_at';
        WHEN 'last_accessed_at' THEN v_order_by := 'last_accessed_at';
        ELSE v_order_by := 'name';
    END CASE;

    v_sort_order := CASE WHEN v_is_asc THEN 'asc' ELSE 'desc' END;

    -- ========================================================================
    -- NON-NAME SORTING: Use path_tokens approach (unchanged)
    -- ========================================================================
    IF v_order_by != 'name' THEN
        RETURN QUERY EXECUTE format(
            $sql$
            WITH folders AS (
                SELECT path_tokens[$1] AS folder
                FROM storage.objects
                WHERE objects.name ILIKE $2 || '%%'
                  AND bucket_id = $3
                  AND array_length(objects.path_tokens, 1) <> $1
                GROUP BY folder
                ORDER BY folder %s
            )
            (SELECT folder AS "name",
                   NULL::uuid AS id,
                   NULL::timestamptz AS updated_at,
                   NULL::timestamptz AS created_at,
                   NULL::timestamptz AS last_accessed_at,
                   NULL::jsonb AS metadata FROM folders)
            UNION ALL
            (SELECT path_tokens[$1] AS "name",
                   id, updated_at, created_at, last_accessed_at, metadata
             FROM storage.objects
             WHERE objects.name ILIKE $2 || '%%'
               AND bucket_id = $3
               AND array_length(objects.path_tokens, 1) = $1
             ORDER BY %I %s)
            LIMIT $4 OFFSET $5
            $sql$, v_sort_order, v_order_by, v_sort_order
        ) USING levels, v_prefix, bucketname, v_limit, offsets;
        RETURN;
    END IF;

    -- ========================================================================
    -- NAME SORTING: Hybrid skip-scan with batch optimization
    -- ========================================================================

    -- Calculate upper bound for prefix filtering
    IF v_prefix_lower = '' THEN
        v_upper_bound := NULL;
    ELSIF right(v_prefix_lower, 1) = v_delimiter THEN
        v_upper_bound := left(v_prefix_lower, -1) || chr(ascii(v_delimiter) + 1);
    ELSE
        v_upper_bound := left(v_prefix_lower, -1) || chr(ascii(right(v_prefix_lower, 1)) + 1);
    END IF;

    -- Build batch query (dynamic SQL - called infrequently, amortized over many rows)
    IF v_is_asc THEN
        IF v_upper_bound IS NOT NULL THEN
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND lower(o.name) COLLATE "C" >= $2 ' ||
                'AND lower(o.name) COLLATE "C" < $3 ORDER BY lower(o.name) COLLATE "C" ASC LIMIT $4';
        ELSE
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND lower(o.name) COLLATE "C" >= $2 ' ||
                'ORDER BY lower(o.name) COLLATE "C" ASC LIMIT $4';
        END IF;
    ELSE
        IF v_upper_bound IS NOT NULL THEN
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND lower(o.name) COLLATE "C" < $2 ' ||
                'AND lower(o.name) COLLATE "C" >= $3 ORDER BY lower(o.name) COLLATE "C" DESC LIMIT $4';
        ELSE
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND lower(o.name) COLLATE "C" < $2 ' ||
                'ORDER BY lower(o.name) COLLATE "C" DESC LIMIT $4';
        END IF;
    END IF;

    -- Initialize seek position
    IF v_is_asc THEN
        v_next_seek := v_prefix_lower;
    ELSE
        -- DESC: find the last item in range first (static SQL)
        IF v_upper_bound IS NOT NULL THEN
            SELECT o.name INTO v_peek_name FROM storage.objects o
            WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" >= v_prefix_lower AND lower(o.name) COLLATE "C" < v_upper_bound
            ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
        ELSIF v_prefix_lower <> '' THEN
            SELECT o.name INTO v_peek_name FROM storage.objects o
            WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" >= v_prefix_lower
            ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
        ELSE
            SELECT o.name INTO v_peek_name FROM storage.objects o
            WHERE o.bucket_id = bucketname
            ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
        END IF;

        IF v_peek_name IS NOT NULL THEN
            v_next_seek := lower(v_peek_name) || v_delimiter;
        ELSE
            RETURN;
        END IF;
    END IF;

    -- ========================================================================
    -- MAIN LOOP: Hybrid peek-then-batch algorithm
    -- Uses STATIC SQL for peek (hot path) and DYNAMIC SQL for batch
    -- ========================================================================
    LOOP
        EXIT WHEN v_count >= v_limit;

        -- STEP 1: PEEK using STATIC SQL (plan cached, very fast)
        IF v_is_asc THEN
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" >= v_next_seek AND lower(o.name) COLLATE "C" < v_upper_bound
                ORDER BY lower(o.name) COLLATE "C" ASC LIMIT 1;
            ELSE
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" >= v_next_seek
                ORDER BY lower(o.name) COLLATE "C" ASC LIMIT 1;
            END IF;
        ELSE
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" < v_next_seek AND lower(o.name) COLLATE "C" >= v_prefix_lower
                ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
            ELSIF v_prefix_lower <> '' THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" < v_next_seek AND lower(o.name) COLLATE "C" >= v_prefix_lower
                ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
            ELSE
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" < v_next_seek
                ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
            END IF;
        END IF;

        EXIT WHEN v_peek_name IS NULL;

        -- STEP 2: Check if this is a FOLDER or FILE
        v_common_prefix := storage.get_common_prefix(lower(v_peek_name), v_prefix_lower, v_delimiter);

        IF v_common_prefix IS NOT NULL THEN
            -- FOLDER: Handle offset, emit if needed, skip to next folder
            IF v_skipped < offsets THEN
                v_skipped := v_skipped + 1;
            ELSE
                name := split_part(rtrim(storage.get_common_prefix(v_peek_name, v_prefix, v_delimiter), v_delimiter), v_delimiter, levels);
                id := NULL;
                updated_at := NULL;
                created_at := NULL;
                last_accessed_at := NULL;
                metadata := NULL;
                RETURN NEXT;
                v_count := v_count + 1;
            END IF;

            -- Advance seek past the folder range
            IF v_is_asc THEN
                v_next_seek := lower(left(v_common_prefix, -1)) || chr(ascii(v_delimiter) + 1);
            ELSE
                v_next_seek := lower(v_common_prefix);
            END IF;
        ELSE
            -- FILE: Batch fetch using DYNAMIC SQL (overhead amortized over many rows)
            -- For ASC: upper_bound is the exclusive upper limit (< condition)
            -- For DESC: prefix_lower is the inclusive lower limit (>= condition)
            FOR v_current IN EXECUTE v_batch_query
                USING bucketname, v_next_seek,
                    CASE WHEN v_is_asc THEN COALESCE(v_upper_bound, v_prefix_lower) ELSE v_prefix_lower END, v_file_batch_size
            LOOP
                v_common_prefix := storage.get_common_prefix(lower(v_current.name), v_prefix_lower, v_delimiter);

                IF v_common_prefix IS NOT NULL THEN
                    -- Hit a folder: exit batch, let peek handle it
                    v_next_seek := lower(v_current.name);
                    EXIT;
                END IF;

                -- Handle offset skipping
                IF v_skipped < offsets THEN
                    v_skipped := v_skipped + 1;
                ELSE
                    -- Emit file
                    name := split_part(v_current.name, v_delimiter, levels);
                    id := v_current.id;
                    updated_at := v_current.updated_at;
                    created_at := v_current.created_at;
                    last_accessed_at := v_current.last_accessed_at;
                    metadata := v_current.metadata;
                    RETURN NEXT;
                    v_count := v_count + 1;
                END IF;

                -- Advance seek past this file
                IF v_is_asc THEN
                    v_next_seek := lower(v_current.name) || v_delimiter;
                ELSE
                    v_next_seek := lower(v_current.name);
                END IF;

                EXIT WHEN v_count >= v_limit;
            END LOOP;
        END IF;
    END LOOP;
END;
$_$;


ALTER FUNCTION storage.search(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text) OWNER TO supabase_storage_admin;

--
-- Name: search_by_timestamp(text, text, integer, integer, text, text, text, text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.search_by_timestamp(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) RETURNS TABLE(key text, name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
DECLARE
    v_cursor_op text;
    v_query text;
    v_prefix text;
BEGIN
    v_prefix := coalesce(p_prefix, '');

    IF p_sort_order = 'asc' THEN
        v_cursor_op := '>';
    ELSE
        v_cursor_op := '<';
    END IF;

    v_query := format($sql$
        WITH raw_objects AS (
            SELECT
                o.name AS obj_name,
                o.id AS obj_id,
                o.updated_at AS obj_updated_at,
                o.created_at AS obj_created_at,
                o.last_accessed_at AS obj_last_accessed_at,
                o.metadata AS obj_metadata,
                storage.get_common_prefix(o.name, $1, '/') AS common_prefix
            FROM storage.objects o
            WHERE o.bucket_id = $2
              AND o.name COLLATE "C" LIKE $1 || '%%'
        ),
        -- Aggregate common prefixes (folders)
        -- Both created_at and updated_at use MIN(obj_created_at) to match the old prefixes table behavior
        aggregated_prefixes AS (
            SELECT
                rtrim(common_prefix, '/') AS name,
                NULL::uuid AS id,
                MIN(obj_created_at) AS updated_at,
                MIN(obj_created_at) AS created_at,
                NULL::timestamptz AS last_accessed_at,
                NULL::jsonb AS metadata,
                TRUE AS is_prefix
            FROM raw_objects
            WHERE common_prefix IS NOT NULL
            GROUP BY common_prefix
        ),
        leaf_objects AS (
            SELECT
                obj_name AS name,
                obj_id AS id,
                obj_updated_at AS updated_at,
                obj_created_at AS created_at,
                obj_last_accessed_at AS last_accessed_at,
                obj_metadata AS metadata,
                FALSE AS is_prefix
            FROM raw_objects
            WHERE common_prefix IS NULL
        ),
        combined AS (
            SELECT * FROM aggregated_prefixes
            UNION ALL
            SELECT * FROM leaf_objects
        ),
        filtered AS (
            SELECT *
            FROM combined
            WHERE (
                $5 = ''
                OR ROW(
                    date_trunc('milliseconds', %I),
                    name COLLATE "C"
                ) %s ROW(
                    COALESCE(NULLIF($6, '')::timestamptz, 'epoch'::timestamptz),
                    $5
                )
            )
        )
        SELECT
            split_part(name, '/', $3) AS key,
            name,
            id,
            updated_at,
            created_at,
            last_accessed_at,
            metadata
        FROM filtered
        ORDER BY
            COALESCE(date_trunc('milliseconds', %I), 'epoch'::timestamptz) %s,
            name COLLATE "C" %s
        LIMIT $4
    $sql$,
        p_sort_column,
        v_cursor_op,
        p_sort_column,
        p_sort_order,
        p_sort_order
    );

    RETURN QUERY EXECUTE v_query
    USING v_prefix, p_bucket_id, p_level, p_limit, p_start_after, p_sort_column_after;
END;
$_$;


ALTER FUNCTION storage.search_by_timestamp(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) OWNER TO supabase_storage_admin;

--
-- Name: search_v2(text, text, integer, integer, text, text, text, text); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.search_v2(prefix text, bucket_name text, limits integer DEFAULT 100, levels integer DEFAULT 1, start_after text DEFAULT ''::text, sort_order text DEFAULT 'asc'::text, sort_column text DEFAULT 'name'::text, sort_column_after text DEFAULT ''::text) RETURNS TABLE(key text, name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_sort_col text;
    v_sort_ord text;
    v_limit int;
BEGIN
    -- Cap limit to maximum of 1500 records
    v_limit := LEAST(coalesce(limits, 100), 1500);

    -- Validate and normalize sort_order
    v_sort_ord := lower(coalesce(sort_order, 'asc'));
    IF v_sort_ord NOT IN ('asc', 'desc') THEN
        v_sort_ord := 'asc';
    END IF;

    -- Validate and normalize sort_column
    v_sort_col := lower(coalesce(sort_column, 'name'));
    IF v_sort_col NOT IN ('name', 'updated_at', 'created_at') THEN
        v_sort_col := 'name';
    END IF;

    -- Route to appropriate implementation
    IF v_sort_col = 'name' THEN
        -- Use list_objects_with_delimiter for name sorting (most efficient: O(k * log n))
        RETURN QUERY
        SELECT
            split_part(l.name, '/', levels) AS key,
            l.name AS name,
            l.id,
            l.updated_at,
            l.created_at,
            l.last_accessed_at,
            l.metadata
        FROM storage.list_objects_with_delimiter(
            bucket_name,
            coalesce(prefix, ''),
            '/',
            v_limit,
            start_after,
            '',
            v_sort_ord
        ) l;
    ELSE
        -- Use aggregation approach for timestamp sorting
        -- Not efficient for large datasets but supports correct pagination
        RETURN QUERY SELECT * FROM storage.search_by_timestamp(
            prefix, bucket_name, v_limit, levels, start_after,
            v_sort_ord, v_sort_col, sort_column_after
        );
    END IF;
END;
$$;


ALTER FUNCTION storage.search_v2(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_column_after text) OWNER TO supabase_storage_admin;

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: storage; Owner: supabase_storage_admin
--

CREATE FUNCTION storage.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW; 
END;
$$;


ALTER FUNCTION storage.update_updated_at_column() OWNER TO supabase_storage_admin;

--
-- Name: http_request(); Type: FUNCTION; Schema: supabase_functions; Owner: supabase_functions_admin
--

CREATE FUNCTION supabase_functions.http_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'supabase_functions'
    AS $$
  DECLARE
    request_id bigint;
    payload jsonb;
    url text := TG_ARGV[0]::text;
    method text := TG_ARGV[1]::text;
    headers jsonb DEFAULT '{}'::jsonb;
    params jsonb DEFAULT '{}'::jsonb;
    timeout_ms integer DEFAULT 1000;
  BEGIN
    IF url IS NULL OR url = 'null' THEN
      RAISE EXCEPTION 'url argument is missing';
    END IF;

    IF method IS NULL OR method = 'null' THEN
      RAISE EXCEPTION 'method argument is missing';
    END IF;

    IF TG_ARGV[2] IS NULL OR TG_ARGV[2] = 'null' THEN
      headers = '{"Content-Type": "application/json"}'::jsonb;
    ELSE
      headers = TG_ARGV[2]::jsonb;
    END IF;

    IF TG_ARGV[3] IS NULL OR TG_ARGV[3] = 'null' THEN
      params = '{}'::jsonb;
    ELSE
      params = TG_ARGV[3]::jsonb;
    END IF;

    IF TG_ARGV[4] IS NULL OR TG_ARGV[4] = 'null' THEN
      timeout_ms = 1000;
    ELSE
      timeout_ms = TG_ARGV[4]::integer;
    END IF;

    CASE
      WHEN method = 'GET' THEN
        SELECT http_get INTO request_id FROM net.http_get(
          url,
          params,
          headers,
          timeout_ms
        );
      WHEN method = 'POST' THEN
        payload = jsonb_build_object(
          'old_record', OLD,
          'record', NEW,
          'type', TG_OP,
          'table', TG_TABLE_NAME,
          'schema', TG_TABLE_SCHEMA
        );

        SELECT http_post INTO request_id FROM net.http_post(
          url,
          payload,
          params,
          headers,
          timeout_ms
        );
      ELSE
        RAISE EXCEPTION 'method argument % is invalid', method;
    END CASE;

    INSERT INTO supabase_functions.hooks
      (hook_table_id, hook_name, request_id)
    VALUES
      (TG_RELID, TG_NAME, request_id);

    RETURN NEW;
  END
$$;


ALTER FUNCTION supabase_functions.http_request() OWNER TO supabase_functions_admin;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: extensions; Type: TABLE; Schema: _realtime; Owner: supabase_admin
--

CREATE TABLE _realtime.extensions (
    id uuid NOT NULL,
    type text,
    settings jsonb,
    tenant_external_id text,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE _realtime.extensions OWNER TO supabase_admin;

--
-- Name: feature_flags; Type: TABLE; Schema: _realtime; Owner: supabase_admin
--

CREATE TABLE _realtime.feature_flags (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


ALTER TABLE _realtime.feature_flags OWNER TO supabase_admin;

--
-- Name: schema_migrations; Type: TABLE; Schema: _realtime; Owner: supabase_admin
--

CREATE TABLE _realtime.schema_migrations (
    version bigint NOT NULL,
    inserted_at timestamp(0) without time zone
);


ALTER TABLE _realtime.schema_migrations OWNER TO supabase_admin;

--
-- Name: tenants; Type: TABLE; Schema: _realtime; Owner: supabase_admin
--

CREATE TABLE _realtime.tenants (
    id uuid NOT NULL,
    name text,
    external_id text,
    jwt_secret text,
    max_concurrent_users integer DEFAULT 200 NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    max_events_per_second integer DEFAULT 100 NOT NULL,
    postgres_cdc_default text DEFAULT 'postgres_cdc_rls'::text,
    max_bytes_per_second integer DEFAULT 100000 NOT NULL,
    max_channels_per_client integer DEFAULT 100 NOT NULL,
    max_joins_per_second integer DEFAULT 500 NOT NULL,
    suspend boolean DEFAULT false,
    jwt_jwks jsonb,
    notify_private_alpha boolean DEFAULT false,
    private_only boolean DEFAULT false NOT NULL,
    migrations_ran integer DEFAULT 0,
    broadcast_adapter character varying(255) DEFAULT 'gen_rpc'::character varying,
    max_presence_events_per_second integer DEFAULT 1000,
    max_payload_size_in_kb integer DEFAULT 3000,
    max_client_presence_events_per_window integer,
    client_presence_window_ms integer,
    presence_enabled boolean DEFAULT false NOT NULL,
    feature_flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT jwt_secret_or_jwt_jwks_required CHECK (((jwt_secret IS NOT NULL) OR (jwt_jwks IS NOT NULL)))
);


ALTER TABLE _realtime.tenants OWNER TO supabase_admin;

--
-- Name: audit_log_entries; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.audit_log_entries (
    instance_id uuid,
    id uuid NOT NULL,
    payload json,
    created_at timestamp with time zone,
    ip_address character varying(64) DEFAULT ''::character varying NOT NULL
);


ALTER TABLE auth.audit_log_entries OWNER TO supabase_auth_admin;

--
-- Name: TABLE audit_log_entries; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.audit_log_entries IS 'Auth: Audit trail for user actions.';


--
-- Name: custom_oauth_providers; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.custom_oauth_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_type text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    client_id text NOT NULL,
    client_secret text NOT NULL,
    acceptable_client_ids text[] DEFAULT '{}'::text[] NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    pkce_enabled boolean DEFAULT true NOT NULL,
    attribute_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    authorization_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    email_optional boolean DEFAULT false NOT NULL,
    issuer text,
    discovery_url text,
    skip_nonce_check boolean DEFAULT false NOT NULL,
    cached_discovery jsonb,
    discovery_cached_at timestamp with time zone,
    authorization_url text,
    token_url text,
    userinfo_url text,
    jwks_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_claims_allowlist text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT custom_oauth_providers_authorization_url_https CHECK (((authorization_url IS NULL) OR (authorization_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_authorization_url_length CHECK (((authorization_url IS NULL) OR (char_length(authorization_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_client_id_length CHECK (((char_length(client_id) >= 1) AND (char_length(client_id) <= 512))),
    CONSTRAINT custom_oauth_providers_discovery_url_length CHECK (((discovery_url IS NULL) OR (char_length(discovery_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_identifier_format CHECK ((identifier ~ '^[a-z0-9][a-z0-9:-]{0,48}[a-z0-9]$'::text)),
    CONSTRAINT custom_oauth_providers_issuer_length CHECK (((issuer IS NULL) OR ((char_length(issuer) >= 1) AND (char_length(issuer) <= 2048)))),
    CONSTRAINT custom_oauth_providers_jwks_uri_https CHECK (((jwks_uri IS NULL) OR (jwks_uri ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_jwks_uri_length CHECK (((jwks_uri IS NULL) OR (char_length(jwks_uri) <= 2048))),
    CONSTRAINT custom_oauth_providers_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 100))),
    CONSTRAINT custom_oauth_providers_oauth2_requires_endpoints CHECK (((provider_type <> 'oauth2'::text) OR ((authorization_url IS NOT NULL) AND (token_url IS NOT NULL) AND (userinfo_url IS NOT NULL)))),
    CONSTRAINT custom_oauth_providers_oidc_discovery_url_https CHECK (((provider_type <> 'oidc'::text) OR (discovery_url IS NULL) OR (discovery_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_oidc_issuer_https CHECK (((provider_type <> 'oidc'::text) OR (issuer IS NULL) OR (issuer ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_oidc_requires_issuer CHECK (((provider_type <> 'oidc'::text) OR (issuer IS NOT NULL))),
    CONSTRAINT custom_oauth_providers_provider_type_check CHECK ((provider_type = ANY (ARRAY['oauth2'::text, 'oidc'::text]))),
    CONSTRAINT custom_oauth_providers_token_url_https CHECK (((token_url IS NULL) OR (token_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_token_url_length CHECK (((token_url IS NULL) OR (char_length(token_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_userinfo_url_https CHECK (((userinfo_url IS NULL) OR (userinfo_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_userinfo_url_length CHECK (((userinfo_url IS NULL) OR (char_length(userinfo_url) <= 2048)))
);


ALTER TABLE auth.custom_oauth_providers OWNER TO supabase_auth_admin;

--
-- Name: flow_state; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.flow_state (
    id uuid NOT NULL,
    user_id uuid,
    auth_code text,
    code_challenge_method auth.code_challenge_method,
    code_challenge text,
    provider_type text NOT NULL,
    provider_access_token text,
    provider_refresh_token text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    authentication_method text NOT NULL,
    auth_code_issued_at timestamp with time zone,
    invite_token text,
    referrer text,
    oauth_client_state_id uuid,
    linking_target_id uuid,
    email_optional boolean DEFAULT false NOT NULL
);


ALTER TABLE auth.flow_state OWNER TO supabase_auth_admin;

--
-- Name: TABLE flow_state; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.flow_state IS 'Stores metadata for all OAuth/SSO login flows';


--
-- Name: identities; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.identities (
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    identity_data jsonb NOT NULL,
    provider text NOT NULL,
    last_sign_in_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    email text GENERATED ALWAYS AS (lower((identity_data ->> 'email'::text))) STORED,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


ALTER TABLE auth.identities OWNER TO supabase_auth_admin;

--
-- Name: TABLE identities; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.identities IS 'Auth: Stores identities associated to a user.';


--
-- Name: COLUMN identities.email; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.identities.email IS 'Auth: Email is a generated column that references the optional email property in the identity_data';


--
-- Name: instances; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.instances (
    id uuid NOT NULL,
    uuid uuid,
    raw_base_config text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


ALTER TABLE auth.instances OWNER TO supabase_auth_admin;

--
-- Name: TABLE instances; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.instances IS 'Auth: Manages users across multiple sites.';


--
-- Name: mfa_amr_claims; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.mfa_amr_claims (
    session_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    authentication_method text NOT NULL,
    id uuid NOT NULL
);


ALTER TABLE auth.mfa_amr_claims OWNER TO supabase_auth_admin;

--
-- Name: TABLE mfa_amr_claims; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.mfa_amr_claims IS 'auth: stores authenticator method reference claims for multi factor authentication';


--
-- Name: mfa_challenges; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.mfa_challenges (
    id uuid NOT NULL,
    factor_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    ip_address inet NOT NULL,
    otp_code text,
    web_authn_session_data jsonb
);


ALTER TABLE auth.mfa_challenges OWNER TO supabase_auth_admin;

--
-- Name: TABLE mfa_challenges; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.mfa_challenges IS 'auth: stores metadata about challenge requests made';


--
-- Name: mfa_factors; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.mfa_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    friendly_name text,
    factor_type auth.factor_type NOT NULL,
    status auth.factor_status NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    secret text,
    phone text,
    last_challenged_at timestamp with time zone,
    web_authn_credential jsonb,
    web_authn_aaguid uuid,
    last_webauthn_challenge_data jsonb
);


ALTER TABLE auth.mfa_factors OWNER TO supabase_auth_admin;

--
-- Name: TABLE mfa_factors; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.mfa_factors IS 'auth: stores metadata about factors';


--
-- Name: COLUMN mfa_factors.last_webauthn_challenge_data; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.mfa_factors.last_webauthn_challenge_data IS 'Stores the latest WebAuthn challenge data including attestation/assertion for customer verification';


--
-- Name: oauth_authorizations; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.oauth_authorizations (
    id uuid NOT NULL,
    authorization_id text NOT NULL,
    client_id uuid NOT NULL,
    user_id uuid,
    redirect_uri text NOT NULL,
    scope text NOT NULL,
    state text,
    resource text,
    code_challenge text,
    code_challenge_method auth.code_challenge_method,
    response_type auth.oauth_response_type DEFAULT 'code'::auth.oauth_response_type NOT NULL,
    status auth.oauth_authorization_status DEFAULT 'pending'::auth.oauth_authorization_status NOT NULL,
    authorization_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:03:00'::interval) NOT NULL,
    approved_at timestamp with time zone,
    nonce text,
    CONSTRAINT oauth_authorizations_authorization_code_length CHECK ((char_length(authorization_code) <= 255)),
    CONSTRAINT oauth_authorizations_code_challenge_length CHECK ((char_length(code_challenge) <= 128)),
    CONSTRAINT oauth_authorizations_expires_at_future CHECK ((expires_at > created_at)),
    CONSTRAINT oauth_authorizations_nonce_length CHECK ((char_length(nonce) <= 255)),
    CONSTRAINT oauth_authorizations_redirect_uri_length CHECK ((char_length(redirect_uri) <= 2048)),
    CONSTRAINT oauth_authorizations_resource_length CHECK ((char_length(resource) <= 2048)),
    CONSTRAINT oauth_authorizations_scope_length CHECK ((char_length(scope) <= 4096)),
    CONSTRAINT oauth_authorizations_state_length CHECK ((char_length(state) <= 4096))
);


ALTER TABLE auth.oauth_authorizations OWNER TO supabase_auth_admin;

--
-- Name: oauth_client_states; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.oauth_client_states (
    id uuid NOT NULL,
    provider_type text NOT NULL,
    code_verifier text,
    created_at timestamp with time zone NOT NULL
);


ALTER TABLE auth.oauth_client_states OWNER TO supabase_auth_admin;

--
-- Name: TABLE oauth_client_states; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.oauth_client_states IS 'Stores OAuth states for third-party provider authentication flows where Supabase acts as the OAuth client.';


--
-- Name: oauth_clients; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.oauth_clients (
    id uuid NOT NULL,
    client_secret_hash text,
    registration_type auth.oauth_registration_type NOT NULL,
    redirect_uris text NOT NULL,
    grant_types text NOT NULL,
    client_name text,
    client_uri text,
    logo_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    client_type auth.oauth_client_type DEFAULT 'confidential'::auth.oauth_client_type NOT NULL,
    token_endpoint_auth_method text NOT NULL,
    CONSTRAINT oauth_clients_client_name_length CHECK ((char_length(client_name) <= 1024)),
    CONSTRAINT oauth_clients_client_uri_length CHECK ((char_length(client_uri) <= 2048)),
    CONSTRAINT oauth_clients_logo_uri_length CHECK ((char_length(logo_uri) <= 2048)),
    CONSTRAINT oauth_clients_token_endpoint_auth_method_check CHECK ((token_endpoint_auth_method = ANY (ARRAY['client_secret_basic'::text, 'client_secret_post'::text, 'none'::text])))
);


ALTER TABLE auth.oauth_clients OWNER TO supabase_auth_admin;

--
-- Name: oauth_consents; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.oauth_consents (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    scopes text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT oauth_consents_revoked_after_granted CHECK (((revoked_at IS NULL) OR (revoked_at >= granted_at))),
    CONSTRAINT oauth_consents_scopes_length CHECK ((char_length(scopes) <= 2048)),
    CONSTRAINT oauth_consents_scopes_not_empty CHECK ((char_length(TRIM(BOTH FROM scopes)) > 0))
);


ALTER TABLE auth.oauth_consents OWNER TO supabase_auth_admin;

--
-- Name: one_time_tokens; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.one_time_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_type auth.one_time_token_type NOT NULL,
    token_hash text NOT NULL,
    relates_to text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT one_time_tokens_token_hash_check CHECK ((char_length(token_hash) > 0))
);


ALTER TABLE auth.one_time_tokens OWNER TO supabase_auth_admin;

--
-- Name: refresh_tokens; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.refresh_tokens (
    instance_id uuid,
    id bigint NOT NULL,
    token character varying(255),
    user_id character varying(255),
    revoked boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    parent character varying(255),
    session_id uuid
);


ALTER TABLE auth.refresh_tokens OWNER TO supabase_auth_admin;

--
-- Name: TABLE refresh_tokens; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.refresh_tokens IS 'Auth: Store of tokens used to refresh JWT tokens once they expire.';


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: auth; Owner: supabase_auth_admin
--

CREATE SEQUENCE auth.refresh_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE auth.refresh_tokens_id_seq OWNER TO supabase_auth_admin;

--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: supabase_auth_admin
--

ALTER SEQUENCE auth.refresh_tokens_id_seq OWNED BY auth.refresh_tokens.id;


--
-- Name: saml_providers; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.saml_providers (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    entity_id text NOT NULL,
    metadata_xml text NOT NULL,
    metadata_url text,
    attribute_mapping jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    name_id_format text,
    CONSTRAINT "entity_id not empty" CHECK ((char_length(entity_id) > 0)),
    CONSTRAINT "metadata_url not empty" CHECK (((metadata_url = NULL::text) OR (char_length(metadata_url) > 0))),
    CONSTRAINT "metadata_xml not empty" CHECK ((char_length(metadata_xml) > 0))
);


ALTER TABLE auth.saml_providers OWNER TO supabase_auth_admin;

--
-- Name: TABLE saml_providers; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.saml_providers IS 'Auth: Manages SAML Identity Provider connections.';


--
-- Name: saml_relay_states; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.saml_relay_states (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    request_id text NOT NULL,
    for_email text,
    redirect_to text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    flow_state_id uuid,
    CONSTRAINT "request_id not empty" CHECK ((char_length(request_id) > 0))
);


ALTER TABLE auth.saml_relay_states OWNER TO supabase_auth_admin;

--
-- Name: TABLE saml_relay_states; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.saml_relay_states IS 'Auth: Contains SAML Relay State information for each Service Provider initiated login.';


--
-- Name: schema_migrations; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.schema_migrations (
    version character varying(255) NOT NULL
);


ALTER TABLE auth.schema_migrations OWNER TO supabase_auth_admin;

--
-- Name: TABLE schema_migrations; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.schema_migrations IS 'Auth: Manages updates to the auth system.';


--
-- Name: sessions; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    factor_id uuid,
    aal auth.aal_level,
    not_after timestamp with time zone,
    refreshed_at timestamp without time zone,
    user_agent text,
    ip inet,
    tag text,
    oauth_client_id uuid,
    refresh_token_hmac_key text,
    refresh_token_counter bigint,
    scopes text,
    CONSTRAINT sessions_scopes_length CHECK ((char_length(scopes) <= 4096))
);


ALTER TABLE auth.sessions OWNER TO supabase_auth_admin;

--
-- Name: TABLE sessions; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.sessions IS 'Auth: Stores session data associated to a user.';


--
-- Name: COLUMN sessions.not_after; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.sessions.not_after IS 'Auth: Not after is a nullable column that contains a timestamp after which the session should be regarded as expired.';


--
-- Name: COLUMN sessions.refresh_token_hmac_key; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.sessions.refresh_token_hmac_key IS 'Holds a HMAC-SHA256 key used to sign refresh tokens for this session.';


--
-- Name: COLUMN sessions.refresh_token_counter; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.sessions.refresh_token_counter IS 'Holds the ID (counter) of the last issued refresh token.';


--
-- Name: sso_domains; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.sso_domains (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    domain text NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    CONSTRAINT "domain not empty" CHECK ((char_length(domain) > 0))
);


ALTER TABLE auth.sso_domains OWNER TO supabase_auth_admin;

--
-- Name: TABLE sso_domains; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.sso_domains IS 'Auth: Manages SSO email address domain mapping to an SSO Identity Provider.';


--
-- Name: sso_providers; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.sso_providers (
    id uuid NOT NULL,
    resource_id text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    disabled boolean,
    CONSTRAINT "resource_id not empty" CHECK (((resource_id = NULL::text) OR (char_length(resource_id) > 0)))
);


ALTER TABLE auth.sso_providers OWNER TO supabase_auth_admin;

--
-- Name: TABLE sso_providers; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.sso_providers IS 'Auth: Manages SSO identity provider information; see saml_providers for SAML.';


--
-- Name: COLUMN sso_providers.resource_id; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.sso_providers.resource_id IS 'Auth: Uniquely identifies a SSO provider according to a user-chosen resource ID (case insensitive), useful in infrastructure as code.';


--
-- Name: users; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.users (
    instance_id uuid,
    id uuid NOT NULL,
    aud character varying(255),
    role character varying(255),
    email character varying(255),
    encrypted_password character varying(255),
    email_confirmed_at timestamp with time zone,
    invited_at timestamp with time zone,
    confirmation_token character varying(255),
    confirmation_sent_at timestamp with time zone,
    recovery_token character varying(255),
    recovery_sent_at timestamp with time zone,
    email_change_token_new character varying(255),
    email_change character varying(255),
    email_change_sent_at timestamp with time zone,
    last_sign_in_at timestamp with time zone,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    is_super_admin boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    phone text DEFAULT NULL::character varying,
    phone_confirmed_at timestamp with time zone,
    phone_change text DEFAULT ''::character varying,
    phone_change_token character varying(255) DEFAULT ''::character varying,
    phone_change_sent_at timestamp with time zone,
    confirmed_at timestamp with time zone GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current character varying(255) DEFAULT ''::character varying,
    email_change_confirm_status smallint DEFAULT 0,
    banned_until timestamp with time zone,
    reauthentication_token character varying(255) DEFAULT ''::character varying,
    reauthentication_sent_at timestamp with time zone,
    is_sso_user boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    is_anonymous boolean DEFAULT false NOT NULL,
    CONSTRAINT users_email_change_confirm_status_check CHECK (((email_change_confirm_status >= 0) AND (email_change_confirm_status <= 2)))
);


ALTER TABLE auth.users OWNER TO supabase_auth_admin;

--
-- Name: TABLE users; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';


--
-- Name: COLUMN users.is_sso_user; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.users.is_sso_user IS 'Auth: Set this column to true when the account comes from SSO. These accounts can have duplicate emails.';


--
-- Name: webauthn_challenges; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.webauthn_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    challenge_type text NOT NULL,
    session_data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT webauthn_challenges_challenge_type_check CHECK ((challenge_type = ANY (ARRAY['signup'::text, 'registration'::text, 'authentication'::text])))
);


ALTER TABLE auth.webauthn_challenges OWNER TO supabase_auth_admin;

--
-- Name: webauthn_credentials; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.webauthn_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    credential_id bytea NOT NULL,
    public_key bytea NOT NULL,
    attestation_type text DEFAULT ''::text NOT NULL,
    aaguid uuid,
    sign_count bigint DEFAULT 0 NOT NULL,
    transports jsonb DEFAULT '[]'::jsonb NOT NULL,
    backup_eligible boolean DEFAULT false NOT NULL,
    backed_up boolean DEFAULT false NOT NULL,
    friendly_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


ALTER TABLE auth.webauthn_credentials OWNER TO supabase_auth_admin;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: uellix_owner
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


ALTER TABLE drizzle.__drizzle_migrations OWNER TO uellix_owner;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: uellix_owner
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO uellix_owner;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: uellix_owner
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    project_id uuid,
    actor_user_id uuid,
    entity_type character varying(100) NOT NULL,
    entity_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    before_json jsonb,
    after_json jsonb,
    reason text,
    ip_address character varying(45),
    user_agent text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.audit_logs OWNER TO uellix_owner;

--
-- Name: evidence_items; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.evidence_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    outcome_id uuid,
    indicator_id uuid,
    type character varying(50) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    url text,
    file_path text,
    file_size integer,
    mime_type character varying(255),
    content_hash character varying(255),
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    reviewer_id uuid,
    reviewed_at timestamp without time zone,
    review_notes text,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    confidence_score integer,
    confidence_calculated_at timestamp without time zone,
    integrity_verified boolean,
    integrity_verified_at timestamp without time zone,
    CONSTRAINT evidence_items_confidence_score_check CHECK (((confidence_score IS NULL) OR ((confidence_score >= 0) AND (confidence_score <= 100)))),
    CONSTRAINT evidence_items_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'under_review'::character varying, 'approved'::character varying, 'rejected'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT evidence_items_type_check CHECK (((type)::text = ANY ((ARRAY['file'::character varying, 'url'::character varying, 'text'::character varying])::text[])))
);


ALTER TABLE public.evidence_items OWNER TO uellix_owner;

--
-- Name: financial_proxies; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.financial_proxies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    source_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    proxy_type character varying(100),
    country character varying(2),
    territory character varying(255),
    currency character varying(10),
    value numeric(20,4),
    unit character varying(50),
    reference_year integer,
    thematic_area character varying(255),
    methodology text,
    confidence_level character varying(50),
    methodological_risk character varying(50),
    review_status character varying(50) DEFAULT 'suggested'::character varying NOT NULL,
    reviewer_id uuid,
    reviewed_at timestamp without time zone,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    value_usd numeric(20,4),
    fx_rate_id uuid,
    CONSTRAINT approved_proxy_check CHECK ((((review_status)::text <> 'approved'::text) OR ((value IS NOT NULL) AND (currency IS NOT NULL) AND (unit IS NOT NULL) AND (reference_year IS NOT NULL) AND (value_usd IS NOT NULL)))),
    CONSTRAINT confidence_level_check CHECK (((confidence_level)::text = ANY ((ARRAY['high'::character varying, 'medium'::character varying, 'low'::character varying])::text[]))),
    CONSTRAINT methodological_risk_check CHECK (((methodological_risk)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying])::text[]))),
    CONSTRAINT review_status_check CHECK (((review_status)::text = ANY ((ARRAY['suggested'::character varying, 'pending_review'::character varying, 'approved'::character varying, 'rejected'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.financial_proxies OWNER TO uellix_owner;

--
-- Name: funders; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.funders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    funder_type character varying(50) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT funders_funder_type_check CHECK (((funder_type)::text = ANY ((ARRAY['public'::character varying, 'private'::character varying, 'foundation'::character varying, 'multilateral'::character varying, 'individual'::character varying, 'other'::character varying])::text[])))
);


ALTER TABLE public.funders OWNER TO uellix_owner;

--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.fx_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    currency character varying(10) NOT NULL,
    rate_date date NOT NULL,
    rate_to_usd numeric(20,6) NOT NULL,
    source text NOT NULL,
    source_type character varying(20) NOT NULL,
    organization_id uuid,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT fx_rates_rate_to_usd_check CHECK ((rate_to_usd > (0)::numeric)),
    CONSTRAINT fx_rates_source_type_check CHECK (((source_type)::text = ANY ((ARRAY['auto_fetched'::character varying, 'manual'::character varying])::text[])))
);


ALTER TABLE public.fx_rates OWNER TO uellix_owner;

--
-- Name: impact_narratives; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.impact_narratives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    version character varying(50) NOT NULL,
    narrative_text text,
    theory_of_change_summary text,
    assumptions text,
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.impact_narratives OWNER TO uellix_owner;

--
-- Name: indicators; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.indicators (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    outcome_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    indicator_type character varying(100),
    unit character varying(50),
    baseline_value character varying(255),
    target_value character varying(255),
    actual_value character varying(255),
    data_source text,
    measurement_period character varying(100),
    confidence_level character varying(50),
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.indicators OWNER TO uellix_owner;

--
-- Name: invitations; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email character varying(255) NOT NULL,
    role character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    token_hash character varying(255) NOT NULL,
    invited_by uuid NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    accepted_at timestamp without time zone,
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.invitations OWNER TO uellix_owner;

--
-- Name: marketing_leads; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.marketing_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    company_name character varying(255),
    sroi_result character varying(50),
    source character varying(100) DEFAULT 'sroi_calculator'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.marketing_leads OWNER TO uellix_owner;

--
-- Name: methodology_review_matrix; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.methodology_review_matrix (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    pipeline_step character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    readiness_score integer,
    overall_notes text,
    reviewer_id uuid NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid,
    reviewed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT methodology_review_matrix_score_check CHECK (((readiness_score IS NULL) OR ((readiness_score >= 0) AND (readiness_score <= 100)))),
    CONSTRAINT methodology_review_matrix_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'reviewed'::character varying, 'approved'::character varying, 'flagged'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT methodology_review_matrix_step_check CHECK (((pipeline_step)::text = ANY ((ARRAY['stakeholders'::character varying, 'outcomes'::character varying, 'indicators'::character varying, 'evidence'::character varying, 'proxies'::character varying, 'narrative'::character varying])::text[])))
);


ALTER TABLE public.methodology_review_matrix OWNER TO uellix_owner;

--
-- Name: methodology_review_matrix_items; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.methodology_review_matrix_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    matrix_id uuid NOT NULL,
    item_key character varying(255) NOT NULL,
    label character varying(500) NOT NULL,
    status character varying(50) DEFAULT 'warning'::character varying NOT NULL,
    severity character varying(50) DEFAULT 'medium'::character varying NOT NULL,
    is_custom boolean DEFAULT false NOT NULL,
    notes text,
    created_by uuid NOT NULL,
    updated_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT methodology_review_matrix_items_severity_check CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying])::text[]))),
    CONSTRAINT methodology_review_matrix_items_status_check CHECK (((status)::text = ANY ((ARRAY['pass'::character varying, 'warning'::character varying, 'fail'::character varying, 'not_applicable'::character varying])::text[])))
);


ALTER TABLE public.methodology_review_matrix_items OWNER TO uellix_owner;

--
-- Name: organization_members; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.organization_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    invited_by uuid,
    joined_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_check CHECK (((role)::text = ANY ((ARRAY['super_admin'::character varying, 'organization_admin'::character varying, 'impact_manager'::character varying, 'analyst'::character varying, 'reviewer'::character varying, 'viewer'::character varying])::text[])))
);


ALTER TABLE public.organization_members OWNER TO uellix_owner;

--
-- Name: organizations; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    legal_name character varying(255),
    country character varying(2),
    sector character varying(255),
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    stella_monthly_quota integer DEFAULT 0,
    stella_plan_label character varying(100),
    logo_url character varying(255),
    brand_color character varying(7),
    white_label_enabled boolean DEFAULT false NOT NULL,
    base_currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    onboarding_completed boolean DEFAULT false NOT NULL,
    stripe_customer_id character varying(255),
    stripe_subscription_id character varying(255),
    stripe_price_id character varying(255)
);


ALTER TABLE public.organizations OWNER TO uellix_owner;

--
-- Name: outcome_funder_allocations; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.outcome_funder_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    outcome_id uuid NOT NULL,
    funder_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    allocation_pct numeric(7,4) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT outcome_funder_allocations_pct_check CHECK (((allocation_pct > (0)::numeric) AND (allocation_pct <= (100)::numeric))),
    CONSTRAINT outcome_funder_allocations_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.outcome_funder_allocations OWNER TO uellix_owner;

--
-- Name: outcome_proxy_assignments; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.outcome_proxy_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    outcome_id uuid NOT NULL,
    proxy_id uuid NOT NULL,
    justification text,
    territorial_adjustment_notes text,
    assigned_by uuid NOT NULL,
    assigned_at timestamp without time zone DEFAULT now() NOT NULL,
    assignment_status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    archived_by uuid,
    archived_at timestamp without time zone
);


ALTER TABLE public.outcome_proxy_assignments OWNER TO uellix_owner;

--
-- Name: outcome_taxonomy_mappings; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.outcome_taxonomy_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    outcome_id uuid NOT NULL,
    taxonomy_code_id uuid NOT NULL,
    mapping_confidence character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    rationale text,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT outcome_taxonomy_mappings_confidence_check CHECK (((mapping_confidence)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying])::text[])))
);


ALTER TABLE public.outcome_taxonomy_mappings OWNER TO uellix_owner;

--
-- Name: outcomes; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.outcomes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    stakeholder_group_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    outcome_type character varying(100),
    materiality_notes text,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    materiality_score integer,
    materiality_rationale text,
    CONSTRAINT outcomes_materiality_pair_check CHECK ((((materiality_score IS NULL) AND (materiality_rationale IS NULL)) OR ((materiality_score IS NOT NULL) AND (materiality_rationale IS NOT NULL)))),
    CONSTRAINT outcomes_materiality_score_check CHECK (((materiality_score IS NULL) OR ((materiality_score >= 1) AND (materiality_score <= 5))))
);


ALTER TABLE public.outcomes OWNER TO uellix_owner;

--
-- Name: portfolios; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.portfolios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.portfolios OWNER TO uellix_owner;

--
-- Name: project_investments; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.project_investments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    amount numeric(20,4) NOT NULL,
    currency character varying(10) NOT NULL,
    year integer,
    description text,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    funder_id uuid NOT NULL,
    contribution_type character varying(20) DEFAULT 'cash'::character varying NOT NULL,
    in_kind_valuation_notes text,
    amount_usd numeric(20,4),
    fx_rate_id uuid,
    CONSTRAINT project_investments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT project_investments_contribution_type_check CHECK (((contribution_type)::text = ANY ((ARRAY['cash'::character varying, 'in_kind'::character varying])::text[]))),
    CONSTRAINT project_investments_in_kind_notes_check CHECK ((((contribution_type)::text <> 'in_kind'::text) OR (in_kind_valuation_notes IS NOT NULL))),
    CONSTRAINT project_investments_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.project_investments OWNER TO uellix_owner;

--
-- Name: projects; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    portfolio_id uuid,
    name character varying(255) NOT NULL,
    description text,
    thematic_area character varying(255),
    territory character varying(255),
    country character varying(2),
    start_date timestamp without time zone,
    end_date timestamp without time zone,
    target_population_description text,
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    discount_rate_pct numeric(5,2),
    deletion_requested_at timestamp without time zone,
    deletion_requested_by uuid,
    deletion_reason text,
    deleted_at timestamp without time zone,
    deleted_by uuid,
    delete_reason text,
    CONSTRAINT deletion_consistency_check CHECK ((((deleted_at IS NULL) AND (deleted_by IS NULL) AND (delete_reason IS NULL)) OR ((deleted_at IS NOT NULL) AND (deleted_by IS NOT NULL) AND (delete_reason IS NOT NULL)))),
    CONSTRAINT deletion_request_consistency_check CHECK ((((deletion_requested_at IS NULL) AND (deletion_requested_by IS NULL) AND (deletion_reason IS NULL)) OR ((deletion_requested_at IS NOT NULL) AND (deletion_requested_by IS NOT NULL) AND (deletion_reason IS NOT NULL)))),
    CONSTRAINT projects_discount_rate_check CHECK (((discount_rate_pct IS NULL) OR ((discount_rate_pct >= (0)::numeric) AND (discount_rate_pct <= (100)::numeric)))),
    CONSTRAINT status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying, 'paused'::character varying, 'completed'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.projects OWNER TO uellix_owner;

--
-- Name: proxy_sources; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.proxy_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    name character varying(255) NOT NULL,
    description text,
    url text,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.proxy_sources OWNER TO uellix_owner;

--
-- Name: signup_allowlist; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.signup_allowlist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type character varying(20) NOT NULL,
    pattern character varying(255) NOT NULL,
    notes text,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT signup_allowlist_type_check CHECK (((type)::text = ANY ((ARRAY['email'::character varying, 'domain'::character varying])::text[])))
);


ALTER TABLE public.signup_allowlist OWNER TO uellix_owner;

--
-- Name: sroi_assignment_inputs; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.sroi_assignment_inputs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    assignment_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    quantity numeric(20,4) NOT NULL,
    unit character varying(50) NOT NULL,
    year integer,
    notes text,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sroi_assignment_inputs_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT sroi_assignment_inputs_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.sroi_assignment_inputs OWNER TO uellix_owner;

--
-- Name: sroi_calculation_line_items; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.sroi_calculation_line_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    gross_value numeric(20,4),
    net_value character varying(255),
    year integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    outcome_id uuid,
    proxy_id uuid,
    quantity numeric(20,4),
    proxy_value numeric(20,4),
    currency character varying(10),
    adjusted_value numeric(20,4),
    deadweight_pct character varying(255),
    attribution_pct character varying(255),
    displacement_pct character varying(255),
    dropoff_pct character varying(255),
    duration_years integer
);


ALTER TABLE public.sroi_calculation_line_items OWNER TO uellix_owner;

--
-- Name: sroi_calculation_runs; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.sroi_calculation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    total_investment numeric(20,4),
    total_value character varying(255),
    sroi_ratio numeric(20,6),
    run_date timestamp without time zone DEFAULT now() NOT NULL,
    status character varying(50) DEFAULT 'completed'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    currency character varying(10),
    gross_social_value numeric(20,4),
    net_social_value numeric(20,4),
    snapshot_json jsonb,
    calculated_by uuid,
    calculated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT sroi_calculation_runs_status_check CHECK (((status)::text = ANY ((ARRAY['calculated'::character varying, 'failed'::character varying, 'pending'::character varying])::text[])))
);


ALTER TABLE public.sroi_calculation_runs OWNER TO uellix_owner;

--
-- Name: sroi_filter_sets; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.sroi_filter_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    assignment_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    deadweight_pct character varying(255),
    displacement_pct character varying(255),
    attribution_pct character varying(255),
    dropoff_pct character varying(255),
    duration_years integer,
    justification text,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sroi_filter_sets_attribution_pct_check CHECK ((((NULLIF((attribution_pct)::text, ''::text))::numeric >= (0)::numeric) AND ((NULLIF((attribution_pct)::text, ''::text))::numeric <= (100)::numeric))),
    CONSTRAINT sroi_filter_sets_deadweight_pct_check CHECK ((((NULLIF((deadweight_pct)::text, ''::text))::numeric >= (0)::numeric) AND ((NULLIF((deadweight_pct)::text, ''::text))::numeric <= (100)::numeric))),
    CONSTRAINT sroi_filter_sets_displacement_pct_check CHECK ((((NULLIF((displacement_pct)::text, ''::text))::numeric >= (0)::numeric) AND ((NULLIF((displacement_pct)::text, ''::text))::numeric <= (100)::numeric))),
    CONSTRAINT sroi_filter_sets_dropoff_pct_check CHECK ((((NULLIF((dropoff_pct)::text, ''::text))::numeric >= (0)::numeric) AND ((NULLIF((dropoff_pct)::text, ''::text))::numeric <= (100)::numeric))),
    CONSTRAINT sroi_filter_sets_duration_years_check CHECK (((duration_years >= 1) AND (duration_years <= 50))),
    CONSTRAINT sroi_filter_sets_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.sroi_filter_sets OWNER TO uellix_owner;

--
-- Name: sroi_report_sections; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.sroi_report_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    report_id uuid NOT NULL,
    section_type character varying(100) NOT NULL,
    title character varying(255) NOT NULL,
    content text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sroi_report_sections_sort_order_check CHECK ((sort_order >= 0))
);


ALTER TABLE public.sroi_report_sections OWNER TO uellix_owner;

--
-- Name: sroi_reports; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.sroi_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    calculation_run_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    summary text,
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid,
    locked_by uuid,
    locked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    include_funder_breakdown boolean DEFAULT false NOT NULL,
    report_variant character varying(20) DEFAULT 'audit'::character varying NOT NULL,
    verification_hash character varying(255),
    CONSTRAINT sroi_reports_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'under_review'::character varying, 'locked'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT sroi_reports_variant_check CHECK (((report_variant)::text = ANY ((ARRAY['funder'::character varying, 'methodological'::character varying, 'audit'::character varying])::text[])))
);


ALTER TABLE public.sroi_reports OWNER TO uellix_owner;

--
-- Name: sroi_run_review_items; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.sroi_run_review_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    item_key character varying(255) NOT NULL,
    status character varying(50) DEFAULT 'warning'::character varying NOT NULL,
    severity character varying(50) DEFAULT 'medium'::character varying NOT NULL,
    notes text,
    created_by uuid NOT NULL,
    updated_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sroi_run_review_items_severity_check CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying])::text[]))),
    CONSTRAINT sroi_run_review_items_status_check CHECK (((status)::text = ANY ((ARRAY['pass'::character varying, 'warning'::character varying, 'fail'::character varying, 'not_applicable'::character varying])::text[])))
);


ALTER TABLE public.sroi_run_review_items OWNER TO uellix_owner;

--
-- Name: sroi_run_reviews; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.sroi_run_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    calculation_run_id uuid NOT NULL,
    reviewer_id uuid NOT NULL,
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    readiness_score integer,
    overall_notes text,
    created_by uuid NOT NULL,
    updated_by uuid,
    reviewed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sroi_run_reviews_score_check CHECK (((readiness_score >= 0) AND (readiness_score <= 100))),
    CONSTRAINT sroi_run_reviews_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'reviewed'::character varying, 'approved'::character varying, 'flagged'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.sroi_run_reviews OWNER TO uellix_owner;

--
-- Name: stakeholder_groups; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.stakeholder_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    type character varying(100),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.stakeholder_groups OWNER TO uellix_owner;

--
-- Name: stella_interactions; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.stella_interactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    created_by uuid NOT NULL,
    stella_role character varying(50) NOT NULL,
    pipeline_step character varying(100) NOT NULL,
    context_hash character varying(64) NOT NULL,
    response_json jsonb NOT NULL,
    model_used character varying(100) DEFAULT 'gemini-2.0-flash'::character varying NOT NULL,
    tokens_used integer,
    risk_level character varying(50),
    risk_flags text[],
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT stella_interactions_risk_level_check CHECK (((risk_level IS NULL) OR ((risk_level)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying])::text[])))),
    CONSTRAINT stella_interactions_stella_role_check CHECK (((stella_role)::text = ANY ((ARRAY['advisor'::character varying, 'validator'::character varying, 'composer'::character varying, 'proxy_reviewer'::character varying, 'evidence_reviewer'::character varying, 'audit_assistant'::character varying])::text[])))
);


ALTER TABLE public.stella_interactions OWNER TO uellix_owner;

--
-- Name: stella_suggestion_decisions; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.stella_suggestion_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    interaction_id uuid,
    suggestion_key text NOT NULL,
    decision text NOT NULL,
    previous_value_hash text,
    applied_text text,
    rejection_reason text,
    decided_by uuid NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stella_suggestion_decisions_decision_check CHECK ((decision = ANY (ARRAY['accepted'::text, 'accepted_edited'::text, 'rejected'::text, 'undone'::text]))),
    CONSTRAINT stella_suggestion_decisions_prev_hash_check CHECK (((previous_value_hash IS NULL) OR (previous_value_hash ~ '^[0-9a-f]{64}$'::text)))
);


ALTER TABLE public.stella_suggestion_decisions OWNER TO uellix_owner;

--
-- Name: TABLE stella_suggestion_decisions; Type: COMMENT; Schema: public; Owner: uellix_owner
--

COMMENT ON TABLE public.stella_suggestion_decisions IS 'Human decisions over Stella suggestions (WS3b, prepared stella_0003, gate G2). previous_value_hash is a SHA-256 digest — raw previous text is never stored. Managed outside the drizzle chain: see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.';


--
-- Name: taxonomy_catalogs; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.taxonomy_catalogs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(20) NOT NULL,
    name character varying(255) NOT NULL,
    version character varying(50) NOT NULL,
    source_url text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.taxonomy_catalogs OWNER TO uellix_owner;

--
-- Name: taxonomy_codes; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.taxonomy_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    catalog_id uuid NOT NULL,
    code character varying(50) NOT NULL,
    label character varying(500) NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.taxonomy_codes OWNER TO uellix_owner;

--
-- Name: theory_of_change_links; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.theory_of_change_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    from_node_id uuid NOT NULL,
    to_node_id uuid NOT NULL,
    assumption text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT theory_of_change_links_no_self_check CHECK ((from_node_id <> to_node_id)),
    CONSTRAINT theory_of_change_links_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


ALTER TABLE public.theory_of_change_links OWNER TO uellix_owner;

--
-- Name: theory_of_change_nodes; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.theory_of_change_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    node_type character varying(20) NOT NULL,
    outcome_id uuid,
    title character varying(255) NOT NULL,
    description text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT theory_of_change_nodes_outcome_ref_check CHECK (((((node_type)::text = 'outcome'::text) AND (outcome_id IS NOT NULL)) OR (((node_type)::text <> 'outcome'::text) AND (outcome_id IS NULL)))),
    CONSTRAINT theory_of_change_nodes_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT theory_of_change_nodes_type_check CHECK (((node_type)::text = ANY ((ARRAY['activity'::character varying, 'output'::character varying, 'outcome'::character varying])::text[])))
);


ALTER TABLE public.theory_of_change_nodes OWNER TO uellix_owner;

--
-- Name: users; Type: TABLE; Schema: public; Owner: uellix_owner
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    email character varying(255) NOT NULL,
    full_name character varying(255),
    avatar_url character varying(255),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    is_super_admin boolean DEFAULT false NOT NULL,
    deleted_at timestamp without time zone,
    deleted_by uuid
);


ALTER TABLE public.users OWNER TO uellix_owner;

--
-- Name: messages; Type: TABLE; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE TABLE realtime.messages (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binary_payload bytea
)
PARTITION BY RANGE (inserted_at);


ALTER TABLE realtime.messages OWNER TO supabase_realtime_admin;

--
-- Name: messages_2026_08_01; Type: TABLE; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE TABLE realtime.messages_2026_08_01 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binary_payload bytea,
    CONSTRAINT messages_payload_exclusive CHECK (((payload IS NULL) OR (binary_payload IS NULL)))
);


ALTER TABLE realtime.messages_2026_08_01 OWNER TO supabase_realtime_admin;

--
-- Name: messages_2026_08_02; Type: TABLE; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE TABLE realtime.messages_2026_08_02 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binary_payload bytea,
    CONSTRAINT messages_payload_exclusive CHECK (((payload IS NULL) OR (binary_payload IS NULL)))
);


ALTER TABLE realtime.messages_2026_08_02 OWNER TO supabase_realtime_admin;

--
-- Name: messages_2026_08_03; Type: TABLE; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE TABLE realtime.messages_2026_08_03 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binary_payload bytea,
    CONSTRAINT messages_payload_exclusive CHECK (((payload IS NULL) OR (binary_payload IS NULL)))
);


ALTER TABLE realtime.messages_2026_08_03 OWNER TO supabase_realtime_admin;

--
-- Name: messages_2026_08_04; Type: TABLE; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE TABLE realtime.messages_2026_08_04 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binary_payload bytea,
    CONSTRAINT messages_payload_exclusive CHECK (((payload IS NULL) OR (binary_payload IS NULL)))
);


ALTER TABLE realtime.messages_2026_08_04 OWNER TO supabase_realtime_admin;

--
-- Name: messages_2026_08_05; Type: TABLE; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE TABLE realtime.messages_2026_08_05 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binary_payload bytea,
    CONSTRAINT messages_payload_exclusive CHECK (((payload IS NULL) OR (binary_payload IS NULL)))
);


ALTER TABLE realtime.messages_2026_08_05 OWNER TO supabase_realtime_admin;

--
-- Name: messages_2026_08_06; Type: TABLE; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE TABLE realtime.messages_2026_08_06 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binary_payload bytea,
    CONSTRAINT messages_payload_exclusive CHECK (((payload IS NULL) OR (binary_payload IS NULL)))
);


ALTER TABLE realtime.messages_2026_08_06 OWNER TO supabase_realtime_admin;

--
-- Name: messages_2026_08_07; Type: TABLE; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE TABLE realtime.messages_2026_08_07 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binary_payload bytea,
    CONSTRAINT messages_payload_exclusive CHECK (((payload IS NULL) OR (binary_payload IS NULL)))
);


ALTER TABLE realtime.messages_2026_08_07 OWNER TO supabase_realtime_admin;

--
-- Name: schema_migrations; Type: TABLE; Schema: realtime; Owner: supabase_admin
--

CREATE TABLE realtime.schema_migrations (
    version bigint NOT NULL,
    inserted_at timestamp(0) without time zone
);


ALTER TABLE realtime.schema_migrations OWNER TO supabase_admin;

--
-- Name: subscription; Type: TABLE; Schema: realtime; Owner: supabase_admin
--

CREATE TABLE realtime.subscription (
    id bigint NOT NULL,
    subscription_id uuid NOT NULL,
    entity regclass NOT NULL,
    filters realtime.user_defined_filter[] DEFAULT '{}'::realtime.user_defined_filter[] NOT NULL,
    claims jsonb NOT NULL,
    claims_role regrole GENERATED ALWAYS AS (realtime.to_regrole((claims ->> 'role'::text))) STORED NOT NULL,
    created_at timestamp without time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    action_filter text DEFAULT '*'::text,
    selected_columns text[],
    CONSTRAINT subscription_action_filter_check CHECK ((action_filter = ANY (ARRAY['*'::text, 'INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))
);


ALTER TABLE realtime.subscription OWNER TO supabase_admin;

--
-- Name: subscription_id_seq; Type: SEQUENCE; Schema: realtime; Owner: supabase_admin
--

ALTER TABLE realtime.subscription ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME realtime.subscription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: buckets; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.buckets (
    id text NOT NULL,
    name text NOT NULL,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    public boolean DEFAULT false,
    avif_autodetection boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    owner_id text,
    type storage.buckettype DEFAULT 'STANDARD'::storage.buckettype NOT NULL
);


ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;

--
-- Name: COLUMN buckets.owner; Type: COMMENT; Schema: storage; Owner: supabase_storage_admin
--

COMMENT ON COLUMN storage.buckets.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: buckets_analytics; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.buckets_analytics (
    name text NOT NULL,
    type storage.buckettype DEFAULT 'ANALYTICS'::storage.buckettype NOT NULL,
    format text DEFAULT 'ICEBERG'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deleted_at timestamp with time zone
);


ALTER TABLE storage.buckets_analytics OWNER TO supabase_storage_admin;

--
-- Name: buckets_vectors; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.buckets_vectors (
    id text NOT NULL,
    type storage.buckettype DEFAULT 'VECTOR'::storage.buckettype NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE storage.buckets_vectors OWNER TO supabase_storage_admin;

--
-- Name: iceberg_namespaces; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.iceberg_namespaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_name text NOT NULL,
    name text NOT NULL COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    catalog_id uuid NOT NULL
);


ALTER TABLE storage.iceberg_namespaces OWNER TO supabase_storage_admin;

--
-- Name: iceberg_tables; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.iceberg_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    namespace_id uuid NOT NULL,
    bucket_name text NOT NULL,
    name text NOT NULL COLLATE pg_catalog."C",
    location text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    remote_table_id text,
    shard_key text,
    shard_id text,
    catalog_id uuid NOT NULL
);


ALTER TABLE storage.iceberg_tables OWNER TO supabase_storage_admin;

--
-- Name: migrations; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.migrations (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    hash character varying(40) NOT NULL,
    executed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE storage.migrations OWNER TO supabase_storage_admin;

--
-- Name: objects; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_id text,
    name text,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_accessed_at timestamp with time zone DEFAULT now(),
    metadata jsonb,
    path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/'::text)) STORED,
    version text,
    owner_id text,
    user_metadata jsonb
);


ALTER TABLE storage.objects OWNER TO supabase_storage_admin;

--
-- Name: COLUMN objects.owner; Type: COMMENT; Schema: storage; Owner: supabase_storage_admin
--

COMMENT ON COLUMN storage.objects.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: s3_multipart_uploads; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.s3_multipart_uploads (
    id text NOT NULL,
    in_progress_size bigint DEFAULT 0 NOT NULL,
    upload_signature text NOT NULL,
    bucket_id text NOT NULL,
    key text NOT NULL COLLATE pg_catalog."C",
    version text NOT NULL,
    owner_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_metadata jsonb,
    metadata jsonb
);


ALTER TABLE storage.s3_multipart_uploads OWNER TO supabase_storage_admin;

--
-- Name: s3_multipart_uploads_parts; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.s3_multipart_uploads_parts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    upload_id text NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    part_number integer NOT NULL,
    bucket_id text NOT NULL,
    key text NOT NULL COLLATE pg_catalog."C",
    etag text NOT NULL,
    owner_id text,
    version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE storage.s3_multipart_uploads_parts OWNER TO supabase_storage_admin;

--
-- Name: vector_indexes; Type: TABLE; Schema: storage; Owner: supabase_storage_admin
--

CREATE TABLE storage.vector_indexes (
    id text DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL COLLATE pg_catalog."C",
    bucket_id text NOT NULL,
    data_type text NOT NULL,
    dimension integer NOT NULL,
    distance_metric text NOT NULL,
    metadata_configuration jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE storage.vector_indexes OWNER TO supabase_storage_admin;

--
-- Name: hooks; Type: TABLE; Schema: supabase_functions; Owner: supabase_functions_admin
--

CREATE TABLE supabase_functions.hooks (
    id bigint NOT NULL,
    hook_table_id integer NOT NULL,
    hook_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id bigint
);


ALTER TABLE supabase_functions.hooks OWNER TO supabase_functions_admin;

--
-- Name: TABLE hooks; Type: COMMENT; Schema: supabase_functions; Owner: supabase_functions_admin
--

COMMENT ON TABLE supabase_functions.hooks IS 'Supabase Functions Hooks: Audit trail for triggered hooks.';


--
-- Name: hooks_id_seq; Type: SEQUENCE; Schema: supabase_functions; Owner: supabase_functions_admin
--

CREATE SEQUENCE supabase_functions.hooks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE supabase_functions.hooks_id_seq OWNER TO supabase_functions_admin;

--
-- Name: hooks_id_seq; Type: SEQUENCE OWNED BY; Schema: supabase_functions; Owner: supabase_functions_admin
--

ALTER SEQUENCE supabase_functions.hooks_id_seq OWNED BY supabase_functions.hooks.id;


--
-- Name: migrations; Type: TABLE; Schema: supabase_functions; Owner: supabase_functions_admin
--

CREATE TABLE supabase_functions.migrations (
    version text NOT NULL,
    inserted_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE supabase_functions.migrations OWNER TO supabase_functions_admin;

--
-- Name: schema_migrations; Type: TABLE; Schema: supabase_migrations; Owner: postgres
--

CREATE TABLE supabase_migrations.schema_migrations (
    version text NOT NULL,
    statements text[],
    name text
);


ALTER TABLE supabase_migrations.schema_migrations OWNER TO postgres;

--
-- Name: messages_2026_08_01; Type: TABLE ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_01 FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-08-02 00:00:00');


--
-- Name: messages_2026_08_02; Type: TABLE ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_02 FOR VALUES FROM ('2026-08-02 00:00:00') TO ('2026-08-03 00:00:00');


--
-- Name: messages_2026_08_03; Type: TABLE ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_03 FOR VALUES FROM ('2026-08-03 00:00:00') TO ('2026-08-04 00:00:00');


--
-- Name: messages_2026_08_04; Type: TABLE ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_04 FOR VALUES FROM ('2026-08-04 00:00:00') TO ('2026-08-05 00:00:00');


--
-- Name: messages_2026_08_05; Type: TABLE ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_05 FOR VALUES FROM ('2026-08-05 00:00:00') TO ('2026-08-06 00:00:00');


--
-- Name: messages_2026_08_06; Type: TABLE ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_06 FOR VALUES FROM ('2026-08-06 00:00:00') TO ('2026-08-07 00:00:00');


--
-- Name: messages_2026_08_07; Type: TABLE ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_07 FOR VALUES FROM ('2026-08-07 00:00:00') TO ('2026-08-08 00:00:00');


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('auth.refresh_tokens_id_seq'::regclass);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: uellix_owner
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: hooks id; Type: DEFAULT; Schema: supabase_functions; Owner: supabase_functions_admin
--

ALTER TABLE ONLY supabase_functions.hooks ALTER COLUMN id SET DEFAULT nextval('supabase_functions.hooks_id_seq'::regclass);


--
-- Name: extensions extensions_pkey; Type: CONSTRAINT; Schema: _realtime; Owner: supabase_admin
--

ALTER TABLE ONLY _realtime.extensions
    ADD CONSTRAINT extensions_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: _realtime; Owner: supabase_admin
--

ALTER TABLE ONLY _realtime.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: _realtime; Owner: supabase_admin
--

ALTER TABLE ONLY _realtime.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: _realtime; Owner: supabase_admin
--

ALTER TABLE ONLY _realtime.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: mfa_amr_claims amr_id_pk; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT amr_id_pk PRIMARY KEY (id);


--
-- Name: audit_log_entries audit_log_entries_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.audit_log_entries
    ADD CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id);


--
-- Name: custom_oauth_providers custom_oauth_providers_identifier_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.custom_oauth_providers
    ADD CONSTRAINT custom_oauth_providers_identifier_key UNIQUE (identifier);


--
-- Name: custom_oauth_providers custom_oauth_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.custom_oauth_providers
    ADD CONSTRAINT custom_oauth_providers_pkey PRIMARY KEY (id);


--
-- Name: flow_state flow_state_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.flow_state
    ADD CONSTRAINT flow_state_pkey PRIMARY KEY (id);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);


--
-- Name: identities identities_provider_id_provider_unique; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_authentication_method_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_authentication_method_pkey UNIQUE (session_id, authentication_method);


--
-- Name: mfa_challenges mfa_challenges_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id);


--
-- Name: mfa_factors mfa_factors_last_challenged_at_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_last_challenged_at_key UNIQUE (last_challenged_at);


--
-- Name: mfa_factors mfa_factors_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_pkey PRIMARY KEY (id);


--
-- Name: oauth_authorizations oauth_authorizations_authorization_code_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_authorization_code_key UNIQUE (authorization_code);


--
-- Name: oauth_authorizations oauth_authorizations_authorization_id_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_authorization_id_key UNIQUE (authorization_id);


--
-- Name: oauth_authorizations oauth_authorizations_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_pkey PRIMARY KEY (id);


--
-- Name: oauth_client_states oauth_client_states_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_client_states
    ADD CONSTRAINT oauth_client_states_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: oauth_consents oauth_consents_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_pkey PRIMARY KEY (id);


--
-- Name: oauth_consents oauth_consents_user_client_unique; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_user_client_unique UNIQUE (user_id, client_id);


--
-- Name: one_time_tokens one_time_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_unique; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_unique UNIQUE (token);


--
-- Name: saml_providers saml_providers_entity_id_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_entity_id_key UNIQUE (entity_id);


--
-- Name: saml_providers saml_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_pkey PRIMARY KEY (id);


--
-- Name: saml_relay_states saml_relay_states_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sso_domains sso_domains_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_pkey PRIMARY KEY (id);


--
-- Name: sso_providers sso_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sso_providers
    ADD CONSTRAINT sso_providers_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: webauthn_challenges webauthn_challenges_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_pkey PRIMARY KEY (id);


--
-- Name: webauthn_credentials webauthn_credentials_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_pkey PRIMARY KEY (id);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: uellix_owner
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: evidence_items evidence_items_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.evidence_items
    ADD CONSTRAINT evidence_items_pkey PRIMARY KEY (id);


--
-- Name: financial_proxies financial_proxies_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.financial_proxies
    ADD CONSTRAINT financial_proxies_pkey PRIMARY KEY (id);


--
-- Name: funders funders_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.funders
    ADD CONSTRAINT funders_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (id);


--
-- Name: impact_narratives impact_narratives_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.impact_narratives
    ADD CONSTRAINT impact_narratives_pkey PRIMARY KEY (id);


--
-- Name: indicators indicators_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.indicators
    ADD CONSTRAINT indicators_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: marketing_leads marketing_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.marketing_leads
    ADD CONSTRAINT marketing_leads_pkey PRIMARY KEY (id);


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_matrix_key_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix_items
    ADD CONSTRAINT methodology_review_matrix_items_matrix_key_unique UNIQUE (matrix_id, item_key);


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix_items
    ADD CONSTRAINT methodology_review_matrix_items_pkey PRIMARY KEY (id);


--
-- Name: methodology_review_matrix methodology_review_matrix_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix
    ADD CONSTRAINT methodology_review_matrix_pkey PRIMARY KEY (id);


--
-- Name: methodology_review_matrix methodology_review_matrix_project_step_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix
    ADD CONSTRAINT methodology_review_matrix_project_step_unique UNIQUE (project_id, pipeline_step);


--
-- Name: organization_members organization_members_org_user_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_org_user_unique UNIQUE (organization_id, user_id);


--
-- Name: organization_members organization_members_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_unique UNIQUE (slug);


--
-- Name: organizations organizations_stripe_customer_id_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_stripe_customer_id_unique UNIQUE (stripe_customer_id);


--
-- Name: organizations organizations_stripe_subscription_id_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_stripe_subscription_id_unique UNIQUE (stripe_subscription_id);


--
-- Name: outcome_funder_allocations outcome_funder_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_funder_allocations
    ADD CONSTRAINT outcome_funder_allocations_pkey PRIMARY KEY (id);


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_proxy_assignments
    ADD CONSTRAINT outcome_proxy_assignments_pkey PRIMARY KEY (id);


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_outcome_code_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_taxonomy_mappings
    ADD CONSTRAINT outcome_taxonomy_mappings_outcome_code_unique UNIQUE (outcome_id, taxonomy_code_id);


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_taxonomy_mappings
    ADD CONSTRAINT outcome_taxonomy_mappings_pkey PRIMARY KEY (id);


--
-- Name: outcomes outcomes_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcomes
    ADD CONSTRAINT outcomes_pkey PRIMARY KEY (id);


--
-- Name: portfolios portfolios_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.portfolios
    ADD CONSTRAINT portfolios_pkey PRIMARY KEY (id);


--
-- Name: project_investments project_investments_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.project_investments
    ADD CONSTRAINT project_investments_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: proxy_sources proxy_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.proxy_sources
    ADD CONSTRAINT proxy_sources_pkey PRIMARY KEY (id);


--
-- Name: signup_allowlist signup_allowlist_pattern_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.signup_allowlist
    ADD CONSTRAINT signup_allowlist_pattern_unique UNIQUE (pattern);


--
-- Name: signup_allowlist signup_allowlist_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.signup_allowlist
    ADD CONSTRAINT signup_allowlist_pkey PRIMARY KEY (id);


--
-- Name: sroi_assignment_inputs sroi_assignment_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_assignment_inputs
    ADD CONSTRAINT sroi_assignment_inputs_pkey PRIMARY KEY (id);


--
-- Name: sroi_calculation_line_items sroi_calculation_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_line_items
    ADD CONSTRAINT sroi_calculation_line_items_pkey PRIMARY KEY (id);


--
-- Name: sroi_calculation_runs sroi_calculation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_runs
    ADD CONSTRAINT sroi_calculation_runs_pkey PRIMARY KEY (id);


--
-- Name: sroi_filter_sets sroi_filter_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_filter_sets
    ADD CONSTRAINT sroi_filter_sets_pkey PRIMARY KEY (id);


--
-- Name: sroi_report_sections sroi_report_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_report_sections
    ADD CONSTRAINT sroi_report_sections_pkey PRIMARY KEY (id);


--
-- Name: sroi_reports sroi_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_reports
    ADD CONSTRAINT sroi_reports_pkey PRIMARY KEY (id);


--
-- Name: sroi_reports sroi_reports_verification_hash_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_reports
    ADD CONSTRAINT sroi_reports_verification_hash_unique UNIQUE (verification_hash);


--
-- Name: sroi_run_review_items sroi_run_review_items_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_review_items
    ADD CONSTRAINT sroi_run_review_items_pkey PRIMARY KEY (id);


--
-- Name: sroi_run_reviews sroi_run_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_reviews
    ADD CONSTRAINT sroi_run_reviews_pkey PRIMARY KEY (id);


--
-- Name: stakeholder_groups stakeholder_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stakeholder_groups
    ADD CONSTRAINT stakeholder_groups_pkey PRIMARY KEY (id);


--
-- Name: stella_interactions stella_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_interactions
    ADD CONSTRAINT stella_interactions_pkey PRIMARY KEY (id);


--
-- Name: stella_suggestion_decisions stella_suggestion_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_suggestion_decisions
    ADD CONSTRAINT stella_suggestion_decisions_pkey PRIMARY KEY (id);


--
-- Name: taxonomy_catalogs taxonomy_catalogs_code_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.taxonomy_catalogs
    ADD CONSTRAINT taxonomy_catalogs_code_unique UNIQUE (code);


--
-- Name: taxonomy_catalogs taxonomy_catalogs_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.taxonomy_catalogs
    ADD CONSTRAINT taxonomy_catalogs_pkey PRIMARY KEY (id);


--
-- Name: taxonomy_codes taxonomy_codes_catalog_code_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.taxonomy_codes
    ADD CONSTRAINT taxonomy_codes_catalog_code_unique UNIQUE (catalog_id, code);


--
-- Name: taxonomy_codes taxonomy_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.taxonomy_codes
    ADD CONSTRAINT taxonomy_codes_pkey PRIMARY KEY (id);


--
-- Name: theory_of_change_links theory_of_change_links_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_links
    ADD CONSTRAINT theory_of_change_links_pkey PRIMARY KEY (id);


--
-- Name: theory_of_change_nodes theory_of_change_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_nodes
    ADD CONSTRAINT theory_of_change_nodes_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_01 messages_2026_08_01_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages_2026_08_01
    ADD CONSTRAINT messages_2026_08_01_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_02 messages_2026_08_02_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages_2026_08_02
    ADD CONSTRAINT messages_2026_08_02_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_03 messages_2026_08_03_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages_2026_08_03
    ADD CONSTRAINT messages_2026_08_03_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_04 messages_2026_08_04_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages_2026_08_04
    ADD CONSTRAINT messages_2026_08_04_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_05 messages_2026_08_05_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages_2026_08_05
    ADD CONSTRAINT messages_2026_08_05_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_06 messages_2026_08_06_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages_2026_08_06
    ADD CONSTRAINT messages_2026_08_06_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_07 messages_2026_08_07_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE ONLY realtime.messages_2026_08_07
    ADD CONSTRAINT messages_2026_08_07_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages messages_payload_exclusive; Type: CHECK CONSTRAINT; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE realtime.messages
    ADD CONSTRAINT messages_payload_exclusive CHECK (((payload IS NULL) OR (binary_payload IS NULL))) NOT VALID;


--
-- Name: subscription pk_subscription; Type: CONSTRAINT; Schema: realtime; Owner: supabase_admin
--

ALTER TABLE ONLY realtime.subscription
    ADD CONSTRAINT pk_subscription PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: realtime; Owner: supabase_admin
--

ALTER TABLE ONLY realtime.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: buckets_analytics buckets_analytics_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.buckets_analytics
    ADD CONSTRAINT buckets_analytics_pkey PRIMARY KEY (id);


--
-- Name: buckets buckets_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);


--
-- Name: buckets_vectors buckets_vectors_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.buckets_vectors
    ADD CONSTRAINT buckets_vectors_pkey PRIMARY KEY (id);


--
-- Name: iceberg_namespaces iceberg_namespaces_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.iceberg_namespaces
    ADD CONSTRAINT iceberg_namespaces_pkey PRIMARY KEY (id);


--
-- Name: iceberg_tables iceberg_tables_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.iceberg_tables
    ADD CONSTRAINT iceberg_tables_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_name_key; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.migrations
    ADD CONSTRAINT migrations_name_key UNIQUE (name);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_pkey PRIMARY KEY (id);


--
-- Name: s3_multipart_uploads s3_multipart_uploads_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.s3_multipart_uploads
    ADD CONSTRAINT s3_multipart_uploads_pkey PRIMARY KEY (id);


--
-- Name: vector_indexes vector_indexes_pkey; Type: CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.vector_indexes
    ADD CONSTRAINT vector_indexes_pkey PRIMARY KEY (id);


--
-- Name: hooks hooks_pkey; Type: CONSTRAINT; Schema: supabase_functions; Owner: supabase_functions_admin
--

ALTER TABLE ONLY supabase_functions.hooks
    ADD CONSTRAINT hooks_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: supabase_functions; Owner: supabase_functions_admin
--

ALTER TABLE ONLY supabase_functions.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (version);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: supabase_migrations; Owner: postgres
--

ALTER TABLE ONLY supabase_migrations.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: extensions_tenant_external_id_index; Type: INDEX; Schema: _realtime; Owner: supabase_admin
--

CREATE INDEX extensions_tenant_external_id_index ON _realtime.extensions USING btree (tenant_external_id);


--
-- Name: extensions_tenant_external_id_type_index; Type: INDEX; Schema: _realtime; Owner: supabase_admin
--

CREATE UNIQUE INDEX extensions_tenant_external_id_type_index ON _realtime.extensions USING btree (tenant_external_id, type);


--
-- Name: feature_flags_name_index; Type: INDEX; Schema: _realtime; Owner: supabase_admin
--

CREATE UNIQUE INDEX feature_flags_name_index ON _realtime.feature_flags USING btree (name);


--
-- Name: tenants_external_id_index; Type: INDEX; Schema: _realtime; Owner: supabase_admin
--

CREATE UNIQUE INDEX tenants_external_id_index ON _realtime.tenants USING btree (external_id);


--
-- Name: audit_logs_instance_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);


--
-- Name: confirmation_token_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: custom_oauth_providers_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX custom_oauth_providers_created_at_idx ON auth.custom_oauth_providers USING btree (created_at);


--
-- Name: custom_oauth_providers_enabled_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX custom_oauth_providers_enabled_idx ON auth.custom_oauth_providers USING btree (enabled);


--
-- Name: custom_oauth_providers_identifier_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX custom_oauth_providers_identifier_idx ON auth.custom_oauth_providers USING btree (identifier);


--
-- Name: custom_oauth_providers_provider_type_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX custom_oauth_providers_provider_type_idx ON auth.custom_oauth_providers USING btree (provider_type);


--
-- Name: email_change_token_current_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_new_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);


--
-- Name: factor_id_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX factor_id_created_at_idx ON auth.mfa_factors USING btree (user_id, created_at);


--
-- Name: flow_state_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX flow_state_created_at_idx ON auth.flow_state USING btree (created_at DESC);


--
-- Name: identities_email_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX identities_email_idx ON auth.identities USING btree (email text_pattern_ops);


--
-- Name: INDEX identities_email_idx; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON INDEX auth.identities_email_idx IS 'Auth: Ensures indexed queries on the email column';


--
-- Name: identities_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX identities_user_id_idx ON auth.identities USING btree (user_id);


--
-- Name: idx_auth_code; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX idx_auth_code ON auth.flow_state USING btree (auth_code);


--
-- Name: idx_oauth_client_states_created_at; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX idx_oauth_client_states_created_at ON auth.oauth_client_states USING btree (created_at);


--
-- Name: idx_user_id_auth_method; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX idx_user_id_auth_method ON auth.flow_state USING btree (user_id, authentication_method);


--
-- Name: mfa_challenge_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX mfa_challenge_created_at_idx ON auth.mfa_challenges USING btree (created_at DESC);


--
-- Name: mfa_factors_user_friendly_name_unique; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX mfa_factors_user_friendly_name_unique ON auth.mfa_factors USING btree (friendly_name, user_id) WHERE (TRIM(BOTH FROM friendly_name) <> ''::text);


--
-- Name: mfa_factors_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX mfa_factors_user_id_idx ON auth.mfa_factors USING btree (user_id);


--
-- Name: oauth_auth_pending_exp_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_auth_pending_exp_idx ON auth.oauth_authorizations USING btree (expires_at) WHERE (status = 'pending'::auth.oauth_authorization_status);


--
-- Name: oauth_clients_deleted_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_clients_deleted_at_idx ON auth.oauth_clients USING btree (deleted_at);


--
-- Name: oauth_consents_active_client_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_consents_active_client_idx ON auth.oauth_consents USING btree (client_id) WHERE (revoked_at IS NULL);


--
-- Name: oauth_consents_active_user_client_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_consents_active_user_client_idx ON auth.oauth_consents USING btree (user_id, client_id) WHERE (revoked_at IS NULL);


--
-- Name: oauth_consents_user_order_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_consents_user_order_idx ON auth.oauth_consents USING btree (user_id, granted_at DESC);


--
-- Name: one_time_tokens_relates_to_hash_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);


--
-- Name: one_time_tokens_token_hash_hash_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);


--
-- Name: one_time_tokens_user_id_token_type_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX one_time_tokens_user_id_token_type_key ON auth.one_time_tokens USING btree (user_id, token_type);


--
-- Name: reauthentication_token_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: recovery_token_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX recovery_token_idx ON auth.users USING btree (recovery_token) WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: refresh_tokens_instance_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);


--
-- Name: refresh_tokens_instance_id_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);


--
-- Name: refresh_tokens_parent_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_parent_idx ON auth.refresh_tokens USING btree (parent);


--
-- Name: refresh_tokens_session_id_revoked_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_session_id_revoked_idx ON auth.refresh_tokens USING btree (session_id, revoked);


--
-- Name: refresh_tokens_updated_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_updated_at_idx ON auth.refresh_tokens USING btree (updated_at DESC);


--
-- Name: saml_providers_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX saml_providers_sso_provider_id_idx ON auth.saml_providers USING btree (sso_provider_id);


--
-- Name: saml_relay_states_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX saml_relay_states_created_at_idx ON auth.saml_relay_states USING btree (created_at DESC);


--
-- Name: saml_relay_states_for_email_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX saml_relay_states_for_email_idx ON auth.saml_relay_states USING btree (for_email);


--
-- Name: saml_relay_states_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX saml_relay_states_sso_provider_id_idx ON auth.saml_relay_states USING btree (sso_provider_id);


--
-- Name: sessions_not_after_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sessions_not_after_idx ON auth.sessions USING btree (not_after DESC);


--
-- Name: sessions_oauth_client_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sessions_oauth_client_id_idx ON auth.sessions USING btree (oauth_client_id);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sessions_user_id_idx ON auth.sessions USING btree (user_id);


--
-- Name: sso_domains_domain_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX sso_domains_domain_idx ON auth.sso_domains USING btree (lower(domain));


--
-- Name: sso_domains_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sso_domains_sso_provider_id_idx ON auth.sso_domains USING btree (sso_provider_id);


--
-- Name: sso_providers_resource_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX sso_providers_resource_id_idx ON auth.sso_providers USING btree (lower(resource_id));


--
-- Name: sso_providers_resource_id_pattern_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sso_providers_resource_id_pattern_idx ON auth.sso_providers USING btree (resource_id text_pattern_ops);


--
-- Name: unique_phone_factor_per_user; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX unique_phone_factor_per_user ON auth.mfa_factors USING btree (user_id, phone);


--
-- Name: user_id_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX user_id_created_at_idx ON auth.sessions USING btree (user_id, created_at);


--
-- Name: users_email_partial_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX users_email_partial_key ON auth.users USING btree (email) WHERE (is_sso_user = false);


--
-- Name: INDEX users_email_partial_key; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON INDEX auth.users_email_partial_key IS 'Auth: A partial unique index that applies only when is_sso_user is false';


--
-- Name: users_instance_id_email_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX users_instance_id_email_idx ON auth.users USING btree (instance_id, lower((email)::text));


--
-- Name: users_instance_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX users_instance_id_idx ON auth.users USING btree (instance_id);


--
-- Name: users_is_anonymous_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX users_is_anonymous_idx ON auth.users USING btree (is_anonymous);


--
-- Name: webauthn_challenges_expires_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX webauthn_challenges_expires_at_idx ON auth.webauthn_challenges USING btree (expires_at);


--
-- Name: webauthn_challenges_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX webauthn_challenges_user_id_idx ON auth.webauthn_challenges USING btree (user_id);


--
-- Name: webauthn_credentials_credential_id_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON auth.webauthn_credentials USING btree (credential_id);


--
-- Name: webauthn_credentials_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX webauthn_credentials_user_id_idx ON auth.webauthn_credentials USING btree (user_id);


--
-- Name: fx_rates_org_currency_date_unique; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE UNIQUE INDEX fx_rates_org_currency_date_unique ON public.fx_rates USING btree (organization_id, currency, rate_date) WHERE (organization_id IS NOT NULL);


--
-- Name: fx_rates_shared_currency_date_unique; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE UNIQUE INDEX fx_rates_shared_currency_date_unique ON public.fx_rates USING btree (currency, rate_date) WHERE (organization_id IS NULL);


--
-- Name: idx_audit_logs_created_at; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_audit_logs_created_at ON public.audit_logs USING btree (created_at);


--
-- Name: idx_audit_logs_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_audit_logs_organization_id ON public.audit_logs USING btree (organization_id);


--
-- Name: idx_evidence_items_indicator_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_evidence_items_indicator_id ON public.evidence_items USING btree (indicator_id);


--
-- Name: idx_evidence_items_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_evidence_items_organization_id ON public.evidence_items USING btree (organization_id);


--
-- Name: idx_evidence_items_outcome_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_evidence_items_outcome_id ON public.evidence_items USING btree (outcome_id);


--
-- Name: idx_evidence_items_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_evidence_items_project_id ON public.evidence_items USING btree (project_id);


--
-- Name: idx_financial_proxies_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_financial_proxies_organization_id ON public.financial_proxies USING btree (organization_id);


--
-- Name: idx_financial_proxies_source_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_financial_proxies_source_id ON public.financial_proxies USING btree (source_id);


--
-- Name: idx_funders_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_funders_organization_id ON public.funders USING btree (organization_id);


--
-- Name: idx_fx_rates_currency_date; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_fx_rates_currency_date ON public.fx_rates USING btree (currency, rate_date);


--
-- Name: idx_impact_narratives_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_impact_narratives_project_id ON public.impact_narratives USING btree (project_id);


--
-- Name: idx_indicators_outcome_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_indicators_outcome_id ON public.indicators USING btree (outcome_id);


--
-- Name: idx_indicators_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_indicators_project_id ON public.indicators USING btree (project_id);


--
-- Name: idx_invitations_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_invitations_organization_id ON public.invitations USING btree (organization_id);


--
-- Name: idx_invitations_token_hash; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_invitations_token_hash ON public.invitations USING btree (token_hash);


--
-- Name: idx_methodology_review_matrix_items_matrix_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_methodology_review_matrix_items_matrix_id ON public.methodology_review_matrix_items USING btree (matrix_id);


--
-- Name: idx_methodology_review_matrix_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_methodology_review_matrix_project_id ON public.methodology_review_matrix USING btree (project_id);


--
-- Name: idx_ofa_funder_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_ofa_funder_id ON public.outcome_funder_allocations USING btree (funder_id);


--
-- Name: idx_ofa_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_ofa_organization_id ON public.outcome_funder_allocations USING btree (organization_id);


--
-- Name: idx_ofa_outcome_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_ofa_outcome_id ON public.outcome_funder_allocations USING btree (outcome_id);


--
-- Name: idx_opa_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_opa_organization_id ON public.outcome_proxy_assignments USING btree (organization_id);


--
-- Name: idx_opa_outcome_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_opa_outcome_id ON public.outcome_proxy_assignments USING btree (outcome_id);


--
-- Name: idx_opa_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_opa_project_id ON public.outcome_proxy_assignments USING btree (project_id);


--
-- Name: idx_opa_proxy_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_opa_proxy_id ON public.outcome_proxy_assignments USING btree (proxy_id);


--
-- Name: idx_outcome_taxonomy_mappings_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_outcome_taxonomy_mappings_organization_id ON public.outcome_taxonomy_mappings USING btree (organization_id);


--
-- Name: idx_outcome_taxonomy_mappings_outcome_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_outcome_taxonomy_mappings_outcome_id ON public.outcome_taxonomy_mappings USING btree (outcome_id);


--
-- Name: idx_outcomes_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_outcomes_project_id ON public.outcomes USING btree (project_id);


--
-- Name: idx_outcomes_stakeholder_group_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_outcomes_stakeholder_group_id ON public.outcomes USING btree (stakeholder_group_id);


--
-- Name: idx_portfolios_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_portfolios_organization_id ON public.portfolios USING btree (organization_id);


--
-- Name: idx_project_investments_funder_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_project_investments_funder_id ON public.project_investments USING btree (funder_id);


--
-- Name: idx_project_investments_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_project_investments_project_id ON public.project_investments USING btree (project_id);


--
-- Name: idx_projects_deleted_at; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_projects_deleted_at ON public.projects USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_projects_deletion_requested_at; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_projects_deletion_requested_at ON public.projects USING btree (deletion_requested_at) WHERE (deletion_requested_at IS NOT NULL);


--
-- Name: idx_projects_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_projects_organization_id ON public.projects USING btree (organization_id);


--
-- Name: idx_projects_portfolio_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_projects_portfolio_id ON public.projects USING btree (portfolio_id);


--
-- Name: idx_proxy_sources_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_proxy_sources_organization_id ON public.proxy_sources USING btree (organization_id);


--
-- Name: idx_sroi_assignment_inputs_assignment_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_assignment_inputs_assignment_id ON public.sroi_assignment_inputs USING btree (assignment_id);


--
-- Name: idx_sroi_calculation_runs_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_calculation_runs_project_id ON public.sroi_calculation_runs USING btree (project_id);


--
-- Name: idx_sroi_filter_sets_assignment_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_filter_sets_assignment_id ON public.sroi_filter_sets USING btree (assignment_id);


--
-- Name: idx_sroi_line_items_assignment_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_line_items_assignment_id ON public.sroi_calculation_line_items USING btree (assignment_id);


--
-- Name: idx_sroi_line_items_run_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_line_items_run_id ON public.sroi_calculation_line_items USING btree (run_id);


--
-- Name: idx_sroi_report_sections_report_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_report_sections_report_id ON public.sroi_report_sections USING btree (report_id);


--
-- Name: idx_sroi_reports_calculation_run_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_reports_calculation_run_id ON public.sroi_reports USING btree (calculation_run_id);


--
-- Name: idx_sroi_reports_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_reports_project_id ON public.sroi_reports USING btree (project_id);


--
-- Name: idx_sroi_run_review_items_review_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_run_review_items_review_id ON public.sroi_run_review_items USING btree (review_id);


--
-- Name: idx_sroi_run_reviews_calculation_run_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_run_reviews_calculation_run_id ON public.sroi_run_reviews USING btree (calculation_run_id);


--
-- Name: idx_sroi_run_reviews_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_sroi_run_reviews_project_id ON public.sroi_run_reviews USING btree (project_id);


--
-- Name: idx_stakeholder_groups_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_stakeholder_groups_project_id ON public.stakeholder_groups USING btree (project_id);


--
-- Name: idx_stella_suggestion_decisions_interaction_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_stella_suggestion_decisions_interaction_id ON public.stella_suggestion_decisions USING btree (interaction_id);


--
-- Name: idx_stella_suggestion_decisions_org_decided_at; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_stella_suggestion_decisions_org_decided_at ON public.stella_suggestion_decisions USING btree (organization_id, decided_at);


--
-- Name: idx_taxonomy_codes_catalog_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_taxonomy_codes_catalog_id ON public.taxonomy_codes USING btree (catalog_id);


--
-- Name: idx_toc_links_from_node_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_toc_links_from_node_id ON public.theory_of_change_links USING btree (from_node_id);


--
-- Name: idx_toc_links_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_toc_links_organization_id ON public.theory_of_change_links USING btree (organization_id);


--
-- Name: idx_toc_links_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_toc_links_project_id ON public.theory_of_change_links USING btree (project_id);


--
-- Name: idx_toc_links_to_node_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_toc_links_to_node_id ON public.theory_of_change_links USING btree (to_node_id);


--
-- Name: idx_toc_nodes_organization_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_toc_nodes_organization_id ON public.theory_of_change_nodes USING btree (organization_id);


--
-- Name: idx_toc_nodes_outcome_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_toc_nodes_outcome_id ON public.theory_of_change_nodes USING btree (outcome_id);


--
-- Name: idx_toc_nodes_project_id; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX idx_toc_nodes_project_id ON public.theory_of_change_nodes USING btree (project_id);


--
-- Name: stella_interactions_context_hash_idx; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX stella_interactions_context_hash_idx ON public.stella_interactions USING btree (context_hash);


--
-- Name: stella_interactions_created_by_created_idx; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX stella_interactions_created_by_created_idx ON public.stella_interactions USING btree (created_by, created_at);


--
-- Name: stella_interactions_org_created_idx; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX stella_interactions_org_created_idx ON public.stella_interactions USING btree (organization_id, created_at);


--
-- Name: stella_interactions_project_role_idx; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX stella_interactions_project_role_idx ON public.stella_interactions USING btree (project_id, stella_role);


--
-- Name: stella_interactions_risk_level_idx; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE INDEX stella_interactions_risk_level_idx ON public.stella_interactions USING btree (risk_level) WHERE (risk_level IS NOT NULL);


--
-- Name: theory_of_change_nodes_outcome_unique; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE UNIQUE INDEX theory_of_change_nodes_outcome_unique ON public.theory_of_change_nodes USING btree (project_id, outcome_id) WHERE ((outcome_id IS NOT NULL) AND ((status)::text = 'active'::text));


--
-- Name: uq_active_outcome_proxy_assignment; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE UNIQUE INDEX uq_active_outcome_proxy_assignment ON public.outcome_proxy_assignments USING btree (project_id, outcome_id, proxy_id) WHERE ((assignment_status)::text = 'active'::text);


--
-- Name: uq_sroi_run_project_version; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE UNIQUE INDEX uq_sroi_run_project_version ON public.sroi_calculation_runs USING btree (project_id, version);


--
-- Name: user_single_active_membership; Type: INDEX; Schema: public; Owner: uellix_owner
--

CREATE UNIQUE INDEX user_single_active_membership ON public.organization_members USING btree (user_id) WHERE ((status)::text = 'active'::text);


--
-- Name: ix_realtime_subscription_entity; Type: INDEX; Schema: realtime; Owner: supabase_admin
--

CREATE INDEX ix_realtime_subscription_entity ON realtime.subscription USING btree (entity);


--
-- Name: messages_inserted_at_topic_index; Type: INDEX; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE INDEX messages_inserted_at_topic_index ON ONLY realtime.messages USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE));


--
-- Name: messages_2026_08_01_inserted_at_topic_idx; Type: INDEX; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE INDEX messages_2026_08_01_inserted_at_topic_idx ON realtime.messages_2026_08_01 USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE));


--
-- Name: messages_2026_08_02_inserted_at_topic_idx; Type: INDEX; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE INDEX messages_2026_08_02_inserted_at_topic_idx ON realtime.messages_2026_08_02 USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE));


--
-- Name: messages_2026_08_03_inserted_at_topic_idx; Type: INDEX; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE INDEX messages_2026_08_03_inserted_at_topic_idx ON realtime.messages_2026_08_03 USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE));


--
-- Name: messages_2026_08_04_inserted_at_topic_idx; Type: INDEX; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE INDEX messages_2026_08_04_inserted_at_topic_idx ON realtime.messages_2026_08_04 USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE));


--
-- Name: messages_2026_08_05_inserted_at_topic_idx; Type: INDEX; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE INDEX messages_2026_08_05_inserted_at_topic_idx ON realtime.messages_2026_08_05 USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE));


--
-- Name: messages_2026_08_06_inserted_at_topic_idx; Type: INDEX; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE INDEX messages_2026_08_06_inserted_at_topic_idx ON realtime.messages_2026_08_06 USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE));


--
-- Name: messages_2026_08_07_inserted_at_topic_idx; Type: INDEX; Schema: realtime; Owner: supabase_realtime_admin
--

CREATE INDEX messages_2026_08_07_inserted_at_topic_idx ON realtime.messages_2026_08_07 USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE));


--
-- Name: subscription_subscription_id_entity_filters_action_filter_selec; Type: INDEX; Schema: realtime; Owner: supabase_admin
--

CREATE UNIQUE INDEX subscription_subscription_id_entity_filters_action_filter_selec ON realtime.subscription USING btree (subscription_id, entity, filters, action_filter, COALESCE(selected_columns, '{}'::text[]));


--
-- Name: bname; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE UNIQUE INDEX bname ON storage.buckets USING btree (name);


--
-- Name: bucketid_objname; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE UNIQUE INDEX bucketid_objname ON storage.objects USING btree (bucket_id, name);


--
-- Name: buckets_analytics_unique_name_idx; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE UNIQUE INDEX buckets_analytics_unique_name_idx ON storage.buckets_analytics USING btree (name) WHERE (deleted_at IS NULL);


--
-- Name: idx_iceberg_namespaces_bucket_id; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE UNIQUE INDEX idx_iceberg_namespaces_bucket_id ON storage.iceberg_namespaces USING btree (catalog_id, name);


--
-- Name: idx_iceberg_tables_location; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE UNIQUE INDEX idx_iceberg_tables_location ON storage.iceberg_tables USING btree (location);


--
-- Name: idx_iceberg_tables_namespace_id; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE UNIQUE INDEX idx_iceberg_tables_namespace_id ON storage.iceberg_tables USING btree (catalog_id, namespace_id, name);


--
-- Name: idx_multipart_uploads_list; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE INDEX idx_multipart_uploads_list ON storage.s3_multipart_uploads USING btree (bucket_id, key, created_at);


--
-- Name: idx_objects_bucket_id_name; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE INDEX idx_objects_bucket_id_name ON storage.objects USING btree (bucket_id, name COLLATE "C");


--
-- Name: idx_objects_bucket_id_name_lower; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE INDEX idx_objects_bucket_id_name_lower ON storage.objects USING btree (bucket_id, lower(name) COLLATE "C");


--
-- Name: name_prefix_search; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE INDEX name_prefix_search ON storage.objects USING btree (name text_pattern_ops);


--
-- Name: vector_indexes_name_bucket_id_idx; Type: INDEX; Schema: storage; Owner: supabase_storage_admin
--

CREATE UNIQUE INDEX vector_indexes_name_bucket_id_idx ON storage.vector_indexes USING btree (name, bucket_id);


--
-- Name: supabase_functions_hooks_h_table_id_h_name_idx; Type: INDEX; Schema: supabase_functions; Owner: supabase_functions_admin
--

CREATE INDEX supabase_functions_hooks_h_table_id_h_name_idx ON supabase_functions.hooks USING btree (hook_table_id, hook_name);


--
-- Name: supabase_functions_hooks_request_id_idx; Type: INDEX; Schema: supabase_functions; Owner: supabase_functions_admin
--

CREATE INDEX supabase_functions_hooks_request_id_idx ON supabase_functions.hooks USING btree (request_id);


--
-- Name: messages_2026_08_01_inserted_at_topic_idx; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_inserted_at_topic_index ATTACH PARTITION realtime.messages_2026_08_01_inserted_at_topic_idx;


--
-- Name: messages_2026_08_01_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_01_pkey;


--
-- Name: messages_2026_08_02_inserted_at_topic_idx; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_inserted_at_topic_index ATTACH PARTITION realtime.messages_2026_08_02_inserted_at_topic_idx;


--
-- Name: messages_2026_08_02_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_02_pkey;


--
-- Name: messages_2026_08_03_inserted_at_topic_idx; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_inserted_at_topic_index ATTACH PARTITION realtime.messages_2026_08_03_inserted_at_topic_idx;


--
-- Name: messages_2026_08_03_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_03_pkey;


--
-- Name: messages_2026_08_04_inserted_at_topic_idx; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_inserted_at_topic_index ATTACH PARTITION realtime.messages_2026_08_04_inserted_at_topic_idx;


--
-- Name: messages_2026_08_04_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_04_pkey;


--
-- Name: messages_2026_08_05_inserted_at_topic_idx; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_inserted_at_topic_index ATTACH PARTITION realtime.messages_2026_08_05_inserted_at_topic_idx;


--
-- Name: messages_2026_08_05_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_05_pkey;


--
-- Name: messages_2026_08_06_inserted_at_topic_idx; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_inserted_at_topic_index ATTACH PARTITION realtime.messages_2026_08_06_inserted_at_topic_idx;


--
-- Name: messages_2026_08_06_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_06_pkey;


--
-- Name: messages_2026_08_07_inserted_at_topic_idx; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_inserted_at_topic_index ATTACH PARTITION realtime.messages_2026_08_07_inserted_at_topic_idx;


--
-- Name: messages_2026_08_07_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_07_pkey;


--
-- Name: users on_auth_user_created; Type: TRIGGER; Schema: auth; Owner: supabase_auth_admin
--

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


--
-- Name: users on_auth_user_updated; Type: TRIGGER; Schema: auth; Owner: supabase_auth_admin
--

CREATE TRIGGER on_auth_user_updated AFTER UPDATE OF email, raw_user_meta_data ON auth.users FOR EACH ROW WHEN ((((old.email)::text IS DISTINCT FROM (new.email)::text) OR (old.raw_user_meta_data IS DISTINCT FROM new.raw_user_meta_data))) EXECUTE FUNCTION public.handle_update_user();


--
-- Name: audit_logs trg_audit_logs_append_only; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_audit_logs_append_only BEFORE DELETE OR UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: audit_logs trg_audit_logs_no_truncate; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON public.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: TRIGGER trg_audit_logs_no_truncate ON audit_logs; Type: COMMENT; Schema: public; Owner: uellix_owner
--

COMMENT ON TRIGGER trg_audit_logs_no_truncate ON public.audit_logs IS 'WS3b hardening (prepared stella_0002b, gate G2): TRUNCATE is forbidden on this append-only audit log, including for the table owner.';


--
-- Name: sroi_calculation_line_items trg_sroi_calculation_line_items_no_truncate; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_sroi_calculation_line_items_no_truncate BEFORE TRUNCATE ON public.sroi_calculation_line_items FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: TRIGGER trg_sroi_calculation_line_items_no_truncate ON sroi_calculation_line_items; Type: COMMENT; Schema: public; Owner: uellix_owner
--

COMMENT ON TRIGGER trg_sroi_calculation_line_items_no_truncate ON public.sroi_calculation_line_items IS 'WS3b hardening (prepared stella_0002b, gate G2): TRUNCATE is forbidden on these immutable calculation line items, including for the table owner.';


--
-- Name: sroi_calculation_runs trg_sroi_calculation_runs_no_truncate; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_sroi_calculation_runs_no_truncate BEFORE TRUNCATE ON public.sroi_calculation_runs FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: TRIGGER trg_sroi_calculation_runs_no_truncate ON sroi_calculation_runs; Type: COMMENT; Schema: public; Owner: uellix_owner
--

COMMENT ON TRIGGER trg_sroi_calculation_runs_no_truncate ON public.sroi_calculation_runs IS 'WS3b hardening (prepared stella_0002b, gate G2): TRUNCATE is forbidden on these immutable calculation runs, including for the table owner.';


--
-- Name: sroi_calculation_line_items trg_sroi_line_items_append_only; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_sroi_line_items_append_only BEFORE DELETE OR UPDATE ON public.sroi_calculation_line_items FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: sroi_calculation_runs trg_sroi_runs_append_only; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_sroi_runs_append_only BEFORE DELETE OR UPDATE ON public.sroi_calculation_runs FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: stella_interactions trg_stella_interactions_append_only; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_stella_interactions_append_only BEFORE DELETE OR UPDATE ON public.stella_interactions FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: TRIGGER trg_stella_interactions_append_only ON stella_interactions; Type: COMMENT; Schema: public; Owner: uellix_owner
--

COMMENT ON TRIGGER trg_stella_interactions_append_only ON public.stella_interactions IS 'WS3b hardening (prepared stella_0002, gate G2): stella_interactions is an append-only AI audit trail; UPDATE/DELETE are forbidden even for the service role.';


--
-- Name: stella_interactions trg_stella_interactions_no_truncate; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_stella_interactions_no_truncate BEFORE TRUNCATE ON public.stella_interactions FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: TRIGGER trg_stella_interactions_no_truncate ON stella_interactions; Type: COMMENT; Schema: public; Owner: uellix_owner
--

COMMENT ON TRIGGER trg_stella_interactions_no_truncate ON public.stella_interactions IS 'WS3b hardening (prepared stella_0002b, gate G2): TRUNCATE is forbidden on this append-only AI audit trail, including for the table owner.';


--
-- Name: stella_suggestion_decisions trg_stella_suggestion_decisions_append_only; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_stella_suggestion_decisions_append_only BEFORE DELETE OR UPDATE ON public.stella_suggestion_decisions FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: TRIGGER trg_stella_suggestion_decisions_append_only ON stella_suggestion_decisions; Type: COMMENT; Schema: public; Owner: uellix_owner
--

COMMENT ON TRIGGER trg_stella_suggestion_decisions_append_only ON public.stella_suggestion_decisions IS 'WS3b (prepared stella_0003, gate G2): human-decision audit trail is append-only; UPDATE/DELETE are forbidden even for the table owner.';


--
-- Name: stella_suggestion_decisions trg_stella_suggestion_decisions_no_truncate; Type: TRIGGER; Schema: public; Owner: uellix_owner
--

CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate BEFORE TRUNCATE ON public.stella_suggestion_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();


--
-- Name: TRIGGER trg_stella_suggestion_decisions_no_truncate ON stella_suggestion_decisions; Type: COMMENT; Schema: public; Owner: uellix_owner
--

COMMENT ON TRIGGER trg_stella_suggestion_decisions_no_truncate ON public.stella_suggestion_decisions IS 'WS3b (prepared stella_0003, gate G2): TRUNCATE is forbidden on this append-only table, including for the table owner.';


--
-- Name: subscription tr_check_filters; Type: TRIGGER; Schema: realtime; Owner: supabase_admin
--

CREATE TRIGGER tr_check_filters BEFORE INSERT OR UPDATE ON realtime.subscription FOR EACH ROW EXECUTE FUNCTION realtime.subscription_check_filters();


--
-- Name: buckets enforce_bucket_name_length_trigger; Type: TRIGGER; Schema: storage; Owner: supabase_storage_admin
--

CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();


--
-- Name: buckets protect_buckets_delete; Type: TRIGGER; Schema: storage; Owner: supabase_storage_admin
--

CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();


--
-- Name: objects protect_objects_delete; Type: TRIGGER; Schema: storage; Owner: supabase_storage_admin
--

CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();


--
-- Name: objects update_objects_updated_at; Type: TRIGGER; Schema: storage; Owner: supabase_storage_admin
--

CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: extensions extensions_tenant_external_id_fkey; Type: FK CONSTRAINT; Schema: _realtime; Owner: supabase_admin
--

ALTER TABLE ONLY _realtime.extensions
    ADD CONSTRAINT extensions_tenant_external_id_fkey FOREIGN KEY (tenant_external_id) REFERENCES _realtime.tenants(external_id) ON DELETE CASCADE;


--
-- Name: identities identities_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: mfa_challenges mfa_challenges_auth_factor_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_auth_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE;


--
-- Name: mfa_factors mfa_factors_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_authorizations oauth_authorizations_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_authorizations oauth_authorizations_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_consents oauth_consents_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_consents oauth_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: one_time_tokens one_time_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: saml_providers saml_providers_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_flow_state_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_flow_state_id_fkey FOREIGN KEY (flow_state_id) REFERENCES auth.flow_state(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_oauth_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_oauth_client_id_fkey FOREIGN KEY (oauth_client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sso_domains sso_domains_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: webauthn_challenges webauthn_challenges_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: webauthn_credentials webauthn_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_actor_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_user_id_users_id_fk FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: audit_logs audit_logs_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: evidence_items evidence_items_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.evidence_items
    ADD CONSTRAINT evidence_items_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: evidence_items evidence_items_indicator_id_indicators_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.evidence_items
    ADD CONSTRAINT evidence_items_indicator_id_indicators_id_fk FOREIGN KEY (indicator_id) REFERENCES public.indicators(id);


--
-- Name: evidence_items evidence_items_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.evidence_items
    ADD CONSTRAINT evidence_items_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: evidence_items evidence_items_outcome_id_outcomes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.evidence_items
    ADD CONSTRAINT evidence_items_outcome_id_outcomes_id_fk FOREIGN KEY (outcome_id) REFERENCES public.outcomes(id);


--
-- Name: evidence_items evidence_items_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.evidence_items
    ADD CONSTRAINT evidence_items_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: evidence_items evidence_items_reviewer_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.evidence_items
    ADD CONSTRAINT evidence_items_reviewer_id_users_id_fk FOREIGN KEY (reviewer_id) REFERENCES public.users(id);


--
-- Name: financial_proxies financial_proxies_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.financial_proxies
    ADD CONSTRAINT financial_proxies_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: financial_proxies financial_proxies_fx_rate_id_fx_rates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.financial_proxies
    ADD CONSTRAINT financial_proxies_fx_rate_id_fx_rates_id_fk FOREIGN KEY (fx_rate_id) REFERENCES public.fx_rates(id);


--
-- Name: financial_proxies financial_proxies_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.financial_proxies
    ADD CONSTRAINT financial_proxies_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: financial_proxies financial_proxies_reviewer_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.financial_proxies
    ADD CONSTRAINT financial_proxies_reviewer_id_users_id_fk FOREIGN KEY (reviewer_id) REFERENCES public.users(id);


--
-- Name: financial_proxies financial_proxies_source_id_proxy_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.financial_proxies
    ADD CONSTRAINT financial_proxies_source_id_proxy_sources_id_fk FOREIGN KEY (source_id) REFERENCES public.proxy_sources(id);


--
-- Name: funders funders_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.funders
    ADD CONSTRAINT funders_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: funders funders_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.funders
    ADD CONSTRAINT funders_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: fx_rates fx_rates_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: fx_rates fx_rates_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: impact_narratives impact_narratives_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.impact_narratives
    ADD CONSTRAINT impact_narratives_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: impact_narratives impact_narratives_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.impact_narratives
    ADD CONSTRAINT impact_narratives_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: indicators indicators_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.indicators
    ADD CONSTRAINT indicators_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: indicators indicators_outcome_id_outcomes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.indicators
    ADD CONSTRAINT indicators_outcome_id_outcomes_id_fk FOREIGN KEY (outcome_id) REFERENCES public.outcomes(id);


--
-- Name: indicators indicators_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.indicators
    ADD CONSTRAINT indicators_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: invitations invitations_invited_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invited_by_users_id_fk FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: invitations invitations_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: methodology_review_matrix methodology_review_matrix_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix
    ADD CONSTRAINT methodology_review_matrix_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix_items
    ADD CONSTRAINT methodology_review_matrix_items_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_matrix_id_methodology_review_ma; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix_items
    ADD CONSTRAINT methodology_review_matrix_items_matrix_id_methodology_review_ma FOREIGN KEY (matrix_id) REFERENCES public.methodology_review_matrix(id);


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_organization_id_organizations_i; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix_items
    ADD CONSTRAINT methodology_review_matrix_items_organization_id_organizations_i FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix_items
    ADD CONSTRAINT methodology_review_matrix_items_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_updated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix_items
    ADD CONSTRAINT methodology_review_matrix_items_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: methodology_review_matrix methodology_review_matrix_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix
    ADD CONSTRAINT methodology_review_matrix_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: methodology_review_matrix methodology_review_matrix_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix
    ADD CONSTRAINT methodology_review_matrix_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: methodology_review_matrix methodology_review_matrix_reviewer_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix
    ADD CONSTRAINT methodology_review_matrix_reviewer_id_users_id_fk FOREIGN KEY (reviewer_id) REFERENCES public.users(id);


--
-- Name: methodology_review_matrix methodology_review_matrix_updated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.methodology_review_matrix
    ADD CONSTRAINT methodology_review_matrix_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: organization_members organization_members_invited_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_invited_by_users_id_fk FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: organization_members organization_members_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: organization_members organization_members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: outcome_funder_allocations outcome_funder_allocations_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_funder_allocations
    ADD CONSTRAINT outcome_funder_allocations_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: outcome_funder_allocations outcome_funder_allocations_funder_id_funders_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_funder_allocations
    ADD CONSTRAINT outcome_funder_allocations_funder_id_funders_id_fk FOREIGN KEY (funder_id) REFERENCES public.funders(id);


--
-- Name: outcome_funder_allocations outcome_funder_allocations_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_funder_allocations
    ADD CONSTRAINT outcome_funder_allocations_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: outcome_funder_allocations outcome_funder_allocations_outcome_id_outcomes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_funder_allocations
    ADD CONSTRAINT outcome_funder_allocations_outcome_id_outcomes_id_fk FOREIGN KEY (outcome_id) REFERENCES public.outcomes(id);


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_archived_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_proxy_assignments
    ADD CONSTRAINT outcome_proxy_assignments_archived_by_users_id_fk FOREIGN KEY (archived_by) REFERENCES public.users(id);


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_assigned_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_proxy_assignments
    ADD CONSTRAINT outcome_proxy_assignments_assigned_by_users_id_fk FOREIGN KEY (assigned_by) REFERENCES public.users(id);


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_proxy_assignments
    ADD CONSTRAINT outcome_proxy_assignments_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_outcome_id_outcomes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_proxy_assignments
    ADD CONSTRAINT outcome_proxy_assignments_outcome_id_outcomes_id_fk FOREIGN KEY (outcome_id) REFERENCES public.outcomes(id);


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_proxy_assignments
    ADD CONSTRAINT outcome_proxy_assignments_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_proxy_id_financial_proxies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_proxy_assignments
    ADD CONSTRAINT outcome_proxy_assignments_proxy_id_financial_proxies_id_fk FOREIGN KEY (proxy_id) REFERENCES public.financial_proxies(id);


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_taxonomy_mappings
    ADD CONSTRAINT outcome_taxonomy_mappings_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_taxonomy_mappings
    ADD CONSTRAINT outcome_taxonomy_mappings_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_outcome_id_outcomes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_taxonomy_mappings
    ADD CONSTRAINT outcome_taxonomy_mappings_outcome_id_outcomes_id_fk FOREIGN KEY (outcome_id) REFERENCES public.outcomes(id);


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_taxonomy_mappings
    ADD CONSTRAINT outcome_taxonomy_mappings_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_taxonomy_code_id_taxonomy_codes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcome_taxonomy_mappings
    ADD CONSTRAINT outcome_taxonomy_mappings_taxonomy_code_id_taxonomy_codes_id_fk FOREIGN KEY (taxonomy_code_id) REFERENCES public.taxonomy_codes(id);


--
-- Name: outcomes outcomes_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcomes
    ADD CONSTRAINT outcomes_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: outcomes outcomes_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcomes
    ADD CONSTRAINT outcomes_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: outcomes outcomes_stakeholder_group_id_stakeholder_groups_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.outcomes
    ADD CONSTRAINT outcomes_stakeholder_group_id_stakeholder_groups_id_fk FOREIGN KEY (stakeholder_group_id) REFERENCES public.stakeholder_groups(id);


--
-- Name: portfolios portfolios_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.portfolios
    ADD CONSTRAINT portfolios_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: portfolios portfolios_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.portfolios
    ADD CONSTRAINT portfolios_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: project_investments project_investments_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.project_investments
    ADD CONSTRAINT project_investments_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: project_investments project_investments_funder_id_funders_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.project_investments
    ADD CONSTRAINT project_investments_funder_id_funders_id_fk FOREIGN KEY (funder_id) REFERENCES public.funders(id);


--
-- Name: project_investments project_investments_fx_rate_id_fx_rates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.project_investments
    ADD CONSTRAINT project_investments_fx_rate_id_fx_rates_id_fk FOREIGN KEY (fx_rate_id) REFERENCES public.fx_rates(id);


--
-- Name: project_investments project_investments_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.project_investments
    ADD CONSTRAINT project_investments_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: project_investments project_investments_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.project_investments
    ADD CONSTRAINT project_investments_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: projects projects_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: projects projects_deleted_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_deleted_by_users_id_fk FOREIGN KEY (deleted_by) REFERENCES public.users(id);


--
-- Name: projects projects_deletion_requested_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_deletion_requested_by_users_id_fk FOREIGN KEY (deletion_requested_by) REFERENCES public.users(id);


--
-- Name: projects projects_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: projects projects_portfolio_id_portfolios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_portfolio_id_portfolios_id_fk FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(id);


--
-- Name: proxy_sources proxy_sources_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.proxy_sources
    ADD CONSTRAINT proxy_sources_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: proxy_sources proxy_sources_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.proxy_sources
    ADD CONSTRAINT proxy_sources_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: signup_allowlist signup_allowlist_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.signup_allowlist
    ADD CONSTRAINT signup_allowlist_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sroi_assignment_inputs sroi_assignment_inputs_assignment_id_outcome_proxy_assignments_; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_assignment_inputs
    ADD CONSTRAINT sroi_assignment_inputs_assignment_id_outcome_proxy_assignments_ FOREIGN KEY (assignment_id) REFERENCES public.outcome_proxy_assignments(id);


--
-- Name: sroi_assignment_inputs sroi_assignment_inputs_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_assignment_inputs
    ADD CONSTRAINT sroi_assignment_inputs_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sroi_assignment_inputs sroi_assignment_inputs_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_assignment_inputs
    ADD CONSTRAINT sroi_assignment_inputs_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: sroi_calculation_line_items sroi_calculation_line_items_assignment_id_outcome_proxy_assignm; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_line_items
    ADD CONSTRAINT sroi_calculation_line_items_assignment_id_outcome_proxy_assignm FOREIGN KEY (assignment_id) REFERENCES public.outcome_proxy_assignments(id);


--
-- Name: sroi_calculation_line_items sroi_calculation_line_items_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_line_items
    ADD CONSTRAINT sroi_calculation_line_items_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: sroi_calculation_line_items sroi_calculation_line_items_outcome_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_line_items
    ADD CONSTRAINT sroi_calculation_line_items_outcome_id_fkey FOREIGN KEY (outcome_id) REFERENCES public.outcomes(id);


--
-- Name: sroi_calculation_line_items sroi_calculation_line_items_proxy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_line_items
    ADD CONSTRAINT sroi_calculation_line_items_proxy_id_fkey FOREIGN KEY (proxy_id) REFERENCES public.financial_proxies(id);


--
-- Name: sroi_calculation_line_items sroi_calculation_line_items_run_id_sroi_calculation_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_line_items
    ADD CONSTRAINT sroi_calculation_line_items_run_id_sroi_calculation_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.sroi_calculation_runs(id);


--
-- Name: sroi_calculation_runs sroi_calculation_runs_calculated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_runs
    ADD CONSTRAINT sroi_calculation_runs_calculated_by_fkey FOREIGN KEY (calculated_by) REFERENCES public.users(id);


--
-- Name: sroi_calculation_runs sroi_calculation_runs_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_runs
    ADD CONSTRAINT sroi_calculation_runs_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: sroi_calculation_runs sroi_calculation_runs_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_calculation_runs
    ADD CONSTRAINT sroi_calculation_runs_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: sroi_filter_sets sroi_filter_sets_assignment_id_outcome_proxy_assignments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_filter_sets
    ADD CONSTRAINT sroi_filter_sets_assignment_id_outcome_proxy_assignments_id_fk FOREIGN KEY (assignment_id) REFERENCES public.outcome_proxy_assignments(id);


--
-- Name: sroi_filter_sets sroi_filter_sets_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_filter_sets
    ADD CONSTRAINT sroi_filter_sets_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sroi_filter_sets sroi_filter_sets_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_filter_sets
    ADD CONSTRAINT sroi_filter_sets_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: sroi_report_sections sroi_report_sections_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_report_sections
    ADD CONSTRAINT sroi_report_sections_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sroi_report_sections sroi_report_sections_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_report_sections
    ADD CONSTRAINT sroi_report_sections_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: sroi_report_sections sroi_report_sections_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_report_sections
    ADD CONSTRAINT sroi_report_sections_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: sroi_report_sections sroi_report_sections_report_id_sroi_reports_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_report_sections
    ADD CONSTRAINT sroi_report_sections_report_id_sroi_reports_id_fk FOREIGN KEY (report_id) REFERENCES public.sroi_reports(id);


--
-- Name: sroi_report_sections sroi_report_sections_updated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_report_sections
    ADD CONSTRAINT sroi_report_sections_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: sroi_reports sroi_reports_calculation_run_id_sroi_calculation_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_reports
    ADD CONSTRAINT sroi_reports_calculation_run_id_sroi_calculation_runs_id_fk FOREIGN KEY (calculation_run_id) REFERENCES public.sroi_calculation_runs(id);


--
-- Name: sroi_reports sroi_reports_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_reports
    ADD CONSTRAINT sroi_reports_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sroi_reports sroi_reports_locked_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_reports
    ADD CONSTRAINT sroi_reports_locked_by_users_id_fk FOREIGN KEY (locked_by) REFERENCES public.users(id);


--
-- Name: sroi_reports sroi_reports_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_reports
    ADD CONSTRAINT sroi_reports_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: sroi_reports sroi_reports_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_reports
    ADD CONSTRAINT sroi_reports_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: sroi_reports sroi_reports_updated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_reports
    ADD CONSTRAINT sroi_reports_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: sroi_run_review_items sroi_run_review_items_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_review_items
    ADD CONSTRAINT sroi_run_review_items_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sroi_run_review_items sroi_run_review_items_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_review_items
    ADD CONSTRAINT sroi_run_review_items_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: sroi_run_review_items sroi_run_review_items_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_review_items
    ADD CONSTRAINT sroi_run_review_items_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: sroi_run_review_items sroi_run_review_items_review_id_sroi_run_reviews_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_review_items
    ADD CONSTRAINT sroi_run_review_items_review_id_sroi_run_reviews_id_fk FOREIGN KEY (review_id) REFERENCES public.sroi_run_reviews(id);


--
-- Name: sroi_run_review_items sroi_run_review_items_updated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_review_items
    ADD CONSTRAINT sroi_run_review_items_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: sroi_run_reviews sroi_run_reviews_calculation_run_id_sroi_calculation_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_reviews
    ADD CONSTRAINT sroi_run_reviews_calculation_run_id_sroi_calculation_runs_id_fk FOREIGN KEY (calculation_run_id) REFERENCES public.sroi_calculation_runs(id);


--
-- Name: sroi_run_reviews sroi_run_reviews_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_reviews
    ADD CONSTRAINT sroi_run_reviews_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sroi_run_reviews sroi_run_reviews_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_reviews
    ADD CONSTRAINT sroi_run_reviews_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: sroi_run_reviews sroi_run_reviews_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_reviews
    ADD CONSTRAINT sroi_run_reviews_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: sroi_run_reviews sroi_run_reviews_reviewer_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_reviews
    ADD CONSTRAINT sroi_run_reviews_reviewer_id_users_id_fk FOREIGN KEY (reviewer_id) REFERENCES public.users(id);


--
-- Name: sroi_run_reviews sroi_run_reviews_updated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.sroi_run_reviews
    ADD CONSTRAINT sroi_run_reviews_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: stakeholder_groups stakeholder_groups_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stakeholder_groups
    ADD CONSTRAINT stakeholder_groups_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: stella_interactions stella_interactions_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_interactions
    ADD CONSTRAINT stella_interactions_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: stella_interactions stella_interactions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_interactions
    ADD CONSTRAINT stella_interactions_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: stella_interactions stella_interactions_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_interactions
    ADD CONSTRAINT stella_interactions_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: stella_suggestion_decisions stella_suggestion_decisions_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_suggestion_decisions
    ADD CONSTRAINT stella_suggestion_decisions_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id);


--
-- Name: stella_suggestion_decisions stella_suggestion_decisions_interaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_suggestion_decisions
    ADD CONSTRAINT stella_suggestion_decisions_interaction_id_fkey FOREIGN KEY (interaction_id) REFERENCES public.stella_interactions(id);


--
-- Name: stella_suggestion_decisions stella_suggestion_decisions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_suggestion_decisions
    ADD CONSTRAINT stella_suggestion_decisions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: stella_suggestion_decisions stella_suggestion_decisions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.stella_suggestion_decisions
    ADD CONSTRAINT stella_suggestion_decisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: taxonomy_codes taxonomy_codes_catalog_id_taxonomy_catalogs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.taxonomy_codes
    ADD CONSTRAINT taxonomy_codes_catalog_id_taxonomy_catalogs_id_fk FOREIGN KEY (catalog_id) REFERENCES public.taxonomy_catalogs(id);


--
-- Name: theory_of_change_links theory_of_change_links_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_links
    ADD CONSTRAINT theory_of_change_links_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: theory_of_change_links theory_of_change_links_from_node_id_theory_of_change_nodes_id_f; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_links
    ADD CONSTRAINT theory_of_change_links_from_node_id_theory_of_change_nodes_id_f FOREIGN KEY (from_node_id) REFERENCES public.theory_of_change_nodes(id);


--
-- Name: theory_of_change_links theory_of_change_links_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_links
    ADD CONSTRAINT theory_of_change_links_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: theory_of_change_links theory_of_change_links_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_links
    ADD CONSTRAINT theory_of_change_links_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: theory_of_change_links theory_of_change_links_to_node_id_theory_of_change_nodes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_links
    ADD CONSTRAINT theory_of_change_links_to_node_id_theory_of_change_nodes_id_fk FOREIGN KEY (to_node_id) REFERENCES public.theory_of_change_nodes(id);


--
-- Name: theory_of_change_nodes theory_of_change_nodes_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_nodes
    ADD CONSTRAINT theory_of_change_nodes_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: theory_of_change_nodes theory_of_change_nodes_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_nodes
    ADD CONSTRAINT theory_of_change_nodes_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: theory_of_change_nodes theory_of_change_nodes_outcome_id_outcomes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_nodes
    ADD CONSTRAINT theory_of_change_nodes_outcome_id_outcomes_id_fk FOREIGN KEY (outcome_id) REFERENCES public.outcomes(id);


--
-- Name: theory_of_change_nodes theory_of_change_nodes_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: uellix_owner
--

ALTER TABLE ONLY public.theory_of_change_nodes
    ADD CONSTRAINT theory_of_change_nodes_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: iceberg_namespaces iceberg_namespaces_catalog_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.iceberg_namespaces
    ADD CONSTRAINT iceberg_namespaces_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES storage.buckets_analytics(id) ON DELETE CASCADE;


--
-- Name: iceberg_tables iceberg_tables_catalog_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.iceberg_tables
    ADD CONSTRAINT iceberg_tables_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES storage.buckets_analytics(id) ON DELETE CASCADE;


--
-- Name: iceberg_tables iceberg_tables_namespace_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.iceberg_tables
    ADD CONSTRAINT iceberg_tables_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES storage.iceberg_namespaces(id) ON DELETE CASCADE;


--
-- Name: objects objects_bucketId_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT "objects_bucketId_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads s3_multipart_uploads_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.s3_multipart_uploads
    ADD CONSTRAINT s3_multipart_uploads_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_upload_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES storage.s3_multipart_uploads(id) ON DELETE CASCADE;


--
-- Name: vector_indexes vector_indexes_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE ONLY storage.vector_indexes
    ADD CONSTRAINT vector_indexes_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets_vectors(id);


--
-- Name: audit_log_entries; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.audit_log_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_state; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.flow_state ENABLE ROW LEVEL SECURITY;

--
-- Name: identities; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;

--
-- Name: instances; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.instances ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_amr_claims; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.mfa_amr_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_challenges; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.mfa_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_factors; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;

--
-- Name: one_time_tokens; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.one_time_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: refresh_tokens; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_providers; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.saml_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_relay_states; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.saml_relay_states ENABLE ROW LEVEL SECURITY;

--
-- Name: schema_migrations; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.schema_migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_domains; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.sso_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_providers; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.sso_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_leads anon_insert_marketing_leads; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY anon_insert_marketing_leads ON public.marketing_leads FOR INSERT TO anon WITH CHECK (true);


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs audit_logs_insert_member_or_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY audit_logs_insert_member_or_admin ON public.audit_logs FOR INSERT TO uellix_app WITH CHECK (((actor_user_id = auth.uid()) AND (((organization_id IS NOT NULL) AND (organization_id = ANY (public.current_user_org_ids()))) OR public.current_user_is_super_admin())));


--
-- Name: audit_logs audit_logs_select_member_or_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY audit_logs_select_member_or_admin ON public.audit_logs FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: marketing_leads authenticated_insert_marketing_leads; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY authenticated_insert_marketing_leads ON public.marketing_leads FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: evidence_items; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.evidence_items ENABLE ROW LEVEL SECURITY;

--
-- Name: evidence_items evidence_items_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY evidence_items_insert ON public.evidence_items FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: evidence_items evidence_items_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY evidence_items_select ON public.evidence_items FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: evidence_items evidence_items_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY evidence_items_update ON public.evidence_items FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: financial_proxies; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.financial_proxies ENABLE ROW LEVEL SECURITY;

--
-- Name: financial_proxies financial_proxies_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY financial_proxies_insert ON public.financial_proxies FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: financial_proxies financial_proxies_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY financial_proxies_select ON public.financial_proxies FOR SELECT USING ((((auth.uid() IS NOT NULL) AND (organization_id IS NULL) AND ((review_status)::text = 'approved'::text)) OR (organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: financial_proxies financial_proxies_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY financial_proxies_update ON public.financial_proxies FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: funders; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.funders ENABLE ROW LEVEL SECURITY;

--
-- Name: funders funders_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY funders_insert ON public.funders FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: funders funders_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY funders_select ON public.funders FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: funders funders_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY funders_update ON public.funders FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: fx_rates; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_rates fx_rates_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY fx_rates_insert ON public.fx_rates FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: fx_rates fx_rates_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY fx_rates_select ON public.fx_rates FOR SELECT USING ((((auth.uid() IS NOT NULL) AND (organization_id IS NULL)) OR (organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: fx_rates fx_rates_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY fx_rates_update ON public.fx_rates FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: impact_narratives; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.impact_narratives ENABLE ROW LEVEL SECURITY;

--
-- Name: impact_narratives impact_narratives_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY impact_narratives_insert ON public.impact_narratives FOR INSERT WITH CHECK (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin()));


--
-- Name: impact_narratives impact_narratives_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY impact_narratives_select ON public.impact_narratives FOR SELECT USING (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (projects.organization_id = ANY (public.current_user_org_ids())))) OR public.current_user_is_super_admin()));


--
-- Name: impact_narratives impact_narratives_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY impact_narratives_update ON public.impact_narratives FOR UPDATE USING (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin())) WITH CHECK (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin()));


--
-- Name: indicators; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.indicators ENABLE ROW LEVEL SECURITY;

--
-- Name: indicators indicators_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY indicators_insert ON public.indicators FOR INSERT WITH CHECK (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin()));


--
-- Name: indicators indicators_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY indicators_select ON public.indicators FOR SELECT USING (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (projects.organization_id = ANY (public.current_user_org_ids())))) OR public.current_user_is_super_admin()));


--
-- Name: indicators indicators_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY indicators_update ON public.indicators FOR UPDATE USING (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin())) WITH CHECK (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin()));


--
-- Name: invitations; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: invitations invitations_insert_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY invitations_insert_admin ON public.invitations FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin()));


--
-- Name: invitations invitations_select_member; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY invitations_select_member ON public.invitations FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: invitations invitations_update_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY invitations_update_admin ON public.invitations FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin()));


--
-- Name: marketing_leads; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.marketing_leads ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_members members_delete_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY members_delete_admin ON public.organization_members FOR DELETE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin()));


--
-- Name: organization_members members_insert_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY members_insert_admin ON public.organization_members FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin()));


--
-- Name: organization_members members_select_own_org; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY members_select_own_org ON public.organization_members FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: organization_members members_update_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY members_update_admin ON public.organization_members FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin()));


--
-- Name: methodology_review_matrix; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.methodology_review_matrix ENABLE ROW LEVEL SECURITY;

--
-- Name: methodology_review_matrix methodology_review_matrix_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY methodology_review_matrix_insert ON public.methodology_review_matrix FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin()));


--
-- Name: methodology_review_matrix_items; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.methodology_review_matrix_items ENABLE ROW LEVEL SECURITY;

--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY methodology_review_matrix_items_insert ON public.methodology_review_matrix_items FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin()));


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY methodology_review_matrix_items_select ON public.methodology_review_matrix_items FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: methodology_review_matrix_items methodology_review_matrix_items_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY methodology_review_matrix_items_update ON public.methodology_review_matrix_items FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin()));


--
-- Name: methodology_review_matrix methodology_review_matrix_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY methodology_review_matrix_select ON public.methodology_review_matrix FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: methodology_review_matrix methodology_review_matrix_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY methodology_review_matrix_update ON public.methodology_review_matrix FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin()));


--
-- Name: organization_members; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations orgs_insert_super_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY orgs_insert_super_admin ON public.organizations FOR INSERT WITH CHECK (public.current_user_is_super_admin());


--
-- Name: organizations orgs_select_member_or_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY orgs_select_member_or_admin ON public.organizations FOR SELECT USING (((id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: organizations orgs_update_admin_or_super; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY orgs_update_admin_or_super ON public.organizations FOR UPDATE USING (((public.current_user_role_in_org(id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text])) OR public.current_user_is_super_admin()));


--
-- Name: outcome_funder_allocations; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.outcome_funder_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: outcome_funder_allocations outcome_funder_allocations_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_funder_allocations_insert ON public.outcome_funder_allocations FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: outcome_funder_allocations outcome_funder_allocations_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_funder_allocations_select ON public.outcome_funder_allocations FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: outcome_funder_allocations outcome_funder_allocations_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_funder_allocations_update ON public.outcome_funder_allocations FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: outcome_proxy_assignments; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.outcome_proxy_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_proxy_assignments_insert ON public.outcome_proxy_assignments FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_proxy_assignments_select ON public.outcome_proxy_assignments FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: outcome_proxy_assignments outcome_proxy_assignments_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_proxy_assignments_update ON public.outcome_proxy_assignments FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: outcome_taxonomy_mappings; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.outcome_taxonomy_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_delete; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_taxonomy_mappings_delete ON public.outcome_taxonomy_mappings FOR DELETE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_taxonomy_mappings_insert ON public.outcome_taxonomy_mappings FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_taxonomy_mappings_select ON public.outcome_taxonomy_mappings FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: outcome_taxonomy_mappings outcome_taxonomy_mappings_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcome_taxonomy_mappings_update ON public.outcome_taxonomy_mappings FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: outcomes; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.outcomes ENABLE ROW LEVEL SECURITY;

--
-- Name: outcomes outcomes_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcomes_insert ON public.outcomes FOR INSERT WITH CHECK (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin()));


--
-- Name: outcomes outcomes_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcomes_select ON public.outcomes FOR SELECT USING (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (projects.organization_id = ANY (public.current_user_org_ids())))) OR public.current_user_is_super_admin()));


--
-- Name: outcomes outcomes_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY outcomes_update ON public.outcomes FOR UPDATE USING (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin())) WITH CHECK (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin()));


--
-- Name: portfolios; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.portfolios ENABLE ROW LEVEL SECURITY;

--
-- Name: portfolios portfolios_insert_allowed_roles; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY portfolios_insert_allowed_roles ON public.portfolios FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: portfolios portfolios_select_member_or_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY portfolios_select_member_or_admin ON public.portfolios FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: portfolios portfolios_update_allowed_roles; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY portfolios_update_allowed_roles ON public.portfolios FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: project_investments; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.project_investments ENABLE ROW LEVEL SECURITY;

--
-- Name: project_investments project_investments_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY project_investments_insert ON public.project_investments FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: project_investments project_investments_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY project_investments_select ON public.project_investments FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: project_investments project_investments_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY project_investments_update ON public.project_investments FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: projects projects_insert_allowed_roles; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY projects_insert_allowed_roles ON public.projects FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: projects projects_select_member_or_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY projects_select_member_or_admin ON public.projects FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: projects projects_update_allowed_roles; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY projects_update_allowed_roles ON public.projects FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: proxy_sources; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.proxy_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: proxy_sources proxy_sources_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY proxy_sources_insert ON public.proxy_sources FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: proxy_sources proxy_sources_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY proxy_sources_select ON public.proxy_sources FOR SELECT USING ((((auth.uid() IS NOT NULL) AND (organization_id IS NULL) AND ((status)::text = 'active'::text)) OR (organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: proxy_sources proxy_sources_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY proxy_sources_update ON public.proxy_sources FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: signup_allowlist; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.signup_allowlist ENABLE ROW LEVEL SECURITY;

--
-- Name: signup_allowlist signup_allowlist_delete_super_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY signup_allowlist_delete_super_admin ON public.signup_allowlist FOR DELETE USING (public.current_user_is_super_admin());


--
-- Name: signup_allowlist signup_allowlist_insert_super_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY signup_allowlist_insert_super_admin ON public.signup_allowlist FOR INSERT WITH CHECK (public.current_user_is_super_admin());


--
-- Name: signup_allowlist signup_allowlist_select_super_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY signup_allowlist_select_super_admin ON public.signup_allowlist FOR SELECT USING (public.current_user_is_super_admin());


--
-- Name: sroi_assignment_inputs; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.sroi_assignment_inputs ENABLE ROW LEVEL SECURITY;

--
-- Name: sroi_assignment_inputs sroi_assignment_inputs_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_assignment_inputs_insert ON public.sroi_assignment_inputs FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_assignment_inputs sroi_assignment_inputs_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_assignment_inputs_select ON public.sroi_assignment_inputs FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: sroi_assignment_inputs sroi_assignment_inputs_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_assignment_inputs_update ON public.sroi_assignment_inputs FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_calculation_line_items; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.sroi_calculation_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: sroi_calculation_line_items sroi_calculation_line_items_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_calculation_line_items_insert ON public.sroi_calculation_line_items FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_calculation_line_items sroi_calculation_line_items_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_calculation_line_items_select ON public.sroi_calculation_line_items FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: sroi_calculation_runs; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.sroi_calculation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: sroi_calculation_runs sroi_calculation_runs_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_calculation_runs_insert ON public.sroi_calculation_runs FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_calculation_runs sroi_calculation_runs_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_calculation_runs_select ON public.sroi_calculation_runs FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: sroi_filter_sets; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.sroi_filter_sets ENABLE ROW LEVEL SECURITY;

--
-- Name: sroi_filter_sets sroi_filter_sets_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_filter_sets_insert ON public.sroi_filter_sets FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_filter_sets sroi_filter_sets_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_filter_sets_select ON public.sroi_filter_sets FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: sroi_filter_sets sroi_filter_sets_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_filter_sets_update ON public.sroi_filter_sets FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_report_sections; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.sroi_report_sections ENABLE ROW LEVEL SECURITY;

--
-- Name: sroi_report_sections sroi_report_sections_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_report_sections_insert ON public.sroi_report_sections FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_report_sections sroi_report_sections_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_report_sections_select ON public.sroi_report_sections FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: sroi_report_sections sroi_report_sections_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_report_sections_update ON public.sroi_report_sections FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_reports; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.sroi_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: sroi_reports sroi_reports_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_reports_insert ON public.sroi_reports FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_reports sroi_reports_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_reports_select ON public.sroi_reports FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: sroi_reports sroi_reports_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_reports_update ON public.sroi_reports FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_run_review_items; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.sroi_run_review_items ENABLE ROW LEVEL SECURITY;

--
-- Name: sroi_run_review_items sroi_run_review_items_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_run_review_items_insert ON public.sroi_run_review_items FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_run_review_items sroi_run_review_items_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_run_review_items_select ON public.sroi_run_review_items FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: sroi_run_review_items sroi_run_review_items_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_run_review_items_update ON public.sroi_run_review_items FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_run_reviews; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.sroi_run_reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: sroi_run_reviews sroi_run_reviews_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_run_reviews_insert ON public.sroi_run_reviews FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin()));


--
-- Name: sroi_run_reviews sroi_run_reviews_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_run_reviews_select ON public.sroi_run_reviews FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: sroi_run_reviews sroi_run_reviews_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY sroi_run_reviews_update ON public.sroi_run_reviews FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'reviewer'::text])) OR public.current_user_is_super_admin()));


--
-- Name: stakeholder_groups; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.stakeholder_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: stakeholder_groups stakeholder_groups_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY stakeholder_groups_insert ON public.stakeholder_groups FOR INSERT WITH CHECK (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin()));


--
-- Name: stakeholder_groups stakeholder_groups_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY stakeholder_groups_select ON public.stakeholder_groups FOR SELECT USING (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (projects.organization_id = ANY (public.current_user_org_ids())))) OR public.current_user_is_super_admin()));


--
-- Name: stakeholder_groups stakeholder_groups_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY stakeholder_groups_update ON public.stakeholder_groups FOR UPDATE USING (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin())) WITH CHECK (((project_id IN ( SELECT projects.id
   FROM public.projects
  WHERE (public.current_user_role_in_org(projects.organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])))) OR public.current_user_is_super_admin()));


--
-- Name: stella_interactions; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.stella_interactions ENABLE ROW LEVEL SECURITY;

--
-- Name: stella_interactions stella_interactions_insert_member_or_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY stella_interactions_insert_member_or_admin ON public.stella_interactions FOR INSERT TO uellix_app WITH CHECK (((created_by = auth.uid()) AND ((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin())));


--
-- Name: stella_interactions stella_interactions_select_member_or_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY stella_interactions_select_member_or_admin ON public.stella_interactions FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: stella_suggestion_decisions; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.stella_suggestion_decisions ENABLE ROW LEVEL SECURITY;

--
-- Name: stella_suggestion_decisions stella_suggestion_decisions_insert_member_or_admin; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY stella_suggestion_decisions_insert_member_or_admin ON public.stella_suggestion_decisions FOR INSERT TO uellix_app WITH CHECK (((decided_by = auth.uid()) AND ((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin())));


--
-- Name: stella_suggestion_decisions stella_suggestion_decisions_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY stella_suggestion_decisions_select ON public.stella_suggestion_decisions FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: marketing_leads super_admins_read_marketing_leads; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY super_admins_read_marketing_leads ON public.marketing_leads FOR SELECT TO authenticated USING (public.current_user_is_super_admin());


--
-- Name: taxonomy_catalogs; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.taxonomy_catalogs ENABLE ROW LEVEL SECURITY;

--
-- Name: taxonomy_catalogs taxonomy_catalogs_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY taxonomy_catalogs_select ON public.taxonomy_catalogs FOR SELECT USING (true);


--
-- Name: taxonomy_codes; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.taxonomy_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: taxonomy_codes taxonomy_codes_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY taxonomy_codes_select ON public.taxonomy_codes FOR SELECT USING (true);


--
-- Name: theory_of_change_links; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.theory_of_change_links ENABLE ROW LEVEL SECURITY;

--
-- Name: theory_of_change_links theory_of_change_links_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY theory_of_change_links_insert ON public.theory_of_change_links FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: theory_of_change_links theory_of_change_links_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY theory_of_change_links_select ON public.theory_of_change_links FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: theory_of_change_links theory_of_change_links_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY theory_of_change_links_update ON public.theory_of_change_links FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: theory_of_change_nodes; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.theory_of_change_nodes ENABLE ROW LEVEL SECURITY;

--
-- Name: theory_of_change_nodes theory_of_change_nodes_insert; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY theory_of_change_nodes_insert ON public.theory_of_change_nodes FOR INSERT WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: theory_of_change_nodes theory_of_change_nodes_select; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY theory_of_change_nodes_select ON public.theory_of_change_nodes FOR SELECT USING (((organization_id = ANY (public.current_user_org_ids())) OR public.current_user_is_super_admin()));


--
-- Name: theory_of_change_nodes theory_of_change_nodes_update; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY theory_of_change_nodes_update ON public.theory_of_change_nodes FOR UPDATE USING (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin())) WITH CHECK (((public.current_user_role_in_org(organization_id) = ANY (ARRAY['super_admin'::text, 'organization_admin'::text, 'impact_manager'::text, 'analyst'::text])) OR public.current_user_is_super_admin()));


--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: uellix_owner
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: users users_insert_own; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY users_insert_own ON public.users FOR INSERT WITH CHECK ((id = auth.uid()));


--
-- Name: users users_select_own; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY users_select_own ON public.users FOR SELECT USING (((id = auth.uid()) OR public.current_user_is_super_admin()));


--
-- Name: users users_update_own; Type: POLICY; Schema: public; Owner: uellix_owner
--

CREATE POLICY users_update_own ON public.users FOR UPDATE USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));


--
-- Name: messages; Type: ROW SECURITY; Schema: realtime; Owner: supabase_realtime_admin
--

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: buckets; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: buckets_analytics; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.buckets_analytics ENABLE ROW LEVEL SECURITY;

--
-- Name: buckets_vectors; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.buckets_vectors ENABLE ROW LEVEL SECURITY;

--
-- Name: objects delete_evidence; Type: POLICY; Schema: storage; Owner: supabase_storage_admin
--

CREATE POLICY delete_evidence ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid())));


--
-- Name: iceberg_namespaces; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.iceberg_namespaces ENABLE ROW LEVEL SECURITY;

--
-- Name: iceberg_tables; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.iceberg_tables ENABLE ROW LEVEL SECURITY;

--
-- Name: objects insert_evidence; Type: POLICY; Schema: storage; Owner: supabase_storage_admin
--

CREATE POLICY insert_evidence ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid())));


--
-- Name: migrations; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: objects; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

--
-- Name: s3_multipart_uploads; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.s3_multipart_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: s3_multipart_uploads_parts; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.s3_multipart_uploads_parts ENABLE ROW LEVEL SECURITY;

--
-- Name: objects select_evidence; Type: POLICY; Schema: storage; Owner: supabase_storage_admin
--

CREATE POLICY select_evidence ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid())));


--
-- Name: vector_indexes; Type: ROW SECURITY; Schema: storage; Owner: supabase_storage_admin
--

ALTER TABLE storage.vector_indexes ENABLE ROW LEVEL SECURITY;

--
-- Name: supabase_realtime; Type: PUBLICATION; Schema: -; Owner: postgres
--

CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete, truncate');


ALTER PUBLICATION supabase_realtime OWNER TO postgres;

--
-- Name: SCHEMA auth; Type: ACL; Schema: -; Owner: supabase_admin
--

GRANT USAGE ON SCHEMA auth TO anon;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO dashboard_user;
GRANT USAGE ON SCHEMA auth TO postgres;
GRANT USAGE ON SCHEMA auth TO uellix_owner;


--
-- Name: SCHEMA drizzle; Type: ACL; Schema: -; Owner: uellix_owner
--

GRANT USAGE ON SCHEMA drizzle TO uellix_migrator;


--
-- Name: SCHEMA extensions; Type: ACL; Schema: -; Owner: postgres
--

GRANT USAGE ON SCHEMA extensions TO anon;
GRANT USAGE ON SCHEMA extensions TO authenticated;
GRANT USAGE ON SCHEMA extensions TO service_role;
GRANT ALL ON SCHEMA extensions TO dashboard_user;


--
-- Name: SCHEMA net; Type: ACL; Schema: -; Owner: supabase_admin
--

GRANT USAGE ON SCHEMA net TO supabase_functions_admin;
GRANT USAGE ON SCHEMA net TO postgres;
GRANT USAGE ON SCHEMA net TO anon;
GRANT USAGE ON SCHEMA net TO authenticated;
GRANT USAGE ON SCHEMA net TO service_role;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON SCHEMA public TO uellix_owner;
GRANT USAGE ON SCHEMA public TO uellix_migrator;
GRANT USAGE ON SCHEMA public TO uellix_app;
GRANT USAGE ON SCHEMA public TO uellix_writer;
GRANT USAGE ON SCHEMA public TO uellix_auditor;


--
-- Name: SCHEMA realtime; Type: ACL; Schema: -; Owner: supabase_admin
--

GRANT USAGE ON SCHEMA realtime TO postgres;
GRANT USAGE ON SCHEMA realtime TO anon;
GRANT USAGE ON SCHEMA realtime TO authenticated;
GRANT USAGE ON SCHEMA realtime TO service_role;
GRANT ALL ON SCHEMA realtime TO supabase_realtime_admin;


--
-- Name: SCHEMA storage; Type: ACL; Schema: -; Owner: supabase_admin
--

GRANT USAGE ON SCHEMA storage TO postgres WITH GRANT OPTION;
GRANT USAGE ON SCHEMA storage TO anon;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT USAGE ON SCHEMA storage TO service_role;
GRANT ALL ON SCHEMA storage TO supabase_storage_admin WITH GRANT OPTION;
GRANT ALL ON SCHEMA storage TO dashboard_user;
GRANT USAGE ON SCHEMA storage TO uellix_owner;


--
-- Name: SCHEMA supabase_functions; Type: ACL; Schema: -; Owner: supabase_admin
--

GRANT USAGE ON SCHEMA supabase_functions TO postgres;
GRANT USAGE ON SCHEMA supabase_functions TO anon;
GRANT USAGE ON SCHEMA supabase_functions TO authenticated;
GRANT USAGE ON SCHEMA supabase_functions TO service_role;
GRANT ALL ON SCHEMA supabase_functions TO supabase_functions_admin;


--
-- Name: SCHEMA vault; Type: ACL; Schema: -; Owner: supabase_admin
--

GRANT USAGE ON SCHEMA vault TO postgres WITH GRANT OPTION;
GRANT USAGE ON SCHEMA vault TO service_role;


--
-- Name: FUNCTION email(); Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON FUNCTION auth.email() TO dashboard_user;


--
-- Name: FUNCTION jwt(); Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON FUNCTION auth.jwt() TO postgres;
GRANT ALL ON FUNCTION auth.jwt() TO dashboard_user;


--
-- Name: FUNCTION role(); Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON FUNCTION auth.role() TO dashboard_user;


--
-- Name: FUNCTION uid(); Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON FUNCTION auth.uid() TO dashboard_user;


--
-- Name: FUNCTION armor(bytea); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.armor(bytea) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.armor(bytea) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION armor(bytea, text[], text[]); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.armor(bytea, text[], text[]) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.armor(bytea, text[], text[]) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION crypt(text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.crypt(text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.crypt(text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION dearmor(text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.dearmor(text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.dearmor(text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION decrypt(bytea, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.decrypt(bytea, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.decrypt(bytea, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION decrypt_iv(bytea, bytea, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.decrypt_iv(bytea, bytea, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.decrypt_iv(bytea, bytea, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION digest(bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.digest(bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.digest(bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION digest(text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.digest(text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.digest(text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION encrypt(bytea, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.encrypt(bytea, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.encrypt(bytea, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION encrypt_iv(bytea, bytea, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.encrypt_iv(bytea, bytea, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.encrypt_iv(bytea, bytea, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION gen_random_bytes(integer); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.gen_random_bytes(integer) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.gen_random_bytes(integer) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION gen_random_uuid(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.gen_random_uuid() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.gen_random_uuid() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION gen_salt(text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.gen_salt(text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.gen_salt(text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION gen_salt(text, integer); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.gen_salt(text, integer) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.gen_salt(text, integer) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION grant_pg_cron_access(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION extensions.grant_pg_cron_access() FROM supabase_admin;
GRANT ALL ON FUNCTION extensions.grant_pg_cron_access() TO supabase_admin WITH GRANT OPTION;
GRANT ALL ON FUNCTION extensions.grant_pg_cron_access() TO dashboard_user;


--
-- Name: FUNCTION grant_pg_graphql_access(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.grant_pg_graphql_access() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION grant_pg_net_access(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION extensions.grant_pg_net_access() FROM supabase_admin;
GRANT ALL ON FUNCTION extensions.grant_pg_net_access() TO supabase_admin WITH GRANT OPTION;
GRANT ALL ON FUNCTION extensions.grant_pg_net_access() TO dashboard_user;


--
-- Name: FUNCTION hmac(bytea, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.hmac(bytea, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.hmac(bytea, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION hmac(text, text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.hmac(text, text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.hmac(text, text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pg_stat_statements(showtext boolean, OUT userid oid, OUT dbid oid, OUT toplevel boolean, OUT queryid bigint, OUT query text, OUT plans bigint, OUT total_plan_time double precision, OUT min_plan_time double precision, OUT max_plan_time double precision, OUT mean_plan_time double precision, OUT stddev_plan_time double precision, OUT calls bigint, OUT total_exec_time double precision, OUT min_exec_time double precision, OUT max_exec_time double precision, OUT mean_exec_time double precision, OUT stddev_exec_time double precision, OUT rows bigint, OUT shared_blks_hit bigint, OUT shared_blks_read bigint, OUT shared_blks_dirtied bigint, OUT shared_blks_written bigint, OUT local_blks_hit bigint, OUT local_blks_read bigint, OUT local_blks_dirtied bigint, OUT local_blks_written bigint, OUT temp_blks_read bigint, OUT temp_blks_written bigint, OUT shared_blk_read_time double precision, OUT shared_blk_write_time double precision, OUT local_blk_read_time double precision, OUT local_blk_write_time double precision, OUT temp_blk_read_time double precision, OUT temp_blk_write_time double precision, OUT wal_records bigint, OUT wal_fpi bigint, OUT wal_bytes numeric, OUT jit_functions bigint, OUT jit_generation_time double precision, OUT jit_inlining_count bigint, OUT jit_inlining_time double precision, OUT jit_optimization_count bigint, OUT jit_optimization_time double precision, OUT jit_emission_count bigint, OUT jit_emission_time double precision, OUT jit_deform_count bigint, OUT jit_deform_time double precision, OUT stats_since timestamp with time zone, OUT minmax_stats_since timestamp with time zone); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pg_stat_statements(showtext boolean, OUT userid oid, OUT dbid oid, OUT toplevel boolean, OUT queryid bigint, OUT query text, OUT plans bigint, OUT total_plan_time double precision, OUT min_plan_time double precision, OUT max_plan_time double precision, OUT mean_plan_time double precision, OUT stddev_plan_time double precision, OUT calls bigint, OUT total_exec_time double precision, OUT min_exec_time double precision, OUT max_exec_time double precision, OUT mean_exec_time double precision, OUT stddev_exec_time double precision, OUT rows bigint, OUT shared_blks_hit bigint, OUT shared_blks_read bigint, OUT shared_blks_dirtied bigint, OUT shared_blks_written bigint, OUT local_blks_hit bigint, OUT local_blks_read bigint, OUT local_blks_dirtied bigint, OUT local_blks_written bigint, OUT temp_blks_read bigint, OUT temp_blks_written bigint, OUT shared_blk_read_time double precision, OUT shared_blk_write_time double precision, OUT local_blk_read_time double precision, OUT local_blk_write_time double precision, OUT temp_blk_read_time double precision, OUT temp_blk_write_time double precision, OUT wal_records bigint, OUT wal_fpi bigint, OUT wal_bytes numeric, OUT jit_functions bigint, OUT jit_generation_time double precision, OUT jit_inlining_count bigint, OUT jit_inlining_time double precision, OUT jit_optimization_count bigint, OUT jit_optimization_time double precision, OUT jit_emission_count bigint, OUT jit_emission_time double precision, OUT jit_deform_count bigint, OUT jit_deform_time double precision, OUT stats_since timestamp with time zone, OUT minmax_stats_since timestamp with time zone) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pg_stat_statements_info(OUT dealloc bigint, OUT stats_reset timestamp with time zone); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pg_stat_statements_info(OUT dealloc bigint, OUT stats_reset timestamp with time zone) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pg_stat_statements_reset(userid oid, dbid oid, queryid bigint, minmax_only boolean); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pg_stat_statements_reset(userid oid, dbid oid, queryid bigint, minmax_only boolean) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_armor_headers(text, OUT key text, OUT value text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_armor_headers(text, OUT key text, OUT value text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_armor_headers(text, OUT key text, OUT value text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_key_id(bytea); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_key_id(bytea) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_key_id(bytea) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_decrypt(bytea, bytea); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt(bytea, bytea) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt(bytea, bytea) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_decrypt(bytea, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt(bytea, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt(bytea, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_decrypt(bytea, bytea, text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt(bytea, bytea, text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt(bytea, bytea, text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_decrypt_bytea(bytea, bytea); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt_bytea(bytea, bytea) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt_bytea(bytea, bytea) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_decrypt_bytea(bytea, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt_bytea(bytea, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt_bytea(bytea, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_decrypt_bytea(bytea, bytea, text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt_bytea(bytea, bytea, text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_decrypt_bytea(bytea, bytea, text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_encrypt(text, bytea); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_encrypt(text, bytea) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_encrypt(text, bytea) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_encrypt(text, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_encrypt(text, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_encrypt(text, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_encrypt_bytea(bytea, bytea); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_encrypt_bytea(bytea, bytea) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_encrypt_bytea(bytea, bytea) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_pub_encrypt_bytea(bytea, bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_pub_encrypt_bytea(bytea, bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_pub_encrypt_bytea(bytea, bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_sym_decrypt(bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_sym_decrypt(bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_sym_decrypt(bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_sym_decrypt(bytea, text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_sym_decrypt(bytea, text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_sym_decrypt(bytea, text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_sym_decrypt_bytea(bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_sym_decrypt_bytea(bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_sym_decrypt_bytea(bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_sym_decrypt_bytea(bytea, text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_sym_decrypt_bytea(bytea, text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_sym_decrypt_bytea(bytea, text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_sym_encrypt(text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_sym_encrypt(text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_sym_encrypt(text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_sym_encrypt(text, text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_sym_encrypt(text, text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_sym_encrypt(text, text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_sym_encrypt_bytea(bytea, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_sym_encrypt_bytea(bytea, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_sym_encrypt_bytea(bytea, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgp_sym_encrypt_bytea(bytea, text, text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgp_sym_encrypt_bytea(bytea, text, text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.pgp_sym_encrypt_bytea(bytea, text, text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgrst_ddl_watch(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgrst_ddl_watch() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION pgrst_drop_watch(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.pgrst_drop_watch() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION set_graphql_placeholder(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.set_graphql_placeholder() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_generate_v1(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_generate_v1() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_generate_v1() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_generate_v1mc(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_generate_v1mc() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_generate_v1mc() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_generate_v3(namespace uuid, name text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_generate_v3(namespace uuid, name text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_generate_v3(namespace uuid, name text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_generate_v4(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_generate_v4() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_generate_v4() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_generate_v5(namespace uuid, name text); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_generate_v5(namespace uuid, name text) TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_generate_v5(namespace uuid, name text) TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_nil(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_nil() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_nil() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_ns_dns(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_ns_dns() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_ns_dns() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_ns_oid(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_ns_oid() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_ns_oid() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_ns_url(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_ns_url() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_ns_url() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION uuid_ns_x500(); Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON FUNCTION extensions.uuid_ns_x500() TO dashboard_user;
GRANT ALL ON FUNCTION extensions.uuid_ns_x500() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION graphql("operationName" text, query text, variables jsonb, extensions jsonb); Type: ACL; Schema: graphql_public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb) TO postgres;
GRANT ALL ON FUNCTION graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb) TO anon;
GRANT ALL ON FUNCTION graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb) TO authenticated;
GRANT ALL ON FUNCTION graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb) TO service_role;


--
-- Name: FUNCTION http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer); Type: ACL; Schema: net; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin;
GRANT ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO postgres;
GRANT ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO anon;
GRANT ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO authenticated;
GRANT ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO service_role;


--
-- Name: FUNCTION http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer); Type: ACL; Schema: net; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin;
GRANT ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO postgres;
GRANT ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO anon;
GRANT ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO authenticated;
GRANT ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO service_role;


--
-- Name: FUNCTION pg_reload_conf(); Type: ACL; Schema: pg_catalog; Owner: supabase_admin
--

GRANT ALL ON FUNCTION pg_catalog.pg_reload_conf() TO postgres WITH GRANT OPTION;


--
-- Name: FUNCTION get_auth(p_usename text); Type: ACL; Schema: pgbouncer; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION pgbouncer.get_auth(p_usename text) FROM PUBLIC;
GRANT ALL ON FUNCTION pgbouncer.get_auth(p_usename text) TO pgbouncer;


--
-- Name: FUNCTION can_read_evidence_object(object_name text, user_id uuid); Type: ACL; Schema: public; Owner: uellix_owner
--

REVOKE ALL ON FUNCTION public.can_read_evidence_object(object_name text, user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.can_read_evidence_object(object_name text, user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.can_read_evidence_object(object_name text, user_id uuid) TO postgres;


--
-- Name: FUNCTION can_write_evidence_object(object_name text, user_id uuid); Type: ACL; Schema: public; Owner: uellix_owner
--

REVOKE ALL ON FUNCTION public.can_write_evidence_object(object_name text, user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.can_write_evidence_object(object_name text, user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.can_write_evidence_object(object_name text, user_id uuid) TO postgres;


--
-- Name: FUNCTION current_user_is_super_admin(); Type: ACL; Schema: public; Owner: uellix_owner
--

REVOKE ALL ON FUNCTION public.current_user_is_super_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_user_is_super_admin() TO authenticated;
GRANT ALL ON FUNCTION public.current_user_is_super_admin() TO postgres;
GRANT ALL ON FUNCTION public.current_user_is_super_admin() TO uellix_writer;
GRANT ALL ON FUNCTION public.current_user_is_super_admin() TO uellix_auditor;


--
-- Name: FUNCTION current_user_org_ids(); Type: ACL; Schema: public; Owner: uellix_owner
--

REVOKE ALL ON FUNCTION public.current_user_org_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_user_org_ids() TO authenticated;
GRANT ALL ON FUNCTION public.current_user_org_ids() TO postgres;
GRANT ALL ON FUNCTION public.current_user_org_ids() TO uellix_writer;
GRANT ALL ON FUNCTION public.current_user_org_ids() TO uellix_auditor;


--
-- Name: FUNCTION current_user_role_in_org(org_id uuid); Type: ACL; Schema: public; Owner: uellix_owner
--

REVOKE ALL ON FUNCTION public.current_user_role_in_org(org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_user_role_in_org(org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.current_user_role_in_org(org_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.current_user_role_in_org(org_id uuid) TO uellix_writer;
GRANT ALL ON FUNCTION public.current_user_role_in_org(org_id uuid) TO uellix_auditor;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: uellix_owner
--

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO postgres;


--
-- Name: FUNCTION handle_update_user(); Type: ACL; Schema: public; Owner: uellix_owner
--

REVOKE ALL ON FUNCTION public.handle_update_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_update_user() TO postgres;


--
-- Name: FUNCTION uellix_forbid_mutation(); Type: ACL; Schema: public; Owner: uellix_owner
--

REVOKE ALL ON FUNCTION public.uellix_forbid_mutation() FROM PUBLIC;
GRANT ALL ON FUNCTION public.uellix_forbid_mutation() TO postgres;


--
-- Name: FUNCTION apply_rls(wal jsonb, max_record_bytes integer); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO postgres;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO anon;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO authenticated;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO service_role;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO supabase_realtime_admin;


--
-- Name: FUNCTION broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text) TO postgres;
GRANT ALL ON FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text) TO dashboard_user;


--
-- Name: FUNCTION build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO postgres;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO anon;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO authenticated;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO service_role;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO supabase_realtime_admin;


--
-- Name: FUNCTION "cast"(val text, type_ regtype); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO postgres;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO dashboard_user;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO anon;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO authenticated;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO service_role;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO supabase_realtime_admin;


--
-- Name: FUNCTION check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO postgres;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO anon;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO authenticated;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO service_role;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO supabase_realtime_admin;


--
-- Name: FUNCTION check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text, negate boolean); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text, negate boolean) TO postgres;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text, negate boolean) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text, negate boolean) TO anon;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text, negate boolean) TO authenticated;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text, negate boolean) TO service_role;


--
-- Name: FUNCTION is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO postgres;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO anon;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO authenticated;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO service_role;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO supabase_realtime_admin;


--
-- Name: FUNCTION list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) TO postgres;
GRANT ALL ON FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) TO dashboard_user;


--
-- Name: FUNCTION quote_wal2json(entity regclass); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO postgres;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO anon;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO authenticated;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO service_role;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO supabase_realtime_admin;


--
-- Name: FUNCTION send(payload jsonb, event text, topic text, private boolean); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) TO postgres;
GRANT ALL ON FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) TO dashboard_user;


--
-- Name: FUNCTION send_binary(payload bytea, event text, topic text, private boolean); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.send_binary(payload bytea, event text, topic text, private boolean) TO postgres;
GRANT ALL ON FUNCTION realtime.send_binary(payload bytea, event text, topic text, private boolean) TO dashboard_user;


--
-- Name: FUNCTION subscription_check_filters(); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO postgres;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO dashboard_user;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO anon;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO authenticated;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO service_role;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO supabase_realtime_admin;


--
-- Name: FUNCTION to_regrole(role_name text); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO postgres;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO anon;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO authenticated;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO service_role;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO supabase_realtime_admin;


--
-- Name: FUNCTION topic(); Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON FUNCTION realtime.topic() TO postgres;
GRANT ALL ON FUNCTION realtime.topic() TO dashboard_user;


--
-- Name: FUNCTION wal2json_escape_identifier(name text); Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON FUNCTION realtime.wal2json_escape_identifier(name text) TO postgres;
GRANT ALL ON FUNCTION realtime.wal2json_escape_identifier(name text) TO dashboard_user;


--
-- Name: FUNCTION http_request(); Type: ACL; Schema: supabase_functions; Owner: supabase_functions_admin
--

REVOKE ALL ON FUNCTION supabase_functions.http_request() FROM PUBLIC;
GRANT ALL ON FUNCTION supabase_functions.http_request() TO postgres;
GRANT ALL ON FUNCTION supabase_functions.http_request() TO anon;
GRANT ALL ON FUNCTION supabase_functions.http_request() TO authenticated;
GRANT ALL ON FUNCTION supabase_functions.http_request() TO service_role;


--
-- Name: FUNCTION _crypto_aead_det_decrypt(message bytea, additional bytea, key_id bigint, context bytea, nonce bytea); Type: ACL; Schema: vault; Owner: supabase_admin
--

GRANT ALL ON FUNCTION vault._crypto_aead_det_decrypt(message bytea, additional bytea, key_id bigint, context bytea, nonce bytea) TO postgres WITH GRANT OPTION;
GRANT ALL ON FUNCTION vault._crypto_aead_det_decrypt(message bytea, additional bytea, key_id bigint, context bytea, nonce bytea) TO service_role;


--
-- Name: FUNCTION create_secret(new_secret text, new_name text, new_description text, new_key_id uuid); Type: ACL; Schema: vault; Owner: supabase_admin
--

GRANT ALL ON FUNCTION vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid) TO postgres WITH GRANT OPTION;
GRANT ALL ON FUNCTION vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid) TO service_role;


--
-- Name: FUNCTION update_secret(secret_id uuid, new_secret text, new_name text, new_description text, new_key_id uuid); Type: ACL; Schema: vault; Owner: supabase_admin
--

GRANT ALL ON FUNCTION vault.update_secret(secret_id uuid, new_secret text, new_name text, new_description text, new_key_id uuid) TO postgres WITH GRANT OPTION;
GRANT ALL ON FUNCTION vault.update_secret(secret_id uuid, new_secret text, new_name text, new_description text, new_key_id uuid) TO service_role;


--
-- Name: TABLE audit_log_entries; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.audit_log_entries TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.audit_log_entries TO postgres;
GRANT SELECT ON TABLE auth.audit_log_entries TO postgres WITH GRANT OPTION;


--
-- Name: TABLE custom_oauth_providers; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.custom_oauth_providers TO postgres;
GRANT ALL ON TABLE auth.custom_oauth_providers TO dashboard_user;


--
-- Name: TABLE flow_state; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.flow_state TO postgres;
GRANT SELECT ON TABLE auth.flow_state TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.flow_state TO dashboard_user;


--
-- Name: TABLE identities; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.identities TO postgres;
GRANT SELECT ON TABLE auth.identities TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.identities TO dashboard_user;


--
-- Name: TABLE instances; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.instances TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.instances TO postgres;
GRANT SELECT ON TABLE auth.instances TO postgres WITH GRANT OPTION;


--
-- Name: TABLE mfa_amr_claims; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_amr_claims TO postgres;
GRANT SELECT ON TABLE auth.mfa_amr_claims TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_amr_claims TO dashboard_user;


--
-- Name: TABLE mfa_challenges; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_challenges TO postgres;
GRANT SELECT ON TABLE auth.mfa_challenges TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_challenges TO dashboard_user;


--
-- Name: TABLE mfa_factors; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_factors TO postgres;
GRANT SELECT ON TABLE auth.mfa_factors TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_factors TO dashboard_user;


--
-- Name: TABLE oauth_authorizations; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.oauth_authorizations TO postgres;
GRANT ALL ON TABLE auth.oauth_authorizations TO dashboard_user;


--
-- Name: TABLE oauth_client_states; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.oauth_client_states TO postgres;
GRANT ALL ON TABLE auth.oauth_client_states TO dashboard_user;


--
-- Name: TABLE oauth_clients; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.oauth_clients TO postgres;
GRANT ALL ON TABLE auth.oauth_clients TO dashboard_user;


--
-- Name: TABLE oauth_consents; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.oauth_consents TO postgres;
GRANT ALL ON TABLE auth.oauth_consents TO dashboard_user;


--
-- Name: TABLE one_time_tokens; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.one_time_tokens TO postgres;
GRANT SELECT ON TABLE auth.one_time_tokens TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.one_time_tokens TO dashboard_user;


--
-- Name: TABLE refresh_tokens; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.refresh_tokens TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.refresh_tokens TO postgres;
GRANT SELECT ON TABLE auth.refresh_tokens TO postgres WITH GRANT OPTION;


--
-- Name: SEQUENCE refresh_tokens_id_seq; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON SEQUENCE auth.refresh_tokens_id_seq TO dashboard_user;
GRANT ALL ON SEQUENCE auth.refresh_tokens_id_seq TO postgres;


--
-- Name: TABLE saml_providers; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.saml_providers TO postgres;
GRANT SELECT ON TABLE auth.saml_providers TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.saml_providers TO dashboard_user;


--
-- Name: TABLE saml_relay_states; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.saml_relay_states TO postgres;
GRANT SELECT ON TABLE auth.saml_relay_states TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.saml_relay_states TO dashboard_user;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT SELECT ON TABLE auth.schema_migrations TO postgres WITH GRANT OPTION;


--
-- Name: TABLE sessions; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sessions TO postgres;
GRANT SELECT ON TABLE auth.sessions TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sessions TO dashboard_user;


--
-- Name: TABLE sso_domains; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sso_domains TO postgres;
GRANT SELECT ON TABLE auth.sso_domains TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sso_domains TO dashboard_user;


--
-- Name: TABLE sso_providers; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sso_providers TO postgres;
GRANT SELECT ON TABLE auth.sso_providers TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sso_providers TO dashboard_user;


--
-- Name: TABLE users; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.users TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.users TO postgres;
GRANT SELECT ON TABLE auth.users TO postgres WITH GRANT OPTION;


--
-- Name: TABLE webauthn_challenges; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.webauthn_challenges TO postgres;
GRANT ALL ON TABLE auth.webauthn_challenges TO dashboard_user;


--
-- Name: TABLE webauthn_credentials; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.webauthn_credentials TO postgres;
GRANT ALL ON TABLE auth.webauthn_credentials TO dashboard_user;


--
-- Name: TABLE pg_stat_statements; Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON TABLE extensions.pg_stat_statements TO postgres WITH GRANT OPTION;


--
-- Name: TABLE pg_stat_statements_info; Type: ACL; Schema: extensions; Owner: supabase_admin
--

GRANT ALL ON TABLE extensions.pg_stat_statements_info TO postgres WITH GRANT OPTION;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT ON TABLE public.audit_logs TO authenticated;
GRANT SELECT ON TABLE public.audit_logs TO service_role;
GRANT SELECT,INSERT ON TABLE public.audit_logs TO uellix_writer;
GRANT SELECT ON TABLE public.audit_logs TO uellix_auditor;


--
-- Name: TABLE evidence_items; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.evidence_items TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.evidence_items TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.evidence_items TO uellix_writer;
GRANT SELECT ON TABLE public.evidence_items TO uellix_auditor;


--
-- Name: TABLE financial_proxies; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.financial_proxies TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.financial_proxies TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.financial_proxies TO uellix_writer;
GRANT SELECT ON TABLE public.financial_proxies TO uellix_auditor;


--
-- Name: TABLE funders; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.funders TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.funders TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.funders TO uellix_writer;
GRANT SELECT ON TABLE public.funders TO uellix_auditor;


--
-- Name: TABLE fx_rates; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fx_rates TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fx_rates TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fx_rates TO uellix_writer;
GRANT SELECT ON TABLE public.fx_rates TO uellix_auditor;


--
-- Name: TABLE impact_narratives; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.impact_narratives TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.impact_narratives TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.impact_narratives TO uellix_writer;
GRANT SELECT ON TABLE public.impact_narratives TO uellix_auditor;


--
-- Name: TABLE indicators; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.indicators TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.indicators TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.indicators TO uellix_writer;
GRANT SELECT ON TABLE public.indicators TO uellix_auditor;


--
-- Name: TABLE invitations; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invitations TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invitations TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invitations TO uellix_writer;
GRANT SELECT ON TABLE public.invitations TO uellix_auditor;


--
-- Name: TABLE marketing_leads; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.marketing_leads TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.marketing_leads TO uellix_writer;
GRANT SELECT ON TABLE public.marketing_leads TO uellix_auditor;


--
-- Name: TABLE methodology_review_matrix; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.methodology_review_matrix TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.methodology_review_matrix TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.methodology_review_matrix TO uellix_writer;
GRANT SELECT ON TABLE public.methodology_review_matrix TO uellix_auditor;


--
-- Name: TABLE methodology_review_matrix_items; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.methodology_review_matrix_items TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.methodology_review_matrix_items TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.methodology_review_matrix_items TO uellix_writer;
GRANT SELECT ON TABLE public.methodology_review_matrix_items TO uellix_auditor;


--
-- Name: TABLE organization_members; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_members TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_members TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_members TO uellix_writer;
GRANT SELECT ON TABLE public.organization_members TO uellix_auditor;


--
-- Name: TABLE organizations; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO uellix_writer;
GRANT SELECT ON TABLE public.organizations TO uellix_auditor;


--
-- Name: TABLE outcome_funder_allocations; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_funder_allocations TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_funder_allocations TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_funder_allocations TO uellix_writer;
GRANT SELECT ON TABLE public.outcome_funder_allocations TO uellix_auditor;


--
-- Name: TABLE outcome_proxy_assignments; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_proxy_assignments TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_proxy_assignments TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_proxy_assignments TO uellix_writer;
GRANT SELECT ON TABLE public.outcome_proxy_assignments TO uellix_auditor;


--
-- Name: TABLE outcome_taxonomy_mappings; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_taxonomy_mappings TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_taxonomy_mappings TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcome_taxonomy_mappings TO uellix_writer;
GRANT SELECT ON TABLE public.outcome_taxonomy_mappings TO uellix_auditor;


--
-- Name: TABLE outcomes; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcomes TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcomes TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.outcomes TO uellix_writer;
GRANT SELECT ON TABLE public.outcomes TO uellix_auditor;


--
-- Name: TABLE portfolios; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.portfolios TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.portfolios TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.portfolios TO uellix_writer;
GRANT SELECT ON TABLE public.portfolios TO uellix_auditor;


--
-- Name: TABLE project_investments; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_investments TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_investments TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_investments TO uellix_writer;
GRANT SELECT ON TABLE public.project_investments TO uellix_auditor;


--
-- Name: TABLE projects; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.projects TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.projects TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.projects TO uellix_writer;
GRANT SELECT ON TABLE public.projects TO uellix_auditor;


--
-- Name: TABLE proxy_sources; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proxy_sources TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proxy_sources TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.proxy_sources TO uellix_writer;
GRANT SELECT ON TABLE public.proxy_sources TO uellix_auditor;


--
-- Name: TABLE signup_allowlist; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.signup_allowlist TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.signup_allowlist TO uellix_writer;
GRANT SELECT ON TABLE public.signup_allowlist TO uellix_auditor;


--
-- Name: TABLE sroi_assignment_inputs; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_assignment_inputs TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_assignment_inputs TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_assignment_inputs TO uellix_writer;
GRANT SELECT ON TABLE public.sroi_assignment_inputs TO uellix_auditor;


--
-- Name: TABLE sroi_calculation_line_items; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT ON TABLE public.sroi_calculation_line_items TO authenticated;
GRANT SELECT,INSERT ON TABLE public.sroi_calculation_line_items TO service_role;
GRANT SELECT,INSERT ON TABLE public.sroi_calculation_line_items TO uellix_writer;
GRANT SELECT ON TABLE public.sroi_calculation_line_items TO uellix_auditor;


--
-- Name: TABLE sroi_calculation_runs; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT ON TABLE public.sroi_calculation_runs TO authenticated;
GRANT SELECT,INSERT ON TABLE public.sroi_calculation_runs TO service_role;
GRANT SELECT,INSERT ON TABLE public.sroi_calculation_runs TO uellix_writer;
GRANT SELECT ON TABLE public.sroi_calculation_runs TO uellix_auditor;


--
-- Name: TABLE sroi_filter_sets; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_filter_sets TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_filter_sets TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_filter_sets TO uellix_writer;
GRANT SELECT ON TABLE public.sroi_filter_sets TO uellix_auditor;


--
-- Name: TABLE sroi_report_sections; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_report_sections TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_report_sections TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_report_sections TO uellix_writer;
GRANT SELECT ON TABLE public.sroi_report_sections TO uellix_auditor;


--
-- Name: TABLE sroi_reports; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_reports TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_reports TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_reports TO uellix_writer;
GRANT SELECT ON TABLE public.sroi_reports TO uellix_auditor;


--
-- Name: TABLE sroi_run_review_items; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_run_review_items TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_run_review_items TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_run_review_items TO uellix_writer;
GRANT SELECT ON TABLE public.sroi_run_review_items TO uellix_auditor;


--
-- Name: TABLE sroi_run_reviews; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_run_reviews TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_run_reviews TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sroi_run_reviews TO uellix_writer;
GRANT SELECT ON TABLE public.sroi_run_reviews TO uellix_auditor;


--
-- Name: TABLE stakeholder_groups; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stakeholder_groups TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stakeholder_groups TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stakeholder_groups TO uellix_writer;
GRANT SELECT ON TABLE public.stakeholder_groups TO uellix_auditor;


--
-- Name: TABLE stella_interactions; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT ON TABLE public.stella_interactions TO authenticated;
GRANT SELECT ON TABLE public.stella_interactions TO service_role;
GRANT SELECT,INSERT ON TABLE public.stella_interactions TO uellix_writer;
GRANT SELECT ON TABLE public.stella_interactions TO uellix_auditor;


--
-- Name: TABLE stella_suggestion_decisions; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT ON TABLE public.stella_suggestion_decisions TO authenticated;
GRANT SELECT,INSERT ON TABLE public.stella_suggestion_decisions TO uellix_writer;
GRANT SELECT ON TABLE public.stella_suggestion_decisions TO uellix_auditor;


--
-- Name: TABLE taxonomy_catalogs; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT ON TABLE public.taxonomy_catalogs TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.taxonomy_catalogs TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.taxonomy_catalogs TO uellix_writer;
GRANT SELECT ON TABLE public.taxonomy_catalogs TO uellix_auditor;


--
-- Name: TABLE taxonomy_codes; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT ON TABLE public.taxonomy_codes TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.taxonomy_codes TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.taxonomy_codes TO uellix_writer;
GRANT SELECT ON TABLE public.taxonomy_codes TO uellix_auditor;


--
-- Name: TABLE theory_of_change_links; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.theory_of_change_links TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.theory_of_change_links TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.theory_of_change_links TO uellix_writer;
GRANT SELECT ON TABLE public.theory_of_change_links TO uellix_auditor;


--
-- Name: TABLE theory_of_change_nodes; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.theory_of_change_nodes TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.theory_of_change_nodes TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.theory_of_change_nodes TO uellix_writer;
GRANT SELECT ON TABLE public.theory_of_change_nodes TO uellix_auditor;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: uellix_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.users TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO uellix_writer;
GRANT SELECT ON TABLE public.users TO uellix_auditor;


--
-- Name: TABLE messages; Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON TABLE realtime.messages TO postgres;
GRANT ALL ON TABLE realtime.messages TO dashboard_user;
GRANT SELECT,INSERT,UPDATE ON TABLE realtime.messages TO anon;
GRANT SELECT,INSERT,UPDATE ON TABLE realtime.messages TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE realtime.messages TO service_role;


--
-- Name: TABLE messages_2026_08_01; Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON TABLE realtime.messages_2026_08_01 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_01 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_02; Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON TABLE realtime.messages_2026_08_02 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_02 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_03; Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON TABLE realtime.messages_2026_08_03 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_03 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_04; Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON TABLE realtime.messages_2026_08_04 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_04 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_05; Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON TABLE realtime.messages_2026_08_05 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_05 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_06; Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON TABLE realtime.messages_2026_08_06 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_06 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_07; Type: ACL; Schema: realtime; Owner: supabase_realtime_admin
--

GRANT ALL ON TABLE realtime.messages_2026_08_07 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_07 TO dashboard_user;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON TABLE realtime.schema_migrations TO postgres;
GRANT ALL ON TABLE realtime.schema_migrations TO dashboard_user;
GRANT SELECT ON TABLE realtime.schema_migrations TO anon;
GRANT SELECT ON TABLE realtime.schema_migrations TO authenticated;
GRANT SELECT ON TABLE realtime.schema_migrations TO service_role;
GRANT ALL ON TABLE realtime.schema_migrations TO supabase_realtime_admin;


--
-- Name: TABLE subscription; Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON TABLE realtime.subscription TO postgres;
GRANT ALL ON TABLE realtime.subscription TO dashboard_user;
GRANT SELECT ON TABLE realtime.subscription TO anon;
GRANT SELECT ON TABLE realtime.subscription TO authenticated;
GRANT SELECT ON TABLE realtime.subscription TO service_role;
GRANT ALL ON TABLE realtime.subscription TO supabase_realtime_admin;


--
-- Name: SEQUENCE subscription_id_seq; Type: ACL; Schema: realtime; Owner: supabase_admin
--

GRANT ALL ON SEQUENCE realtime.subscription_id_seq TO postgres;
GRANT ALL ON SEQUENCE realtime.subscription_id_seq TO dashboard_user;
GRANT USAGE ON SEQUENCE realtime.subscription_id_seq TO anon;
GRANT USAGE ON SEQUENCE realtime.subscription_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE realtime.subscription_id_seq TO service_role;
GRANT ALL ON SEQUENCE realtime.subscription_id_seq TO supabase_realtime_admin;


--
-- Name: TABLE buckets; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT ALL ON TABLE storage.buckets TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE storage.buckets TO service_role;
GRANT ALL ON TABLE storage.buckets TO authenticated;
GRANT ALL ON TABLE storage.buckets TO anon;


--
-- Name: TABLE buckets_analytics; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT ALL ON TABLE storage.buckets_analytics TO service_role;
GRANT ALL ON TABLE storage.buckets_analytics TO authenticated;
GRANT ALL ON TABLE storage.buckets_analytics TO anon;


--
-- Name: TABLE buckets_vectors; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT SELECT ON TABLE storage.buckets_vectors TO service_role;
GRANT SELECT ON TABLE storage.buckets_vectors TO authenticated;
GRANT SELECT ON TABLE storage.buckets_vectors TO anon;


--
-- Name: TABLE iceberg_namespaces; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT ALL ON TABLE storage.iceberg_namespaces TO service_role;
GRANT SELECT ON TABLE storage.iceberg_namespaces TO authenticated;
GRANT SELECT ON TABLE storage.iceberg_namespaces TO anon;


--
-- Name: TABLE iceberg_tables; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT ALL ON TABLE storage.iceberg_tables TO service_role;
GRANT SELECT ON TABLE storage.iceberg_tables TO authenticated;
GRANT SELECT ON TABLE storage.iceberg_tables TO anon;


--
-- Name: TABLE objects; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT ALL ON TABLE storage.objects TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE storage.objects TO service_role;
GRANT ALL ON TABLE storage.objects TO authenticated;
GRANT ALL ON TABLE storage.objects TO anon;


--
-- Name: TABLE s3_multipart_uploads; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT ALL ON TABLE storage.s3_multipart_uploads TO service_role;
GRANT SELECT ON TABLE storage.s3_multipart_uploads TO authenticated;
GRANT SELECT ON TABLE storage.s3_multipart_uploads TO anon;


--
-- Name: TABLE s3_multipart_uploads_parts; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT ALL ON TABLE storage.s3_multipart_uploads_parts TO service_role;
GRANT SELECT ON TABLE storage.s3_multipart_uploads_parts TO authenticated;
GRANT SELECT ON TABLE storage.s3_multipart_uploads_parts TO anon;


--
-- Name: TABLE vector_indexes; Type: ACL; Schema: storage; Owner: supabase_storage_admin
--

GRANT SELECT ON TABLE storage.vector_indexes TO service_role;
GRANT SELECT ON TABLE storage.vector_indexes TO authenticated;
GRANT SELECT ON TABLE storage.vector_indexes TO anon;


--
-- Name: TABLE hooks; Type: ACL; Schema: supabase_functions; Owner: supabase_functions_admin
--

GRANT ALL ON TABLE supabase_functions.hooks TO postgres;
GRANT ALL ON TABLE supabase_functions.hooks TO anon;
GRANT ALL ON TABLE supabase_functions.hooks TO authenticated;
GRANT ALL ON TABLE supabase_functions.hooks TO service_role;


--
-- Name: SEQUENCE hooks_id_seq; Type: ACL; Schema: supabase_functions; Owner: supabase_functions_admin
--

GRANT ALL ON SEQUENCE supabase_functions.hooks_id_seq TO postgres;
GRANT ALL ON SEQUENCE supabase_functions.hooks_id_seq TO anon;
GRANT ALL ON SEQUENCE supabase_functions.hooks_id_seq TO authenticated;
GRANT ALL ON SEQUENCE supabase_functions.hooks_id_seq TO service_role;


--
-- Name: TABLE migrations; Type: ACL; Schema: supabase_functions; Owner: supabase_functions_admin
--

GRANT ALL ON TABLE supabase_functions.migrations TO postgres;
GRANT ALL ON TABLE supabase_functions.migrations TO anon;
GRANT ALL ON TABLE supabase_functions.migrations TO authenticated;
GRANT ALL ON TABLE supabase_functions.migrations TO service_role;


--
-- Name: TABLE secrets; Type: ACL; Schema: vault; Owner: supabase_admin
--

GRANT SELECT,REFERENCES,DELETE,TRUNCATE ON TABLE vault.secrets TO postgres WITH GRANT OPTION;
GRANT SELECT,DELETE ON TABLE vault.secrets TO service_role;


--
-- Name: TABLE decrypted_secrets; Type: ACL; Schema: vault; Owner: supabase_admin
--

GRANT SELECT,REFERENCES,DELETE,TRUNCATE ON TABLE vault.decrypted_secrets TO postgres WITH GRANT OPTION;
GRANT SELECT,DELETE ON TABLE vault.decrypted_secrets TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: auth; Owner: supabase_auth_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: auth; Owner: supabase_auth_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: auth; Owner: supabase_auth_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: extensions; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions GRANT ALL ON SEQUENCES TO postgres WITH GRANT OPTION;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: extensions; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions GRANT ALL ON FUNCTIONS TO postgres WITH GRANT OPTION;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: extensions; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions GRANT ALL ON TABLES TO postgres WITH GRANT OPTION;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: graphql; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: graphql; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: graphql; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: graphql_public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: graphql_public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: graphql_public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: uellix_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO uellix_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO uellix_auditor;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: uellix_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public GRANT SELECT,INSERT ON TABLES TO uellix_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public GRANT SELECT ON TABLES TO uellix_auditor;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: realtime; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON SEQUENCES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: realtime; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON FUNCTIONS TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: realtime; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON TABLES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: storage; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: storage; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: storage; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: supabase_functions; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: supabase_functions; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: supabase_functions; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TYPES; Type: DEFAULT ACL; Schema: -; Owner: uellix_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner REVOKE ALL ON TYPES FROM PUBLIC;


--
-- Name: DEFAULT PRIVILEGES FOR TYPES; Type: DEFAULT ACL; Schema: -; Owner: uellix_migrator
--

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_migrator REVOKE ALL ON TYPES FROM PUBLIC;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: -; Owner: uellix_owner
--

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner REVOKE ALL ON FUNCTIONS FROM PUBLIC;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: -; Owner: uellix_migrator
--

ALTER DEFAULT PRIVILEGES FOR ROLE uellix_migrator REVOKE ALL ON FUNCTIONS FROM PUBLIC;


--
-- Name: issue_graphql_placeholder; Type: EVENT TRIGGER; Schema: -; Owner: supabase_admin
--

CREATE EVENT TRIGGER issue_graphql_placeholder ON sql_drop
         WHEN TAG IN ('DROP EXTENSION')
   EXECUTE FUNCTION extensions.set_graphql_placeholder();


ALTER EVENT TRIGGER issue_graphql_placeholder OWNER TO supabase_admin;

--
-- Name: issue_pg_cron_access; Type: EVENT TRIGGER; Schema: -; Owner: supabase_admin
--

CREATE EVENT TRIGGER issue_pg_cron_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_cron_access();


ALTER EVENT TRIGGER issue_pg_cron_access OWNER TO supabase_admin;

--
-- Name: issue_pg_graphql_access; Type: EVENT TRIGGER; Schema: -; Owner: supabase_admin
--

CREATE EVENT TRIGGER issue_pg_graphql_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_graphql_access();


ALTER EVENT TRIGGER issue_pg_graphql_access OWNER TO supabase_admin;

--
-- Name: issue_pg_net_access; Type: EVENT TRIGGER; Schema: -; Owner: supabase_admin
--

CREATE EVENT TRIGGER issue_pg_net_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_net_access();


ALTER EVENT TRIGGER issue_pg_net_access OWNER TO supabase_admin;

--
-- Name: pgrst_ddl_watch; Type: EVENT TRIGGER; Schema: -; Owner: supabase_admin
--

CREATE EVENT TRIGGER pgrst_ddl_watch ON ddl_command_end
   EXECUTE FUNCTION extensions.pgrst_ddl_watch();


ALTER EVENT TRIGGER pgrst_ddl_watch OWNER TO supabase_admin;

--
-- Name: pgrst_drop_watch; Type: EVENT TRIGGER; Schema: -; Owner: supabase_admin
--

CREATE EVENT TRIGGER pgrst_drop_watch ON sql_drop
   EXECUTE FUNCTION extensions.pgrst_drop_watch();


ALTER EVENT TRIGGER pgrst_drop_watch OWNER TO supabase_admin;

--
-- PostgreSQL database dump complete
--

\unrestrict uellix_baseline_g2

