-- db/prepared/stella_0002b_rollback.sql
-- Rollback for stella_0002b_append_only_truncate_hardening.sql (gate G2).
--
-- POLICY: SAFE_NON_REVERSING_ROLLBACK
--
-- PREPARED ONLY — manual execution by Lorenzo, staging first, following
-- docs/ops/gates/G2_PACKAGE.md.
--
-- RUN AS ONE TRANSACTION, like the forward script:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent. Changes NOTHING: no DDL, no DML, no grants. It verifies and
-- explains.
--
-- ============================================================================
-- WHY THIS ROLLBACK DOES NOT ROLL ANYTHING BACK
-- ============================================================================
-- A rollback exists to undo a change that might have broken something. This
-- change cannot break anything, because it removed only capabilities that
-- nothing exercises:
--
--   * No code path in this repository issues UPDATE, DELETE or TRUNCATE against
--     the four append-only tables. They are INSERT-only (app/actions/stella/*,
--     lib/pipeline/*). Verified before stella_0002b was written.
--   * `authenticated` is NOLOGIN and reaches the database only through
--     PostgREST, which exposes no TRUNCATE verb at all.
--   * REFERENCES is unused: all 147 foreign keys are created by migrations
--     running as `postgres`, never at run time.
--   * MAINTAIN confers maintenance verbs the application never issues.
--
-- So there is no functional regression to recover from — which means the only
-- thing a reversing rollback could achieve is to reopen the hole.
--
-- Restoring the previous privileges would directly contradict the audit-ready
-- guarantee these tables carry. `stella_interactions` is the AI audit trail;
-- `audit_logs` is the audit log; the SROI runs and line items are the immutable
-- evidence behind published social-value figures. The privacy policy states
-- these records cannot be edited or deleted retroactively. A grant that permits
-- TRUNCATE makes that statement false in one round trip, with no row-level
-- trace left behind — TRUNCATE fires no row triggers and writes no per-row
-- audit. An audit trail that can be erased wholesale is not an audit trail; it
-- is a cache.
--
-- Note the difference from stella_0002_rollback.sql, which DOES re-grant
-- UPDATE/DELETE and labels itself "BUG-COMPATIBLE". That one restores a state
-- the codebase actually shipped with, so it can be used to bisect an incident.
-- Here there is no prior shipped behaviour to restore: the surplus privileges
-- were never granted deliberately — they were inherited from Supabase's
-- ALTER DEFAULT PRIVILEGES. Reverting would not restore an intended design; it
-- would restore an accident.
--
-- ============================================================================
-- THE FOUR MEANINGS OF "ROLLBACK" HERE
-- ============================================================================
--   1. TECHNICAL ROLLBACK (undo the DDL/grants) .... NOT PROVIDED. It would
--      reopen a MAJOR finding with no compensating benefit.
--   2. BUG-COMPATIBLE RESTORE (recreate the pre-0002b ACL to bisect an
--      incident) ................................... NOT PROVIDED as a script.
--      Requires a deliberate, logged DBA action — see below.
--   3. SAFE RESTORE (leave the hardening in place, fix forward) ... THIS FILE.
--   4. EMERGENCY OPERATION (a genuine need to bulk-remove rows, e.g. a legal
--      erasure order) ............................. Out of scope for a rollback
--      script. It needs its own change record, its own approval, and an export
--      of the affected rows beforehand.
--
-- If case 2 or 4 is genuinely required, a DBA with ownership must do it
-- explicitly and leave a trace — deliberately NOT scripted here, so that
-- reopening an audit guarantee can never be a copy-paste:
--
--   -- Requires table ownership. Record who, when and why before running.
--   -- DROP TRIGGER trg_stella_interactions_no_truncate ON public.stella_interactions;
--   -- GRANT TRUNCATE ON public.stella_interactions TO authenticated;
--
-- ============================================================================
-- WHAT THIS FILE DOES: verify the hardening is still intact, and say so.
-- ============================================================================

SET search_path = public;

DO $$
DECLARE
  missing_truncate_trg text;
  missing_row_trg      text;
  residual_grants      text;
BEGIN
  -- 1. TRUNCATE statement triggers still attached?
  SELECT string_agg(t.expected || ' on ' || t.tbl, ', ' ORDER BY t.tbl) INTO missing_truncate_trg
  FROM (VALUES
    ('stella_interactions',         'trg_stella_interactions_no_truncate'),
    ('audit_logs',                  'trg_audit_logs_no_truncate'),
    ('sroi_calculation_runs',       'trg_sroi_calculation_runs_no_truncate'),
    ('sroi_calculation_line_items', 'trg_sroi_calculation_line_items_no_truncate')
  ) AS t(tbl, expected)
  WHERE to_regclass('public.' || t.tbl) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_trigger g
      WHERE g.tgname = t.expected
        AND g.tgrelid = to_regclass('public.' || t.tbl)
        AND NOT g.tgisinternal
        AND (g.tgtype & 32) = 32   -- fires on TRUNCATE
    );

  -- 2. Row-level UPDATE/DELETE triggers still attached? (from 0030 / stella_0002)
  SELECT string_agg(t.expected || ' on ' || t.tbl, ', ' ORDER BY t.tbl) INTO missing_row_trg
  FROM (VALUES
    ('stella_interactions',         'trg_stella_interactions_append_only'),
    ('audit_logs',                  'trg_audit_logs_append_only'),
    ('sroi_calculation_runs',       'trg_sroi_runs_append_only'),
    ('sroi_calculation_line_items', 'trg_sroi_line_items_append_only')
  ) AS t(tbl, expected)
  WHERE to_regclass('public.' || t.tbl) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_trigger g
      WHERE g.tgname = t.expected
        AND g.tgrelid = to_regclass('public.' || t.tbl)
        AND NOT g.tgisinternal
    );

  -- 3. Any dangerous privilege that came back?
  SELECT string_agg(x.role_name || ':' || x.priv || ' on ' || x.tbl, ', '
                    ORDER BY x.tbl, x.role_name, x.priv) INTO residual_grants
  FROM (
    SELECT r.role_name, t.tbl, p.priv
    FROM (VALUES ('authenticated'), ('service_role')) AS r(role_name),
         (VALUES ('stella_interactions'), ('audit_logs'),
                 ('sroi_calculation_runs'), ('sroi_calculation_line_items')) AS t(tbl),
         (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
    WHERE to_regclass('public.' || t.tbl) IS NOT NULL
      AND has_table_privilege(r.role_name, to_regclass('public.' || t.tbl), p.priv)
    UNION ALL
    SELECT 'service_role', t.tbl, p.priv
    FROM (VALUES ('stella_interactions'), ('audit_logs'),
                 ('sroi_calculation_runs'), ('sroi_calculation_line_items')) AS t(tbl),
         (VALUES ('UPDATE'), ('DELETE')) AS p(priv)
    WHERE to_regclass('public.' || t.tbl) IS NOT NULL
      AND has_table_privilege('service_role', to_regclass('public.' || t.tbl), p.priv)
  ) AS x;

  RAISE NOTICE '--------------------------------------------------------------';
  RAISE NOTICE 'stella_0002b_rollback: SAFE_NON_REVERSING_ROLLBACK';
  RAISE NOTICE 'This script intentionally changes nothing. The append-only';
  RAISE NOTICE 'hardening is not automatically reversible: restoring TRUNCATE';
  RAISE NOTICE 'on an audit-ready table would contradict the guarantee it';
  RAISE NOTICE 'carries. See the header of this file for the four meanings of';
  RAISE NOTICE '"rollback" and the explicit DBA path for the rare real cases.';
  RAISE NOTICE '--------------------------------------------------------------';

  IF missing_truncate_trg IS NULL THEN
    RAISE NOTICE 'OK  TRUNCATE protection: all 4 statement triggers present.';
  ELSE
    RAISE WARNING 'GAP TRUNCATE protection MISSING: %. The hardening is not fully in place — re-apply stella_0002b_append_only_truncate_hardening.sql (it is convergent).', missing_truncate_trg;
  END IF;

  IF missing_row_trg IS NULL THEN
    RAISE NOTICE 'OK  UPDATE/DELETE protection: all 4 row triggers present.';
  ELSE
    RAISE WARNING 'GAP UPDATE/DELETE protection MISSING: %. Apply db/migrations/0030_immutability.sql and prepared stella_0002.', missing_row_trg;
  END IF;

  IF residual_grants IS NULL THEN
    RAISE NOTICE 'OK  Grants: no TRUNCATE/REFERENCES/TRIGGER for authenticated or service_role, and no UPDATE/DELETE for service_role.';
  ELSE
    RAISE WARNING 'GAP Dangerous grants present again: %. Re-apply stella_0002b_append_only_truncate_hardening.sql.', residual_grants;
  END IF;

  RAISE NOTICE 'No changes were made by this script.';

  -- Fail the process, not just the log. A gate that trusts the exit code must
  -- not see green while this script has just reported that the protection is
  -- gone. Nothing has been modified, so raising costs nothing — and `psql
  -- -v ON_ERROR_STOP=1` turns "the hardening vanished" into a non-zero exit
  -- instead of a WARNING somebody has to notice by reading.
  IF missing_truncate_trg IS NOT NULL OR missing_row_trg IS NOT NULL OR residual_grants IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0002b_rollback: append-only hardening is NOT intact (see the warnings above). Nothing was changed. Re-apply stella_0002b_append_only_truncate_hardening.sql — it is convergent';
  END IF;
END $$;
