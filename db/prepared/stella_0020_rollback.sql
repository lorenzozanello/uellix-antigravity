-- db/prepared/stella_0020_rollback.sql
-- Rollback of stella_0020_stella_interactions_model_default.sql.
--
-- SAME CHANNEL AS THE FORWARD PACKAGE. stella_0020 is a PRECHAIN ADMINISTRATIVE
-- UNIT registered in db/hosted/prechain-ownership.ts, and this file is pinned
-- there beside it. It is not derived, it is not generated, and there is no
-- hosted variant of it: the file below is the artefact, applied through the
-- administrative hosted session or through the local runner, exactly as the
-- forward package is.
--
--   psql "$UELLIX_STAGING_ADMIN_URL" -X -1 -v ON_ERROR_STOP=1 -f <this file>
--   pnpm db:prepared:apply:local stella_0020_rollback.sql
--
-- SAME IDENTITY CONTRACT AS THE FORWARD PACKAGE. `ALTER TABLE` requires
-- ownership of the relation, so §0 MEASURES pg_class.relowner and admits the
-- same two outcomes the forward package admits — the session already IS the
-- owner, or the table is owned by uellix_owner and the session can assume it —
-- and refuses everything else by name. An earlier revision demanded
-- `current_user = uellix_owner`, which named an owner instead of measuring one.
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
-- deliberately does NOT write the current model target: a rollback that
-- installs a value the forward package never removed is not a rollback, and the
-- whole point of stella_0020 is that the database does not choose Stella's
-- model.
--
-- Idempotent AND convergent.
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions and the measured identity decision
-- ============================================================
DO $$
DECLARE
  v_owner name;
BEGIN
  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION 'stella_0020_rollback aborted: table public.stella_interactions not found.';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c WHERE c.oid = 'public.stella_interactions'::regclass;

  PERFORM set_config('uellix.s0020r_owner_pre', v_owner, true);

  IF v_owner = current_user THEN
    PERFORM set_config('uellix.s0020r_assume_owner', 'no', true);

  ELSIF v_owner = 'uellix_owner'
        AND (pg_catalog.pg_has_role(current_user, 'uellix_owner', 'USAGE')
             OR pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET')) THEN
    PERFORM set_config('uellix.s0020r_assume_owner', 'yes', true);

  ELSE
    RAISE EXCEPTION
      'stella_0020_rollback aborted: public.stella_interactions is owned by % and this session (%) is neither that role nor able to assume it. ALTER TABLE requires ownership of the relation.',
      v_owner, current_user;
  END IF;
END $$;

-- ============================================================
-- 1. The reversal, under the identity PostgreSQL requires
-- ============================================================
DO $$
DECLARE
  v_decision text := NULLIF(current_setting('uellix.s0020r_assume_owner', true), '');
BEGIN
  IF v_decision IS NULL THEN
    RAISE EXCEPTION
      'stella_0020_rollback aborted: the identity decision from section 0 is not present in this transaction.';
  END IF;

  IF v_decision = 'yes' THEN
    SET LOCAL ROLE uellix_owner;
  ELSIF v_decision <> 'no' THEN
    RAISE EXCEPTION 'stella_0020_rollback aborted: unrecognised identity decision "%".', v_decision;
  END IF;

  ALTER TABLE public.stella_interactions
    ALTER COLUMN model_used SET DEFAULT 'gemini-2.0-flash';

  COMMENT ON COLUMN public.stella_interactions.model_used IS NULL;

  IF v_decision = 'yes' THEN
    RESET ROLE;
  END IF;
END $$;

-- ============================================================
-- 2. Postconditions
-- ============================================================
DO $$
DECLARE
  v_default   text;
  v_owner_pre text := NULLIF(current_setting('uellix.s0020r_owner_pre', true), '');
  v_owner_now text;
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION
      'stella_0020_rollback FAILED verification: the session is still acting as % rather than %.',
      current_user, session_user;
  END IF;

  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.stella_interactions'::regclass
    AND a.attname = 'model_used'
    AND NOT a.attisdropped;

  IF v_default IS NULL THEN
    RAISE EXCEPTION 'stella_0020_rollback postcondition failed: model_used has no default';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO v_owner_now
  FROM pg_class c WHERE c.oid = 'public.stella_interactions'::regclass;

  IF v_owner_pre IS NULL THEN
    RAISE EXCEPTION 'stella_0020_rollback postcondition failed: the owner measured before the reversal is not present in this transaction.';
  END IF;
  IF v_owner_now <> v_owner_pre THEN
    RAISE EXCEPTION
      'stella_0020_rollback postcondition failed: public.stella_interactions is now owned by % and was owned by % when this file started.',
      v_owner_now, v_owner_pre;
  END IF;

  RAISE NOTICE 'stella_0020_rollback: model_used default restored to %', v_default;
END $$;
