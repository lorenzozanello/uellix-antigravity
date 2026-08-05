-- db/prepared/grounding_0004_rollback.sql
-- Rollback of db/prepared/grounding_0004_runtime_attestation.sql.
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- As in the sibling rollbacks the flags are recommended, not the barrier:
-- everything happens inside ONE `DO` block, where a RAISE EXCEPTION ends the
-- block and no later statement of that block runs — server semantics inside a
-- single statement, which no client can separate.
--
-- ============================================================================
-- THIS ROLLBACK RE-OPENS INT-CAP-002, AND SAYS SO
-- ============================================================================
-- Returning to the grounding_0003 end state means restoring the SELECT grant
-- and the policy role that grounding_0004 removed — `authenticated`, the
-- PostgREST principal. That is what "back to the previous state" MEANS here,
-- and pretending otherwise (leaving the narrower surface behind while claiming
-- a clean rollback) would make the next apply/rollback comparison read as
-- convergent when it was not.
--
-- The re-widening is announced as a WARNING rather than buried, so an operator
-- who rolls this package back learns what they just re-opened.
--
-- WHY IT ASKS NO PERMISSION
-- -------------------------
-- Nothing here destroys data. The three CHECK constraints, the attested reader
-- and the narrowed grant are all statements ABOUT rows, not rows. Every chunk
-- survives, and grounding_0003's own reader continues to serve them. A
-- confirmation prompt would train the habit that grounding_0002's rollback —
-- which does destroy an unregenerable chain of custody — depends on NOT being
-- a habit.
--
-- WHAT THIS ROLLBACK DOES NOT TOUCH
-- ---------------------------------
--   * public.evidence_chunks and every row in it.
--   * uellix_grounding.chunks_in_scope / insert_evidence_chunks /
--     finalize_document_ingestion — grounding_0003 owns them.
--   * schema uellix_grounding and role uellix_cap_grounding — grounding_0002
--     owns them, and grounding_0003 still has three functions there.

SET search_path = public;
SET lock_timeout = '5s';
SET client_min_messages = notice;

DO $$
DECLARE
  tbl_oid oid;
  n       int;
