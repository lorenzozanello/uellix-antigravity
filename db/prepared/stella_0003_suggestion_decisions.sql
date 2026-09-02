-- db/prepared/stella_0003_suggestion_decisions.sql
-- WS3b (persistence & DB security): stella_suggestion_decisions table.
--
-- PREPARED ONLY — NOT A MIGRATION. This file lives in db/prepared/ (never in
-- db/migrations/, where drizzle-kit would apply it). Application to any
-- database is the external gate G2, executed manually by Lorenzo following
-- docs/ops/gates/G2_PACKAGE.md and the process in
-- docs/ops/SUPABASE_MIGRATION_GATE.md. Rollback: stella_0003_rollback.sql.
--
-- SOURCE OF TRUTH: this table is deliberately absent from db/schema.ts and the
-- drizzle snapshot — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md. Do not add
-- it to schema.ts without following the promotion procedure in that ADR §7.
--
-- RUN ONLY through the fixed R3.4 governed local chain, in one transaction:
--   pnpm db:prepared:apply:local
-- The manifest authenticates this phase as uellix_migrator, starts the
-- transaction and reaches uellix_owner with SET LOCAL ROLE. It accepts no SQL
-- filename or arbitrary path. This package refuses every other
-- session/current-user pair before it creates or alters an object.
-- Idempotent AND convergent: on a database where the table already exists with
-- the expected shape, re-running reconciles indexes, grants, RLS, the policy
-- and the CHECK constraints. If the table exists with an INCOMPATIBLE shape the
-- script ABORTS with an explicit error instead of silently doing nothing.
--
-- PURPOSE: records what humans DID with Stella suggestions (accepted,
-- accepted with edits, rejected, undone) — the human-in-the-loop half of the
-- AI audit trail. The consuming server action
-- (app/actions/stella/decisions.ts, recordStellaDecision) ships DORMANT
-- behind STELLA_DECISIONS_PERSISTENCE_ENABLED=false and must stay off until
-- this script has been applied through G2.
--
-- PRIVACY INVARIANT: previous_value_hash stores a SHA-256 hex digest of the
-- value a suggestion replaced — NEVER the raw previous text. The hash is
-- computed server-side in recordStellaDecision. applied_text may store the
-- text that was actually applied (it becomes project content anyway).
--
-- PRIVILEGE HARDENING (2026-08-01, before this script's first application
-- anywhere): section 4 now does REVOKE ALL before granting anything back, and
-- section 6 attaches both append-only triggers. Both changes exist so this
-- table never inherits the Supabase default-privilege surplus (`Dxtm`) that
-- left the four pre-existing audit tables TRUNCATE-able and forced the
-- corrective script db/prepared/stella_0002b_append_only_truncate_hardening.sql.
-- This R3.2 revision has not been applied to any database. Its predecessor's
-- evidence and authorization do not transfer across the changed SHA-256.
-- Added dependency: db/migrations/0030_immutability.sql (uellix_forbid_mutation).

SET search_path = public;

-- On a database where the table ALREADY exists, section 6's DROP/CREATE TRIGGER
-- takes ACCESS EXCLUSIVE and holds it to COMMIT. Bound the wait so a long reader
-- cannot turn this script into a stall for every writer; the script is
-- convergent, so aborting and retrying costs nothing. (Added 2026-08-01.)
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions + shape guard
-- ============================================================
-- CREATE TABLE IF NOT EXISTS silently does nothing when a table of the same
-- name exists with a DIFFERENT shape. That would leave the application talking
-- to a table it does not understand. Fail loudly instead.
-- The error reports COLUMN NAMES AND TYPES ONLY — never row data.
DO $$
DECLARE
  mismatched   text;
  missing_roles text;
  app_oid       oid;
  writer_oid    oid;
  owner_oid     oid;
  migrator_oid  oid;
  bootstrap_oid oid;
  app_canlogin  boolean;
  app_inherit   boolean;
  app_bypass    boolean;
  app_createrole boolean;
  app_createdb  boolean;
  app_replication boolean;
  app_super     boolean;
  writer_canlogin boolean;
  writer_inherit boolean;
  writer_bypass boolean;
  writer_createrole boolean;
  writer_createdb boolean;
  writer_replication boolean;
  writer_super boolean;
  owner_canlogin boolean;
  owner_inherit boolean;
  owner_bypass  boolean;
  owner_createrole boolean;
  owner_createdb boolean;
  owner_replication boolean;
  owner_super boolean;
  migrator_canlogin boolean;
  migrator_inherit boolean;
  migrator_bypass boolean;
  migrator_createrole boolean;
  migrator_createdb boolean;
  migrator_replication boolean;
  migrator_super boolean;
