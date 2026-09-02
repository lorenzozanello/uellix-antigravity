-- db/prepared/stella_0002_interactions_hardening.sql
-- WS3b (persistence & DB security): stella_interactions append-only hardening.
--
-- PREPARED ONLY — NOT A MIGRATION. This file lives in db/prepared/ (never in
-- db/migrations/, where drizzle-kit would apply it). Application to any
-- database is the external gate G2, executed manually by Lorenzo following
-- docs/ops/gates/G2_PACKAGE.md and the process in
-- docs/ops/SUPABASE_MIGRATION_GATE.md. Rollback: stella_0002_rollback.sql.
--
-- SOURCE OF TRUTH: the objects touched here are managed outside the drizzle
-- chain on purpose — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.
--
-- RUN AS ONE TRANSACTION:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Every statement below is idempotent AND convergent (re-running brings an
-- already-hardened database to the same end state), so a failed run can be
-- fixed and re-run without manual cleanup.
--
-- WHY THIS EXISTS (verified drift, 2026-07):
--   1. stella_interactions is documented append-only (db/policies/
--      002_stella_interactions_rls.sql) but db/migrations/0030_immutability.sql
--      attached the uellix_forbid_mutation() trigger only to audit_logs,
--      sroi_calculation_runs and sroi_calculation_line_items — NOT to
--      stella_interactions. The service-role Drizzle client bypasses RLS, so
--      without the trigger a buggy or compromised server path could UPDATE or
--      DELETE interaction rows.
--   2. db/migrations/0033_public_api_grants.sql line 50 GRANTs
--      SELECT, INSERT, UPDATE, DELETE on stella_interactions to authenticated
--      (the full-CRUD business-table block), contradicting the append-only
--      grant style of its own "Append-Only Tables" section (audit_logs et al).
--      RLS already denies UPDATE/DELETE (no policies), so this is defense in
--      depth, not an exploitable hole on its own — but the grant is wrong.
--   3. The stella_role CHECK was created by 0012 with 3 roles and widened by
--      0027 to the 6-role set. Depending on which migrations a given
--      environment actually received, the live CHECK may not match
--      db/schema.ts:635. The DO block below reconciles it idempotently.

-- Resolve every unqualified identifier in this script against public only.
-- Belt-and-braces: every object below is ALSO schema-qualified explicitly.
SET search_path = public;

-- ============================================================
-- 0. Precondition guards — fail explicitly, never silently
-- ============================================================
DO $$
BEGIN
  -- 0a. The shared trigger function must exist (db/migrations/0030_immutability.sql).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'uellix_forbid_mutation' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'stella_0002 aborted: function public.uellix_forbid_mutation() not found — apply db/migrations/0030_immutability.sql first (G2 precondition "migraciones base al día")';
  END IF;

  -- 0b. The target table must exist (db/migrations/0012). Without this guard
  --     the CREATE TRIGGER below would fail with a less actionable message.
  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0002 aborted: table public.stella_interactions not found — this database is not at the expected migration baseline (G2 precondition "migraciones base al día")';
  END IF;
END $$;

-- ============================================================
-- 1. Append-only trigger (mirrors 0030_immutability.sql style) — convergent
-- ============================================================
-- Unconditional DROP TRIGGER / CREATE TRIGGER requires the executing role to
-- own public.stella_interactions. This package runs as the raw local
-- administrative superuser (guard 0), which owns the table before
-- stella_0004 transfers ownership to uellix_owner. A later re-run of this
-- convergent script under that same identity, after that transfer, is no
-- longer the table owner, so unconditional trigger DDL would fail. Only
-- repair the trigger when it is absent or not in the exact canonical shape;
-- a re-run that finds it already canonical issues no owner-dependent DDL.
DO $$
DECLARE
  is_canonical boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.stella_interactions'::regclass
      AND NOT t.tgisinternal
      AND t.tgname = 'trg_stella_interactions_append_only'
      AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2   -- ROW, BEFORE
      AND (t.tgtype & 16) = 16 AND (t.tgtype & 8) = 8 -- UPDATE, DELETE
      AND (t.tgtype & 4) = 0                          -- never INSERT
      AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')
      AND t.tgenabled = 'O'
      AND t.tgnargs = 0                    -- no trigger-function arguments
      AND t.tgattr = ''::int2vector        -- no UPDATE OF column restriction
      AND t.tgqual IS NULL                 -- no WHEN condition
  ) INTO is_canonical;

  IF NOT is_canonical THEN
    DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON public.stella_interactions;
    CREATE TRIGGER trg_stella_interactions_append_only
      BEFORE UPDATE OR DELETE ON public.stella_interactions
      FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();

    COMMENT ON TRIGGER trg_stella_interactions_append_only ON public.stella_interactions IS
      'WS3b hardening (prepared stella_0002, gate G2): stella_interactions is an append-only AI audit trail; UPDATE/DELETE are forbidden even for the service role.';
  END IF;
END $$;

-- ============================================================
-- 2. Grant reconciliation (mirrors 0033 "Append-Only Tables"
--    section: SELECT + INSERT only for authenticated)
-- ============================================================
-- Note: even INSERT is never used by the browser client today (no INSERT RLS
-- policy exists; all writes go through the service-role Drizzle client), but
-- we match the documented append-only grant posture of audit_logs exactly.
-- REVOKE on an already-revoked privilege is a no-op, never an error.
REVOKE UPDATE, DELETE ON public.stella_interactions FROM authenticated;

-- ============================================================
-- 3. stella_role CHECK reconciliation — idempotent AND convergent
--    Target set = db/schema.ts:635 (6 roles, post-0027)
-- ============================================================
DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.stella_interactions'::regclass
    AND c.conname = 'stella_interactions_stella_role_check';

  -- Match the QUOTED literals (''advisor'' etc.) as they appear in
  -- pg_get_constraintdef output — a bare substring match would be fooled by a
  -- superstring role (e.g. a hypothetical 'super_advisor' would satisfy
  -- LIKE '%advisor%' without 'advisor' being in the set).
  IF current_def IS NULL
     OR current_def NOT LIKE '%''advisor''%'
     OR current_def NOT LIKE '%''validator''%'
     OR current_def NOT LIKE '%''composer''%'
     OR current_def NOT LIKE '%''proxy_reviewer''%'
     OR current_def NOT LIKE '%''evidence_reviewer''%'
     OR current_def NOT LIKE '%''audit_assistant''%'
  THEN
    IF current_def IS NOT NULL THEN
      ALTER TABLE public.stella_interactions
        DROP CONSTRAINT stella_interactions_stella_role_check;
    END IF;
    ALTER TABLE public.stella_interactions
      ADD CONSTRAINT stella_interactions_stella_role_check
      CHECK (stella_role IN ('advisor', 'validator', 'composer', 'proxy_reviewer', 'evidence_reviewer', 'audit_assistant'));
  END IF;
END $$;
