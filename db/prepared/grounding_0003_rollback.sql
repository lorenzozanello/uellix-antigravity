-- db/prepared/grounding_0003_rollback.sql
-- Rollback of db/prepared/grounding_0003_evidence_chunks.sql (GR-001).
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- As in grounding_0002_rollback.sql the flags are recommended, not the barrier:
-- everything happens inside ONE `DO` block, where a RAISE EXCEPTION ends the
-- block and no later statement of that block runs — server semantics inside a
-- single statement, which no client can separate.
--
-- WHY THIS ONE ASKS NO PERMISSION, AND grounding_0002's DOES
-- ---------------------------------------------------------
-- public.evidence_chunks is a DERIVED index. Every row is reproducible from the
-- SHA-256-sealed file in Storage plus lib/grounding at the pipeline versions
-- each row records — that reproducibility is the whole claim of GR-001. So
-- dropping it costs a reindex, not evidence, and a confirmation prompt here
-- would train an operator to type the same confirmation at the prompt in
-- grounding_0002's rollback, where the history is NOT regenerable.
--
-- Refusing to acquire a habit is the point; the asymmetry is deliberate and the
-- row count is still reported so nothing happens silently.
--
-- WHAT THIS ROLLBACK DOES NOT TOUCH
-- ---------------------------------
--   * public.evidence_document_versions — grounding_0002 owns it.
--   * schema uellix_grounding and role uellix_cap_grounding — created by
--     grounding_0002, which drops them when its own rollback finds them empty.
--     Dropping them here would break a database that still has 0002 applied.
--   * public.evidence_items and the sealed files — untouched by construction.

SET search_path = public;
SET lock_timeout = '5s';
SET client_min_messages = notice;

DO $$
DECLARE
  tbl_oid   oid;
  n_rows    bigint;
  n_canon   bigint;
BEGIN
  tbl_oid := to_regclass('public.evidence_chunks');

  IF tbl_oid IS NULL THEN
    RAISE NOTICE 'grounding_0003 rollback: public.evidence_chunks is absent — nothing to drop.';
  ELSE
    -- Report what is being destroyed, and report it truthfully. FORCE ROW LEVEL
    -- SECURITY removes the owner's bypass, so an owner without rolbypassrls
    -- would count 0 over a populated table and this NOTICE would understate the
    -- reindex the operator is about to owe. The count is informational here,
    -- not an authorization input, so this warns instead of aborting.
    IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = tbl_oid) THEN
      RAISE WARNING 'grounding_0003 rollback: FORCE ROW LEVEL SECURITY is ON — the counts below are subject to RLS and may understate the table.';
    END IF;

    LOCK TABLE public.evidence_chunks IN ACCESS EXCLUSIVE MODE;
    SELECT count(*), count(*) FILTER (WHERE canonical_chunk_id IS NULL)
      INTO n_rows, n_canon
    FROM public.evidence_chunks;

    RAISE NOTICE 'grounding_0003 rollback: dropping % chunk row(s) (% canonical). All are regenerable from Storage via lib/grounding at the pipeline versions each row records.', n_rows, n_canon;

    -- Fixed literals through EXECUTE: no ||, no format(), no variable. The
    -- surrounding code decides WHETHER, never WHAT.
    EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.insert_evidence_chunks(uuid, jsonb)';
    EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.finalize_document_ingestion(uuid, integer)';
    EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.chunks_in_scope(uuid, uuid, uuid)';
    -- Policies, indexes (including uq_evidence_chunks_version_content) and
    -- triggers fall with the table. No IF EXISTS: existence was proven above,
    -- in this same block.
    EXECUTE 'DROP TABLE public.evidence_chunks';
  END IF;

  -- The version history must survive. Asserted rather than assumed: a CASCADE
  -- somebody added to the DROP above would take it, and this is the last moment
  -- at which the transaction can still be rolled back.
  IF to_regclass('public.evidence_document_versions') IS NULL
     AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_grounding') THEN
    RAISE EXCEPTION
      'grounding_0003 rollback FAILED: public.evidence_document_versions no longer exists. This rollback must never remove the chain of custody — aborting so the transaction rolls back.';
  END IF;

  RAISE NOTICE 'grounding_0003 rollback: complete. evidence_document_versions, schema uellix_grounding and role uellix_cap_grounding are intentionally left in place (grounding_0002 owns them).';
END $$;