BEGIN
  -- 0-pre. This package is only meaningful when DDL is reached, not held:
  -- session_user is the LOGIN migrator and current_user is the NOLOGIN owner.
  -- A superuser would satisfy later catalog checks while proving nothing about
  -- the governed migration path.
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION
      'stella_0003 aborted: current_user must be uellix_owner, found %. Apply through the migration wrapper, which reaches the owner with SET LOCAL ROLE.',
      current_user;
  END IF;

  IF session_user <> 'uellix_migrator' THEN
    RAISE EXCEPTION
      'stella_0003 aborted: session_user must be uellix_migrator, found %. The owner is NOLOGIN and must only be reached through the governed migration path.',
      session_user;
  END IF;

  -- 0-pre. The grantee roles must exist BEFORE anything is created or altered.
  --        Without this, section 4's REVOKE/GRANT and section 0b's
  --        has_function_privilege() both die on a bare
  --        'role "authenticated" does not exist', after the table already
  --        exists. Ported from stella_0002b §0-pre, whose comment notes this is
  --        otherwise the one precondition the script never states.
  --        The fixed runtime/owner/writer topology is verified below before
  --        ACL or policy reconciliation; the installer is never the writer.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing_roles
  FROM (VALUES
    ('anon'), ('authenticated'), ('service_role'), ('postgres'),
    ('uellix_app'), ('uellix_writer'), ('uellix_owner'), ('uellix_migrator')
  ) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: missing role(s): %. This database was not bootstrapped by Supabase; the grant model this script reconciles does not apply', missing_roles;
  END IF;

  SELECT oid, rolcanlogin, rolinherit, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolsuper
    INTO app_oid, app_canlogin, app_inherit, app_bypass, app_createrole, app_createdb, app_replication, app_super
  FROM pg_roles WHERE rolname = 'uellix_app';
  SELECT oid, rolcanlogin, rolinherit, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolsuper
    INTO writer_oid, writer_canlogin, writer_inherit, writer_bypass, writer_createrole, writer_createdb, writer_replication, writer_super
  FROM pg_roles WHERE rolname = 'uellix_writer';
  SELECT oid, rolcanlogin, rolinherit, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolsuper
    INTO owner_oid, owner_canlogin, owner_inherit, owner_bypass, owner_createrole, owner_createdb, owner_replication, owner_super
  FROM pg_roles WHERE rolname = 'uellix_owner';
  SELECT oid, rolcanlogin, rolinherit, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolsuper
    INTO migrator_oid, migrator_canlogin, migrator_inherit, migrator_bypass, migrator_createrole, migrator_createdb, migrator_replication, migrator_super
  FROM pg_roles WHERE rolname = 'uellix_migrator';
  -- The canonical grantor is the PostgreSQL BOOTSTRAP SUPERUSER, asserted by
  -- its fixed oid rather than any role name: PG17 attributes a membership
  -- granted by a raw superuser session to that oid regardless of what the
  -- superuser is called on a given cluster.
  bootstrap_oid := 10::oid;

  -- 0001 makes NOINHERIT a role-wide default and grants writer inheritance
  -- explicitly at membership level. Requiring global INHERIT here would reject
  -- the canonical topology before any DDL is reached.
  IF NOT app_canlogin OR app_inherit OR app_bypass OR app_createrole OR app_createdb OR app_replication OR app_super THEN
    RAISE EXCEPTION 'stella_0003 aborted: uellix_app must be LOGIN NOINHERIT with no BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION or superuser attribute.';
  END IF;
  IF writer_canlogin OR writer_inherit OR writer_bypass OR writer_createrole OR writer_createdb OR writer_replication OR writer_super THEN
    RAISE EXCEPTION 'stella_0003 aborted: uellix_writer must be NOLOGIN NOINHERIT with no BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION or superuser attribute.';
  END IF;
  IF owner_canlogin OR owner_inherit OR owner_bypass OR owner_createrole OR owner_createdb OR owner_replication OR owner_super THEN
    RAISE EXCEPTION 'stella_0003 aborted: uellix_owner must be NOLOGIN NOINHERIT with no BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION or superuser attribute.';
  END IF;
  IF NOT migrator_canlogin OR migrator_inherit OR migrator_bypass OR migrator_createrole OR migrator_createdb OR migrator_replication OR migrator_super THEN
    RAISE EXCEPTION 'stella_0003 aborted: uellix_migrator must be LOGIN NOINHERIT with no BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION or superuser attribute.';
  END IF;
  IF has_schema_privilege('uellix_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_0003 aborted: uellix_app holds CREATE on schema public.';
  END IF;
  -- These two direct checks are exact named-grantor slices of the canonical
  -- inventory below. They preserve its fast, role-specific failure messages;
  -- the complete inventory remains the sole proof of exclusivity.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.member = app_oid
      AND m.roleid = writer_oid
      AND m.grantor = bootstrap_oid
      AND m.inherit_option
      AND NOT m.set_option
      AND NOT m.admin_option
  ) THEN
    RAISE EXCEPTION 'stella_0003 aborted: uellix_app must inherit uellix_writer directly from the bootstrap superuser (INHERIT TRUE, SET FALSE, ADMIN FALSE).';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.member = migrator_oid
      AND m.roleid = owner_oid
      AND m.grantor = bootstrap_oid
      AND NOT m.inherit_option
      AND m.set_option
      AND NOT m.admin_option
  ) THEN
    RAISE EXCEPTION 'stella_0003 aborted: uellix_migrator must reach uellix_owner from the bootstrap superuser only through SET ROLE (INHERIT FALSE, SET TRUE, ADMIN FALSE).';
  END IF;
  -- USAGE is membership/inheritance semantics, not SET ROLE capability. SET
  -- follows every PostgreSQL-supported membership path and therefore rejects
  -- a direct or transitive owner escalation even where USAGE is false.
  IF pg_has_role(app_oid, owner_oid, 'SET') THEN
    RAISE EXCEPTION 'stella_0003 aborted: uellix_app can SET ROLE uellix_owner, which violates the runtime separation.';
  END IF;

  -- PostgreSQL 17 can retain multiple logical membership rows under different
  -- grantors. This single full-tuple inventory is the membership proof for
  -- this package: it rejects every wrong grantor/flag row and requires exactly
  -- one named-grantor canonical row per pair.
  WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
    VALUES
      ('uellix_migrator', 'uellix_owner', bootstrap_oid, false, true, false),
      ('uellix_app', 'uellix_writer', bootstrap_oid, true, false, false),
      ('postgres', 'uellix_writer', bootstrap_oid, true, false, false)
  ), actual AS (
    SELECT m.rolname AS member_name, r.rolname AS role_name, a.grantor AS grantor_oid,
           g.rolname AS grantor_name,
           a.inherit_option, a.set_option, a.admin_option
    FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    JOIN pg_roles g ON g.oid = a.grantor
    WHERE m.rolname IN ('uellix_app', 'uellix_writer', 'uellix_migrator')
       OR r.rolname IN ('uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator')
  )
  SELECT string_agg(a.member_name || '->' || a.role_name || ' granted-by=' || a.grantor_name || '(oid=' || a.grantor_oid || ')', ', ' ORDER BY a.member_name, a.role_name, a.grantor_oid)
    INTO missing_roles
  FROM actual a
  WHERE NOT EXISTS (
    SELECT 1 FROM expected e
    WHERE e.member_name = a.member_name AND e.role_name = a.role_name
      AND e.grantor_oid = a.grantor_oid
      AND a.inherit_option IS NOT DISTINCT FROM e.inherit_option
      AND a.set_option IS NOT DISTINCT FROM e.set_option
      AND a.admin_option IS NOT DISTINCT FROM e.admin_option
  );
  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: unexpected relevant membership row (wrong grantor, membership flags or ADMIN escalation): %', missing_roles;
  END IF;

  WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
    VALUES
      ('uellix_migrator', 'uellix_owner', bootstrap_oid, false, true, false),
      ('uellix_app', 'uellix_writer', bootstrap_oid, true, false, false),
      ('postgres', 'uellix_writer', bootstrap_oid, true, false, false)
  )
  SELECT string_agg(e.member_name || '->' || e.role_name, ', ' ORDER BY e.member_name, e.role_name)
    INTO missing_roles
  FROM expected e
  WHERE (
    SELECT count(*) FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    WHERE m.rolname = e.member_name AND r.rolname = e.role_name
      AND a.grantor = e.grantor_oid
      AND a.inherit_option IS NOT DISTINCT FROM e.inherit_option
      AND a.set_option IS NOT DISTINCT FROM e.set_option
      AND a.admin_option IS NOT DISTINCT FROM e.admin_option
  ) <> 1;
  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: canonical membership tuple cardinality is not one: %', missing_roles;
  END IF;

  -- 0a. FK targets must exist.
  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: one of the referenced tables (organizations, projects, users, stella_interactions) is missing — this database is not at the expected migration baseline (G2 precondition "migraciones base al día")';
  END IF;

  -- 0b. RLS helper functions must exist (db/migrations/0031_rls_core.sql);
  --     EXECUTE is granted by 0039_grant_rls_helper_execution.sql.
  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: RLS helpers public.current_user_org_ids()/current_user_is_super_admin() not found — apply db/migrations/0031_rls_core.sql and 0039_grant_rls_helper_execution.sql first';
  END IF;

  -- Existing is not enough: they must be EXECUTABLE by authenticated, or the
  -- SELECT policy in section 5 fails at runtime for every real user.
  -- 0033_public_api_grants.sql:18 does REVOKE EXECUTE ON ALL FUNCTIONS ... FROM
  -- authenticated, and 0039 grants it back — an environment that received the
  -- first and not the second looks healthy here but denies every read.
  IF NOT has_function_privilege('authenticated', 'public.current_user_org_ids()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.current_user_is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'stella_0003 aborted: role authenticated lacks EXECUTE on the RLS helpers — apply db/migrations/0039_grant_rls_helper_execution.sql (0033:18 revokes it; 0039 grants it back). Without it the SELECT policy denies every read';
  END IF;

  -- 0b-bis. The append-only trigger function must exist
  --         (db/migrations/0030_immutability.sql). Section 6 attaches this
  --         table's immutability triggers to it, mirroring the posture that
  --         prepared stella_0002/stella_0002b established for
  --         stella_interactions and the other audit tables.
  IF to_regprocedure('public.uellix_forbid_mutation()') IS NULL THEN
    RAISE EXCEPTION 'stella_0003 aborted: function public.uellix_forbid_mutation() not found — apply db/migrations/0030_immutability.sql first (G2 precondition "migraciones base al día")';
  END IF;

  -- 0c. Shape guard — only when the table already exists.
  IF to_regclass('public.stella_suggestion_decisions') IS NOT NULL THEN
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.stella_suggestion_decisions')) <> 'uellix_owner' THEN
      RAISE EXCEPTION 'stella_0003 aborted: the existing decision table is not owned by uellix_owner. Repair ownership through its authorised migration path before re-running.';
    END IF;
    SELECT string_agg(
             format('%s (expected %s%s)', e.col, e.typ,
                    CASE WHEN e.nul = 'NO' THEN ' NOT NULL' ELSE ' NULL' END),
             ', ' ORDER BY e.col)
      INTO mismatched
    FROM (VALUES
      ('id',                  'uuid',                        'NO'),
      ('organization_id',     'uuid',                        'NO'),
      ('project_id',          'uuid',                        'NO'),
      ('interaction_id',      'uuid',                        'YES'),
      ('suggestion_key',      'text',                        'NO'),
      ('decision',            'text',                        'NO'),
      ('previous_value_hash', 'text',                        'YES'),
      ('applied_text',        'text',                        'YES'),
      ('rejection_reason',    'text',                        'YES'),
      ('decided_by',          'uuid',                        'NO'),
      ('decided_at',          'timestamp with time zone',    'NO')
    ) AS e(col, typ, nul)
    LEFT JOIN information_schema.columns c
           ON c.table_schema = 'public'
          AND c.table_name   = 'stella_suggestion_decisions'
          AND c.column_name  = e.col
          AND c.data_type    = e.typ
          AND c.is_nullable  = e.nul
    WHERE c.column_name IS NULL;

    IF mismatched IS NOT NULL THEN
      RAISE EXCEPTION
        'stella_0003 aborted: public.stella_suggestion_decisions already exists with an INCOMPATIBLE shape. Missing or mismatched columns: %. This script never ALTERs COLUMNS of an existing table (it does reconcile stale constraints) — resolve manually and re-run (see "Criterios de aborto" in docs/ops/gates/G2_PACKAGE.md).',
        mismatched;
    END IF;

    -- 0d. Columns matching is not enough: a pre-existing table can still be
    --     unusable by the application. Check the three cases that would break
    --     recordStellaDecision's INSERT at runtime.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.stella_suggestion_decisions'::regclass AND contype = 'p'
    ) THEN
      RAISE EXCEPTION 'stella_0003 aborted: public.stella_suggestion_decisions exists without a PRIMARY KEY';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stella_suggestion_decisions'
        AND column_name = 'id' AND column_default IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'stella_0003 aborted: public.stella_suggestion_decisions.id has no DEFAULT — the application INSERT omits id and would fail';
    END IF;

    SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO mismatched
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stella_suggestion_decisions'
      AND is_nullable = 'NO' AND column_default IS NULL
      AND column_name NOT IN (
        'id', 'organization_id', 'project_id', 'suggestion_key',
        'decision', 'decided_by'
      );
    IF mismatched IS NOT NULL THEN
      RAISE EXCEPTION
        'stella_0003 aborted: public.stella_suggestion_decisions has unexpected NOT NULL columns without a default (%), which the application INSERT does not populate.',
        mismatched;
    END IF;
  END IF;
