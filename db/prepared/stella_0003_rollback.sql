-- db/prepared/stella_0003_rollback.sql
-- Rollback for stella_0003_suggestion_decisions.sql (gate G2).
--
-- PREPARED ONLY — manual execution by Lorenzo, staging first, following
-- docs/ops/gates/G2_PACKAGE.md.
--
-- PRECONDITION: STELLA_DECISIONS_PERSISTENCE_ENABLED must be unset/false in
-- every environment pointing at this database BEFORE dropping the table,
-- otherwise recordStellaDecision inserts will start failing at runtime.
--
-- Dropping the table is destructive for the human-decision audit trail it
-- contains. Export the rows first if any were recorded:
--   -- SELECT * FROM stella_suggestion_decisions ORDER BY decided_at;
--
-- Policies, indexes and the two append-only triggers fall with the table; the
-- table-level GRANT disappears with the table as well. The shared trigger
-- function public.uellix_forbid_mutation() is NOT dropped: it is owned by
-- db/migrations/0030_immutability.sql and still guards audit_logs,
-- sroi_calculation_runs, sroi_calculation_line_items and stella_interactions.
--
-- SCOPE — what this rollback deliberately does NOT touch:
--   * It does not alter Supabase's global ALTER DEFAULT PRIVILEGES. Those are
--     out of scope for any single-table script and are deferred to their own
--     cross-cutting gate (docs/ops/STELLA_FABLE_RISK_REGISTER.md).
--   * It does not restore grants on any OTHER table. In particular it must
--     never undo db/prepared/stella_0002b_append_only_truncate_hardening.sql,
--     whose rollback is deliberately non-reversing.
--   * Because the table is dropped outright, there is no "restore the previous
--     privileges" question here: the privileges cease to exist with it. Should
--     this script ever be re-applied afterwards, section 4 does REVOKE ALL
--     before granting, so the table is recreated hardened rather than
--     inheriting the default-privilege surplus.
--
-- RUN AS ONE TRANSACTION, like the forward script:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent: re-running is a no-op.

-- ============================================================================
-- THE FOUR MEANINGS OF "ROLLBACK" HERE (added 2026-08-01)
-- ============================================================================
--   1. TECHNICAL ROLLBACK, BEFORE USE — the table exists but holds ZERO rows
--      (applied by mistake, or the gate aborted downstream). Nothing is lost.
--      This script runs unattended in that case.
--   2. DESTRUCTION WITH DATA — the table holds decisions. DROP TABLE ERASES a
--      human-decision audit trail, and no trigger can stop it: the two
--      append-only triggers forbid UPDATE/DELETE/TRUNCATE, but DROP TABLE
--      removes the table AND its triggers in one statement. This script
--      therefore ABORTS unless the operator explicitly authorises it.
--   3. EMERGENCY OPERATION — a legal erasure order or an incident requiring the
--      table gone despite its contents. Same authorisation as (2), plus an
--      export first, plus its own change record.
--   4. HUMAN RESPONSIBILITY — the authorisation below is not a formality. Who
--      set it, when, and why belongs in the gate record. The script can refuse
--      by default; it cannot decide that erasing an audit trail is acceptable.
--
-- AUTHORISING DESTRUCTION WITH DATA (case 2/3):
--     SET stella.confirm_destroy_decisions = 'true';
--   then run this file. Unset (the default) means "abort if there are rows".
--   Verify what you are about to destroy first:
--     SELECT count(*) FROM public.stella_suggestion_decisions;
--     -- and export: SELECT * FROM public.stella_suggestion_decisions ORDER BY decided_at;

SET search_path = public;

-- DROP TABLE takes ACCESS EXCLUSIVE. Bound the wait so this cannot stall other
-- sessions behind a long reader; the script is idempotent, so retrying is free.
SET lock_timeout = '5s';

DO $$
DECLARE
  n_rows          bigint;
  authorised      boolean;
BEGIN
  IF to_regclass('public.stella_suggestion_decisions') IS NULL THEN
    RAISE NOTICE 'stella_0003_rollback: public.stella_suggestion_decisions does not exist — nothing to do (idempotent no-op).';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.stella_suggestion_decisions' INTO n_rows;
  authorised := COALESCE(current_setting('stella.confirm_destroy_decisions', true), '') = 'true';

  RAISE NOTICE '--------------------------------------------------------------';
  RAISE NOTICE 'stella_0003_rollback: about to DROP public.stella_suggestion_decisions';
  RAISE NOTICE 'Rows currently stored: %', n_rows;
  RAISE NOTICE 'DROP TABLE erases this human-decision audit trail. The two';
  RAISE NOTICE 'append-only triggers forbid UPDATE/DELETE/TRUNCATE, but they';
  RAISE NOTICE 'cannot stop DROP TABLE — it removes the triggers along with the';
  RAISE NOTICE 'table. This is irreversible without a backup.';
  RAISE NOTICE '--------------------------------------------------------------';

  IF n_rows > 0 AND NOT authorised THEN
    RAISE EXCEPTION 'stella_0003_rollback aborted: the table holds % row(s) and destruction was NOT authorised. Export them first, then re-run with: SET stella.confirm_destroy_decisions = ''true''; Record who authorised it and why in the gate log', n_rows;
  END IF;

  IF n_rows > 0 THEN
    RAISE WARNING 'stella_0003_rollback: destroying % decision row(s) under explicit authorisation (stella.confirm_destroy_decisions=true).', n_rows;
  ELSE
    RAISE NOTICE 'stella_0003_rollback: table is empty — technical rollback before use, no audit data lost.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.stella_suggestion_decisions;