BEGIN
  tbl_oid := to_regclass('public.evidence_chunks');

  -- ------------------------------------------------------------------
  -- 1. The attested reader.
  --
  --    UNCONDITIONAL — not nested inside "if the table exists". That nesting
  --    is exactly the defect INT-CAP-004 (1) reports in
  --    grounding_0003_rollback: a database whose table went by another route
  --    got a successful-looking rollback and kept three callable SECURITY
  --    DEFINER functions. Dropping a function does not depend on a table.
  --
  --    Fixed literals through EXECUTE: no ||, no format(), no variable. The
  --    surrounding code decides WHETHER, never WHAT.
  -- ------------------------------------------------------------------
  EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)';

  -- The deprecation notice on the predecessor goes with the successor.
  IF to_regprocedure('uellix_grounding.chunks_in_scope(uuid, uuid, uuid)') IS NOT NULL THEN
    EXECUTE 'COMMENT ON FUNCTION uellix_grounding.chunks_in_scope(uuid, uuid, uuid) IS ''GR-001: canonical chunks of one version inside an exact (organization, project) scope. The scope is checked, not derived.''';
  END IF;

  IF tbl_oid IS NULL THEN
    RAISE NOTICE 'grounding_0004 rollback: public.evidence_chunks is absent — the attested reader was dropped and there is nothing else to undo.';
  ELSE
    -- ----------------------------------------------------------------
    -- 2. The three integrity constraints.
    -- ----------------------------------------------------------------
    EXECUTE 'ALTER TABLE public.evidence_chunks DROP CONSTRAINT IF EXISTS evidence_chunks_chunk_id_derivation_check';
    EXECUTE 'ALTER TABLE public.evidence_chunks DROP CONSTRAINT IF EXISTS evidence_chunks_span_length_check';
    EXECUTE 'ALTER TABLE public.evidence_chunks DROP CONSTRAINT IF EXISTS evidence_chunks_content_hash_derivation_check';

    -- ----------------------------------------------------------------
    -- 3. The read surface, back to grounding_0003's end state.
    --
    --    Re-created VERBATIM from grounding_0003 §6, including the comment
    --    reset: leaving grounding_0004's corrective COMMENT ON POLICY in place
    --    would describe a policy that no longer has the shape it describes.
    -- ----------------------------------------------------------------
    EXECUTE 'DROP POLICY IF EXISTS "evidence_chunks_select" ON public.evidence_chunks';
    EXECUTE 'CREATE POLICY "evidence_chunks_select" ON public.evidence_chunks FOR SELECT TO authenticated, uellix_app, uellix_auditor USING (organization_id = ANY(public.current_user_org_ids()) OR public.current_user_is_super_admin())';
    EXECUTE 'GRANT SELECT ON public.evidence_chunks TO authenticated';

    RAISE WARNING 'grounding_0004 rollback: SELECT on public.evidence_chunks has been RESTORED to authenticated and the policy names it again. INT-CAP-002 is re-opened: PostgREST can now read chunk rows around uellix_grounding.chunks_in_scope and around its canonical_chunk_id filter, so a suppressed duplicate is citable again.';
  END IF;

  -- ------------------------------------------------------------------
  -- 3b. The version table's read policy, back to grounding_0002 §6.
  --
  --     Guarded on ITS OWN table rather than on evidence_chunks: the two
  --     policies live on different tables owned by different packages, and
  --     nesting this inside the chunk branch would make restoring one depend
  --     on the existence of the other — which is the shape of the defect
  --     INT-CAP-004 (1) reports one file over.
  -- ------------------------------------------------------------------
  IF to_regclass('public.evidence_document_versions') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "evidence_document_versions_select" ON public.evidence_document_versions';
    EXECUTE 'CREATE POLICY "evidence_document_versions_select" ON public.evidence_document_versions FOR SELECT TO authenticated, uellix_app, uellix_auditor USING (organization_id = ANY(public.current_user_org_ids()) OR public.current_user_is_super_admin())';

    RAISE WARNING 'grounding_0004 rollback: uellix_cap_grounding is no longer named by a PERMISSIVE SELECT policy on either grounding table. That is grounding_0003''s end state and it is also the Train 4 finding: every SECURITY DEFINER read now returns the empty set, so chunks_in_scope answers nothing, finalize_document_ingestion always reports an incomplete ingestion, and register_document_version pins every document at ordinal 1.';
  END IF;

  IF tbl_oid IS NOT NULL THEN

    -- ----------------------------------------------------------------
    -- 4. Postconditions. Asserted rather than assumed: this is the last moment
    --    at which the transaction can still roll back.
    -- ----------------------------------------------------------------
    SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid;
    IF n <> 4 THEN
      RAISE EXCEPTION 'grounding_0004 rollback FAILED: public.evidence_chunks carries % RLS policies, not the 4 grounding_0003 leaves behind — refusing to report a clean rollback over a policy set this script did not produce.', n;
    END IF;

    SELECT count(*) INTO n FROM pg_constraint
    WHERE conrelid = tbl_oid AND contype = 'c'
      AND conname IN ('evidence_chunks_chunk_id_derivation_check',
                      'evidence_chunks_span_length_check',
                      'evidence_chunks_content_hash_derivation_check');
    IF n <> 0 THEN
      RAISE EXCEPTION 'grounding_0004 rollback FAILED: % of this package''s CHECK constraints survived the drop.', n;
    END IF;
  END IF;

  IF to_regprocedure('uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 rollback FAILED: the attested reader is still installed and still callable.';
  END IF;

  -- The predecessor must SURVIVE. Asserted rather than assumed: a DROP that
  -- named the wrong signature would take it, and grounding_0003's rollback
  -- would then find the read path already gone.
  IF tbl_oid IS NOT NULL
     AND to_regprocedure('uellix_grounding.chunks_in_scope(uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'grounding_0004 rollback FAILED: uellix_grounding.chunks_in_scope no longer exists. This rollback must never remove grounding_0003''s read path — aborting so the transaction rolls back.';
  END IF;

  RAISE NOTICE 'grounding_0004 rollback: complete. public.evidence_chunks, its rows, grounding_0003''s three functions, schema uellix_grounding and role uellix_cap_grounding are intentionally left in place.';
END $$;
