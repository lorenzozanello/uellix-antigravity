-- db/prepared/stella_0020_rollback.sql
-- Rollback of stella_0020_stella_interactions_model_default.sql.
--
-- RUN AS `uellix_owner`, REACHED BY `SET ROLE` FROM `uellix_migrator`.
--
-- ============================================================================
-- READ THIS BEFORE RUNNING IT
-- ============================================================================
-- This restores the state db/migrations/0012_stella_interactions.sql created:
-- `model_used varchar(100) DEFAULT 'gemini-2.0-flash' NOT NULL`.
--
-- `gemini-2.0-flash` IS A RETIRED MODEL. Google returns 404 NOT_FOUND for it
-- (lib/stella/config.ts, MODEL HISTORY). Restoring it is CORRECT for a rollback
-- — a rollback restores what was there, it does not improve on it — and it is
-- the reason this file must never be read as a model recommendation. It also
-- deliberately does NOT write `gemini-3.6-flash`: a rollback that installs a
-- value the forward package never removed is not a rollback, and the whole
-- point of stella_0020 is that the database does not choose Stella's model.
--
-- Idempotent AND convergent.
-- ============================================================================

SET search_path = public;

DO $$
BEGIN
  IF current_user <> 'uellix_owner' THEN
    RAISE EXCEPTION
      'stella_0020_rollback aborted: must be applied as uellix_owner (current_user = %).',
      current_user;
  END IF;
  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0020_rollback aborted: table public.stella_interactions not found.';
  END IF;
END $$;

ALTER TABLE public.stella_interactions
  ALTER COLUMN model_used SET DEFAULT 'gemini-2.0-flash';

COMMENT ON COLUMN public.stella_interactions.model_used IS NULL;

DO $$
DECLARE
  v_default text;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.stella_interactions'::regclass
    AND a.attname = 'model_used'
    AND NOT a.attisdropped;

  IF v_default IS NULL THEN
    RAISE EXCEPTION 'stella_0020_rollback postcondition failed: model_used has no default';
  END IF;
  RAISE NOTICE 'stella_0020_rollback: model_used default restored to %', v_default;
END $$;
