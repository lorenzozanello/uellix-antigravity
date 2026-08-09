-- ============================================================================
-- grounding_0004_runtime_attestation — MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.
-- ============================================================================
--
-- Derived from: db/prepared/grounding_0004_runtime_attestation.sql
-- Source SHA-256 (LF-normalized): e89828da67f142d40140b6a2c6328da013c69b54968168c0474c54db857de5c6
--
-- The canonical file above is the ONLY source of truth. This artefact exists
-- because managed Supabase exposes no superuser and does not let `postgres`
-- grant USAGE on schema auth. Editing THIS file instead of the canonical one
-- creates the second source of truth the design exists to prevent — and the
-- verification suite will fail, because it regenerates and compares bytes.
--
-- Rewrite rules applied (id: times fired):
--   superuser-precondition: 1
--   auth-schema-grant: 0
--   auth-uid-precondition: 0
--   auth-uid-call: 0
--   capability-role-attributes: 0
--
-- Nothing else was changed. No policy predicate, no ownership transfer, no
-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no
-- self-verification block differs from the canonical source.
-- ============================================================================
-- db/prepared/grounding_0004_runtime_attestation.sql
-- INT-GR-004, INT-CAP-002, INT-CAP-003, INT-CAP-004(2) — the four repairs the
-- train-3 adversarial review left open on the grounding read/write surface.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: grounding_0004_rollback.sql.
--
-- CONTRACT:  docs/ops/contracts/CONTRACT_LEDGER.md#int-gr-004 (and #int-cap-002,
--            #int-cap-003, #int-cap-004)
-- RESPONSE:  docs/ops/contracts/CAP-TRAIN4-002_grounding_scope_attestation_response.md
-- DEPENDS ON: grounding_0002 then grounding_0003, both applied first.
-- SOURCE OF TRUTH: absent from db/schema.ts and the drizzle snapshot on purpose
-- — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §4.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED.
--
-- ============================================================================
-- ADDITIVE, AND WHY THAT IS NOT A PREFERENCE
-- ============================================================================
-- The obvious shape for INT-GR-004 is "make chunks_in_scope return two more
-- columns". PostgreSQL does not allow it: `CREATE OR REPLACE FUNCTION` cannot
-- change a function's return type (42P13, "cannot change return type of
-- existing function"), and grounding_0003 creates chunks_in_scope with exactly
-- that statement.
--
-- So a package that DROPped and recreated it under the same name would make
-- the forward chain non-re-appliable: `0002 -> 0003 -> 0004` run a second time
-- would abort inside 0003, and idempotence of the chain is measured by the
-- dry-run and required by every gate this campaign has produced.
--
-- This package therefore publishes a NEW function, `chunks_in_scope_attested`,
-- and leaves grounding_0003 untouched. The cost is one deprecated read path
-- kept callable for exactly as long as the repository adapter takes to move;
-- the alternative cost was a chain that cannot be re-run.
--
-- ============================================================================
-- WHAT EACH REPAIR CLOSES
-- ============================================================================
-- INT-GR-004  chunks_in_scope returns 13 columns, none of which is the row's
--             scope, so the repository adapter stamps the scope THE QUERY
--             ASKED FOR onto every chunk and `enforceRepositoryScope` compares
--             that value with itself. The attested reader returns four scope
--             columns so the comparison becomes load-bearing. Every one of the
--             four is a value the caller ALREADY HOLDS — three are its own
--             arguments and the fourth came from its version lookup — so the
--             attestation discloses nothing; it only lets what was asked for
--             be checked against what came back.
--
-- INT-CAP-002 grounding_0003 §5 grants SELECT on evidence_chunks to
--             `authenticated`, the PostgREST principal, and the permissive
--             SELECT policy filters organization only. A browser session could
--             therefore read the whole organization's chunk index directly,
--             around `chunks_in_scope` and around its
--             `canonical_chunk_id IS NULL` filter — which is the only thing
--             that stops a SUPPRESSED duplicate being cited as if it were the
--             passage. Nothing in this repository reads chunks as
--             `authenticated`: the repository adapter connects as uellix_app.
--             The grant is surplus, and surplus read on a table whose governed
--             reader exists is how a governed reader becomes optional.
--
-- INT-CAP-003 insert_evidence_chunks validates that content_hash is 64-hex and
--             DERIVES chunk_id from it, but nothing computes sha256(content)
--             and compares. The server-derived chunk_id therefore certifies a
--             digest the caller CHOSE, and the adapter's re-derivation passes
--             because it re-derives from the same unverified value.
--
-- INT-CAP-004 evidence_chunks_hash_shape_check only requires chunk_id to be
--             64-hex; the derivation lives solely in the function body, and
--             §5 revokes from seven principals but not from uellix_owner,
--             which keeps implicit INSERT and is not bound by RLS. A forged
--             chunk_id is representable by the owner.
--
-- ALL THREE INTEGRITY REPAIRS ARE `CHECK` CONSTRAINTS, NOT TRIGGERS
-- -----------------------------------------------------------------
-- A CHECK binds the table OWNER, which is the adversary INT-CAP-004 names, and
-- unlike a trigger it cannot be silenced by `session_replication_role =
-- replica` — the residual this campaign already documented for the composite
-- foreign keys. Every function they use (encode, sha256, convert_to, length,
-- the int4->text cast) is IMMUTABLE, which is what makes them legal in a CHECK
-- at all.
--
-- RUN AS ONE TRANSACTION, AS SUPERUSER:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent AND convergent. No CREATE INDEX CONCURRENTLY.

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions (superuser window)
-- ============================================================
DO $$
DECLARE
  missing text;
