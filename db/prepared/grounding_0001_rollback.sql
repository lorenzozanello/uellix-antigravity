-- db/prepared/grounding_0001_rollback.sql
-- Clean teardown for grounding_0001_evidence_chunks.sql.
--
-- PREPARED ONLY — execution is part of the external gate G2
-- (docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md). evidence_chunks holds
-- DERIVED data only (regenerable from Storage + lib/grounding), so dropping it
-- loses no source-of-truth information — the hashed evidence files and their
-- audit trail are untouched.
--
-- Policies and indexes on evidence_chunks are dropped together with the table.
--
-- The pgvector extension is intentionally NOT dropped here: it is a shared,
-- instance-level capability and other tables may adopt it later. If a full
-- revert of the extension is ever wanted, it must be a separate, explicitly
-- approved statement after confirming (via pg_depend / \dx+) that no other
-- object uses the "vector" type.

-- RUN AS ONE TRANSACTION, like the forward script:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent: re-running is a no-op.

SET search_path = public;

DROP TABLE IF EXISTS public.evidence_chunks;