END $$;

-- ============================================================
-- 1. Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stella_suggestion_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  -- The stella_interactions row whose suggestion was decided on; NULL when the
  -- UI cannot attribute the decision to a specific interaction.
  interaction_id uuid REFERENCES public.stella_interactions(id),
  -- Stable key identifying WHICH suggestion inside the interaction payload
  -- (e.g. 'advisor.suggested_next_actions[2]') — assigned by the UI layer.
  suggestion_key text NOT NULL,
  decision text NOT NULL,
  -- SHA-256 (hex) of the replaced value; raw previous text is never persisted.
  previous_value_hash text,
  applied_text text,
  rejection_reason text,
  -- Same user-FK convention as stella_interactions.created_by (public.users).
  decided_by uuid NOT NULL REFERENCES public.users(id),
  decided_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT stella_suggestion_decisions_decision_check
    CHECK (decision IN ('accepted', 'accepted_edited', 'rejected', 'undone')),
  CONSTRAINT stella_suggestion_decisions_prev_hash_check
    CHECK (previous_value_hash IS NULL OR previous_value_hash ~ '^[0-9a-f]{64}$')
);

-- New tables are born owned by current_user, and section 0 requires that to
-- be uellix_owner. State the target explicitly as well so a convergent re-run
-- records and reasserts the canonical owner rather than relying on inference.
ALTER TABLE public.stella_suggestion_decisions OWNER TO uellix_owner;

