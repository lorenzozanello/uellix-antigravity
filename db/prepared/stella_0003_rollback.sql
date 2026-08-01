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

SET search_path = public;

DROP TABLE IF EXISTS public.stella_suggestion_decisions;
