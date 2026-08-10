-- ============================================================================
-- grounding_0003_evidence_chunks — GOVERNED MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm authority:generate`.
-- ============================================================================
--
-- Package: T2
-- Derived from: db/prepared/hosted/grounding_0003_evidence_chunks.hosted.sql
-- Source SHA-256 (LF-normalized): 7505586f6c3759cae85455e641ded5934413bafc8574db273ec90b5edadde6c9
--
-- WHAT CHANGED, AND ONLY THIS:
--   The canonical SET ROLE / RESET ROLE bookkeeping was replaced. It assumes
--   a superuser applies the package, which managed Supabase does not have.
--   In its place each execution segment opens exactly the authority it needs,
--   runs the canonical statements it governs, and gives that authority back.
--
-- WHAT DID NOT CHANGE:
--   Every canonical executable statement, verbatim and in canonical order.
--   No statement was moved to reduce the number of role transitions.
-- ============================================================================
-- ============================================================================
-- grounding_0003_evidence_chunks — MANAGED SUPABASE VARIANT
-- GENERATED — DO NOT EDIT. Regenerate with `pnpm hosted:generate`.
-- ============================================================================
--
-- Derived from: db/prepared/grounding_0003_evidence_chunks.sql
-- Source SHA-256 (LF-normalized): 99980b34b9d4560127085f1be5b67e7a49792e197fa654e9cefe825e89817bd8
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
--   capability-member-count: 1
--   auth-users-privilege-probe: 0
--
-- Nothing else was changed. No policy predicate, no ownership transfer, no
-- REVOKE, no SECURITY DEFINER marker, no search_path, no CHECK and no
-- self-verification block differs from the canonical source.
-- ============================================================================
-- db/prepared/grounding_0003_evidence_chunks.sql
-- GR-001 — provenance and versioning for public.evidence_chunks.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: grounding_0003_rollback.sql.
--
-- CONTRACT:  docs/ops/contracts/GR-001_evidence_chunks_provenance.md
-- RESPONSE:  docs/ops/contracts/GR-CAP-001_grounding_persistence_response.md
-- DEPENDS ON: db/prepared/grounding_0002_document_versions.sql (applied first)
-- SOURCE OF TRUTH: absent from db/schema.ts and the drizzle snapshot on purpose
-- — docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §7.
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. NO CAPABILITY IS ENABLED.
--
-- ============================================================================
-- THIS SUPERSEDES db/prepared/grounding_0001_evidence_chunks.sql
-- ============================================================================
-- grounding_0001 has never been applied to any database (its gate, the G2
-- grounding addendum, has not run), so superseding it costs nothing and repairs
-- three things that an additive edit could not:
--
--   1. `UNIQUE (evidence_id, chunk_index)` is not merely incomplete, it is
--      INCOMPATIBLE with GR-002. With a version history, version 2 of a
--      document collides with version 1 on chunk_index 0. That constraint makes
--      the thing GR-002 asks for unrepresentable, so it has to go — and
--      grounding_0001's own §2 refuses to drop a uniqueness guarantee, by
--      design. The correct scope is the VERSION, not the evidence item.
--
--   2. Its shape guard ABORTS when the table exists with missing columns. That
--      is the right behaviour and it is precisely why the six columns GR-001
--      asks for cannot be added by an ALTER in a follow-up script: the guard
--      would have to be edited too, and at that point the file is a different
--      package wearing the old number, with the old package's gate evidence
--      still attached to it.
--
--   3. It couples to the G5 P3 decision (pgvector vs. lexical) that has NOT
--      been made. GR-001 §4 explicitly places vector indexes and
--      CREATE EXTENSION outside this request. This package is pgvector-free —
--      `SET search_path = public` alone, no extension, no `vector` type — so
--      persisting provenance no longer waits on a retrieval decision it does
--      not depend on. The `embedding vector(N)` column arrives additively under
--      G5 P3 as its own package; `embedding_provider_id` ships HERE so that
--      follow-up can add the vector and its pairing invariant together instead
--      of backfilling a provider onto rows that already have vectors.
--
-- An operator who already applied grounding_0001 must run
-- grounding_0001_rollback.sql first; the shape guard in section 0 says so by
-- name rather than reporting a generic mismatch.
--
-- ============================================================================
-- WHAT MAKES A CITATION VERIFIABLE, AND WHY EACH COLUMN IS HERE
-- ============================================================================
-- Given the sealed original file, a third party must be able to re-run
-- normalization at the stated version, slice the stated span, hash the result,
-- and get `content_hash` back. Every column below is a link in that chain:
--
--   raw_content_hash        the bytes that were sealed at upload
--   normalized_content_hash THE COORDINATE SPACE. char_start/char_end mean
--                           nothing without it: an anchor produced under one
--                           normalization can otherwise be resolved against
--                           text produced under another, with both offsets in
--                           range and the quoted passage wrong. GR-001 calls
--                           this the gravest gap in the old shape and it is.
--   normalization_version   a change invalidates every stored offset
--   chunker_version         a change invalidates boundaries, not coordinates
--   injection_scanner_version  lets an old scan be found and redone WITHOUT
--                           re-extracting the document
--   version_id              which byte-state of the document
--   chunk_id                the content-addressed identity a citation quotes.
--                           The uuid primary key cannot serve: it is not
--                           recomputable from the sealed file, so it cannot
--                           anchor a claim anyone else can check.
--
-- RUN AS ONE TRANSACTION:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent AND convergent. No CREATE INDEX CONCURRENTLY.

SET search_path = public;
SET lock_timeout = '5s';
-- ============================================================
-- 0. Preconditions + shape guard (superuser window)
-- ============================================================
DO $$
DECLARE
  mismatched    text;
  missing_roles text;
  legacy_shape  boolean;
BEGIN
  -- HOSTED VARIANT (Train 5B, generated — do not edit by hand).
  -- The superuser check below was replaced by a capability assertion installed by
  -- db/prepared/stella_hosted_0001_managed_role_bootstrap.sql. Original message,
  -- preserved verbatim so the refusal it encoded stays reviewable:
  --   grounding_0003 aborted: must run as a SUPERUSER (current_user=%). It transfers function ownership to uellix_cap_grounding, which requires it.
  PERFORM uellix_bootstrap.assert_hosted_capabilities('grounding_0003_evidence_chunks');

  -- grounding_0002 is a hard dependency: this table's rows are meaningless
  -- without the version they belong to, and the FK below has nothing to point
  -- at.
  IF to_regclass('public.evidence_document_versions') IS NULL THEN
    RAISE EXCEPTION 'grounding_0003 aborted: requires grounding_0002 (public.evidence_document_versions is absent). Apply db/prepared/grounding_0002_document_versions.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_grounding')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_grounding') THEN
    RAISE EXCEPTION 'grounding_0003 aborted: requires grounding_0002 (schema uellix_grounding or role uellix_cap_grounding is absent).';
  END IF;

  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO missing_roles
  FROM (VALUES ('uellix_owner'), ('uellix_app'), ('uellix_auditor'),
               ('anon'), ('authenticated'), ('service_role')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0003 aborted: missing role(s): %.', missing_roles;
  END IF;

  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.evidence_items') IS NULL THEN
    RAISE EXCEPTION 'grounding_0003 aborted: organizations, projects or evidence_items is missing — this database is not at the expected migration baseline.';
  END IF;

  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'grounding_0003 aborted: RLS helpers not found — apply db/migrations/0031_rls_core.sql first.';
  END IF;

  -- 0c. Shape guard. Two outcomes, and telling them apart is the point: a table
  --     left by grounding_0001 gets a message naming that package and its
  --     rollback, because "add the missing columns" is the wrong instruction
  --     there — the legacy UNIQUE has to go too.
  IF to_regclass('public.evidence_chunks') IS NOT NULL THEN
    legacy_shape := EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.evidence_chunks'::regclass
        AND conname = 'evidence_chunks_evidence_chunk_unique'
    );

    SELECT string_agg(
             format('%s (expected %s%s)', e.col, e.typ,
                    CASE WHEN e.nul = 'NO' THEN ' NOT NULL' ELSE ' NULL' END),
             ', ' ORDER BY e.col)
      INTO mismatched
    FROM (VALUES
      ('id',                        'uuid',                     'NO'),
      ('chunk_id',                  'character',                'NO'),
      ('organization_id',           'uuid',                     'NO'),
      ('project_id',                'uuid',                     'NO'),
      ('evidence_id',               'uuid',                     'NO'),
      ('document_version_id',       'uuid',                     'NO'),
      ('version_id',                'character',                'NO'),
      ('raw_content_hash',          'character',                'NO'),
      ('normalized_content_hash',   'character',                'NO'),
      ('chunk_index',               'integer',                  'NO'),
      ('content',                   'text',                     'YES'),
      ('content_hash',              'character',                'NO'),
      ('char_start',                'integer',                  'NO'),
      ('char_end',                  'integer',                  'NO'),
      ('page',                      'integer',                  'YES'),
      ('section_index',             'integer',                  'YES'),
      ('normalization_version',     'character varying',        'NO'),
      ('chunker_version',           'character varying',        'NO'),
      ('injection_scanner_version', 'character varying',        'NO'),
      ('signals',                   'jsonb',                    'NO'),
      ('canonical_chunk_id',        'character',                'YES'),
      ('embedding_provider_id',     'character varying',        'YES'),
      ('created_at',                'timestamp with time zone', 'NO')
    ) AS e(col, typ, nul)
    LEFT JOIN information_schema.columns c
           ON c.table_schema = 'public'
          AND c.table_name   = 'evidence_chunks'
          AND c.column_name  = e.col
          AND c.data_type    = e.typ
          AND c.is_nullable  = e.nul
    WHERE c.column_name IS NULL;

    IF mismatched IS NOT NULL AND legacy_shape THEN
      RAISE EXCEPTION
        'grounding_0003 aborted: public.evidence_chunks exists in the SUPERSEDED grounding_0001 shape (constraint evidence_chunks_evidence_chunk_unique is present). That constraint scopes uniqueness to (evidence_id, chunk_index), which makes a second document version unrepresentable, and this script will not drop a uniqueness guarantee. Apply db/prepared/grounding_0001_rollback.sql first, then re-run this package. Missing or mismatched columns: %.',
        mismatched;
    ELSIF mismatched IS NOT NULL THEN
      RAISE EXCEPTION
        'grounding_0003 aborted: public.evidence_chunks already exists with an INCOMPATIBLE shape. Missing or mismatched columns: %. This script never ALTERs COLUMNS of an existing table — resolve manually and re-run.',
        mismatched;
    END IF;
  END IF;
END $$;
-- authority: canonical role context — this statement must be created by uellix_owner
SET ROLE uellix_owner;
CREATE TABLE IF NOT EXISTS public.evidence_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- deriveChunkId(versionId, chunkIndex, contentHash). This is what a Stella
  -- answer cites. Not the primary key: `id` keeps the house convention and
  -- gives FKs a narrow target, while chunk_id carries identity that can be
  -- recomputed from the sealed file by someone who does not trust this system.
  chunk_id char(64) NOT NULL,

  -- GroundingScope, denormalised on purpose. project_id is reachable by join
  -- through evidence_items; carrying it here is the same double belt the rest
  -- of the pipeline uses (RLS plus an explicit filter), extended to the project
  -- level. NOT NULL because evidence_items.project_id is NOT NULL — see the
  -- note in grounding_0002.
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),

  -- CASCADE, unlike the version table: this is a derived, regenerable index
  -- over the sealed file, not an audit trail. Losing it to a deletion loses
  -- nothing that cannot be rebuilt from Storage plus lib/grounding.
  evidence_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  -- TRAIN 3 HARDENING: no inline REFERENCES here on purpose. The FK is
  -- declared as the table-level CONSTRAINT evidence_chunks_version_scope_fk
  -- below, over this column PLUS every scope/provenance column, so "this
  -- chunk's version exists" and "this chunk's scope and provenance agree with
  -- that version" become ONE un-bypassable check instead of a plain FK for
  -- existence plus an RLS RESTRICTIVE policy for consistency that the table
  -- OWNER does not observe.
  document_version_id uuid NOT NULL,

  -- The verification chain, carried on the row rather than reached by join.
  -- A join can be written wrong; a column cannot be forgotten.
  version_id char(64) NOT NULL,
  raw_content_hash char(64) NOT NULL,
  -- ChunkLocation.coordinateSpace. char_start/char_end are offsets into the
  -- text with THIS digest and no other.
  normalized_content_hash char(64) NOT NULL,

  -- 0-based, in document order. NOT contiguous when suppressed occurrences are
  -- not stored: indexes are assigned before deduplication and kept afterwards,
  -- so a gap says "the chunk that would have sat here duplicated an earlier
  -- one". Nothing here may assume contiguity.
  chunk_index integer NOT NULL,

  -- NULL exactly when this row is a SUPPRESSED occurrence (canonical_chunk_id
  -- is set). A suppressed occurrence is a location, not a passage: its text is
  -- byte-identical to the canonical chunk's by definition, so storing it again
  -- would duplicate private document text for no informational gain. The
  -- biconditional CHECK below makes the two shapes mutually exclusive.
  content text,
  content_hash char(64) NOT NULL,

  char_start integer NOT NULL,
  char_end integer NOT NULL,
  -- 1-based page when the source paginates.
  page integer,
  -- Index into the version's sections. section_LABEL is deliberately absent:
  -- GR-001 §4 excludes it, and a page marker says where a page begins and
  -- nothing more — inventing a heading is exactly what a provenance layer
  -- must not do.
  section_index integer,

  normalization_version varchar(32) NOT NULL,
  chunker_version varchar(32) NOT NULL,
  injection_scanner_version varchar(32) NOT NULL,

  -- PromptInjectionSignal[] found in THIS chunk's text. Always present,
  -- possibly empty, so a consumer cannot mistake "not scanned" for "clean" —
  -- which is why the column is NOT NULL with a default rather than nullable.
  signals jsonb DEFAULT '[]'::jsonb NOT NULL,

  -- The deduplication relation. NULL means this row IS the canonical chunk;
  -- otherwise it holds the chunk_id that was kept. Keeping suppressed
  -- occurrences answers "where else does this sentence appear?" without ever
  -- letting a citation silently relocate to a different page.
  canonical_chunk_id char(64),

  -- Which embedding provider produced this row's vector. The vector column
  -- itself arrives with the G5 P3 follow-up package; the provider ships now so
  -- that follow-up can add the vector and the "provider present iff vector
  -- present" invariant in one step, instead of backfilling a provider onto
  -- rows that already carry vectors from an unknown one. Without it, a change
  -- of provider is undetectable: the index quietly mixes two incomparable
  -- vector spaces and the bug surfaces as "retrieval got worse".
  embedding_provider_id varchar(64),

  created_at timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT evidence_chunks_chunk_id_unique UNIQUE (chunk_id),
  -- Uniqueness scoped to the VERSION, not the evidence item. This is the
  -- constraint grounding_0001 got wrong.
  CONSTRAINT evidence_chunks_version_index_unique UNIQUE (document_version_id, chunk_index),

  CONSTRAINT evidence_chunks_chunk_index_check CHECK (chunk_index >= 0),
  -- Half-open [start, end): an empty span cannot anchor a citation, so
  -- char_end > char_start rather than >=.
  CONSTRAINT evidence_chunks_char_range_check CHECK (char_start >= 0 AND char_end > char_start),
  CONSTRAINT evidence_chunks_location_check
    CHECK ((page IS NULL OR page >= 1) AND (section_index IS NULL OR section_index >= 0)),
  -- One constraint over every digest, plus the acyclicity of the dedup
  -- relation: a chunk cannot be a duplicate of itself, which would make every
  -- "which one survived?" walk non-terminating.
  CONSTRAINT evidence_chunks_hash_shape_check
    CHECK (chunk_id ~ '^[0-9a-f]{64}$'
           AND version_id ~ '^[0-9a-f]{64}$'
           AND raw_content_hash ~ '^[0-9a-f]{64}$'
           AND normalized_content_hash ~ '^[0-9a-f]{64}$'
           AND content_hash ~ '^[0-9a-f]{64}$'
           AND (canonical_chunk_id IS NULL
                OR (canonical_chunk_id ~ '^[0-9a-f]{64}$' AND canonical_chunk_id <> chunk_id))),
  -- Canonical rows carry text; suppressed occurrences carry none. Biconditional
  -- rather than two one-way CHECKs so neither shape can drift into the other.
  CONSTRAINT evidence_chunks_content_presence_check
    CHECK ((canonical_chunk_id IS NULL) = (content IS NOT NULL)),
  CONSTRAINT evidence_chunks_signals_array_check
    CHECK (jsonb_typeof(signals) = 'array'),
  CONSTRAINT evidence_chunks_pipeline_version_check
    CHECK (normalization_version <> '' AND chunker_version <> '' AND injection_scanner_version <> ''
           AND (embedding_provider_id IS NULL OR embedding_provider_id <> '')),

  -- ============================================================
  -- TRAIN 3 HARDENING (risks #1, #2, #5) — see the header note below section 2
  -- for the full argument. Two composite foreign keys, both un-bypassable by
  -- the table owner because FOREIGN KEY has no owner exemption (unlike RLS).
  -- ============================================================

  -- FK target: a chunk's own identity plus its full scope/provenance tuple.
  -- Trivially unique — chunk_id alone is already UNIQUE — but PostgreSQL only
  -- accepts a FK whose referenced side is backed by a UNIQUE/PK constraint
  -- over EXACTLY the referencing column list.
  CONSTRAINT evidence_chunks_identity_scope_unique
    UNIQUE (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash),

  -- "This chunk's version exists, and this chunk's scope and provenance agree
  -- with it" — replaces what the RESTRICTIVE scope_consistency policy (section
  -- 6) stated only for RLS-bound roles. ON DELETE CASCADE mirrors the rest of
  -- this table's posture: a derived, regenerable index, unlike the version
  -- history it points to.
  CONSTRAINT evidence_chunks_version_scope_fk
    FOREIGN KEY (document_version_id, organization_id, project_id, evidence_id, version_id,
                 raw_content_hash, normalized_content_hash, normalization_version, chunker_version)
    REFERENCES public.evidence_document_versions (id, organization_id, project_id, evidence_id, version_id,
                 raw_content_hash, normalized_content_hash, normalization_version, chunker_version)
    ON DELETE CASCADE,

  -- The dedup relation's referential integrity. canonical_chunk_id must name a
  -- chunk that EXISTS and shares this row's organization, project, evidence
  -- item, document version AND content_hash — "the same passage, the same
  -- document, the same tenant" — closing risk #1 (no FK existed at all: any
  -- 64-hex string was accepted, canonical or not, in scope or out of it).
  --
  -- This does NOT by itself stop a chain (A -> B -> C) or a cycle (A -> B,
  -- B -> A): a FK only proves the target row exists and matches scope, not
  -- that the target is ITSELF canonical. That half of risk #2 is closed by
  -- trg_evidence_chunks_canonical_integrity in section 7b, which requires the
  -- target's OWN canonical_chunk_id to be NULL — so canonical_chunk_id can
  -- only ever point one level deep, at a row nothing else points through, and
  -- a chain or a cycle of any length becomes unrepresentable rather than
  -- merely undetected. Self-reference (A -> A) is already excluded by
  -- evidence_chunks_hash_shape_check's `canonical_chunk_id <> chunk_id`.
  CONSTRAINT evidence_chunks_canonical_fk
    FOREIGN KEY (canonical_chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)
    REFERENCES public.evidence_chunks (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)
    ON DELETE CASCADE
);
RESET ROLE;
-- authority: open W06.S1 (OWNER) as uellix_owner
SET ROLE uellix_owner;
-- ============================================================
-- 2. Constraint reconciliation — convergent, by DEFINITION
-- ============================================================
-- Every statement is a LITERAL — no `EXECUTE format(...)`, no variable, no
-- concatenation. The static contract in tests/helpers/sql-structure.ts refuses
-- dynamic SQL rather than guessing at it (`unparsed-security-statement`), so a
-- composed ALTER would be a statement no gate can judge.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_chunk_index_check';
  IF def IS NULL OR position('chunk_index >= 0' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_chunk_index_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_chunk_index_check CHECK (chunk_index >= 0);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_char_range_check';
  -- Both halves probed: a stale definition keeping `char_start >= 0` while
  -- relaxing the ordering to `>=` would admit empty spans, and an empty span
  -- quotes nothing while looking like a valid anchor.
  IF def IS NULL
     OR position('char_start >= 0' in def) = 0
     OR position('char_end > char_start' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_char_range_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_char_range_check CHECK (char_start >= 0 AND char_end > char_start);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_location_check';
  IF def IS NULL
     OR position('page >= 1' in def) = 0
     OR position('section_index >= 0' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_location_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_location_check
      CHECK ((page IS NULL OR page >= 1) AND (section_index IS NULL OR section_index >= 0));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_hash_shape_check';
  -- Every digest column is probed by NAME, plus the acyclicity clause. A stale
  -- definition that kept the pattern and dropped one column would otherwise
  -- survive, and the dropped column is the one that stops being validated.
  IF def IS NULL
     OR position('^[0-9a-f]{64}$' in def) = 0
     OR position('chunk_id' in def) = 0
     OR position('version_id' in def) = 0
     OR position('raw_content_hash' in def) = 0
     OR position('normalized_content_hash' in def) = 0
     OR position('content_hash' in def) = 0
     OR position('canonical_chunk_id' in def) = 0
     OR position('<> chunk_id' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_hash_shape_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_hash_shape_check
      CHECK (chunk_id ~ '^[0-9a-f]{64}$'
             AND version_id ~ '^[0-9a-f]{64}$'
             AND raw_content_hash ~ '^[0-9a-f]{64}$'
             AND normalized_content_hash ~ '^[0-9a-f]{64}$'
             AND content_hash ~ '^[0-9a-f]{64}$'
             AND (canonical_chunk_id IS NULL
                  OR (canonical_chunk_id ~ '^[0-9a-f]{64}$' AND canonical_chunk_id <> chunk_id)));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_content_presence_check';
  IF def IS NULL
     OR position('canonical_chunk_id IS NULL' in def) = 0
     OR position('content IS NOT NULL' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_content_presence_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_content_presence_check
      CHECK ((canonical_chunk_id IS NULL) = (content IS NOT NULL));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_signals_array_check';
  IF def IS NULL OR position('jsonb_typeof' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_signals_array_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_signals_array_check CHECK (jsonb_typeof(signals) = 'array');
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_pipeline_version_check';
  IF def IS NULL
     OR position('normalization_version' in def) = 0
     OR position('chunker_version' in def) = 0
     OR position('injection_scanner_version' in def) = 0
     OR position('embedding_provider_id' in def) = 0 THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_pipeline_version_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_pipeline_version_check
      CHECK (normalization_version <> '' AND chunker_version <> '' AND injection_scanner_version <> ''
             AND (embedding_provider_id IS NULL OR embedding_provider_id <> ''));
  END IF;

  -- --- UNIQUE: added when missing, never silently replaced ------------------
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_chunk_id_unique';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_chunk_id_unique UNIQUE (chunk_id);
  ELSIF position('UNIQUE (chunk_id)' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0003 aborted: constraint evidence_chunks_chunk_id_unique exists with an unexpected definition (%). Resolve manually — this script will not drop a uniqueness guarantee.',
      def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_version_index_unique';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_version_index_unique UNIQUE (document_version_id, chunk_index);
  ELSIF position('UNIQUE (document_version_id, chunk_index)' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0003 aborted: constraint evidence_chunks_version_index_unique exists with an unexpected definition (%). Resolve manually — this script will not drop a uniqueness guarantee.',
      def;
  END IF;

  -- --- TRAIN 3 HARDENING: the composite FK target, and the two composite FKs
  --     themselves. CREATE TABLE IF NOT EXISTS is a no-op against a table that
  --     already exists, so on a database where an earlier (pre-train-3)
  --     evidence_chunks is already present, these three would otherwise never
  --     be added. Same asymmetry as every UNIQUE above: added when missing,
  --     the script aborts rather than silently replacing a stale definition.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_identity_scope_unique';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_identity_scope_unique
      UNIQUE (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash);
  ELSIF position('UNIQUE (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0003 aborted: constraint evidence_chunks_identity_scope_unique exists with an unexpected definition (%). Resolve manually — this script will not drop a uniqueness guarantee.',
      def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_version_scope_fk';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_version_scope_fk
      FOREIGN KEY (document_version_id, organization_id, project_id, evidence_id, version_id,
                   raw_content_hash, normalized_content_hash, normalization_version, chunker_version)
      REFERENCES public.evidence_document_versions (id, organization_id, project_id, evidence_id, version_id,
                   raw_content_hash, normalized_content_hash, normalization_version, chunker_version)
      ON DELETE CASCADE;
  ELSIF position('REFERENCES evidence_document_versions(id, organization_id, project_id, evidence_id, version_id, raw_content_hash, normalized_content_hash, normalization_version, chunker_version)' in def) = 0
     OR position('ON DELETE CASCADE' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0003 aborted: constraint evidence_chunks_version_scope_fk exists with an unexpected definition (%). Resolve manually — this script will not drop a referential guarantee.',
      def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_canonical_fk';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_canonical_fk
      FOREIGN KEY (canonical_chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)
      REFERENCES public.evidence_chunks (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)
      ON DELETE CASCADE;
  ELSIF position('REFERENCES evidence_chunks(chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)' in def) = 0
     OR position('ON DELETE CASCADE' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0003 aborted: constraint evidence_chunks_canonical_fk exists with an unexpected definition (%). Resolve manually — this script will not drop a referential guarantee.',
      def;
  END IF;
END $$;
-- ============================================================
-- 3. Deduplication uniqueness — a PARTIAL unique index
-- ============================================================
-- GR-001 §3 asks for UNIQUE (evidence_id, version_id, content_hash): the same
-- passage is stored once per document version, and never deduplicated ACROSS
-- evidence items (two uploads of the same annex are two pieces of evidence and
-- both must stay separately citable).
--
-- It is a PARTIAL index, not a table constraint, and the predicate is the whole
-- point: a suppressed occurrence shares its content_hash with the chunk that
-- survived — that is what "duplicate" means — so a total constraint would make
-- the deduplication relation unstorable. Restricted to the canonical set, the
-- guarantee is exactly the one GR-001 describes: at most one RETRIEVABLE chunk
-- per (evidence item, version, content).
--
-- Idempotent by name; never dropped and re-added, for the same reason section 2
-- refuses to replace a UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_chunks_version_content
  ON public.evidence_chunks (evidence_id, version_id, content_hash)
  WHERE canonical_chunk_id IS NULL;
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid) INTO def
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.evidence_chunks'::regclass
    AND c.relname = 'uq_evidence_chunks_version_content';

  IF def IS NULL THEN
    RAISE EXCEPTION 'grounding_0003 aborted: the deduplication index was not created';
  END IF;
  IF position('UNIQUE INDEX' in def) = 0
     OR position('canonical_chunk_id IS NULL' in def) = 0
     OR position('evidence_id, version_id, content_hash' in def) = 0 THEN
    RAISE EXCEPTION
      'grounding_0003 aborted: uq_evidence_chunks_version_content exists with an unexpected definition (%). A non-unique or unpredicated variant would silently drop the deduplication guarantee.',
      def;
  END IF;
END $$;
-- ============================================================
-- 4. Indexes (no CONCURRENTLY — one transaction)
-- ============================================================
-- Retrieval reads a whole version in document order.
CREATE INDEX IF NOT EXISTS idx_evidence_chunks_version_order
  ON public.evidence_chunks (document_version_id, chunk_index);
-- Every scoped read filters organization AND project explicitly, on top of RLS.
CREATE INDEX IF NOT EXISTS idx_evidence_chunks_scope
  ON public.evidence_chunks (organization_id, project_id);
-- "Where else does this passage appear?" walks the dedup relation.
CREATE INDEX IF NOT EXISTS idx_evidence_chunks_canonical
  ON public.evidence_chunks (canonical_chunk_id)
  WHERE canonical_chunk_id IS NOT NULL;
-- ANN / vector indexes are deliberately absent: that is the G5 P3 decision and
-- GR-001 §4 places it outside this request.

-- ============================================================
-- 5. Grants — deny by default, then the minimum back
-- ============================================================
REVOKE ALL ON public.evidence_chunks FROM PUBLIC;
REVOKE ALL ON public.evidence_chunks FROM anon;
REVOKE ALL ON public.evidence_chunks FROM authenticated;
REVOKE ALL ON public.evidence_chunks FROM service_role;
REVOKE ALL ON public.evidence_chunks FROM uellix_app;
REVOKE ALL ON public.evidence_chunks FROM uellix_writer;
REVOKE ALL ON public.evidence_chunks FROM uellix_auditor;
-- SELECT only for every principal that reads; writes go through section 8.
--
-- No SELECT is granted "so the joins work". A reader that needs a chunk's
-- version reads the version table, which has its own policy bounded by the same
-- organization; widening one table's grant to make another table's query
-- convenient is how a boundary becomes decorative.
GRANT SELECT ON public.evidence_chunks TO authenticated;
GRANT SELECT ON public.evidence_chunks TO uellix_app;
GRANT SELECT ON public.evidence_chunks TO uellix_auditor;
-- DELETE, and only for the definer: this index is regenerable, and reindexing a
-- version is delete + insert. The version HISTORY has no such grant anywhere —
-- that is the difference between a derived index and a chain of custody.
GRANT SELECT, INSERT, DELETE ON public.evidence_chunks TO uellix_cap_grounding;
-- ============================================================
-- 6. RLS — organization and project isolation
-- ============================================================
ALTER TABLE public.evidence_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evidence_chunks_select" ON public.evidence_chunks;
CREATE POLICY "evidence_chunks_select"
ON public.evidence_chunks FOR SELECT
TO authenticated, uellix_app, uellix_auditor
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);
DROP POLICY IF EXISTS "evidence_chunks_definer_write" ON public.evidence_chunks;
CREATE POLICY "evidence_chunks_definer_write"
ON public.evidence_chunks FOR INSERT
TO uellix_cap_grounding
WITH CHECK (
  -- The chunk's scope and version identity must agree with the version row it
  -- claims to belong to. Stated in the database, not only in the function that
  -- currently upholds it: a chunk filed under another tenant's organization, or
  -- under a version that belongs to a different document, is unrepresentable.
  EXISTS (
    SELECT 1 FROM public.evidence_document_versions v
    WHERE v.id = evidence_chunks.document_version_id
      AND v.organization_id = evidence_chunks.organization_id
      AND v.project_id = evidence_chunks.project_id
      AND v.evidence_id = evidence_chunks.evidence_id
      AND v.version_id = evidence_chunks.version_id
      AND v.raw_content_hash = evidence_chunks.raw_content_hash
      AND v.normalized_content_hash = evidence_chunks.normalized_content_hash
      AND v.normalization_version = evidence_chunks.normalization_version
      AND v.chunker_version = evidence_chunks.chunker_version
  )
);
DROP POLICY IF EXISTS "evidence_chunks_definer_delete" ON public.evidence_chunks;
CREATE POLICY "evidence_chunks_definer_delete"
ON public.evidence_chunks FOR DELETE
TO uellix_cap_grounding
USING (
  EXISTS (
    SELECT 1 FROM public.evidence_document_versions v
    WHERE v.id = evidence_chunks.document_version_id
      AND v.organization_id = evidence_chunks.organization_id
  )
);
-- RESTRICTIVE: ANDs with every policy above and can only narrow. It restates
-- the scope-consistency invariant for every command and every role, so a future
-- permissive policy cannot widen past it by accident.
DROP POLICY IF EXISTS "evidence_chunks_scope_consistency" ON public.evidence_chunks;
CREATE POLICY "evidence_chunks_scope_consistency"
ON public.evidence_chunks AS RESTRICTIVE FOR ALL
TO authenticated, uellix_app, uellix_auditor, uellix_cap_grounding
USING (
  EXISTS (
    SELECT 1 FROM public.evidence_document_versions v
    WHERE v.id = evidence_chunks.document_version_id
      AND v.organization_id = evidence_chunks.organization_id
      AND v.project_id = evidence_chunks.project_id
      AND v.evidence_id = evidence_chunks.evidence_id
  )
);
-- ============================================================
-- 7. Immutability of the provenance chain
-- ============================================================
-- Chunks are NOT append-only in the sense the version history is: a reindex
-- legitimately deletes and re-inserts them. What must never happen is an UPDATE
-- — rewriting a hash, an offset or a scope in place. That is the mutation which
-- keeps the row's identity while changing what it claims, so a citation that
-- resolved yesterday quotes a different passage today with nothing to show for
-- it.
--
-- So: UPDATE forbidden for EVERY role including the owner (a trigger is the
-- only control that reaches the owner), DELETE allowed only to the definer via
-- the grant and policy above, TRUNCATE forbidden outright — it is a delete that
-- no policy governs and no row trigger can see.
DROP TRIGGER IF EXISTS trg_evidence_chunks_no_update ON public.evidence_chunks;
CREATE TRIGGER trg_evidence_chunks_no_update
  BEFORE UPDATE ON public.evidence_chunks
  FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();
DROP TRIGGER IF EXISTS trg_evidence_chunks_no_truncate ON public.evidence_chunks;
CREATE TRIGGER trg_evidence_chunks_no_truncate
  BEFORE TRUNCATE ON public.evidence_chunks
  FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();
COMMENT ON TRIGGER trg_evidence_chunks_no_update ON public.evidence_chunks IS
  'GR-001 (prepared grounding_0003): a chunk is never rewritten in place. Reindexing is DELETE + INSERT, so an UPDATE could only be a provenance claim being changed under a stable identity.';
COMMENT ON TRIGGER trg_evidence_chunks_no_truncate ON public.evidence_chunks IS
  'GR-001 (prepared grounding_0003): TRUNCATE is forbidden — it is a delete that no RLS policy governs and no row trigger can observe.';
-- ============================================================
-- 7b. Canonical-chunk acyclicity (TRAIN 3 HARDENING — risk #2)
-- ============================================================
-- evidence_chunks_canonical_fk (section 1) proves canonical_chunk_id names a
-- row that EXISTS and shares this row's scope, evidence item, document
-- version and content_hash. It does NOT prove that row is itself canonical —
-- a FOREIGN KEY can compare column values, not another row's nullability — so
-- a FK alone still permits a chain (A -> B -> C) or a cycle (A -> B, B -> A).
--
-- This trigger closes that: the target's OWN canonical_chunk_id must be NULL.
-- Since canonical_chunk_id can then only ever point at a row nothing else
-- points through, the relation is AT MOST ONE LEVEL DEEP by construction —
-- which is a stronger statement than "no cycle of length 2": no chain of any
-- length, and therefore no cycle of any length, is representable at all.
-- Self-reference (A -> A) is excluded separately by
-- evidence_chunks_hash_shape_check's `canonical_chunk_id <> chunk_id`.
--
-- AFTER, not BEFORE: it must observe the FINAL state of the row it looks up,
-- and — together with insert_evidence_chunks' two-pass insert above — every
-- canonical row a batch contributes is already committed within this
-- transaction before any duplicate naming it is checked.
CREATE OR REPLACE FUNCTION public.uellix_check_canonical_chunk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_canonical char(64);
BEGIN
  IF NEW.canonical_chunk_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ch.canonical_chunk_id INTO v_target_canonical
  FROM public.evidence_chunks ch
  WHERE ch.chunk_id = NEW.canonical_chunk_id;

  -- Existence and scope agreement are already the job of
  -- evidence_chunks_canonical_fk; NOT FOUND here would mean that FK did not
  -- fire, which never happens for a real INSERT/UPDATE. Failing closed rather
  -- than assuming it is cheap and correct either way.
  IF NOT FOUND OR v_target_canonical IS NOT NULL THEN
    RAISE EXCEPTION 'grounding: canonical_chunk_id must reference a canonical chunk (one whose own canonical_chunk_id is NULL) — chained or cyclic duplicate references are not representable'
      USING ERRCODE = 'U0105';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_evidence_chunks_canonical_integrity ON public.evidence_chunks;
CREATE TRIGGER trg_evidence_chunks_canonical_integrity
  AFTER INSERT ON public.evidence_chunks
  FOR EACH ROW EXECUTE FUNCTION public.uellix_check_canonical_chunk();
COMMENT ON TRIGGER trg_evidence_chunks_canonical_integrity ON public.evidence_chunks IS
  'GR-001 hardening (train 3, risk #2): canonical_chunk_id may only reference a chunk that is itself canonical, so a chain or a cycle of any length is unrepresentable rather than merely undetected.';
-- TRAIN 3 HARDENING — risk #4, same reasoning as grounding_0002 §7b: a plain
-- trigger's default tgenabled='O' does not fire under
-- session_replication_role = replica. ENABLE ALWAYS fires in origin, local AND
-- replica. Verified convergent under apply/rollback/reapply
-- (scripts/grounding-dry-run.sh) — it does not survive a DROP TABLE.
ALTER TABLE public.evidence_chunks ENABLE ALWAYS TRIGGER trg_evidence_chunks_no_update;
ALTER TABLE public.evidence_chunks ENABLE ALWAYS TRIGGER trg_evidence_chunks_no_truncate;
ALTER TABLE public.evidence_chunks ENABLE ALWAYS TRIGGER trg_evidence_chunks_canonical_integrity;
COMMENT ON TABLE public.evidence_chunks IS
  'Anchored, provenance-carrying grounding index over evidence documents (GR-001, prepared grounding_0003; supersedes grounding_0001). Derived and regenerable from the sealed file plus lib/grounding; the file remains the source of truth. Rows are never UPDATEd. Managed outside the drizzle chain — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.';
RESET ROLE;
-- authority: close W06.S1
-- authority: open W07.S1 (OWNER) as uellix_owner
SET ROLE uellix_owner;
-- ============================================================
-- 8. Governed write and read paths (superuser window)
-- ============================================================

-- ------------------------------------------------------------
-- 8a. insert_evidence_chunks
-- ------------------------------------------------------------
-- Inserts the chunks of ONE version, in one call, and returns how many landed.
--
-- Batch rather than per-chunk: a document produces hundreds of chunks and a
-- per-row round trip would make partial ingestion the normal case. Here the
-- whole set commits or none of it does.
--
-- SCOPE IS DERIVED. The caller names a version row; organization, project,
-- evidence and every pipeline fact come from THAT row. Nothing about the
-- destination is accepted from the payload, so a chunk cannot be filed against
-- another tenant's document however the payload is shaped.
--
-- IDEMPOTENT ON chunk_id. Re-running a partially completed ingestion inserts
-- what is missing and leaves what is there; ON CONFLICT DO NOTHING is safe
-- precisely because chunk_id is content-addressed — a row with that id cannot
-- disagree about its own content.
CREATE OR REPLACE FUNCTION uellix_grounding.insert_evidence_chunks(
  p_document_version_id uuid,
  p_chunks jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_version    public.evidence_document_versions%ROWTYPE;
  v_scanner    varchar(32);
  v_bad        int;
  v_mismatched int;
  v_inserted   int;
  v_batch      int;
BEGIN
  IF p_document_version_id IS NULL THEN
    RAISE EXCEPTION 'grounding: document version id is required' USING ERRCODE = 'U0100';
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'grounding: chunks payload must be a JSON array' USING ERRCODE = 'U0100';
  END IF;

  SELECT * INTO v_version
  FROM public.evidence_document_versions v
  WHERE v.id = p_document_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'grounding: document version not found' USING ERRCODE = 'U0102';
  END IF;

  -- The caller must be inside the version's organization. The definer bypasses
  -- RLS, so this is the only place that boundary can be re-imposed. Same
  -- message as "not found": distinguishing them is a tenancy oracle.
  IF NOT (v_version.organization_id = ANY(public.current_user_org_ids())
          OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'grounding: document version not found' USING ERRCODE = 'U0102';
  END IF;

  -- One scanner version for the whole batch: the payload declares it once, so a
  -- single ingestion cannot record two different scanners for chunks of the
  -- same text and make "which chunks need rescanning?" unanswerable.
  v_scanner := nullif(p_chunks -> 0 ->> 'injection_scanner_version', '');
  IF v_scanner IS NULL THEN
    RAISE EXCEPTION 'grounding: injection_scanner_version is required on every chunk' USING ERRCODE = 'U0100';
  END IF;

  -- Validate the whole payload BEFORE inserting any of it. A CHECK constraint
  -- would also reject these, but as a constraint-violation SQLSTATE the caller
  -- cannot tell a malformed payload from a genuine conflict — and the error
  -- text would quote the offending value. chunk_id is still required and
  -- format-checked here even though TRAIN 3 makes the STORED value
  -- server-derived (below): requiring the caller to state one and comparing
  -- it turns a caller-side bug (wrong version, stale content) into a loud
  -- U0104 instead of a silent divergence from what lib/grounding computed and
  -- already quoted in a citation.
  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(p_chunks) AS c
  WHERE (c ->> 'chunk_id') IS NULL
     OR (c ->> 'chunk_id') !~ '^[0-9a-f]{64}$'
     OR (c ->> 'content_hash') IS NULL
     OR (c ->> 'content_hash') !~ '^[0-9a-f]{64}$'
     OR (c ->> 'chunk_index') IS NULL
     OR (c ->> 'chunk_index')::integer < 0
     OR (c ->> 'char_start') IS NULL
     OR (c ->> 'char_end') IS NULL
     OR (c ->> 'char_start')::integer < 0
     OR (c ->> 'char_end')::integer <= (c ->> 'char_start')::integer
     OR coalesce(c ->> 'injection_scanner_version', '') <> v_scanner
     OR (c ? 'signals' AND jsonb_typeof(c -> 'signals') <> 'array')
     OR ((c ->> 'canonical_chunk_id') IS NOT NULL
         AND (c ->> 'canonical_chunk_id') !~ '^[0-9a-f]{64}$')
     -- content present iff canonical, mirroring the table's biconditional.
     OR ((c ->> 'canonical_chunk_id') IS NULL) <> ((c ->> 'content') IS NOT NULL);

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'grounding: % chunk(s) in this payload are malformed (identity, offsets, scanner version or content/duplicate pairing)', v_bad
      USING ERRCODE = 'U0100';
  END IF;

  -- TRAIN 3 HARDENING (risk #3) — chunk_id is DERIVED here, never trusted from
  -- the payload for storage. The formula is the contract's own —
  -- lib/grounding/contracts/chunks.ts#deriveChunkId's preimage,
  -- "grounding/chunk/v1\n<version_id>\n<chunk_index>\n<content_hash>",
  -- SHA-256, lowercase hex — so a chunk_id a citation already quotes continues
  -- to resolve to the row this function stores. Every row is inserted under
  -- the SERVER-computed value below; the caller's chunk_id is used only to
  -- VERIFY, never to write, so a caller cannot choose a colliding or
  -- out-of-scope identity even by accident.
  --
  -- pg_catalog.sha256 is a builtin — no pgcrypto, so no reference to the
  -- `extensions` schema from a function whose search_path is empty. Same
  -- construction as db/prepared/stella_0006_invitation_capability.sql's token
  -- hash. convert_to pins UTF8 so the digest cannot depend on client_encoding.
  SELECT count(*) INTO v_mismatched
  FROM jsonb_to_recordset(p_chunks) AS c(chunk_id char(64), chunk_index integer, content_hash char(64))
  WHERE c.chunk_id IS DISTINCT FROM pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'grounding/chunk/v1' || chr(10) || v_version.version_id || chr(10) || c.chunk_index::text || chr(10) || c.content_hash,
      'UTF8')),
    'hex');

  IF v_mismatched > 0 THEN
    RAISE EXCEPTION
      'grounding: % chunk(s) carry a chunk_id that does not derive from (version_id, chunk_index, content_hash)', v_mismatched
      USING ERRCODE = 'U0104';
  END IF;

  -- TRAIN 3 HARDENING (risk #2) — inserted in TWO passes, canonical chunks
  -- first. trg_evidence_chunks_canonical_integrity (section 7b) requires a
  -- duplicate's canonical_chunk_id to name a row that ALREADY has
  -- canonical_chunk_id IS NULL, and a plain trigger (not a deferrable
  -- CONSTRAINT TRIGGER) fires immediately as each row lands — so within a
  -- SINGLE statement a duplicate could be physically inserted before the
  -- canonical row it names, an ordering the JSON array does not promise. Two
  -- statements in the same transaction remove the ambiguity: every canonical
  -- row this batch contributes exists before any duplicate referencing it is
  -- attempted. The two FOREIGN KEYs (evidence_chunks_version_scope_fk,
  -- evidence_chunks_canonical_fk) have no such concern — PostgreSQL checks
  -- FOREIGN KEY constraints at the end of each statement, not per row, so a
  -- canonical inserted in pass 1 already satisfies a duplicate's FK in pass 2.
  --
  -- Explicit column list on both sides, in both passes. `SELECT *` over
  -- jsonb_to_recordset would bind by position, so reordering the record
  -- definition would silently write offsets into hash columns.
  INSERT INTO public.evidence_chunks (
    chunk_id, organization_id, project_id, evidence_id, document_version_id,
    version_id, raw_content_hash, normalized_content_hash,
    chunk_index, content, content_hash, char_start, char_end,
    page, section_index,
    normalization_version, chunker_version, injection_scanner_version,
    signals, canonical_chunk_id, embedding_provider_id
  )
  SELECT
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        'grounding/chunk/v1' || chr(10) || v_version.version_id || chr(10) || c.chunk_index::text || chr(10) || c.content_hash,
        'UTF8')),
      'hex'),
    v_version.organization_id,
    v_version.project_id,
    v_version.evidence_id,
    v_version.id,
    v_version.version_id,
    v_version.raw_content_hash,
    v_version.normalized_content_hash,
    c.chunk_index,
    c.content,
    c.content_hash,
    c.char_start,
    c.char_end,
    c.page,
    c.section_index,
    v_version.normalization_version,
    v_version.chunker_version,
    v_scanner,
    coalesce(c.signals, '[]'::jsonb),
    c.canonical_chunk_id,
    c.embedding_provider_id
  FROM jsonb_to_recordset(p_chunks) AS c(
    chunk_id char(64),
    chunk_index integer,
    content text,
    content_hash char(64),
    char_start integer,
    char_end integer,
    page integer,
    section_index integer,
    signals jsonb,
    canonical_chunk_id char(64),
    embedding_provider_id varchar(64)
  )
  WHERE c.canonical_chunk_id IS NULL
  ON CONFLICT (chunk_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  INSERT INTO public.evidence_chunks (
    chunk_id, organization_id, project_id, evidence_id, document_version_id,
    version_id, raw_content_hash, normalized_content_hash,
    chunk_index, content, content_hash, char_start, char_end,
    page, section_index,
    normalization_version, chunker_version, injection_scanner_version,
    signals, canonical_chunk_id, embedding_provider_id
  )
  SELECT
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        'grounding/chunk/v1' || chr(10) || v_version.version_id || chr(10) || c.chunk_index::text || chr(10) || c.content_hash,
        'UTF8')),
      'hex'),
    v_version.organization_id,
    v_version.project_id,
    v_version.evidence_id,
    v_version.id,
    v_version.version_id,
    v_version.raw_content_hash,
    v_version.normalized_content_hash,
    c.chunk_index,
    c.content,
    c.content_hash,
    c.char_start,
    c.char_end,
    c.page,
    c.section_index,
    v_version.normalization_version,
    v_version.chunker_version,
    v_scanner,
    coalesce(c.signals, '[]'::jsonb),
    c.canonical_chunk_id,
    c.embedding_provider_id
  FROM jsonb_to_recordset(p_chunks) AS c(
    chunk_id char(64),
    chunk_index integer,
    content text,
    content_hash char(64),
    char_start integer,
    char_end integer,
    page integer,
    section_index integer,
    signals jsonb,
    canonical_chunk_id char(64),
    embedding_provider_id varchar(64)
  )
  WHERE c.canonical_chunk_id IS NOT NULL
  ON CONFLICT (chunk_id) DO NOTHING;

  GET DIAGNOSTICS v_batch = ROW_COUNT;
  v_inserted := v_inserted + v_batch;

  RETURN v_inserted;
END;
$$;
-- ------------------------------------------------------------
-- 8b. finalize_document_ingestion
-- ------------------------------------------------------------
-- Asserts that the number of CANONICAL chunks stored for a version equals what
-- the ingestion core produced, and fails the transaction otherwise.
--
-- This is the step that turns a partial ingestion into a loud failure. Without
-- it, a batch that lost its tail leaves a version that looks fully indexed:
-- retrieval simply never returns the missing passages, and an answer abstains
-- or cites something else with no signal that the document was truncated.
--
-- It counts canonical rows only, because suppressed occurrences are optional —
-- a caller may store the dedup relation or not, and the count must not depend
-- on that choice.
CREATE OR REPLACE FUNCTION uellix_grounding.finalize_document_ingestion(
  p_document_version_id uuid,
  p_expected_chunk_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org    uuid;
  v_actual integer;
BEGIN
  IF p_document_version_id IS NULL OR p_expected_chunk_count IS NULL OR p_expected_chunk_count < 0 THEN
    RAISE EXCEPTION 'grounding: a document version id and a non-negative expected count are required' USING ERRCODE = 'U0100';
  END IF;

  SELECT v.organization_id INTO v_org
  FROM public.evidence_document_versions v
  WHERE v.id = p_document_version_id;

  IF NOT FOUND
     OR NOT (v_org = ANY(public.current_user_org_ids()) OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'grounding: document version not found' USING ERRCODE = 'U0102';
  END IF;

  SELECT count(*) INTO v_actual
  FROM public.evidence_chunks ch
  WHERE ch.document_version_id = p_document_version_id
    AND ch.canonical_chunk_id IS NULL;

  IF v_actual <> p_expected_chunk_count THEN
    RAISE EXCEPTION
      'grounding: ingestion incomplete — % canonical chunk(s) stored, % expected', v_actual, p_expected_chunk_count
      USING ERRCODE = 'U0103';
  END IF;
END;
$$;
-- ------------------------------------------------------------
-- 8c. chunks_in_scope
-- ------------------------------------------------------------
-- Reads the canonical chunks of one version inside an EXACT scope.
--
-- The scope is an argument and it is checked, not derived, on purpose: this is
-- the read path a retrieval layer calls with the scope it believes it is
-- serving, and a mismatch between that belief and the row's actual scope is the
-- bug worth catching. Deriving the scope from the row would make every call
-- succeed and the check meaningless.
--
-- Suppressed occurrences are excluded here rather than left to the caller. They
-- carry no text and must never enter a retrieval result; filtering them at each
-- call site is the kind of remembering that eventually is not done.
CREATE OR REPLACE FUNCTION uellix_grounding.chunks_in_scope(
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
  signals jsonb
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

  IF NOT (p_organization_id = ANY(public.current_user_org_ids())
          OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'grounding: document version not found' USING ERRCODE = 'U0102';
  END IF;

  RETURN QUERY
  SELECT ch.chunk_id, ch.chunk_index, ch.content, ch.content_hash,
         ch.char_start, ch.char_end, ch.page, ch.section_index,
         ch.normalized_content_hash, ch.normalization_version,
         ch.chunker_version, ch.injection_scanner_version, ch.signals
  FROM public.evidence_chunks ch
  WHERE ch.document_version_id = p_document_version_id
    AND ch.organization_id = p_organization_id
    AND ch.project_id = p_project_id
    AND ch.canonical_chunk_id IS NULL
  ORDER BY ch.chunk_index;
END;
$$;
RESET ROLE;
-- authority: close W07.S1
-- authority: open W08.S1 (OWNER_TRANSFER) as uellix_owner
GRANT uellix_cap_grounding TO uellix_owner WITH INHERIT FALSE, SET TRUE;
SET ROLE uellix_owner;
GRANT CREATE ON SCHEMA uellix_grounding TO uellix_cap_grounding;
-- ------------------------------------------------------------
-- 8d. Ownership and ACL
-- ------------------------------------------------------------
ALTER FUNCTION uellix_grounding.insert_evidence_chunks(uuid, jsonb) OWNER TO uellix_cap_grounding;
ALTER FUNCTION uellix_grounding.finalize_document_ingestion(uuid, integer) OWNER TO uellix_cap_grounding;
ALTER FUNCTION uellix_grounding.chunks_in_scope(uuid, uuid, uuid) OWNER TO uellix_cap_grounding;
REVOKE CREATE ON SCHEMA uellix_grounding FROM uellix_cap_grounding;
RESET ROLE;
REVOKE uellix_cap_grounding FROM uellix_owner;
-- authority: close W08.S1
-- authority: open W09.S1 (CAPABILITY) as uellix_cap_grounding
GRANT uellix_cap_grounding TO uellix_migrator WITH INHERIT FALSE, SET TRUE;
SET ROLE uellix_cap_grounding;
REVOKE ALL ON FUNCTION uellix_grounding.insert_evidence_chunks(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_grounding.finalize_document_ingestion(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION uellix_grounding.chunks_in_scope(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_grounding.insert_evidence_chunks(uuid, jsonb) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_grounding.finalize_document_ingestion(uuid, integer) TO uellix_app;
GRANT EXECUTE ON FUNCTION uellix_grounding.chunks_in_scope(uuid, uuid, uuid) TO uellix_app;
COMMENT ON FUNCTION uellix_grounding.insert_evidence_chunks(uuid, jsonb) IS
  'GR-001: inserts the chunks of one document version. Scope and pipeline facts are derived from the version row, never from the payload. Idempotent on chunk_id.';
COMMENT ON FUNCTION uellix_grounding.finalize_document_ingestion(uuid, integer) IS
  'GR-001: fails the transaction unless the stored canonical chunk count matches what the ingestion core produced. Turns a partial ingestion into a loud failure.';
COMMENT ON FUNCTION uellix_grounding.chunks_in_scope(uuid, uuid, uuid) IS
  'GR-001: canonical chunks of one version inside an exact (organization, project) scope. The scope is checked, not derived.';
RESET ROLE;
REVOKE uellix_cap_grounding FROM uellix_migrator;
-- authority: close W09.S1
-- ============================================================
-- 9. Self-verification — assert the end state, in this transaction
-- ============================================================
DO $$
DECLARE
  tbl_oid oid;
  problem text;
  n       int;
BEGIN
  tbl_oid := to_regclass('public.evidence_chunks');
  IF tbl_oid IS NULL THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: the table does not exist after the script ran';
  END IF;

  -- (1) Exactly the 23 contracted columns, no extras.
  SELECT count(*) INTO n FROM pg_attribute
  WHERE attrelid = tbl_oid AND attnum > 0 AND NOT attisdropped;
  IF n <> 23 THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: expected exactly 23 columns, found %', n;
  END IF;

  -- (2) The six columns GR-001 §5 makes acceptance conditional on.
  SELECT string_agg(e.col, ', ' ORDER BY e.col) INTO problem
  FROM (VALUES
    ('chunk_id'), ('version_id'), ('raw_content_hash'),
    ('normalized_content_hash'), ('normalization_version'), ('chunker_version')
  ) AS e(col)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = tbl_oid AND a.attname = e.col
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: GR-001 §2 column(s) missing or nullable: %', problem;
  END IF;

  -- (3) The legacy constraint is GONE. Its presence would mean a second
  --     document version cannot be stored.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = tbl_oid AND conname = 'evidence_chunks_evidence_chunk_unique'
  ) THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: the superseded constraint evidence_chunks_evidence_chunk_unique is still present. It scopes uniqueness to (evidence_id, chunk_index), which makes version 2 of a document unstorable';
  END IF;

  -- (4) The deduplication index is unique AND predicated.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = tbl_oid AND c.relname = 'uq_evidence_chunks_version_content'
      AND i.indisunique
      AND position('canonical_chunk_id IS NULL' in pg_get_indexdef(i.indexrelid)) > 0
  ) THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: uq_evidence_chunks_version_content is missing, not unique, or lost its predicate';
  END IF;

  -- (5) RLS on; four policies; no UPDATE policy at all.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = tbl_oid) THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: ROW LEVEL SECURITY is not enabled';
  END IF;
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid;
  IF n <> 4 THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: expected exactly 4 RLS policies, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = tbl_oid AND polcmd = 'w';
  IF n <> 0 THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: % UPDATE policy(ies) present. A chunk is never rewritten in place', n;
  END IF;

  -- (6) Both immutability triggers, bound to public.uellix_forbid_mutation.
  SELECT count(*) INTO n FROM pg_trigger t
  WHERE t.tgrelid = tbl_oid AND NOT t.tgisinternal
    AND t.tgfoid = to_regprocedure('public.uellix_forbid_mutation()')::oid;
  IF n <> 2 THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: expected 2 triggers bound to public.uellix_forbid_mutation(), found %', n;
  END IF;

  -- (6b) TRAIN 3 HARDENING — risk #2. The canonical-acyclicity trigger, AFTER
  --      INSERT, bound to the new function, distinct from the two
  --      immutability triggers counted above.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = tbl_oid AND NOT t.tgisinternal
      AND t.tgname = 'trg_evidence_chunks_canonical_integrity'
      AND t.tgfoid = to_regprocedure('public.uellix_check_canonical_chunk()')::oid
  ) THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: trg_evidence_chunks_canonical_integrity is missing or bound to the wrong function';
  END IF;

  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = tbl_oid AND NOT tgisinternal;
  IF n <> 3 THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: unexpected trigger count (total %, expected 3: 2 immutability + 1 canonical-acyclicity)', n;
  END IF;

  -- (6c) TRAIN 3 HARDENING — risk #4. Every trigger on this table must be
  --      ENABLE ALWAYS (tgenabled='A'), or session_replication_role=replica
  --      silently disables immutability and canonical-acyclicity alike.
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = tbl_oid AND NOT tgisinternal AND tgenabled = 'A';
  IF n <> 3 THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: % of 3 triggers are ENABLE ALWAYS (tgenabled=''A''); a plain-enabled trigger is skipped under session_replication_role=replica', n;
  END IF;

  -- (6d) TRAIN 3 HARDENING — risks #1 and #5. The two composite FOREIGN KEYs:
  --      scope/provenance consistency against evidence_document_versions, and
  --      canonical_chunk_id's existence + scope match against this table
  --      itself. Both ON DELETE CASCADE, both un-bypassable by the owner.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = tbl_oid AND c.contype = 'f'
      AND c.conname = 'evidence_chunks_version_scope_fk'
      AND c.confrelid = to_regclass('public.evidence_document_versions')
      AND c.confdeltype = 'c'
      AND array_length(c.conkey, 1) = 9
  ) THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: evidence_chunks_version_scope_fk is missing, does not target evidence_document_versions, is not ON DELETE CASCADE, or does not cover all 9 scope/provenance columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = tbl_oid AND c.contype = 'f'
      AND c.conname = 'evidence_chunks_canonical_fk'
      AND c.confrelid = tbl_oid
      AND c.confdeltype = 'c'
      AND array_length(c.conkey, 1) = 6
  ) THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: evidence_chunks_canonical_fk is missing, is not self-referencing, is not ON DELETE CASCADE, or does not cover all 6 identity/scope/hash columns';
  END IF;

  -- (7) No write privilege outside the definer role, and nothing for PUBLIC.
  SELECT string_agg(g.rolname || ':' || a.privilege_type, ', ' ORDER BY g.rolname, a.privilege_type)
    INTO problem
  FROM pg_class c,
       aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = tbl_oid
    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND g.rolname <> 'uellix_cap_grounding'
    AND g.rolname <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = tbl_oid);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: unexpected write privilege(s): %', problem;
  END IF;

  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) INTO problem
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = tbl_oid AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: PUBLIC holds privilege(s): %', problem;
  END IF;

  -- (8) Every function in the schema is SECURITY DEFINER with an empty
  --     search_path, and none is executable by PUBLIC. Written over the whole
  --     schema rather than the three names, so a fourth function added later
  --     cannot arrive unchecked.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'uellix_grounding'
    -- BOTH spellings — see the identical note in grounding_0002. PostgreSQL
    -- stores `SET search_path = ''` as `search_path=""`, so the bare-form-only
    -- check was always true and this package aborted on every apply.
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT (p.proconfig @> ARRAY['search_path=']::text[]
                 OR p.proconfig @> ARRAY['search_path=""']::text[]));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: function(s) % are not SECURITY DEFINER with search_path=''''', problem;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO problem
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE ns.nspname = 'uellix_grounding' AND a.grantee = 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'grounding_0003 FAILED verification: PUBLIC holds EXECUTE on %', problem;
  END IF;

  -- (9) The capability role still has zero members.
  -- HOSTED VARIANT (Train 5B / Commit 5.1, generated — do not edit by hand).
  -- The zero-member count below was replaced by a topology assertion installed by
  -- db/prepared/stella_hosted_0001_managed_role_bootstrap.sql. RR-02 makes a member
  -- unavoidable for a managed installer; the assertion checks what the count was
  -- standing in for. Original message, preserved verbatim:
  --   grounding_0003 FAILED verification: uellix_cap_grounding has % member(s)
  PERFORM uellix_bootstrap.assert_capability_membership_topology('grounding_0003_evidence_chunks', 'uellix_cap_grounding');

  RAISE NOTICE 'grounding_0003: verification passed — 23 columns with the six GR-001 provenance columns NOT NULL, superseded UNIQUE absent, deduplication index unique and predicated, RLS on with 4 policies and no UPDATE policy, 3 triggers (2 immutability + 1 canonical-acyclicity) all ENABLE ALWAYS, 2 composite FOREIGN KEYs (version-scope, canonical) both ON DELETE CASCADE, no write privilege outside uellix_cap_grounding, all functions SECURITY DEFINER with empty search_path, capability role with 0 members.';
END $$;