-- ============================================================
-- 2. CHECK reconciliation — convergent
-- ============================================================
-- Covers the case where the table pre-exists with the right columns (so the
-- shape guard passed) but a named CHECK is MISSING **or STALE**.
--
-- Comparing only `conname` would be a trap: an earlier revision that created
-- decision_check with 3 values (no 'undone') carries the right name with the
-- wrong definition, and a name-only check would silently leave it in place —
-- the gate would sign off green and recordStellaDecision would fail at runtime
-- on the first 'undone'. So we compare the DEFINITION, matching quoted
-- literals exactly as pg_get_constraintdef renders them (same rigour as
-- stella_0002's stella_role reconciliation).
DO $$
DECLARE
  def       text;
  offending text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.stella_suggestion_decisions'::regclass
    AND conname = 'stella_suggestion_decisions_decision_check';

  -- position(), not LIKE: in a LIKE pattern `_` matches ANY single character,
  -- so `LIKE '%''accepted_edited''%'` would also accept a stale constraint
  -- spelling 'acceptedXedited' and leave it in place. position() is a literal
  -- substring search with no metacharacters at all.
  -- Reconcile on the SAME test section 7 verifies with — presence AND
  -- exclusivity. Reconciling on presence alone left a convergence gap: a
  -- pre-existing CHECK that was a strict SUPERSET (the four states plus a
  -- fifth) satisfied section 2, was left in place, and then made section 7
  -- abort the whole transaction. Now it is rebuilt instead.
  IF def IS NULL
     OR position('''accepted''' in def) = 0
     OR position('''accepted_edited''' in def) = 0
     OR position('''rejected''' in def) = 0
     OR position('''undone''' in def) = 0
     OR EXISTS (
          SELECT 1
          FROM (SELECT (regexp_matches(def, '''([^'']+)''', 'g'))[1] AS lit) AS x
          WHERE lit NOT IN ('accepted', 'accepted_edited', 'rejected', 'undone')
        )
  THEN
    -- Before narrowing the constraint, check the DATA. Rebuilding a CHECK that
    -- existing rows violate fails with PostgreSQL's generic
    -- 'check constraint "..." is violated by some row' — no table name, no
    -- guidance, and none of the 'stella_0003 aborted:' prefix that this file's
    -- header and the G2 abort criteria tell the operator to look for. Report
    -- the offending STATES (never row data) instead.
    SELECT string_agg(DISTINCT d.decision, ', ' ORDER BY d.decision) INTO offending
    FROM public.stella_suggestion_decisions d
    WHERE d.decision NOT IN ('accepted', 'accepted_edited', 'rejected', 'undone');

    IF offending IS NOT NULL THEN
      RAISE EXCEPTION 'stella_0003 aborted: existing rows hold decision state(s) outside the contract: %. The CHECK cannot be narrowed to accepted / accepted_edited / rejected / undone without losing or rewriting those rows — resolve manually (see "Criterios de aborto" in docs/ops/gates/G2_PACKAGE.md). No row data is shown, only the distinct states', offending;
    END IF;

    IF def IS NOT NULL THEN
      ALTER TABLE public.stella_suggestion_decisions
        DROP CONSTRAINT stella_suggestion_decisions_decision_check;
    END IF;
    ALTER TABLE public.stella_suggestion_decisions
      ADD CONSTRAINT stella_suggestion_decisions_decision_check
      CHECK (decision IN ('accepted', 'accepted_edited', 'rejected', 'undone'));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.stella_suggestion_decisions'::regclass
    AND conname = 'stella_suggestion_decisions_prev_hash_check';

  -- The hash-not-content invariant: the definition must still pin the ANCHORED
  -- 64-hex shape. Matching the bare class would accept a stale UNANCHORED regex
  -- ('[0-9a-f]{64}' without ^$), which would happily admit
  -- "<raw text><64 hex><more raw text>" — i.e. the very leak this CHECK exists
  -- to prevent. pg_get_constraintdef renders the literal as '^[0-9a-f]{64}$',
  -- so match it including its surrounding quotes.
  -- position() again: the pattern contains no `_`, but LIKE would still treat
  -- any future edit's `_` as a wildcard. Literal search removes the trap class.
  IF def IS NULL OR position('''^[0-9a-f]{64}$''' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.stella_suggestion_decisions
        DROP CONSTRAINT stella_suggestion_decisions_prev_hash_check;
    END IF;
    ALTER TABLE public.stella_suggestion_decisions
      ADD CONSTRAINT stella_suggestion_decisions_prev_hash_check
      CHECK (previous_value_hash IS NULL OR previous_value_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

-- ============================================================
-- 3. Indexes (no CONCURRENTLY — this script runs inside one transaction)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_org_decided_at
  ON public.stella_suggestion_decisions (organization_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_interaction_id
  ON public.stella_suggestion_decisions (interaction_id);

-- ============================================================
-- 4. Grants — deny-by-default, then grant back the minimum
-- ============================================================
-- WHY REVOKE ALL FIRST (hardened 2026-08-01, before this script's first ever
-- application anywhere):
--
-- Supabase configures ALTER DEFAULT PRIVILEGES so that every table created by
-- `postgres` in schema `public` is born granting `Dxtm` to `authenticated` —
-- D=TRUNCATE, x=REFERENCES, t=TRIGGER, m=MAINTAIN (PG17+) — and full `arwdDxtm`
-- to `service_role`. That inheritance is exactly what left the four existing
-- append-only tables TRUNCATE-able by `authenticated`, a MAJOR finding that
-- prepared stella_0002b had to repair after the fact (it was demonstrated on a
-- real PostgreSQL 17: `SET LOCAL ROLE authenticated; TRUNCATE ...` succeeded).
--
-- Listing privileges to revoke one by one is a losing game: it silently misses
-- whatever a future PostgreSQL version or Supabase bootstrap adds. REVOKE ALL
-- and then granting back is the only formulation that cannot inherit a surplus
-- it was not written to anticipate. This table therefore never carries the
-- defect its siblings had to be repaired for.
--
-- REVOKE of a privilege a role does not hold is a no-op, so this is repeatable.
REVOKE ALL ON public.stella_suggestion_decisions FROM anon;
REVOKE ALL ON public.stella_suggestion_decisions FROM authenticated;
REVOKE ALL ON public.stella_suggestion_decisions FROM service_role;
REVOKE ALL ON public.stella_suggestion_decisions FROM uellix_app;
REVOKE ALL ON public.stella_suggestion_decisions FROM uellix_writer;
-- PUBLIC is a fourth grantee, and an easy one to forget: it is not a role in
-- pg_roles (it is grantee OID 0 in the ACL), so a check that joins pg_roles
-- cannot even see it. Revoking is cheap and closes the gap by construction.
REVOKE ALL ON public.stella_suggestion_decisions FROM PUBLIC;

-- The minimum the real architecture needs:
--
--   authenticated -> SELECT only. Reads are gated by the org-scoped RLS policy
--     in section 5. This is stricter than the append-only tables, which also
--     carry an (inert) INSERT grant.
--
--   anon -> nothing. Never reads or writes this table.
--
--   uellix_writer -> SELECT + INSERT only. This NOLOGIN capability is the
--     sole direct append authority. uellix_app reaches it through its pinned
--     inherited membership and holds no table ACL entry of its own.
--
--   service_role -> nothing. A service-role/PostgREST route is not a writer
--     contract for this table and must be authorised by a separate package if
--     it is ever introduced.
GRANT SELECT ON public.stella_suggestion_decisions TO authenticated;
GRANT SELECT, INSERT ON public.stella_suggestion_decisions TO uellix_writer;

-- ============================================================
-- 4b. Canonical writer contract
-- ============================================================
-- The table owner is intentionally NOT the runtime. The runtime authenticates
-- as uellix_app and inherits the direct SELECT+INSERT ACL of uellix_writer;
-- owner authority remains reachable only through uellix_migrator -> SET LOCAL
-- ROLE uellix_owner. The self-verification below reads the ACL literally and
-- checks the one-hop membership, so has_table_privilege() is never the sole
-- proof of this authority boundary.

-- ============================================================
-- 5. RLS (mirrors db/policies/002_stella_interactions_rls.sql posture)
-- ============================================================
--   - SELECT: org members read their own org's decisions; super_admin sees all
--   - INSERT: only uellix_app may use the append capability it inherits from
--     uellix_writer. It must write the organisation fixed by the verified,
--     transaction-local context and attribute the decision to auth.uid().
--   - No UPDATE policy: decisions are immutable ('undone' is a NEW row, not an
--     update of the original decision)
--   - No DELETE policy: audit-trail integrity

ALTER TABLE public.stella_suggestion_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stella_suggestion_decisions_select" ON public.stella_suggestion_decisions;
CREATE POLICY "stella_suggestion_decisions_select"
ON public.stella_suggestion_decisions FOR SELECT
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);

DROP POLICY IF EXISTS stella_suggestion_decisions_insert_member_or_admin
  ON public.stella_suggestion_decisions;
CREATE POLICY stella_suggestion_decisions_insert_member_or_admin
  ON public.stella_suggestion_decisions
  FOR INSERT
  TO uellix_app
  WITH CHECK (
    organization_id = current_setting('app.organization_id', true)::uuid
    AND organization_id = ANY(public.current_user_org_ids())
    AND decided_by = auth.uid()
  );

-- No UPDATE policy -> UPDATE denied (immutable decisions)
-- No DELETE policy -> DELETE denied (audit trail integrity)

-- ============================================================
-- 6. Append-only enforcement at the database level
-- ============================================================
-- RLS and grants do not constrain the table owner. The runtime writer is
-- uellix_app through uellix_writer, while the owner is reached only by the
-- governed migration path. Triggers are the one control that fires for every
-- role, owner included, so they are what actually makes "decisions are
-- immutable" true rather than merely intended.
--
-- Two triggers are required, not one, because they cover disjoint events:
--   * FOR EACH ROW  on UPDATE/DELETE — no OLD/NEW rows exist for TRUNCATE, so a
--     row trigger can never see it;
--   * FOR EACH STATEMENT on TRUNCATE — PostgreSQL forbids FOR EACH ROW here.
-- Omitting the second is precisely the gap that stella_0002b had to close on
-- the four pre-existing audit tables. This table ships with both from day one.
--
-- 'undone' is a NEW row, never an UPDATE of the original decision, so nothing in
-- the application is affected by forbidding mutation.
--
-- public.uellix_forbid_mutation() is reused unchanged: it reads only TG_OP and
-- TG_TABLE_NAME, both available at row and statement level, and always raises
-- with SQLSTATE 42501.

DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_append_only ON public.stella_suggestion_decisions;
CREATE TRIGGER trg_stella_suggestion_decisions_append_only
  BEFORE UPDATE OR DELETE ON public.stella_suggestion_decisions
  FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_no_truncate ON public.stella_suggestion_decisions;
CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate
  BEFORE TRUNCATE ON public.stella_suggestion_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();

COMMENT ON TRIGGER trg_stella_suggestion_decisions_append_only ON public.stella_suggestion_decisions IS
  'WS3b (prepared stella_0003, gate G2): human-decision audit trail is append-only; UPDATE/DELETE are forbidden even for the table owner.';
COMMENT ON TRIGGER trg_stella_suggestion_decisions_no_truncate ON public.stella_suggestion_decisions IS
  'WS3b (prepared stella_0003, gate G2): TRUNCATE is forbidden on this append-only table, including for the table owner.';

COMMENT ON TABLE public.stella_suggestion_decisions IS
  'Human decisions over Stella suggestions (WS3b, prepared stella_0003, gate G2). previous_value_hash is a SHA-256 digest — raw previous text is never stored. Managed outside the drizzle chain: see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.';

-- ============================================================
-- 7. Self-verification — assert the end state, inside this transaction
-- ============================================================
-- Ported from stella_0002b §5, whose lesson was learned the hard way (RK-04b):
-- a REVOKE only removes grants made by the CURRENT grantor, and PostgreSQL
-- merely emits a WARNING — never an error — when there is nothing to revoke.
-- So "I ran REVOKE ALL" is not evidence that the privilege is gone.
--
-- Everything below reads pg_catalog directly. In particular, privileges come
-- from aclexplode() over pg_class.relacl, which reports the ACL literally:
-- privileges a role merely INHERITS through membership do not appear, and there
-- is no superuser short-circuit of the kind that made the old write-path guard
-- vacuous. information_schema.role_table_grants would have reported both.
--
-- Running inside the same transaction is what makes this worth doing: a failure
-- rolls the whole script back instead of leaving a table that reported success.
DO $$
DECLARE
  tbl_oid        oid;
  tbl_owner      name;
  app_oid        oid;
  writer_oid     oid;
  owner_oid      oid;
  migrator_oid   oid;
  bootstrap_oid  oid;
  problem        text;
  def            text;
  decision_insert_check_actual text;
  decision_insert_check_probe  text;
  n              int;
BEGIN
  -- (1) The table exists.
  tbl_oid := to_regclass('public.stella_suggestion_decisions');
  IF tbl_oid IS NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: public.stella_suggestion_decisions does not exist after the script ran';
  END IF;

  -- (2) Ownership is exact: the owner capability never belongs to runtime.
  SELECT pg_get_userbyid(relowner) INTO tbl_owner FROM pg_class WHERE oid = tbl_oid;
  IF tbl_owner <> 'uellix_owner' THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: table owner is %, expected uellix_owner.', tbl_owner;
  END IF;
  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'uellix_app';
  SELECT oid INTO writer_oid FROM pg_roles WHERE rolname = 'uellix_writer';
  SELECT oid INTO owner_oid FROM pg_roles WHERE rolname = 'uellix_owner';
  SELECT oid INTO migrator_oid FROM pg_roles WHERE rolname = 'uellix_migrator';
  -- Canonical grantor is the bootstrap superuser, asserted by its fixed oid.
  bootstrap_oid := 10::oid;

  -- (3) Columns: exact name, type, nullability and presence/absence of default.
  SELECT string_agg(format('%s(%s)', e.col, e.why), ', ' ORDER BY e.col) INTO problem
  FROM (
    SELECT x.col,
           CASE
             WHEN a.attname IS NULL THEN 'missing'
             WHEN format_type(a.atttypid, a.atttypmod) <> x.typ
               THEN 'type ' || format_type(a.atttypid, a.atttypmod) || ' <> ' || x.typ
             WHEN a.attnotnull <> x.req_notnull THEN 'nullability'
             WHEN (a.atthasdef OR a.attidentity <> '') <> x.req_hasdef THEN 'default'
           END AS why
    FROM (VALUES
      ('id',                  'uuid',                        true,  true),
      ('organization_id',     'uuid',                        true,  false),
      ('project_id',          'uuid',                        true,  false),
      ('interaction_id',      'uuid',                        false, false),
      ('suggestion_key',      'text',                        true,  false),
      ('decision',            'text',                        true,  false),
      ('previous_value_hash', 'text',                        false, false),
      ('applied_text',        'text',                        false, false),
      ('rejection_reason',    'text',                        false, false),
      ('decided_by',          'uuid',                        true,  false),
      ('decided_at',          'timestamp with time zone',    true,  true)
    -- NB: the alias cannot be `notnull` — PostgreSQL parses NOTNULL as an
    -- operator (`x NOTNULL` == `x IS NOT NULL`), so it is not a usable name.
    ) AS x(col, typ, req_notnull, req_hasdef)
    LEFT JOIN pg_attribute a
           ON a.attrelid = tbl_oid AND a.attname = x.col AND a.attnum > 0 AND NOT a.attisdropped
  ) AS e
  WHERE e.why IS NOT NULL;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: column contract broken: %', problem;
  END IF;

  -- ...and no EXTRA columns. Checking the 11 named columns says nothing about a
  -- 12th that the application does not know exists.
  SELECT count(*) INTO n FROM pg_attribute
  WHERE attrelid = tbl_oid AND attnum > 0 AND NOT attisdropped;
  IF n <> 11 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 11 columns, found %', n;
  END IF;

  -- (4) Primary key on (id).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = tbl_oid AND contype = 'p'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = tbl_oid AND attname = 'id')]
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: PRIMARY KEY on (id) missing or on the wrong column(s)';
  END IF;

  -- (5) Foreign keys to the four referenced tables.
  SELECT string_agg(f.col || '->' || f.tbl, ', ' ORDER BY f.col) INTO problem
  FROM (VALUES
    ('organization_id', 'organizations'),
    ('project_id',      'projects'),
    ('interaction_id',  'stella_interactions'),
    ('decided_by',      'users')
  ) AS f(col, tbl)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = tbl_oid AND c.contype = 'f'
      AND c.confrelid = to_regclass('public.' || f.tbl)
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = tbl_oid AND attname = f.col)]
      -- confdeltype 'a' = NO ACTION. This is a DELIBERATE invariant (RK-04f):
      -- these rows must BLOCK deletion of their organization/project/user
      -- rather than vanish with it. STELLA_RETENTION_POLICY.md documents it, so
      -- pin it here — a silent switch to CASCADE would turn an accidental org
      -- delete into silent audit-trail loss.
      AND c.confdeltype = 'a'
  );

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: missing FOREIGN KEY(s), or one is not ON DELETE NO ACTION: %', problem;
  END IF;

  -- ...and no EXTRA foreign keys.
  SELECT count(*) INTO n FROM pg_constraint WHERE conrelid = tbl_oid AND contype = 'f';
  IF n <> 4 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 4 foreign keys, found %', n;
  END IF;

  -- (6) UNIQUE: this table deliberately has NO unique constraint beyond the PK —
  --     the same (project, suggestion_key) may be decided more than once
  --     ('undone' is a NEW row). Assert that on purpose, so adding one silently
  --     later is caught rather than assumed.
  SELECT count(*) INTO n FROM pg_constraint WHERE conrelid = tbl_oid AND contype = 'u';
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: unexpected UNIQUE constraint(s) (%). Decisions are append-only history: re-deciding a suggestion inserts a NEW row', n;
  END IF;

  -- pg_constraint is not enough: a bare CREATE UNIQUE INDEX enforces uniqueness
  -- without creating a constraint, so the check above would miss it entirely.
  -- Exclude the primary key's own index, which is legitimately unique.
  SELECT count(*) INTO n
  FROM pg_index i
  WHERE i.indrelid = tbl_oid AND i.indisunique AND NOT i.indisprimary;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: % unexpected UNIQUE index(es) besides the primary key. A standalone unique index enforces uniqueness without a constraint and would silently forbid re-deciding a suggestion', n;
  END IF;

  -- (7)+(8) decision CHECK holds exactly the four states. position(), not LIKE:
  --         `_` is a LIKE wildcard, so 'acceptedXedited' would have passed.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = tbl_oid AND conname = 'stella_suggestion_decisions_decision_check';
  IF def IS NULL
     OR position('''accepted''' in def) = 0
     OR position('''accepted_edited''' in def) = 0
     OR position('''rejected''' in def) = 0
     OR position('''undone''' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: decision CHECK missing or incomplete: %', COALESCE(def, '<absent>');
  END IF;

  -- Presence is not exclusivity. Without this, a stale CHECK that ALSO allowed
  -- a fifth state (e.g. 'deleted') would satisfy the four position() probes and
  -- pass. Extract every quoted literal from the rendered definition and require
  -- the set to be exactly the four documented states.
  -- `[^'']+`, not `[a-z_]+`: a stale CHECK admitting 'accepted2', 'Deleted' or
  -- 'v2' would produce NO match under the narrower class and pass silently —
  -- the same "matches only what we already expected" trap that MIN-A closed.
  SELECT string_agg(DISTINCT lit, ', ' ORDER BY lit) INTO problem
  FROM (
    SELECT (regexp_matches(def, '''([^'']+)''', 'g'))[1] AS lit
  ) AS x
  WHERE lit NOT IN ('accepted', 'accepted_edited', 'rejected', 'undone');

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: decision CHECK allows unexpected state(s): %. The contract is exactly accepted / accepted_edited / rejected / undone', problem;
  END IF;

  -- (9) hash CHECK still pins the ANCHORED 64-hex shape. An unanchored variant
  --     would admit "<raw text><64 hex><more>" — the very leak it prevents.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = tbl_oid AND conname = 'stella_suggestion_decisions_prev_hash_check';
  IF def IS NULL OR position('''^[0-9a-f]{64}$''' in def) = 0 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: previous_value_hash CHECK missing or not anchored: %', COALESCE(def, '<absent>');
  END IF;

  -- (10) RLS enabled — and FORCE explicitly OFF. The runtime is not the owner
  --      and is NOBYPASSRLS, so both read and append policy expressions apply.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = tbl_oid) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: ROW LEVEL SECURITY is not enabled';
  END IF;
  IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = tbl_oid) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: FORCE ROW LEVEL SECURITY is ON. The canonical contract requires RLS enabled with FORCE off.';
  END IF;

  -- (11) Exactly two policies: SELECT plus the one narrow runtime INSERT.
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid;
  IF n <> 2 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 2 RLS policies, found %. UPDATE and DELETE must stay denied by absence', n;
  END IF;

  -- (11b) Observed-vs-observed same-session probe (MSC-07B.8-R9T remediation
  -- of R9S-X root cause B: the previous verifier compared
  -- pg_get_expr(..., true) against a handwritten predicted deparse literal
  -- that was never validated live against a real PostgreSQL deparser). A
  -- disjoint, temporary policy carrying the identical WITH CHECK source is
  -- created on this table in this session; its pg_get_expr(polwithcheck,
  -- polrelid) — the 2-arg form, the SAME form used to observe the real
  -- policy below — is compared to the canonical policy's own observation
  -- instead of to a prediction. The probe is dropped before the policy
  -- count above is trusted to still mean "2" and before any further
  -- inventory check runs.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = tbl_oid AND polname = 'stella_decision_canonical_insert_probe'
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: probe policy stella_decision_canonical_insert_probe already exists on public.stella_suggestion_decisions — refusing to trust unexpected pre-existing state';
  END IF;

  CREATE POLICY stella_decision_canonical_insert_probe
    ON public.stella_suggestion_decisions
    FOR INSERT
    TO uellix_app
    WITH CHECK (
      organization_id = current_setting('app.organization_id', true)::uuid
      AND organization_id = ANY(public.current_user_org_ids())
      AND decided_by = auth.uid()
    );

  SELECT pg_get_expr(polwithcheck, polrelid) INTO decision_insert_check_actual
  FROM pg_policy
  WHERE polrelid = tbl_oid AND polname = 'stella_suggestion_decisions_insert_member_or_admin';

  SELECT pg_get_expr(polwithcheck, polrelid) INTO decision_insert_check_probe
  FROM pg_policy
  WHERE polrelid = tbl_oid AND polname = 'stella_decision_canonical_insert_probe';

  DROP POLICY stella_decision_canonical_insert_probe ON public.stella_suggestion_decisions;

  IF decision_insert_check_actual IS NULL
     OR decision_insert_check_probe IS NULL
     OR decision_insert_check_actual <> decision_insert_check_probe THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: canonical INSERT policy WITH CHECK does not match the same-session probe. actual=%, probe=%',
      COALESCE(decision_insert_check_actual, '<absent>'), COALESCE(decision_insert_check_probe, '<absent>');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = tbl_oid
      AND polname = 'stella_suggestion_decisions_select'
      AND polcmd = 'r'                                   -- SELECT
      AND position('current_user_org_ids' in pg_get_expr(polqual, polrelid)) > 0
      AND position('current_user_is_super_admin' in pg_get_expr(polqual, polrelid)) > 0
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: the SELECT policy is missing, is not SELECT-only, or lost its org scoping';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = tbl_oid
      AND polname = 'stella_suggestion_decisions_insert_member_or_admin'
      AND polcmd = 'a'                                   -- INSERT
      AND polroles = ARRAY[app_oid]
      AND polpermissive
      -- The WITH CHECK body itself was already proven identical to the
      -- probe's above; this repeats it as a structural conjunct (defence in
      -- depth) rather than relying solely on the earlier RAISE.
      AND decision_insert_check_actual = decision_insert_check_probe
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: the INSERT policy is not the exact canonical uellix_app conjunction bound to transaction organisation and auth.uid().';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = tbl_oid AND polcmd IN ('w', 'd')
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: UPDATE or DELETE policy exists on an append-only decision table.';
  END IF;

  -- (12) Exactly one BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger.
  SELECT count(*) INTO n FROM pg_trigger
  WHERE tgrelid = tbl_oid AND NOT tgisinternal
    AND tgname = 'trg_stella_suggestion_decisions_append_only'
    AND (tgtype & 1) = 1 AND (tgtype & 2) = 2        -- ROW, BEFORE
    AND (tgtype & 16) = 16 AND (tgtype & 8) = 8      -- UPDATE, DELETE
    AND (tgtype & 4) = 0;                            -- never INSERT
  IF n <> 1 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 1 BEFORE UPDATE OR DELETE FOR EACH ROW trigger, found %', n;
  END IF;

  -- (13) Exactly one BEFORE TRUNCATE ... FOR EACH STATEMENT trigger.
  SELECT count(*) INTO n FROM pg_trigger
  WHERE tgrelid = tbl_oid AND NOT tgisinternal
    AND tgname = 'trg_stella_suggestion_decisions_no_truncate'
    AND (tgtype & 1) = 0 AND (tgtype & 2) = 2        -- STATEMENT, BEFORE
    AND (tgtype & 32) = 32;                          -- TRUNCATE
  IF n <> 1 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected exactly 1 BEFORE TRUNCATE FOR EACH STATEMENT trigger, found %', n;
  END IF;

  -- (14) Both triggers call public.uellix_forbid_mutation(), and no other
  --      non-internal trigger exists on this table.
  SELECT count(*) INTO n FROM pg_trigger t
  WHERE t.tgrelid = tbl_oid AND NOT t.tgisinternal
    AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')::oid;
  IF n <> 2 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: expected 2 triggers bound to public.uellix_forbid_mutation(), found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = tbl_oid AND NOT tgisinternal;
  IF n <> 2 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: unexpected extra trigger(s) on the table (total %, expected 2)', n;
  END IF;

  -- (15) Privileges, read as DIRECT ACL entries only. This is deliberately
  --      stronger than an effective-privilege check: inheritance is required
  --      for the app but forbidden as a substitute for the writer's direct
  --      capability, and an accidental direct app grant must be visible.
  SELECT string_agg(g.rolname || ':' || a.privilege_type, ', ' ORDER BY g.rolname, a.privilege_type)
    INTO problem
  FROM pg_class c,
       aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND g.rolname IN ('anon', 'authenticated', 'service_role', 'uellix_app', 'uellix_writer')
    AND NOT (
      (g.rolname = 'authenticated' AND a.privilege_type = 'SELECT' AND NOT a.is_grantable)
      OR (g.rolname = 'uellix_writer' AND a.privilege_type IN ('SELECT', 'INSERT') AND NOT a.is_grantable)
    );

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: unexpected DIRECT privilege(s) present: %. Target is authenticated=SELECT, uellix_writer=SELECT+INSERT, and anon/service_role/uellix_app=none. A REVOKE only removes grants made by the current grantor — investigate other grantors.', problem;
  END IF;

  -- PUBLIC separately: it is grantee OID 0 and has no pg_roles row, so the
  -- JOIN above cannot see it. A grant to PUBLIC would reach every role in the
  -- cluster, including anon.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = tbl_oid AND a.grantee = 0;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: PUBLIC holds privilege(s): %. That reaches every role in the cluster, anon included', problem;
  END IF;

  -- (16) Required direct entries cannot be over-revoked or made grantable.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c,
         aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = tbl_oid AND g.rolname = 'authenticated' AND a.privilege_type = 'SELECT' AND NOT a.is_grantable
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: authenticated LOST its direct SELECT grant — the RLS read path would deny every user';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = tbl_oid
      AND a.grantee = writer_oid
      AND a.privilege_type IN ('SELECT', 'INSERT')
      AND NOT a.is_grantable
  ) <> 2 THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: uellix_writer must hold exactly direct SELECT and INSERT without grant option.';
  END IF;

  -- (17) Exact named-grantor slices of the full inventory below preserve
  --       specific mediated-path diagnostics; only the full inventory proves
  --       exclusivity and cardinality before pg_has_role(..., 'SET').
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.member = app_oid
      AND m.roleid = writer_oid
      AND m.grantor = bootstrap_oid
      AND m.inherit_option
      AND NOT m.set_option
      AND NOT m.admin_option
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: uellix_app is not the required inheriting, non-SET, non-ADMIN member of uellix_writer from the bootstrap superuser.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.member = migrator_oid
      AND m.roleid = owner_oid
      AND m.grantor = bootstrap_oid
      AND NOT m.inherit_option
      AND m.set_option
      AND NOT m.admin_option
  ) THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: uellix_migrator is not the required non-inheriting, SET-only, non-ADMIN member of uellix_owner from the bootstrap superuser.';
  END IF;

  -- The full inventory proves the exact named grantor, flags and cardinality
  -- before pg_has_role(..., 'SET') makes the final escalation check.
  WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
    VALUES
      ('uellix_migrator', 'uellix_owner', bootstrap_oid, false, true, false),
      ('uellix_app', 'uellix_writer', bootstrap_oid, true, false, false),
      ('postgres', 'uellix_writer', bootstrap_oid, true, false, false)
  ), actual AS (
    SELECT m.rolname AS member_name, r.rolname AS role_name, a.grantor AS grantor_oid,
           g.rolname AS grantor_name,
           a.inherit_option, a.set_option, a.admin_option
    FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    JOIN pg_roles g ON g.oid = a.grantor
    WHERE m.rolname IN ('uellix_app', 'uellix_writer', 'uellix_migrator')
       OR r.rolname IN ('uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator')
  )
  SELECT string_agg(a.member_name || '->' || a.role_name || ' granted-by=' || a.grantor_name || '(oid=' || a.grantor_oid || ')', ', ' ORDER BY a.member_name, a.role_name, a.grantor_oid)
    INTO problem
  FROM actual a
  WHERE NOT EXISTS (
    SELECT 1 FROM expected e
    WHERE e.member_name = a.member_name AND e.role_name = a.role_name
      AND e.grantor_oid = a.grantor_oid
      AND a.inherit_option IS NOT DISTINCT FROM e.inherit_option
      AND a.set_option IS NOT DISTINCT FROM e.set_option
      AND a.admin_option IS NOT DISTINCT FROM e.admin_option
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: unexpected relevant membership row (wrong grantor, membership flags or ADMIN escalation): %', problem;
  END IF;

  WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
    VALUES
      ('uellix_migrator', 'uellix_owner', bootstrap_oid, false, true, false),
      ('uellix_app', 'uellix_writer', bootstrap_oid, true, false, false),
      ('postgres', 'uellix_writer', bootstrap_oid, true, false, false)
  )
  SELECT string_agg(e.member_name || '->' || e.role_name, ', ' ORDER BY e.member_name, e.role_name)
    INTO problem
  FROM expected e
  WHERE (
    SELECT count(*) FROM pg_auth_members a
    JOIN pg_roles m ON m.oid = a.member
    JOIN pg_roles r ON r.oid = a.roleid
    WHERE m.rolname = e.member_name AND r.rolname = e.role_name
      AND a.grantor = e.grantor_oid
      AND a.inherit_option IS NOT DISTINCT FROM e.inherit_option
      AND a.set_option IS NOT DISTINCT FROM e.set_option
      AND a.admin_option IS NOT DISTINCT FROM e.admin_option
  ) <> 1;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: canonical membership tuple cardinality is not one: %', problem;
  END IF;

  IF pg_has_role(app_oid, owner_oid, 'SET') THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: uellix_app can SET ROLE uellix_owner.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE (oid = app_oid
             AND (NOT rolcanlogin OR rolinherit OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolsuper))
       OR (oid = writer_oid
             AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolsuper))
       OR (oid = owner_oid
             AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolsuper))
       OR (oid = migrator_oid
             AND (NOT rolcanlogin OR rolinherit OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolsuper))
  ) OR has_schema_privilege('uellix_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: governed role attributes or uellix_app schema CREATE privilege exceed the canonical 0001 contract.';
  END IF;
  IF NOT has_table_privilege('uellix_app', tbl_oid, 'SELECT')
     OR NOT has_table_privilege('uellix_app', tbl_oid, 'INSERT') THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: uellix_app does not receive SELECT+INSERT through uellix_writer.';
  END IF;
  IF has_table_privilege('uellix_app', tbl_oid, 'UPDATE')
     OR has_table_privilege('uellix_app', tbl_oid, 'DELETE')
     OR has_table_privilege('uellix_app', tbl_oid, 'TRUNCATE')
     OR has_table_privilege('uellix_app', tbl_oid, 'REFERENCES')
     OR has_table_privilege('uellix_app', tbl_oid, 'TRIGGER') THEN
    RAISE EXCEPTION 'stella_0003 FAILED verification: uellix_app has a non-append table privilege.';
  END IF;

  -- (19) NOT CHECKED AT RUNTIME, deliberately.
  --      An earlier revision raised here if public.evidence_chunks existed,
  --      meaning to assert "this script created no foreign object". That was
  --      WRONG and broke the convergence this file promises:
  --      db/prepared/grounding_0001_evidence_chunks.sql legitimately creates
  --      that table on the SAME database under its own gate (G5 P3). Once G5 P3
  --      is applied, every re-run of this script would abort the whole
  --      transaction with a misleading message.
  --      The real invariant — that THIS file never creates it — is static, not
  --      runtime: the EXECUTABLE sql never mentions evidence_chunks (it appears
  --      only in these comments), and tests/prepared-stella-sql.test.ts pins
  --      that, asserting its absence from the comment-stripped script. A
  --      runtime check cannot distinguish "I created it" from "another gate
  --      did", so it must not try.

  -- (20) NOT CHECKED AT RUNTIME either, for a different reason: it is
  --      unfalsifiable. defaclacl is aclitem[] — 'grantee=privs/grantor' — and
  --      never contains a table name, so searching it for
  --      'stella_suggestion_decisions' always returns 0. The previous form was
  --      a check that could never fire while reporting itself as verified.
  --      That this script issues no ALTER DEFAULT PRIVILEGES is, again, a
  --      static property enforced offline.

  RAISE NOTICE 'stella_0003: verification passed — owner=%, session path=uellix_migrator -> SET LOCAL ROLE uellix_owner, writer=uellix_writer direct SELECT+INSERT, runtime=uellix_app inherited-only, RLS on (FORCE off) with SELECT plus one transaction-bound INSERT policy, and append-only triggers intact.', tbl_owner;
END $$;