BEGIN
  -- HOSTED VARIANT (Train 5B, generated — do not edit by hand).
  -- The superuser check below was replaced by a capability assertion installed by
  -- db/prepared/stella_hosted_0001_managed_role_bootstrap.sql. Original message,
  -- preserved verbatim so the refusal it encoded stays reviewable:
  --   grounding_0004 aborted: must run as a SUPERUSER (current_user=%). It transfers function ownership to uellix_cap_grounding, which requires it.
  PERFORM uellix_bootstrap.assert_hosted_capabilities('grounding_0004_runtime_attestation');

  IF to_regclass('public.evidence_chunks') IS NULL
     OR to_regclass('public.evidence_document_versions') IS NULL THEN
    RAISE EXCEPTION 'grounding_0004 aborted: requires grounding_0002 and grounding_0003. Apply db/prepared/grounding_0002_document_versions.sql then db/prepared/grounding_0003_evidence_chunks.sql first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_grounding')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_grounding') THEN
    RAISE EXCEPTION 'grounding_0004 aborted: schema uellix_grounding or role uellix_cap_grounding is absent — apply grounding_0002 first.';
  END IF;

  -- The three governed functions grounding_0003 installs. Named individually
  -- rather than counted: "three functions exist" is satisfied by three wrong
  -- ones, and this package attests ABOUT chunks_in_scope specifically.
  SELECT string_agg(f.name, ', ' ORDER BY f.name) INTO missing
  FROM (VALUES
    ('uellix_grounding.insert_evidence_chunks(uuid, jsonb)'),
    ('uellix_grounding.finalize_document_ingestion(uuid, integer)'),
    ('uellix_grounding.chunks_in_scope(uuid, uuid, uuid)')
  ) AS f(name)
  WHERE to_regprocedure(f.name) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 aborted: grounding_0003 function(s) not found: %.', missing;
  END IF;

  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'grounding_0004 aborted: RLS helpers not found — apply db/migrations/0031_rls_core.sql first.';
  END IF;
END $$;

-- ============================================================
-- 1. Integrity, stated where the owner cannot step around it (owner window)
-- ============================================================
SET ROLE uellix_owner;

DO $$
DECLARE
  def text;
