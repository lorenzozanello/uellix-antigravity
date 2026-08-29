-- db/prepared/stella_0002b_append_only_truncate_hardening.sql
-- WS3b follow-up: close the TRUNCATE hole in the append-only guarantee.
--
-- PREPARED ONLY — NOT A MIGRATION. This file lives in db/prepared/ (never in
-- db/migrations/, where drizzle-kit would apply it). Application to any
-- database is the external gate G2, executed manually by Lorenzo following
-- docs/ops/gates/G2_PACKAGE.md. Rollback: stella_0002b_rollback.sql — which is
-- deliberately NON-REVERSING (see that file).
--
-- SOURCE OF TRUTH: the objects touched here are managed outside the drizzle
-- chain on purpose — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.
--
-- RUN AS ONE TRANSACTION:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Every statement below is idempotent AND convergent.
--
-- ============================================================================
-- WHY THIS EXISTS (verified on a real PostgreSQL 17, 2026-08-01)
-- ============================================================================
-- The four append-only tables are protected by BEFORE UPDATE OR DELETE row
-- triggers (db/migrations/0030_immutability.sql + prepared stella_0002). A row
-- trigger does not fire on TRUNCATE, and RLS does not govern TRUNCATE either.
-- Empirically, with the privileges as shipped:
--
--     SET LOCAL ROLE authenticated;
--     TRUNCATE TABLE public.stella_interactions;   -- SUCCEEDED (1 row -> 0)
--
-- ROOT CAUSE — not a bug in any migration in this repo. Supabase configures
-- ALTER DEFAULT PRIVILEGES so that every table created by `postgres` in schema
-- `public` grants `Dxtm` to `authenticated`:
--
--     pg_default_acl (postgres -> public):  authenticated=Dxtm/postgres
--       D = TRUNCATE   x = REFERENCES   t = TRIGGER   m = MAINTAIN (PG17+)
--
-- db/migrations/0033_public_api_grants.sql then adds `ar` (SELECT, INSERT) on
-- top, which is why the live ACL reads `authenticated=arDxtm/postgres`. The
-- surplus was never granted deliberately; it was inherited. 36 of 37 tables in
-- `public` carry it. The single exception, `signup_allowlist`, is clean only
-- because 0033:69 does an explicit REVOKE ALL — which is the proof that
-- revoking is the right shape of fix.
--
-- SCOPE OF THIS SCRIPT: the four tables whose append-only guarantee is
-- DOCUMENTED and load-bearing. Repairing the global default privileges is a
-- broader change affecting all 37 tables and is deferred to its own gate — see
-- docs/ops/STELLA_FABLE_RISK_REGISTER.md.
--
-- ============================================================================
-- DEFENCE IN DEPTH — two independent layers, because one is not enough
-- ============================================================================
--   Layer 1 (grants): revoke TRUNCATE/REFERENCES/TRIGGER/MAINTAIN from
--     `authenticated`, and additionally UPDATE/DELETE from `service_role`.
--     This stops any role that is not the table owner.
--
--   Layer 2 (statement triggers): a BEFORE TRUNCATE ... FOR EACH STATEMENT
--     trigger on each table. Triggers fire for EVERY role including the table
--     owner, so this is the only layer that constrains `postgres` — which
--     matters here because db/client.ts connects with DATABASE_URL, and in this
--     deployment that role IS `postgres`, the owner of all four tables. A grant
--     model alone can never protect a table from its own owner.
--
-- Residual, and honestly stated: the owner can still DROP the trigger, run
-- ALTER TABLE ... DISABLE TRIGGER, or SET session_replication_role = 'replica'.
-- Those are deliberate administrative acts, not the ordinary application bug
-- this script defends against. Closing that gap requires not running the
-- application as the table owner, which is a deployment change, not a DDL one.

-- Same explicit search_path as every other script in db/prepared/. Note that
-- pg_catalog is implicitly searched FIRST unless it is named elsewhere in the
-- list, so `public` alone already resists catalog shadowing; every identifier
-- below is ALSO schema-qualified explicitly.
SET search_path = public;

