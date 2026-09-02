-- db/prepared/grounding_0005_claim_advisory_lock.sql
-- M-8 — the row lock `claim_active_document_version` cannot take.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it.
--
-- FORWARD-ONLY. There is NO grounding_0005_rollback.sql, and its absence is a
-- decision rather than an omission — see "WHY THERE IS NO ROLLBACK" below.
--
-- DEPENDS ON: grounding_0002 applied first. It does not touch grounding_0003 or
-- grounding_0004 and does not care whether they are installed.
-- SOURCE OF TRUTH: absent from db/schema.ts and the drizzle snapshot on purpose
-- — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED.
--
-- ============================================================================
-- THE DEFECT
-- ============================================================================
-- `uellix_grounding.claim_active_document_version` derives the caller's scope
-- from the evidence row, and takes that row under a lock:
--
--     SELECT e.organization_id INTO v_org
--     FROM public.evidence_items e
--     WHERE e.id = p_evidence_id
--     FOR UPDATE;
--
-- PostgreSQL requires UPDATE privilege on a table to take a ROW LOCK on it, not
-- merely SELECT. grounding_0002 §219 grants `uellix_cap_grounding` exactly one
-- privilege on that table:
--
--     GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;
--
-- and the package is emphatic that this is deliberate: "Not UPDATE: the row
-- lock that used to require it is now an advisory lock". So every call by the
-- runtime principal dies with SQLSTATE 42501, "permission denied for table
-- evidence_items", BEFORE a single version row is read. The governed ingestion
-- path is functionally dead on the write side.
--
-- ============================================================================
-- WHAT THIS PACKAGE IS NOT
-- ============================================================================
-- It is NOT `GRANT UPDATE ON public.evidence_items TO uellix_cap_grounding`.
-- grounding_0002 §6 states the objection and this package restates it: widening
-- a business table's write surface so that a lock inside another table's
-- function is convenient is how a boundary becomes decorative. The role would
-- gain the ability to change evidence items — chain-of-custody rows — in order
-- to gain the ability to WAIT on one. §3 below re-asserts, after the change,
-- that the privilege is still absent.
--
-- It is NOT an edit to grounding_0002. That package is installed, evidence-
-- versioned, pinned and part of a closed chain; rewriting its bytes would make
-- the installed artefact and the repository disagree about what ran. The repair
-- is a new link applied after the existing chain.
--
-- ============================================================================
-- WHAT IT DOES, AND WHY THE SIBLING IS THE PROOF
-- ============================================================================
-- grounding_0002 hit this EXACT defect in `register_document_version` during
-- the train-2 adversarial review, measured it in a disposable container, and
-- replaced the row lock with a transaction-scoped ADVISORY lock (§765-787):
--
--     PERFORM pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0));
--
-- The repair never reached `claim_active_document_version`. This package
-- applies the same one, keyed IDENTICALLY — same function, same expression,
-- same parameter — so the two serialize against each other for a given evidence
-- id, which is what the "claim" verb has always claimed to do and, since the
-- repair of its sibling, has not done.
--
-- The advisory lock needs no privilege at all, gives the same mutual exclusion,
-- and — unlike the row lock — does not couple a lock inside `uellix_grounding`
-- to the write ACL of a table in `public`.
--
-- WHY THE COMMENT IS ALSO CORRECTED. grounding_0002's COMMENT on this function
-- says it runs "under the same evidence-row lock the registrar takes", and its
-- §8b header says "it takes the same evidence-row lock the registrar takes".
-- Both became false the moment the registrar stopped taking a row lock. A
-- reviewer reading the catalog would have been told the two functions agree —
-- which is the sentence this package finally makes true, by a different lock.
--
-- ============================================================================
-- WHY THERE IS NO ROLLBACK
-- ============================================================================
-- Same shape as stella_0016 and stella_0017, and for the same reason: what this
-- package removes is a DEFECT, not a feature. "Restore the previous version of
-- claim_active_document_version" and "republish the lock no principal can take"
-- are the same sentence. A rollback script here would be a script whose only
-- effect is to make a governed function uncallable again, and its correctness
-- would be a claim nobody measured.
--
-- Reverting is still possible and is deliberately made expensive rather than
-- easy: the grounding unit's own rollbacks (0004 -> 0003 -> 0002) withdraw the
-- whole surface, which is the honest way to remove a function that four other
-- packages depend on.
--
-- The in-flight failure path is a different question and IS covered: the script
-- runs in ONE transaction, so a failure at any statement leaves the prior
-- posture exactly as it was. That is measured rather than asserted —
-- `scripts/pg176-certify.ts` injects a failure at every authority boundary this
-- package opens and reads the catalog afterwards.
--
-- ============================================================================
-- RE-APPLICATION
-- ============================================================================
-- Idempotent and convergent. `CREATE OR REPLACE` over the body this package
-- already published is a no-op in effect, and §0 accepts that state explicitly
-- instead of refusing it.
--
-- The other direction is NOT safe and the runner refuses it:
-- db/prepared-package-order.ts records that `grounding_0002` may not be applied
-- over this package. grounding_0002 is idempotent, so re-running it alone would
-- succeed — and republish `claim_active_document_version` with the `FOR UPDATE`
-- still in it, reopening M-8 beside its own fix, with no signature change for
-- anything later to notice. That is R2a in a third form.
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- No CREATE INDEX CONCURRENTLY.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (superuser window)
-- ============================================================
-- FAIL CLOSED. Everything this package assumes is asked here, before a byte of
-- the function body is republished. The order is cheapest-refusal-first.
--
-- WHY THE CATALOG IS READ THROUGH JOINS AND NOT THROUGH to_regprocedure.
-- `to_regprocedure('uellix_grounding.…')` needs USAGE on that schema to resolve
-- the name, and answers `permission denied for schema uellix_grounding` when it
-- is missing. E-01/E-02 is the measured record of what that costs: a SAFETY
-- check failing for lack of privilege looks exactly like the property being
-- violated. pg_proc and pg_namespace are not privilege-gated, so the questions
-- below can always be ASKED; whether the installer may act on the answer is
-- asked separately, as (0.2), where it produces a message naming the grant.
--
-- WHY EVERY POSITIONAL TEST BELOW READS A COMMENT-STRIPPED DEFINITION.
-- `pg_get_functiondef` returns the source VERBATIM, comments included, and both
-- of these functions carry comments that quote the very tokens being searched
-- for — grounding_0002's registrar explains its own repair by writing out the
-- `FOR UPDATE` it removed. Searching the raw text would therefore find the
-- defect in a sentence describing the absence of the defect. That is F-08C, the
-- rule db/hosted/authority/classification-manifest.ts states for window
-- anchors, applied to a catalog read: a comment must never satisfy a test about
-- code.
DO $$
DECLARE
  claim_oid    oid;
  register_oid oid;
  claim_def    text;
  register_def text;
  problem      text;