BEGIN
  -- ----------------------------------------------------------------
  -- 1a. INT-CAP-003 — content_hash IS the digest of content.
  --
  -- lib/grounding/contracts/core.ts#hashContent is
  -- `sha256(utf8(text)).hex`, and chunk-document.ts computes it over
  -- `normalizedText.slice(char_start, char_end)` — the very text this column
  -- stores. So the invariant is exactly reproducible in SQL, and until now it
  -- was checked nowhere: the package's own header promises a third party can
  -- re-normalise, slice, hash and recover content_hash, and the database
  -- accepted any 64-hex string in its place.
  --
  -- Restricted to canonical rows: a SUPPRESSED occurrence stores NO text (the
  -- content-presence biconditional), and its content_hash is by definition the
  -- canonical chunk's — verifying it against a NULL content would reject every
  -- duplicate the deduplication relation exists to record.
  -- ----------------------------------------------------------------
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_content_hash_derivation_check';
  IF def IS NULL OR position('sha256' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_content_hash_derivation_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_content_hash_derivation_check
      CHECK (content IS NULL
             OR content_hash = encode(sha256(convert_to(content, 'UTF8')), 'hex'));
  END IF;

  -- ----------------------------------------------------------------
  -- 1b. INT-CAP-003 — the declared span is consistent with the stored text.
  --
  -- A BOUND, not an equality, and the reason is precise. `char_start` and
  -- `char_end` are offsets produced by JavaScript `String.prototype.slice`,
  -- which indexes UTF-16 CODE UNITS; PostgreSQL `length(text)` counts CODE
  -- POINTS. For text inside the Basic Multilingual Plane the two agree; every
  -- character outside it (emoji, historic scripts, some CJK extensions) is one
  -- code point and TWO code units.
  --
  -- So `char_end - char_start = length(content)` would reject legitimate
  -- passages containing a single emoji, and a constraint that fails on valid
  -- data teaches an operator to drop it. The sound statement is the interval
  -- every string satisfies:
  --
  --     length(content) <= char_end - char_start <= 2 * length(content)
  --
  -- which is tight for BMP-only text and still refuses the attack INT-CAP-003
  -- describes: a span declared over thousands of characters for a passage of
  -- ten. It bounds the claim without inventing a precision the two coordinate
  -- systems do not share.
  -- ----------------------------------------------------------------
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_span_length_check';
  IF def IS NULL
     OR position('length(content)' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_span_length_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_span_length_check
      CHECK (content IS NULL
             OR ((char_end - char_start) >= length(content)
                 AND (char_end - char_start) <= 2 * length(content)));
  END IF;

  -- ----------------------------------------------------------------
  -- 1c. INT-CAP-004 (2) — chunk_id IS the derivation, for every writer.
  --
  -- insert_evidence_chunks already derives it server-side, and that closes the
  -- path through the governed function. It does not close the path AROUND it:
  -- grounding_0003 §5 revokes from seven principals and not from
  -- uellix_owner, which holds INSERT implicitly as the table owner and is not
  -- bound by RLS. A CHECK is bound by nobody's exemption — the owner included
  -- — so the derivation stops being a property of one function's body and
  -- becomes a property of the row.
  --
  -- Same preimage as lib/grounding/contracts/chunks.ts#deriveChunkId and as
  -- the function: 'grounding/chunk/v1', version_id, chunk_index, content_hash,
  -- newline-separated, SHA-256, lowercase hex. char(64) concatenated into text
  -- loses no character here because every value is exactly 64 characters wide.
  -- ----------------------------------------------------------------
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_chunk_id_derivation_check';
  IF def IS NULL
     OR position('grounding/chunk/v1' in def) = 0
     OR position('chunk_index' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_chunk_id_derivation_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_chunk_id_derivation_check
      CHECK (chunk_id = encode(sha256(convert_to(
               'grounding/chunk/v1' || chr(10) || version_id || chr(10)
                 || chunk_index::text || chr(10) || content_hash,
               'UTF8')), 'hex'));
  END IF;
END $$;

-- ============================================================
-- 2. The read surface: one role added, one role removed
-- ============================================================
-- ------------------------------------------------------------------------
-- 2a. TRAIN 4 FINDING — the capability role reads NOTHING, silently.
-- ------------------------------------------------------------------------
-- Found by INVOKING the governed reader against seeded rows in
-- scripts/stella-train4-dry-run.sh. `uellix_cap_grounding` holds SELECT on
-- both tables (grounding_0002 §5, grounding_0003 §5) and is named by NEITHER
-- permissive SELECT policy: `evidence_document_versions_select` is
-- `TO authenticated, uellix_app, uellix_auditor` and `evidence_chunks_select`
-- was the same. The role holds no BYPASSRLS and owns neither table, so RLS
-- applies to it in full and every read returns the empty set.
--
-- That is not a degradation of one function. It is the whole governed surface:
--
--   chunks_in_scope              returns 0 rows for every caller
--   chunks_in_scope_attested     would do the same
--   finalize_document_ingestion  counts 0 stored chunks -> U0103 on every call
--   claim_active_document_version  never finds a version -> U0102 on every call
--   register_document_version    never sees the existing version, so it cannot
--                                detect a re-registration, and never sees the
--                                previous one, so `ordinal` is always 1 and
--                                `supersedes_version_id` always NULL — which
--                                makes VERSION 2 OF ANY DOCUMENT unstorable
--                                against UNIQUE (evidence_id, ordinal)
--
-- It is the same class as the train-2 finding (the definer had no privilege on
-- evidence_items, so every call died with 42501) and strictly worse: a missing
-- GRANT raises, a missing POLICY returns nothing. A structural dry-run cannot
-- see either, which is why this one seeds rows and calls the functions.
--
-- THE FIX IS A REPLACEMENT, NOT AN ADDITION, and that is forced: grounding_0002
-- §9 asserts EXACTLY 3 policies on the version table and grounding_0003 §9
-- asserts EXACTLY 4 on the chunk table. A fifth policy would make re-applying
-- either package fail its own postcondition, and the forward chain has to stay
-- re-appliable. Both policies are therefore re-created under their own names
-- with the same predicate and one more role.
--
-- Adding the role does NOT widen what a user can reach: the predicate is
-- unchanged, and `public.current_user_org_ids()` reads the CALLER's
-- `auth.uid()` — SECURITY DEFINER changes the executing role, not the session's
-- claims. So the definer sees exactly the organizations the caller belongs to,
-- and the explicit check inside each function is now backed by RLS instead of
-- standing alone.
DROP POLICY IF EXISTS "evidence_document_versions_select" ON public.evidence_document_versions;
CREATE POLICY "evidence_document_versions_select"
ON public.evidence_document_versions FOR SELECT
TO authenticated, uellix_app, uellix_auditor, uellix_cap_grounding
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);

COMMENT ON POLICY "evidence_document_versions_select" ON public.evidence_document_versions IS
  'Train 4 repair (prepared grounding_0004): identical predicate to grounding_0002 §6 plus uellix_cap_grounding. Without that role the SECURITY DEFINER functions read the empty set — they hold SELECT but no policy named them — so register_document_version could never see a previous version and every document was permanently stuck at ordinal 1.';

-- ------------------------------------------------------------------------
-- 2b. INT-CAP-002 — the read surface, narrowed to what actually reads
-- ------------------------------------------------------------------------
-- `authenticated` is PostgREST's principal. No code in this repository reads
-- evidence_chunks through it: db/grounding/grounding-chunk-repository.ts
-- connects as `uellix_app` and calls the governed function. Removing the grant
-- and the policy role therefore removes a capability nothing exercises, and
-- with it the only route that reached chunk rows without the
-- `canonical_chunk_id IS NULL` filter.
--
-- The policy is REPLACED under the same name rather than dropped: the count of
-- policies on this table is asserted by grounding_0003 §9 (exactly four), and
-- a rollback that has to re-create a policy it deleted is a rollback that can
-- re-create it differently.
DROP POLICY IF EXISTS "evidence_chunks_select" ON public.evidence_chunks;
CREATE POLICY "evidence_chunks_select"
ON public.evidence_chunks FOR SELECT
TO uellix_app, uellix_auditor, uellix_cap_grounding
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);

REVOKE SELECT ON public.evidence_chunks FROM authenticated;

-- The correction INT-CAP-002 asks for, recorded where an operator reading the
-- LIVE schema sees it rather than only in a source comment.
COMMENT ON POLICY "evidence_chunks_select" ON public.evidence_chunks IS
  'INT-CAP-002 (prepared grounding_0004): ORGANIZATION isolation, not project isolation. This policy bounds rows to the caller''s organizations and nothing narrower; the project boundary on a retrieval read is imposed by uellix_grounding.chunks_in_scope_attested, whose project argument is checked against the row. grounding_0003 §6''s heading overstated this. `authenticated` is deliberately absent: the governed reader is the only chunk read path, so PostgREST cannot reach rows around the canonical_chunk_id filter. `uellix_cap_grounding` is deliberately present: without it the governed reader itself returned the empty set (Train 4 finding, §2a).';

RESET ROLE;

-- ============================================================
-- 3. INT-GR-004 — the attested read path (superuser window)
-- ============================================================
-- Identical scoping and filtering to chunks_in_scope. The ONLY difference is
-- that each row carries the scope it was actually stored under, so a caller
-- can compare what it asked for against what it received instead of comparing
-- its own request with itself.
--
-- FOUR attestation columns and no more:
--
--   organization_id      argument 1, echoed from the ROW
--   project_id           argument 2, echoed from the ROW
--   document_version_id  argument 3, echoed from the ROW
--   evidence_id          not an argument, but the caller already resolved it
--                        from evidence_document_versions to obtain argument 3
--                        — so this is the one column that lets the caller
--                        detect a DISAGREEMENT between its version lookup and
--                        the chunk rows, which is precisely the class of bug
--                        the tautological guard could never see.
--
-- Nothing else is added. `content`, the digests and the pipeline versions are
-- already returned; adding, say, `created_at` or `signals` metadata would be
-- widening a read surface for no assertion anyone makes.
CREATE OR REPLACE FUNCTION uellix_grounding.chunks_in_scope_attested(
  p_organization_id uuid,
  p_project_id uuid,
  p_document_version_id uuid
)
RETURNS TABLE (
  chunk_id char(64),
  chunk_index integer,
  content text,
  content_hash char(64),
  char_start integer,
  char_end integer,
  page integer,
  section_index integer,
  normalized_content_hash char(64),
  normalization_version varchar(32),
  chunker_version varchar(32),
  injection_scanner_version varchar(32),
  signals jsonb,
  organization_id uuid,
  project_id uuid,
  evidence_id uuid,
  document_version_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_organization_id IS NULL OR p_project_id IS NULL OR p_document_version_id IS NULL THEN
    RAISE EXCEPTION 'grounding: organization, project and document version are all required' USING ERRCODE = 'U0100';
  END IF;

  -- SECURITY DEFINER bypasses RLS, so this check IS the boundary. Same message
  -- as "not found" everywhere in these packages: telling the two apart is a
  -- tenancy oracle.
  IF NOT (p_organization_id = ANY(public.current_user_org_ids())
          OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'grounding: document version not found' USING ERRCODE = 'U0102';
  END IF;

  RETURN QUERY
  SELECT ch.chunk_id, ch.chunk_index, ch.content, ch.content_hash,
         ch.char_start, ch.char_end, ch.page, ch.section_index,
         ch.normalized_content_hash, ch.normalization_version,
         ch.chunker_version, ch.injection_scanner_version, ch.signals,
         -- The attestation. Read from the ROW, never echoed from the argument:
         -- echoing the argument is exactly the tautology INT-GR-004 reports,
         -- moved one layer down where it would be harder to see.
         ch.organization_id, ch.project_id, ch.evidence_id, ch.document_version_id
  FROM public.evidence_chunks ch
  WHERE ch.document_version_id = p_document_version_id
    AND ch.organization_id = p_organization_id
    AND ch.project_id = p_project_id
    AND ch.canonical_chunk_id IS NULL
  ORDER BY ch.chunk_index;
END;
$$;

-- ------------------------------------------------------------
-- 3b. Ownership and ACL
-- ------------------------------------------------------------
ALTER FUNCTION uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid) OWNER TO uellix_cap_grounding;

REVOKE ALL ON FUNCTION uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid) TO uellix_app;

COMMENT ON FUNCTION uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid) IS
  'INT-GR-004: canonical chunks of one version inside an exact (organization, project) scope, each row carrying the scope it was STORED under. The four attestation columns are values the caller already holds, so they disclose nothing and exist solely so a requested scope can be compared against a returned one.';

