-- db/prepared/stella_0020_stella_interactions_model_default.sql
-- G1-B PRECONDITIONS — remove the provider model id the DATABASE was choosing.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0020_rollback.sql.
--
-- RUN AS `uellix_owner`, REACHED BY `SET ROLE` FROM `uellix_migrator`:
--   pnpm db:prepared:apply:local stella_0020_stella_interactions_model_default.sql
--
-- NOT YET APPLIED TO ANY HOSTED DATABASE. The hosted variant is generated and
-- authorised through the normal channel (pnpm hosted:generate / the operator
-- runbook); this file is the canon it is generated from.
--
-- ============================================================================
-- WHAT IS WRONG, EXACTLY
-- ============================================================================
-- db/migrations/0012_stella_interactions.sql created:
--
--     model_used varchar(100) DEFAULT 'gemini-2.0-flash' NOT NULL
--
-- `gemini-2.0-flash` was retired by Google and now returns 404 NOT_FOUND
-- (lib/stella/config.ts, MODEL HISTORY). The column default is therefore a
-- SECOND SOURCE OF TRUTH for Stella's model target which disagrees with the
-- only real one, `STELLA_DEFAULT_GEMINI_MODEL`.
--
-- ============================================================================
-- WHY THE DEFAULT IS DROPPED AND NOT RETARGETED
-- ============================================================================
-- `model_used` records WHICH MODEL ANSWERED. It is a MEASUREMENT, not a
-- configuration, and a column default is the database inventing a measurement
-- for a row whose writer did not supply one. Retargeting the literal to
-- `gemini-3.6-flash` would keep exactly that property and make it harder to
-- see, because the invented value would then look plausible.
--
-- ============================================================================
-- WHY THIS CHANGES NO BEHAVIOUR
-- ============================================================================
-- Since stella_0017 there is exactly ONE writer of public.stella_interactions:
-- `uellix_stella.settle_reserved_quota`, called by
-- `uellix_stella_ops.complete_operation_ticket`. INSERT was revoked from
-- uellix_writer and uellix_app (stella_0017 §339/§342), and RLS admits no other
-- role. That function:
--
--   * resolves `v_model := COALESCE(p_model_used, 'not-applicable')`, so it
--     never passes NULL, and
--   * names `model_used` explicitly in its INSERT column list, so the DEFAULT
--     clause is unreachable from it even if it did.
--
-- The default is therefore dead in the live system. §0.3 below PROVES that
-- claim against the catalog instead of asserting it, and aborts if a second
-- writer has appeared since this was written.
--
-- The column stays NOT NULL. Dropping the default without dropping the
-- constraint is the whole change: a writer that supplies no model now FAILS
-- (23502) instead of silently recording a retired model id.
--
-- ============================================================================
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It does not drop, rename or retype any column.
--   * It does not relax NOT NULL.
--   * It does not touch a single row.
--   * It does not change any grant, policy, trigger or role.
--   * It uses no CASCADE and no dynamic DDL built from a variable.
--
-- Idempotent AND convergent: a second application changes nothing.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions — abort before touching anything
-- ============================================================
DO $$
DECLARE
  v_writers text;
BEGIN
  -- 0.1 The applying identity.
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION
      'stella_0020 aborted: must be applied as uellix_owner (current_user = %). Reach it with SET ROLE uellix_owner from uellix_migrator.',
      current_user;
  END IF;

  -- 0.2 The target must exist.
  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION
      'stella_0020 aborted: table public.stella_interactions not found — this database is not at the expected baseline.';
  END IF;

  -- 0.3 THE DEAD-DEFAULT PROOF. The claim in the header is that no principal
  --     can reach the DEFAULT because none of them can INSERT. Measured, not
  --     assumed: if any role outside the governed capability holds INSERT, the
  --     default is NOT dead and dropping it would turn a silently-wrong row
  --     into a hard 23502 in a path nobody has reviewed. Abort and let a human
  --     look.
  SELECT string_agg(grantee, ', ' ORDER BY grantee) INTO v_writers
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name = 'stella_interactions'
    AND privilege_type = 'INSERT'
    AND grantee NOT IN ('uellix_owner', 'uellix_cap_stella_quota', 'postgres');

  IF v_writers IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_0020 aborted: unexpected INSERT grant on public.stella_interactions held by [%]. The ledger is written only through the governed ticket protocol (stella_0017); an extra writer means the column default is reachable and this change needs review, not application.',
      v_writers;
  END IF;
END $$;

-- ============================================================
-- 1. The change. One statement.
-- ============================================================
-- ALTER COLUMN ... DROP DEFAULT on a column that has no default is a no-op in
-- PostgreSQL, never an error — which is what makes this convergent.
ALTER TABLE public.stella_interactions
  ALTER COLUMN model_used DROP DEFAULT;

COMMENT ON COLUMN public.stella_interactions.model_used IS
  'The model that ANSWERED, as reported by the adapter. NOT NULL and with NO DEFAULT since prepared stella_0020: the database must never choose or invent Stella''s model. The only writer is uellix_stella.settle_reserved_quota, which resolves COALESCE(p_model_used, ''not-applicable'').';

-- ============================================================
-- 2. Postconditions — assert the end state
-- ============================================================
DO $$
DECLARE
  v_default text;
  v_notnull boolean;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid), a.attnotnull
    INTO v_default, v_notnull
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.stella_interactions'::regclass
    AND a.attname = 'model_used'
    AND NOT a.attisdropped;

  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0020 postcondition failed: model_used still has a default (%)', v_default;
  END IF;
  IF v_notnull IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'stella_0020 postcondition failed: model_used is no longer NOT NULL — the constraint must survive the default';
  END IF;

  RAISE NOTICE 'stella_0020: public.stella_interactions.model_used = NOT NULL, no default. OK.';
END $$;
