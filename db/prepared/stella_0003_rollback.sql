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
-- Policies and indexes fall with the table; the table-level GRANT disappears
-- with the table as well. No shared functions or extensions are involved.
--
-- RUN AS ONE TRANSACTION, like the forward script:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent: re-running is a no-op.

SET search_path = public;

DROP TABLE IF EXISTS public.stella_suggestion_decisions;