-- The predecessor stays callable — the repository adapter still names it and
-- this package does not edit TypeScript — but the live schema says which one
-- is current. EXECUTE is deliberately NOT revoked from uellix_app here:
-- revoking it would break a working read path in the same train that forbids
-- editing the caller, which is a coordinated change and not a unilateral one.
COMMENT ON FUNCTION uellix_grounding.chunks_in_scope(uuid, uuid, uuid) IS
  'DEPRECATED by uellix_grounding.chunks_in_scope_attested (prepared grounding_0004, INT-GR-004). Identical filtering, but it returns no scope column, so a caller cannot verify that the rows it received carry the scope it asked for and any TypeScript comparison against them is tautological. Kept callable only until db/grounding/grounding-chunk-repository.ts moves.';

-- ============================================================
-- 4. Self-verification — assert the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  tbl_oid  oid;
  problem  text;
  argnames text[];
  n        int;
BEGIN
  tbl_oid := to_regclass('public.evidence_chunks');

  -- (1) The three integrity constraints exist and are the ones intended.
  SELECT string_agg(c.name, ', ' ORDER BY c.name) INTO problem
  FROM (VALUES
    ('evidence_chunks_content_hash_derivation_check'),
    ('evidence_chunks_span_length_check'),
    ('evidence_chunks_chunk_id_derivation_check')
  ) AS c(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint pc
    WHERE pc.conrelid = tbl_oid AND pc.conname = c.name AND pc.contype = 'c'
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: CHECK constraint(s) % are absent', problem;
  END IF;

  -- (1b) ...and they are VALIDATED. A constraint added NOT VALID is present in
  --      the catalogue, enforced for new rows, and silent about every row that
  --      was already there — a distinction no `EXISTS` above can see.
  SELECT string_agg(pc.conname, ', ' ORDER BY pc.conname) INTO problem
  FROM pg_constraint pc
  WHERE pc.conrelid = tbl_oid AND pc.contype = 'c' AND NOT pc.convalidated;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: constraint(s) % are NOT VALID, so pre-existing rows were never checked', problem;
  END IF;

  -- (2) The attested reader exists, is SECURITY DEFINER with an empty
  --     search_path, is owned by the capability role, and PUBLIC cannot call
  --     it. Written over the WHOLE schema, so a fifth function added later
  --     cannot arrive unchecked — the same shape grounding_0003 §9 uses.
  IF to_regprocedure('uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: uellix_grounding.chunks_in_scope_attested does not exist after the script ran';
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_grounding'
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[])
         OR pg_get_userbyid(p.proowner) <> 'uellix_cap_grounding');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: function(s) % are not SECURITY DEFINER with search_path='''' owned by uellix_cap_grounding', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname = 'uellix_grounding' AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: PUBLIC holds EXECUTE on %', problem;
  END IF;

  -- (3) The attestation columns are actually in the result shape. Read from
  --     pg_proc's declared OUT parameters, not from the source text: a
  --     function whose body selects them but whose signature does not declare
  --     them would not compile, and one whose signature declares them while
  --     the body echoes an argument is caught by the dry-run's cross-scope
  --     probes, not here.
  --     Read into a variable first: `= ANY (SELECT ...)` is the SUBQUERY form
  --     of ANY, which compares against a set of rows, and pg_proc.proargnames
  --     is a single text[] value — the two forms differ and the parser picks
  --     the wrong one (`operator does not exist: text = text[]`).
  SELECT p.proargnames INTO argnames
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_grounding' AND p.proname = 'chunks_in_scope_attested';

  SELECT string_agg(c.name, ', ' ORDER BY c.name) INTO problem
  FROM (VALUES ('organization_id'), ('project_id'), ('evidence_id'), ('document_version_id')) AS c(name)
  WHERE argnames IS NULL OR NOT (c.name = ANY(argnames));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: the attested reader does not return column(s) %', problem;
  END IF;

  -- (4) INT-CAP-002: `authenticated` holds no privilege on the chunk index and
  --     is named by no policy on it.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid AND g.rolname = 'authenticated';
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: authenticated still holds % on public.evidence_chunks — PostgREST would reach chunk rows around the governed reader', problem;
  END IF;

  --      PERMISSIVE only, and the distinction is the whole point. A
  --      RESTRICTIVE policy ANDs with every other one and can only NARROW, so
  --      grounding_0003's evidence_chunks_scope_consistency naming
  --      `authenticated` grants nothing — it merely states an invariant that
  --      would bind that role if it ever had a grant. A PERMISSIVE policy ORs,
  --      and one naming `authenticated` is a way IN.
  IF EXISTS (
    SELECT 1 FROM pg_policy pol
    CROSS JOIN LATERAL unnest(pol.polroles) AS r(oid)
    JOIN pg_roles g ON g.oid = r.oid
    WHERE pol.polrelid = tbl_oid AND g.rolname = 'authenticated' AND pol.polpermissive
  ) THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: a PERMISSIVE policy on public.evidence_chunks still names authenticated, which is a way in rather than a narrowing';
  END IF;

  -- (5) The policy counts grounding_0002 and grounding_0003 assert are
  --     unchanged: this package REPLACED two policies, it added none and
  --     removed none. A fifth policy on either table would make re-applying
  --     the package that owns it fail its own postcondition, and the forward
  --     chain has to stay re-appliable.
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid;
  IF n <> 4 THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: expected exactly 4 RLS policies on public.evidence_chunks, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = to_regclass('public.evidence_document_versions');
  IF n <> 3 THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: expected exactly 3 RLS policies on public.evidence_document_versions, found %', n;
  END IF;

  -- (5b) TRAIN 4 FINDING (§2a) — the capability role must be covered by a
  --      PERMISSIVE SELECT policy on BOTH tables. It holds SELECT on both and
  --      no BYPASSRLS, so without the policy every governed function reads the
  --      empty set: chunks_in_scope returns nothing, finalize_document_ingestion
  --      always reports an incomplete ingestion, and register_document_version
  --      never sees a previous version, which pins every document at ordinal 1.
  --      Asserted per table so a repair that lands on one and not the other is
  --      not reported as a repair.
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO problem
  FROM (VALUES ('public.evidence_chunks'), ('public.evidence_document_versions')) AS t(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    CROSS JOIN LATERAL unnest(pol.polroles) AS r(oid)
    JOIN pg_roles g ON g.oid = r.oid
    WHERE pol.polrelid = to_regclass(t.name)
      AND pol.polpermissive
      AND pol.polcmd IN ('r', '*')
      AND g.rolname = 'uellix_cap_grounding'
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: uellix_cap_grounding is named by no PERMISSIVE SELECT policy on %. It holds SELECT and no BYPASSRLS, so every SECURITY DEFINER read there returns the empty set — silently', problem;
  END IF;

  -- (6) The capability role still has zero members. Restated here because this
  --     package gives it a fourth function to own, and a membership granted
  --     between packages would pass every other assertion.
  SELECT count(*) INTO n FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  WHERE r.rolname = 'uellix_cap_grounding';
  IF n <> 0 THEN
    RAISE EXCEPTION 'grounding_0004 FAILED verification: uellix_cap_grounding has % member(s)', n;
  END IF;

  RAISE NOTICE 'grounding_0004: verification passed — 3 validated integrity CHECKs (content_hash derivation, span bound, chunk_id derivation), attested reader present with 4 scope columns and owned by uellix_cap_grounding, authenticated holds nothing on evidence_chunks and is named by no policy, 4 policies unchanged, capability role with 0 members.';
END $$;