-- Every DROP/CREATE TRIGGER below takes ACCESS EXCLUSIVE on its table and holds
-- it until COMMIT. The work itself is pure catalogue (microseconds), but
-- ACQUIRING the lock can queue behind a long-running reader — and audit_logs is
-- written on essentially every request (logAuditAction). Without a timeout, this
-- script would then block ALL traffic to that table for as long as the reader
-- runs. With one, the failure mode degrades from "site stalls" to "script aborts,
-- retry later" — and since the whole script is convergent, retrying is free.
SET lock_timeout = '5s';

-- ============================================================
-- 0. Precondition guards — fail explicitly, never silently
-- ============================================================
DO $$
DECLARE
  missing_tables   text;
  missing_triggers text;
  missing_roles    text;
BEGIN
  -- 0-pre. The grantee roles must exist. Without this, the REVOKEs below fail
  --        with a bare 'role "authenticated" does not exist' — actionable, but
  --        this is the only precondition the script would otherwise not state.
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing_roles
  FROM (VALUES ('authenticated'), ('service_role')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0002b aborted: missing role(s): %. This database was not bootstrapped by Supabase; the grant model this script reconciles does not apply', missing_roles;
  END IF;

  -- 0a. The shared trigger function must exist (db/migrations/0030_immutability.sql).
  IF to_regprocedure('public.uellix_forbid_mutation()') IS NULL THEN
    RAISE EXCEPTION 'stella_0002b aborted: function public.uellix_forbid_mutation() not found — apply db/migrations/0030_immutability.sql first (G2 precondition "migraciones base al día")';
  END IF;

  -- 0b. All four target tables must exist.
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing_tables
  FROM (VALUES
    ('stella_interactions'),
    ('audit_logs'),
    ('sroi_calculation_runs'),
    ('sroi_calculation_line_items')
  ) AS t(name)
  WHERE to_regclass('public.' || t.name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0002b aborted: missing target table(s): %. This database is not at the expected migration baseline (G2 precondition "migraciones base al día")', missing_tables;
  END IF;

  -- 0c. Each table must already carry its BEFORE UPDATE OR DELETE row trigger.
  --     This script HARDENS an existing append-only posture; it does not
  --     establish one. Running it on a table with no row-level protection would
  --     produce a table that rejects TRUNCATE but happily accepts UPDATE — a
  --     misleading half-guarantee. For stella_interactions this doubles as the
  --     "stella_0002 has been applied" check.
  SELECT string_agg(t.expected || ' on ' || t.tbl, ', ' ORDER BY t.tbl) INTO missing_triggers
  FROM (VALUES
    ('stella_interactions',         'trg_stella_interactions_append_only'),
    ('audit_logs',                  'trg_audit_logs_append_only'),
    ('sroi_calculation_runs',       'trg_sroi_runs_append_only'),
    ('sroi_calculation_line_items', 'trg_sroi_line_items_append_only')
  ) AS t(tbl, expected)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger g
    WHERE g.tgname = t.expected
      AND g.tgrelid = to_regclass('public.' || t.tbl)
      AND NOT g.tgisinternal
      AND (g.tgtype & 16) = 16   -- fires on UPDATE
      AND (g.tgtype & 8)  = 8    -- fires on DELETE
  );

  IF missing_triggers IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0002b aborted: missing UPDATE/DELETE append-only trigger(s): %. Apply db/migrations/0030_immutability.sql and prepared stella_0002 first', missing_triggers;
  END IF;
END $$;

-- ============================================================
-- 1. Grant reconciliation — `authenticated`
-- ============================================================
-- Removes the inherited default-privilege surplus. SELECT and INSERT are NOT
-- touched: they are the documented append-only posture (0033:60-62) and are
-- what RLS gates. REVOKE of a privilege the role does not hold is a no-op,
-- never an error — which is what makes this repeatable.
--
-- REFERENCES and TRIGGER are revoked as least-privilege hygiene rather than as
-- an exploit fix: `authenticated` holds no CREATE on any schema and cannot own
-- these tables, so it can neither add a foreign key nor drop the protection.
-- They are simply privileges nothing in this system needs.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON
  public.stella_interactions,
  public.audit_logs,
  public.sroi_calculation_runs,
  public.sroi_calculation_line_items
FROM authenticated;

-- ============================================================
-- 2. Grant reconciliation — `service_role`
-- ============================================================
-- service_role carries rolbypassrls, so RLS is not a control for it: grants and
-- triggers are. Nothing in the codebase issues UPDATE, DELETE or TRUNCATE
-- against these four tables (verified: INSERT-only, in app/actions/stella/* and
-- lib/pipeline/*), so revoking costs no functionality and removes the blast
-- radius of an application bug reaching an audit trail.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.stella_interactions,
  public.audit_logs,
  public.sroi_calculation_runs,
  public.sroi_calculation_line_items
FROM service_role;

-- ============================================================
-- 3. MAINTAIN — version-aware (PostgreSQL 17+ only)
-- ============================================================
-- MAINTAIN was introduced in PostgreSQL 17. On an older server the token is a
-- SYNTAX error, and a syntax error cannot be avoided by an IF guard around a
-- statically-parsed statement. EXECUTE defers parsing to run time, so the
-- statement is never parsed on a server that would reject it.
--
-- The string passed to EXECUTE is a fixed literal: no concatenation, no
-- identifier or value derived from data, catalogs, or user input. There is
-- nothing here to inject into. It is dynamic only in WHEN it is parsed.
--
-- It is deliberately written as ONE long single-quoted literal on ONE line.
-- Splitting it across lines would rely on SQL's implicit concatenation of
-- adjacent string constants, which is only valid when a NEWLINE separates them:
-- any reformatting that joined those lines would silently turn the statement
-- into a syntax error. One literal has no such trap.
--
-- Why revoke it at all: MAINTAIN confers VACUUM / ANALYZE / REINDEX / CLUSTER /
-- REFRESH MATERIALIZED VIEW / LOCK TABLE. LOCK TABLE in particular lets a role
-- stall writers to an audit table — a denial-of-service vector, not a data one.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON public.stella_interactions, public.audit_logs, public.sroi_calculation_runs, public.sroi_calculation_line_items FROM authenticated, service_role';
  ELSE
    RAISE NOTICE 'stella_0002b: server is pre-17 (%), MAINTAIN does not exist — skipping that REVOKE by design',
      current_setting('server_version');
  END IF;
END $$;

-- ============================================================
-- 4. Statement-level TRUNCATE triggers — the owner-proof layer, convergent
-- ============================================================
-- TRUNCATE triggers MUST be FOR EACH STATEMENT (PostgreSQL forbids FOR EACH ROW
-- on TRUNCATE — there are no per-row OLD/NEW records to hand to it), so the
-- canonical predicate below requires tgtype's ROW bit to be UNSET.
--
-- public.uellix_forbid_mutation() is reused unchanged: it reads only TG_OP and
-- TG_TABLE_NAME, both populated for statement-level triggers, and raises
-- unconditionally with SQLSTATE 42501. Its return value is irrelevant because it
-- never returns. So the same function yields
-- "append-only: TRUNCATE on <table> is not permitted".
--
-- Unconditional DROP TRIGGER / CREATE TRIGGER requires the executing role to
-- own the target table. This package runs as the raw local administrative
-- superuser (guard 0-pre), which owns all four tables before stella_0004
-- transfers stella_interactions' ownership to uellix_owner. A later re-run of
-- this convergent script under that same identity, after that transfer, is no
-- longer the owner of stella_interactions, so unconditional trigger DDL on
-- that one table would fail. Reconcile each trigger independently and only
-- when it is absent or not in the exact canonical shape, so a re-run that
-- finds all four already canonical issues no owner-dependent DDL on any of
-- them.

DO $$
DECLARE
  is_canonical boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.stella_interactions'::regclass
      AND NOT t.tgisinternal
      AND t.tgname = 'trg_stella_interactions_no_truncate'
      AND (t.tgtype & 1) = 0 AND (t.tgtype & 2) = 2   -- STATEMENT, BEFORE
      AND (t.tgtype & 32) = 32                        -- TRUNCATE
      AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')
      AND t.tgenabled = 'O'
  ) INTO is_canonical;

  IF NOT is_canonical THEN
    DROP TRIGGER IF EXISTS trg_stella_interactions_no_truncate ON public.stella_interactions;
    CREATE TRIGGER trg_stella_interactions_no_truncate
      BEFORE TRUNCATE ON public.stella_interactions
      FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();

    COMMENT ON TRIGGER trg_stella_interactions_no_truncate ON public.stella_interactions IS
      'WS3b hardening (prepared stella_0002b, gate G2): TRUNCATE is forbidden on this append-only AI audit trail, including for the table owner.';
  END IF;
END $$;

DO $$
DECLARE
  is_canonical boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.audit_logs'::regclass
      AND NOT t.tgisinternal
      AND t.tgname = 'trg_audit_logs_no_truncate'
      AND (t.tgtype & 1) = 0 AND (t.tgtype & 2) = 2
      AND (t.tgtype & 32) = 32
      AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')
      AND t.tgenabled = 'O'
  ) INTO is_canonical;

  IF NOT is_canonical THEN
    DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON public.audit_logs;
    CREATE TRIGGER trg_audit_logs_no_truncate
      BEFORE TRUNCATE ON public.audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();

    COMMENT ON TRIGGER trg_audit_logs_no_truncate ON public.audit_logs IS
      'WS3b hardening (prepared stella_0002b, gate G2): TRUNCATE is forbidden on this append-only audit log, including for the table owner.';
  END IF;
END $$;

DO $$
DECLARE
  is_canonical boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.sroi_calculation_runs'::regclass
      AND NOT t.tgisinternal
      AND t.tgname = 'trg_sroi_calculation_runs_no_truncate'
      AND (t.tgtype & 1) = 0 AND (t.tgtype & 2) = 2
      AND (t.tgtype & 32) = 32
      AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')
      AND t.tgenabled = 'O'
  ) INTO is_canonical;

  IF NOT is_canonical THEN
    DROP TRIGGER IF EXISTS trg_sroi_calculation_runs_no_truncate ON public.sroi_calculation_runs;
    CREATE TRIGGER trg_sroi_calculation_runs_no_truncate
      BEFORE TRUNCATE ON public.sroi_calculation_runs
      FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();

    COMMENT ON TRIGGER trg_sroi_calculation_runs_no_truncate ON public.sroi_calculation_runs IS
      'WS3b hardening (prepared stella_0002b, gate G2): TRUNCATE is forbidden on these immutable calculation runs, including for the table owner.';
  END IF;
END $$;

DO $$
DECLARE
  is_canonical boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.sroi_calculation_line_items'::regclass
      AND NOT t.tgisinternal
      AND t.tgname = 'trg_sroi_calculation_line_items_no_truncate'
      AND (t.tgtype & 1) = 0 AND (t.tgtype & 2) = 2
      AND (t.tgtype & 32) = 32
      AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')
      AND t.tgenabled = 'O'
  ) INTO is_canonical;

  IF NOT is_canonical THEN
    DROP TRIGGER IF EXISTS trg_sroi_calculation_line_items_no_truncate ON public.sroi_calculation_line_items;
    CREATE TRIGGER trg_sroi_calculation_line_items_no_truncate
      BEFORE TRUNCATE ON public.sroi_calculation_line_items
      FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();

    COMMENT ON TRIGGER trg_sroi_calculation_line_items_no_truncate ON public.sroi_calculation_line_items IS
      'WS3b hardening (prepared stella_0002b, gate G2): TRUNCATE is forbidden on these immutable calculation line items, including for the table owner.';
  END IF;
END $$;

-- ============================================================
-- 5. Self-verification — assert the end state, inside this transaction
-- ============================================================
-- The whole lesson of RK-04b is that a privilege was present where nobody
-- expected it. A REVOKE only removes grants made by the CURRENT grantor; a grant
-- from another grantor, or one reaching the role via membership, survives it —
-- and PostgreSQL merely emits a WARNING, never an error, when there is nothing
-- to revoke. So the script must not trust that "I ran REVOKE" means "the
-- privilege is gone": it must look.
--
-- Running inside the same transaction is what makes this worth doing — a failure
-- here rolls back the whole script rather than leaving a half-hardened database
-- that reported success.
DO $$
DECLARE
  residual text;
  missing  text;
BEGIN
  SELECT string_agg(x.role_name || ':' || x.priv || ' on ' || x.tbl, ', '
                    ORDER BY x.tbl, x.role_name, x.priv) INTO residual
  FROM (
    SELECT r.role_name, t.tbl, p.priv
    FROM (VALUES ('authenticated'), ('service_role')) AS r(role_name),
         (VALUES ('stella_interactions'), ('audit_logs'),
                 ('sroi_calculation_runs'), ('sroi_calculation_line_items')) AS t(tbl),
         (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
    WHERE has_table_privilege(r.role_name, to_regclass('public.' || t.tbl), p.priv)
    UNION ALL
    SELECT 'service_role', t.tbl, p.priv
    FROM (VALUES ('stella_interactions'), ('audit_logs'),
                 ('sroi_calculation_runs'), ('sroi_calculation_line_items')) AS t(tbl),
         (VALUES ('UPDATE'), ('DELETE')) AS p(priv)
    WHERE has_table_privilege('service_role', to_regclass('public.' || t.tbl), p.priv)
  ) AS x;

  IF residual IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0002b FAILED verification: privileges still present after REVOKE: %. A REVOKE only removes grants from the current grantor — investigate other grantors or role membership before retrying', residual;
  END IF;

  -- The four TRUNCATE triggers must be attached and actually fire on TRUNCATE.
  SELECT string_agg(t.expected || ' on ' || t.tbl, ', ' ORDER BY t.tbl) INTO missing
  FROM (VALUES
    ('stella_interactions',         'trg_stella_interactions_no_truncate'),
    ('audit_logs',                  'trg_audit_logs_no_truncate'),
    ('sroi_calculation_runs',       'trg_sroi_calculation_runs_no_truncate'),
    ('sroi_calculation_line_items', 'trg_sroi_calculation_line_items_no_truncate')
  ) AS t(tbl, expected)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger g
    WHERE g.tgname = t.expected
      AND g.tgrelid = to_regclass('public.' || t.tbl)
      AND NOT g.tgisinternal
      AND (g.tgtype & 32) = 32   -- fires on TRUNCATE
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0002b FAILED verification: TRUNCATE trigger(s) not attached: %', missing;
  END IF;

  -- SELECT/INSERT must have SURVIVED: over-revoking would silently break reads.
  SELECT string_agg(t.tbl || ':' || p.priv, ', ' ORDER BY t.tbl, p.priv) INTO missing
  FROM (VALUES ('stella_interactions'), ('audit_logs'),
               ('sroi_calculation_runs'), ('sroi_calculation_line_items')) AS t(tbl),
       (VALUES ('SELECT'), ('INSERT')) AS p(priv)
  WHERE NOT has_table_privilege('authenticated', to_regclass('public.' || t.tbl), p.priv);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0002b FAILED verification: authenticated LOST expected privilege(s): %. The append-only posture is SELECT+INSERT, not read-only', missing;
  END IF;

  RAISE NOTICE 'stella_0002b: verification passed — 4 TRUNCATE triggers attached, 0 residual dangerous grants, SELECT/INSERT preserved.';
END $$;