BEGIN
  -- 0.1 Superuser — required to open the capability window this package needs.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'grounding_0005 aborted: must run as a SUPERUSER (current_user=%). It republishes a function owned by uellix_cap_grounding, which requires becoming that role and holding CREATE on schema uellix_grounding for the length of one statement.', current_user;
  END IF;

  -- 0.2 grounding_0002 must be installed: the schema, the capability role and
  --     the table its functions read. Named individually — "the grounding
  --     surface exists" is satisfied by a partial one.
  SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO problem
  FROM (VALUES
    ('schema uellix_grounding', EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_grounding')),
    ('role uellix_cap_grounding', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_grounding')),
    ('table public.evidence_items', to_regclass('public.evidence_items') IS NOT NULL),
    ('table public.evidence_document_versions', to_regclass('public.evidence_document_versions') IS NOT NULL)
  ) AS m(what, present)
  WHERE NOT m.present;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0005 aborted: requires grounding_0002. Missing: %. Apply db/prepared/grounding_0002_document_versions.sql first.', problem;
  END IF;

  -- 0.3 The two functions, resolved without needing USAGE on their schema.
  SELECT p.oid INTO claim_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'uellix_grounding'
    AND p.proname = 'claim_active_document_version'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_evidence_id uuid';

  IF claim_oid IS NULL THEN
    RAISE EXCEPTION 'grounding_0005 aborted: uellix_grounding.claim_active_document_version(uuid) does not exist with the expected single uuid argument. This package republishes that exact signature IN PLACE and will not create one that grounding_0002 did not.';
  END IF;

  SELECT p.oid INTO register_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'uellix_grounding'
    AND p.proname = 'register_document_version'
    AND p.pronargs = 8;

  IF register_oid IS NULL THEN
    RAISE EXCEPTION 'grounding_0005 aborted: uellix_grounding.register_document_version(8 arguments) does not exist. This package keys its lock to that function''s lock; with no sibling to agree with, "the same lock domain" is a claim about nothing.';
  END IF;

  claim_def    := regexp_replace(pg_catalog.pg_get_functiondef(claim_oid), '--[^\n]*', '', 'g');
  register_def := regexp_replace(pg_catalog.pg_get_functiondef(register_oid), '--[^\n]*', '', 'g');

  -- 0.4 The SIBLING must already hold the advisory lock this package copies.
  --     Measured, not assumed: the key is only "identical to register's" if
  --     register has one, and a database where grounding_0002 predates the
  --     train-2 repair needs that repair first, not this package.
  IF position('pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0))' in register_def) = 0 THEN
    RAISE EXCEPTION 'grounding_0005 aborted: register_document_version does not take pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0)). The installed grounding_0002 predates the train-2 lock repair, so copying its key here would key claim to a lock nothing else takes. Re-apply the grounding unit (0002 -> 0003 -> 0004) from the current canonical bytes first.';
  END IF;

  -- 0.5 The function this package is about to overwrite must be in one of
  --     exactly TWO states: the defect, or this package already applied.
  --
  --     A third state is a body somebody edited by hand, and `CREATE OR
  --     REPLACE` over it would destroy that edit without ever naming it. The
  --     two recognised states are distinguished by the lock, and both are
  --     accepted — the second is what makes re-application converge.
  IF position('FOR UPDATE' in claim_def) > 0
     AND position('pg_advisory_xact_lock' in claim_def) > 0 THEN
    RAISE EXCEPTION 'grounding_0005 aborted: claim_active_document_version holds BOTH a row lock and an advisory lock. That is neither the state grounding_0002 published nor the state this package publishes, so its body was changed by something else. Resolve manually — this package will not overwrite a body it cannot account for.';
  END IF;

  IF position('FOR UPDATE' in claim_def) = 0
     AND position('pg_advisory_xact_lock' in claim_def) = 0 THEN
    RAISE EXCEPTION 'grounding_0005 aborted: claim_active_document_version takes NO lock at all. grounding_0002 published it with a row lock and this package replaces that with an advisory lock; a body with neither is one this package did not write and did not expect.';
  END IF;

  -- 0.6 Owner, definer posture and search_path — the three properties this
  --     package must leave EXACTLY as it found them. Asserted before the
  --     change so a mismatch is a refusal rather than a silent normalization:
  --     `CREATE OR REPLACE` preserves all three, which means it would also
  --     preserve a wrong one and report success.
  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid)
     <> 'uellix_cap_grounding' THEN
    RAISE EXCEPTION 'grounding_0005 aborted: claim_active_document_version is owned by %, not uellix_cap_grounding. The capability window below becomes that role to republish the body; over a differently-owned function it would either fail or transfer ownership by accident.',
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid);
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid) THEN
    RAISE EXCEPTION 'grounding_0005 aborted: claim_active_document_version is not SECURITY DEFINER. Its scope re-imposition assumes it bypasses RLS; over an INVOKER function this package would republish checks that mean something different.';
  END IF;

  -- BOTH SPELLINGS, and the disjunction is not defensive padding. MEASURED on
  -- PostgreSQL 17.6 and already recorded by grounding_0002 §9: the server
  -- normalizes `SET search_path = ''` into proconfig as `search_path=""` — it
  -- QUOTES the empty value — while other versions store the bare
  -- `search_path=`. A check written for one form refuses a function that is
  -- correctly configured, which is how a safety precondition becomes an outage.
  IF NOT (SELECT coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=']::text[]
               OR coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[]
          FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid) THEN
    RAISE EXCEPTION 'grounding_0005 aborted: claim_active_document_version does not carry SET search_path = ''''. Every unqualified name in the body this package publishes resolves under that setting.';
  END IF;

  -- 0.7 THE POSTURE THIS PACKAGE EXISTS TO PRESERVE. If somebody has already
  --     "fixed" M-8 by granting UPDATE, this package is the wrong remedy and
  --     applying it would leave the grant behind, unremarked, next to a lock
  --     that no longer needs it.
  IF has_table_privilege('uellix_cap_grounding', 'public.evidence_items', 'UPDATE') THEN
    RAISE EXCEPTION 'grounding_0005 aborted: uellix_cap_grounding already holds UPDATE on public.evidence_items. M-8 was closed by widening a business table instead of by narrowing the lock. This package would remove the need for that privilege without removing the privilege, leaving a write grant on chain-of-custody rows that nothing accounts for. REVOKE it first, then apply.';
  END IF;

  IF NOT has_table_privilege('uellix_cap_grounding', 'public.evidence_items', 'SELECT') THEN
    RAISE EXCEPTION 'grounding_0005 aborted: uellix_cap_grounding lacks SELECT on public.evidence_items, which grounding_0002 §219 grants. The body republished below reads that table; without the grant this package would install a function that fails for a different reason.';
  END IF;

  -- 0.8 The RLS helpers the body calls. grounding_0002 granted EXECUTE on both
  --     to the capability role; a database where that was revoked would accept
  --     this package and answer every scope check as "not yours".
  IF NOT has_function_privilege('uellix_cap_grounding', 'public.current_user_org_ids()', 'EXECUTE')
     OR NOT has_function_privilege('uellix_cap_grounding', 'public.current_user_is_super_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'grounding_0005 aborted: uellix_cap_grounding lacks EXECUTE on the RLS helpers public.current_user_org_ids()/current_user_is_super_admin(). The body republished below re-imposes the caller''s organization boundary through them.';
  END IF;
END $$;

-- ============================================================
-- 1. claim_active_document_version, republished in place (capability window)
-- ============================================================
-- IDENTICAL to grounding_0002 §8b in every respect a caller can observe —
-- schema, name, signature, return type, language, SECURITY DEFINER, empty
-- search_path, argument validation, scope re-imposition, error codes, column
-- list, ordering and limit — except for the lock.
--
-- STABLE is still deliberately NOT declared, and now for a stronger reason than
-- before: an advisory lock is even more plainly a side effect than a row lock,
-- and a STABLE function may be folded or executed in a snapshot where the lock
-- means nothing.
--
-- THE ORDER OF THE FIRST TWO STEPS IS THE POINT. The lock is taken BEFORE the
-- evidence row is read, exactly as the registrar takes it before its own read.
-- Taking it afterwards would leave the window this verb exists to close — a
-- successor version registered between the read and the caller's next
-- statement — open by the width of one SELECT.
CREATE OR REPLACE FUNCTION uellix_grounding.claim_active_document_version(
  p_evidence_id uuid
)
RETURNS TABLE (
  id uuid,
  version_id char(64),
  ordinal integer,
  normalized_content_hash char(64),
  normalization_version varchar(32),
  extractor_version varchar(32),
  chunker_version varchar(32)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF p_evidence_id IS NULL THEN
    RAISE EXCEPTION 'grounding: evidence id is required' USING ERRCODE = 'U0100';
  END IF;

  -- M-8. This was `SELECT ... FROM public.evidence_items ... FOR UPDATE`, and
  -- PostgreSQL requires UPDATE privilege on a table to take a row lock on it —
  -- not just SELECT. `uellix_cap_grounding` holds only SELECT (grounding_0002
  -- §219, deliberately), so every call failed with 42501 before reading a
  -- version and the governed ingestion path was dead on the write side.
  --
  -- The same repair grounding_0002 §765-787 applied to the registrar, keyed
  -- IDENTICALLY so the two serialize against each other for a given evidence
  -- id. Transaction-scoped: it is released when the caller's transaction ends,
  -- which is the same lifetime the row lock had and the lifetime the ingestion
  -- sequence (claim -> register -> insert -> finalize) shares.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0));

  SELECT e.organization_id INTO v_org
  FROM public.evidence_items e
  WHERE e.id = p_evidence_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'grounding: evidence item not found' USING ERRCODE = 'U0102';
  END IF;

  -- The definer bypasses RLS, so the caller's boundary has to be re-imposed
  -- here explicitly. Same message for "not yours" and "does not exist": telling
  -- them apart is a tenancy oracle.
  IF NOT (v_org = ANY(public.current_user_org_ids()) OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'grounding: evidence item not found' USING ERRCODE = 'U0102';
  END IF;

  -- Explicit column list, never SELECT *: a column added later would silently
  -- change this function's result shape and break its callers at run time.
  RETURN QUERY
  SELECT v.id, v.version_id, v.ordinal, v.normalized_content_hash,
         v.normalization_version, v.extractor_version, v.chunker_version
  FROM public.evidence_document_versions v
  WHERE v.evidence_id = p_evidence_id
  ORDER BY v.ordinal DESC
  LIMIT 1;
END;
$$;

-- The documentation grounding_0002 left describing a lock its sibling had
-- already stopped taking. Corrected to say what the catalog now shows.
COMMENT ON FUNCTION uellix_grounding.claim_active_document_version(uuid) IS
  'GR-002 + M-8: the active version of a document (max ordinal, unique by construction), under the SAME transaction-scoped advisory lock register_document_version takes — pg_advisory_xact_lock(hashtextextended(evidence_id::text, 0)) — so the two serialize for a given evidence id. It is NOT an evidence-row lock: uellix_cap_grounding holds only SELECT on public.evidence_items, and a row lock there requires UPDATE.';

-- NOTE ON WHAT IS DELIBERATELY ABSENT HERE.
-- No `ALTER FUNCTION ... OWNER TO`, no `REVOKE ALL ... FROM PUBLIC` and no
-- `GRANT EXECUTE ... TO uellix_app`. `CREATE OR REPLACE FUNCTION` preserves the
-- owner and the ACL of the function it replaces, so all three would be no-ops
-- in the ordinary case — and in the case that matters they would be worse than
-- no-ops: re-stating them would REPAIR an ownership or a grant that had drifted,
-- silently, and this package would report success over a database whose posture
-- it had quietly changed. §3 MEASURES all three instead, and refuses.

-- ============================================================
-- 2. Self-verification — assert the end state, in this transaction
-- ============================================================
-- Read from pg_catalog, in the same transaction that made the change, so a
-- failure here rolls the change back rather than reporting on it afterwards.
--
-- The ACL is read through aclexplode(), which reports it literally: inherited
-- privileges do not appear and there is no superuser short-circuit. "I ran
-- CREATE OR REPLACE" is not evidence about who may execute the result.
DO $$
DECLARE
  claim_oid    oid;
  register_oid oid;
  claim_def    text;
  register_def text;
  problem      text;
  n            int;
BEGIN
  SELECT p.oid INTO claim_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n2 ON n2.oid = p.pronamespace
  WHERE n2.nspname = 'uellix_grounding'
    AND p.proname = 'claim_active_document_version'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_evidence_id uuid';

  IF claim_oid IS NULL THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: claim_active_document_version(uuid) does not exist after the script ran';
  END IF;

  SELECT p.oid INTO register_oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n2 ON n2.oid = p.pronamespace
  WHERE n2.nspname = 'uellix_grounding'
    AND p.proname = 'register_document_version'
    AND p.pronargs = 8;

  -- Comment-stripped, for the reason §0 states: this function's own body now
  -- explains the defect by naming it, and a test that read the raw definition
  -- would find `FOR UPDATE` in the sentence saying there is no `FOR UPDATE`.
  claim_def    := regexp_replace(pg_catalog.pg_get_functiondef(claim_oid), '--[^\n]*', '', 'g');
  register_def := regexp_replace(pg_catalog.pg_get_functiondef(register_oid), '--[^\n]*', '', 'g');

  -- (1) The row lock is GONE. Stated over the installed definition rather than
  --     over this file, because what matters is what a caller will execute.
  IF position('FOR UPDATE' in claim_def) > 0 THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: claim_active_document_version still contains FOR UPDATE. M-8 is not closed.';
  END IF;

  -- (2) The advisory lock is present, and (3) it is keyed IDENTICALLY to the
  --     registrar's. Two separate assertions on purpose: a body could take an
  --     advisory lock on a different key and satisfy (2) while serializing
  --     against nothing, which is the failure mode that would look most like
  --     success.
  IF position('pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0))' in claim_def) = 0 THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: claim_active_document_version does not take pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0)).';
  END IF;

  IF position('pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0))' in register_def) = 0 THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: register_document_version no longer takes the key this package matched. The two functions would no longer serialize against each other.';
  END IF;

  -- (4) The lock precedes the read it protects. A body that locked afterwards
  --     would pass (1), (2) and (3) and still leave the race open.
  IF position('pg_advisory_xact_lock' in claim_def)
     > position('FROM public.evidence_items' in claim_def) THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: the advisory lock is taken AFTER the evidence row is read. The window this verb exists to close stays open by the width of one SELECT.';
  END IF;

  -- (5) Owner UNCHANGED. `CREATE OR REPLACE` preserves it, which is exactly why
  --     it is measured: a preserved wrong owner reports success.
  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid)
     <> 'uellix_cap_grounding' THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: claim_active_document_version is owned by %, not uellix_cap_grounding',
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid);
  END IF;

  -- (6) SECURITY DEFINER and the empty search_path, both unchanged.
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid) THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: claim_active_document_version is no longer SECURITY DEFINER';
  END IF;
  -- Both spellings again — see §0.6. PG 17.6 stores the empty value QUOTED.
  IF NOT (SELECT coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=']::text[]
               OR coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']::text[]
          FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid) THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: claim_active_document_version no longer carries SET search_path = ''''';
  END IF;

  -- (7) The RETURN TYPE, column by column. `CREATE OR REPLACE` refuses to change
  --     it (42P13), so this cannot fail here — and it is asserted anyway,
  --     because "the engine would have stopped us" is a belief about the engine
  --     and this package's whole subject is a belief about the engine that was
  --     wrong.
  --
  --     Compared as a WHOLE ARRAY with IS DISTINCT FROM, not element by
  --     element: a per-element comparison against a missing element yields
  --     NULL, NULL is not TRUE, and the row would drop out of the aggregate —
  --     so a TRUNCATED column list would have passed the check written the
  --     obvious way. The IN parameter is included because the advisory key
  --     expression names it, so a rename would silently re-key the lock.
  IF (SELECT p.proargnames FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid)
     IS DISTINCT FROM ARRAY[
       'p_evidence_id',
       'id', 'version_id', 'ordinal', 'normalized_content_hash',
       'normalization_version', 'extractor_version', 'chunker_version'
     ] THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: the argument and OUT column names are %, not the eight grounding_0002 published',
      (SELECT p.proargnames::text FROM pg_catalog.pg_proc p WHERE p.oid = claim_oid);
  END IF;

  -- (8) THE ACL, LITERALLY. Exactly uellix_app holds EXECUTE, and PUBLIC holds
  --     nothing. This is the property §1 deliberately does not re-state, so it
  --     is the property that most needs measuring.
  --
  --     `coalesce(rolname, 'PUBLIC')` is inside the aggregate as well as inside
  --     the filter: aclexplode reports a PUBLIC grant with grantee 0, the LEFT
  --     JOIN leaves rolname NULL, and `NULL || ':EXECUTE'` is NULL — so the one
  --     grant this check exists to catch would have aggregated to nothing.
  SELECT string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ', '
                    ORDER BY coalesce(g.rolname, 'PUBLIC'), a.privilege_type)
    INTO problem
  FROM pg_catalog.pg_proc p,
       aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
  WHERE p.oid = claim_oid
    AND coalesce(g.rolname, 'PUBLIC') NOT IN ('uellix_app', 'uellix_cap_grounding');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: unexpected EXECUTE grant(s) on claim_active_document_version: %. Only uellix_app may call it; PUBLIC must hold nothing.', problem;
  END IF;

  IF NOT has_function_privilege('uellix_app', claim_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: uellix_app can no longer execute claim_active_document_version. The runtime principal is the only caller, so a preserved-but-empty ACL would be a silently dead ingestion path — which is the class of defect this package closes.';
  END IF;

  -- (9) THE POSTURE, RE-ASSERTED AFTER THE CHANGE. The whole argument for an
  --     advisory lock is that it needs no privilege; if UPDATE appeared anyway
  --     the argument would be decorative.
  IF has_table_privilege('uellix_cap_grounding', 'public.evidence_items', 'UPDATE') THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: uellix_cap_grounding holds UPDATE on public.evidence_items. This package exists precisely so that grant is unnecessary.';
  END IF;
  IF NOT has_table_privilege('uellix_cap_grounding', 'public.evidence_items', 'SELECT') THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: uellix_cap_grounding lost SELECT on public.evidence_items';
  END IF;

  -- (10) The comment says what the catalog shows. The stale one was half of
  --      this defect: it told every reviewer the two functions agreed.
  IF coalesce(pg_catalog.obj_description(claim_oid, 'pg_proc'), '') NOT LIKE '%advisory lock%' THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: the COMMENT on claim_active_document_version does not describe the advisory lock it now takes';
  END IF;

  -- (11) The capability role still has zero members. Restated here because this
  --      package OPENS a temporary membership in it to republish the function,
  --      and a membership that outlived the window would pass every other
  --      assertion in this block.
  SELECT count(*) INTO n FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  WHERE r.rolname = 'uellix_cap_grounding';
  IF n <> 0 THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: uellix_cap_grounding has % member(s)', n;
  END IF;

  -- (12) And no temporary CREATE survived on the schema either. The window this
  --      package needs is `GRANT CREATE ON SCHEMA uellix_grounding` for exactly
  --      one statement; a residual grant would be a permanent widening nobody
  --      declared.
  SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname) INTO problem
  FROM pg_catalog.pg_namespace ns,
       aclexplode(COALESCE(ns.nspacl, acldefault('n', ns.nspowner))) a
  JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
  WHERE ns.nspname = 'uellix_grounding'
    AND a.privilege_type = 'CREATE'
    AND g.rolname <> pg_catalog.pg_get_userbyid(ns.nspowner);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0005 FAILED verification: CREATE on schema uellix_grounding survives for: %. The capability window grants it temporarily and must give it back.', problem;
  END IF;

  RAISE NOTICE 'grounding_0005: verification passed — claim_active_document_version republished in place under pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0)), the same key register_document_version takes; no FOR UPDATE; owner, ACL, SECURITY DEFINER, search_path and return type unchanged; uellix_cap_grounding still SELECT-only on public.evidence_items; capability role with 0 members and no residual schema CREATE.';
END $$;
