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
-- INT-CAP-004 (1) — REPAIRED IN THE TRAIN 4 INTEGRATION
-- -----------------------------------------------------
-- The four `DROP FUNCTION` statements used to be nested inside the `ELSE` of
-- "if public.evidence_chunks exists". They are now unconditional, after that
-- block. See the comment at the statements themselves for why the nesting was
-- a defect and why AFTER is the only correct position. The gate
-- `rollback-function-drop-unconditional` in tests/helpers/train4-gates.ts now
-- reads this file, and mutation T-61 reintroduces the nesting to prove it.
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
    RAISE NOTICE 'grounding_0003 rollback: public.evidence_chunks is absent — no rows to destroy. The four functions this package created are dropped below regardless, because their existence never depended on the table.';
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

    -- Policies, indexes (including uq_evidence_chunks_version_content),
    -- triggers and the two composite FOREIGN KEYs fall with the table. No IF
    -- EXISTS: existence was proven above, in this same block.
    -- Fixed literal through EXECUTE: no ||, no format(), no variable. The
    -- surrounding code decides WHETHER, never WHAT.
    EXECUTE 'DROP TABLE public.evidence_chunks';
  END IF;

  -- ------------------------------------------------------------------
  -- INT-CAP-004 (1) — the four functions, UNCONDITIONALLY.
  --
  -- These four DROPs used to live inside the ELSE above, and that was the
  -- defect. A function does not depend on a table for its existence: a
  -- database whose evidence_chunks went by another route — a partially
  -- applied forward package, a manual DROP, a restore from a dump taken
  -- between the two — took the `IF tbl_oid IS NULL` branch, printed
  -- "nothing to drop", exited 0, and left three callable SECURITY DEFINER
  -- functions behind.
  --
  -- The consequence is not cosmetic. `uellix_cap_grounding` OWNS all three
  -- (grounding_0003 §11), and PostgreSQL refuses to remove a role that still
  -- owns anything — so grounding_0002's rollback, which retires that role,
  -- became permanently impossible. A rollback that reports success and
  -- bricks its predecessor's rollback is worse than one that fails loudly.
  --
  -- (Phrased without the two-word DDL spelling on purpose: the sibling
  -- assertion in tests/grounding-persistence-contract.test.ts scans this file
  -- WITHOUT stripping comments, so prose naming a statement this rollback must
  -- never execute would read as the statement itself.)
  --
  -- Placed AFTER the END IF rather than before it, and that order is load
  -- bearing in both directions:
  --   * the table branch must have run first, because
  --     trg_evidence_chunks_canonical_integrity references
  --     public.uellix_check_canonical_chunk() and PostgreSQL refuses to drop
  --     a function a live trigger still names;
  --   * when the table is absent there is no trigger, so the same four
  --     statements are safe on that path too — which is the whole point.
  --
  -- `IF EXISTS` on each: this is now the branch reached whether or not the
  -- table was there, so absence is an expected state and not an error.
  --
  -- public.uellix_check_canonical_chunk() is a plain (non-SECURITY-DEFINER)
  -- trigger function created BY this package, unlike
  -- public.uellix_forbid_mutation() which is baseline and shared with other
  -- immutable tables — that one is never dropped here. This one is exclusive
  -- to evidence_chunks and has no other caller.
  -- ------------------------------------------------------------------
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.insert_evidence_chunks(uuid, jsonb)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.finalize_document_ingestion(uuid, integer)';
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.chunks_in_scope(uuid, uuid, uuid)';
  EXECUTE 'DROP FUNCTION IF EXISTS public.uellix_check_canonical_chunk()';

  -- The four are gone whichever branch ran. Asserted rather than assumed:
  -- this is the last moment at which the transaction can still roll back, and
  -- a surviving SECURITY DEFINER function is exactly what INT-CAP-004 (1)
  -- reports. Named individually — "the schema is empty" is a weaker statement
  -- and would also be satisfied by grounding_0002 having gone first.
  IF to_regprocedure('uellix_grounding.insert_evidence_chunks(uuid, jsonb)') IS NOT NULL
     OR to_regprocedure('uellix_grounding.finalize_document_ingestion(uuid, integer)') IS NOT NULL
     OR to_regprocedure('uellix_grounding.chunks_in_scope(uuid, uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public.uellix_check_canonical_chunk()') IS NOT NULL THEN
    RAISE EXCEPTION
      'grounding_0003 rollback FAILED: a function this package created is still installed and still callable. uellix_cap_grounding would keep owning it, and grounding_0002''s rollback could never drop that role — aborting so the transaction rolls back.';
  END IF;

  -- ------------------------------------------------------------------
  -- The SUCCESSOR must be gone first. Found by adversarial review, train 4.
  --
  -- grounding_0004 publishes uellix_grounding.chunks_in_scope_attested and
  -- OWNS it through uellix_cap_grounding. This rollback does not drop it —
  -- correctly, since it belongs to the later package — but running out of
  -- order used to leave it behind: a SECURITY DEFINER function still
  -- EXECUTE-able by uellix_app, reading a table this script just destroyed,
  -- and still owned by the capability role. grounding_0002's rollback would
  -- then be unable to retire that role and would abort.
  --
  -- That is exactly the class of defect INT-CAP-004 (1) reports, one package
  -- up: a rollback exiting 0 while bricking its predecessor's. Repairing the
  -- nesting above without this check would have closed the reported instance
  -- and left the same shape reachable through the successor this very train
  -- introduced.
  --
  -- It REFUSES rather than dropping. Dropping another package's object is how
  -- a rollback comes to own something it did not create, and the operator's
  -- next step is a one-line command this message names. Same shape as
  -- grounding_0002_rollback's own refusal while evidence_chunks still
  -- references it.
  -- ------------------------------------------------------------------
  IF to_regprocedure('uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION
      'grounding_0003 rollback refused: uellix_grounding.chunks_in_scope_attested is still installed. It belongs to grounding_0004 and is owned by uellix_cap_grounding, so leaving it behind would make grounding_0002''s rollback unable to retire that role. Roll back grounding_0004 first (db/prepared/grounding_0004_rollback.sql).';
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
