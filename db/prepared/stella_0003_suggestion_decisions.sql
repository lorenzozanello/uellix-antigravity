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
-- RUN AS ONE TRANSACTION:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
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
-- This script has never been applied to any database, so hardening it now costs
-- nothing and leaves no environment to repair later.
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
  mismatched text;
BEGIN
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
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.stella_suggestion_decisions'::regclass
    AND conname = 'stella_suggestion_decisions_decision_check';

  IF def IS NULL
     OR def NOT LIKE '%''accepted''%'
     OR def NOT LIKE '%''accepted_edited''%'
     OR def NOT LIKE '%''rejected''%'
     OR def NOT LIKE '%''undone''%'
  THEN
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
  IF def IS NULL OR def NOT LIKE '%''^[0-9a-f]{64}$''%' THEN
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

-- The minimum the real architecture needs:
--
--   authenticated -> SELECT only. Reads are gated by the org-scoped RLS policy
--     in section 5. This is stricter than the append-only tables, which also
--     carry an (inert) INSERT grant.
--
--   anon -> nothing. Never reads or writes this table.
--
--   service_role -> nothing. The only writer is recordStellaDecision
--     (app/actions/stella/decisions.ts), which goes through the Drizzle client
--     in db/client.ts. That client connects with DATABASE_URL, i.e. as the
--     table's OWNER, whose access derives from ownership and not from any
--     grant. Granting service_role here would hand out privileges that nothing
--     in this system exercises. If a deployment ever routes writes through
--     PostgREST with a service_role JWT, that deployment must add the grant
--     deliberately, through its own gate — it must not be inherited by default.
GRANT SELECT ON public.stella_suggestion_decisions TO authenticated;

-- Assert the premise the paragraph above rests on, instead of trusting it.
--
-- Every other assumption in this script is guarded (FK targets, RLS helpers,
-- trigger function, column shape, PK, defaults, NOT NULLs). This one was not,
-- and it is the one that decides whether the application can write at all: the
-- writer's access comes from OWNING the table, so if this script were ever
-- applied by a role OTHER than the one the app connects as (e.g. via tooling
-- running as supabase_admin), the table would end up with no INSERT path and
-- the first write after STELLA_DECISIONS_PERSISTENCE_ENABLED is flipped would
-- fail with "permission denied".
--
-- Before the REVOKE ALL above, an inherited service_role grant would have
-- masked that mistake. It no longer can — so the check has to be explicit.
DO $$
DECLARE
  tbl_owner name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO tbl_owner
  FROM pg_class c WHERE c.oid = to_regclass('public.stella_suggestion_decisions');

  IF NOT has_table_privilege(current_user, 'public.stella_suggestion_decisions', 'INSERT') THEN
    RAISE EXCEPTION 'stella_0003 aborted: the current role (%) cannot INSERT into public.stella_suggestion_decisions (owner: %). recordStellaDecision writes through db/client.ts as the DATABASE_URL role — apply this script AS that role, or grant it INSERT explicitly through its own gate', current_user, tbl_owner;
  END IF;

  RAISE NOTICE 'stella_0003: write path verified — role % can INSERT (table owner: %). authenticated has SELECT only; anon and service_role have nothing.',
    current_user, tbl_owner;
END $$;

-- ============================================================
-- 5. RLS (mirrors db/policies/002_stella_interactions_rls.sql posture)
-- ============================================================
--   - SELECT: org members read their own org's decisions; super_admin sees all
--   - No INSERT policy: inserts are strictly server-side, via recordStellaDecision
--     over the Drizzle client. NOTE (corrected 2026-08-01): that client connects
--     as the table OWNER, and it is OWNERSHIP that bypasses RLS here — there is
--     no FORCE ROW LEVEL SECURITY on this table. It is NOT `service_role` doing
--     the bypassing: after section 4, service_role holds no privilege on this
--     table at all. The earlier wording claimed the opposite and would have led
--     a reader to believe the write path depended on a grant that does not exist.
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

-- No INSERT policy -> INSERT denied via RLS (service role only)
-- No UPDATE policy -> UPDATE denied (immutable decisions)
-- No DELETE policy -> DELETE denied (audit trail integrity)

-- ============================================================
-- 6. Append-only enforcement at the database level
-- ============================================================
-- RLS and grants both stop at the table OWNER, and the only writer here IS the
-- owner (db/client.ts connects with DATABASE_URL). Triggers are the one control
-- that fires for every role, owner included, so they are what actually makes
-- "decisions are immutable" true rather than merely intended.
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
