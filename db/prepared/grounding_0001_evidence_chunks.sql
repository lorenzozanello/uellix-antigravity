-- db/prepared/grounding_0001_evidence_chunks.sql
-- WS5 (document grounding): evidence_chunks table + org-scoped RLS.
--
-- PREPARED ONLY — NOT A MIGRATION. This file lives in db/prepared/ (never in
-- db/migrations/, where drizzle-kit would apply it). Application to any
-- database is the external gate G2, executed manually by Lorenzo following
-- docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md and the process in
-- docs/ops/SUPABASE_MIGRATION_GATE.md. Rollback: grounding_0001_rollback.sql.
--
-- SOURCE OF TRUTH: this table is deliberately absent from db/schema.ts and the
-- drizzle snapshot — see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md. Do not add
-- it to schema.ts without following the promotion procedure in that ADR §7.
--
-- RUN AS ONE TRANSACTION (same as the stella_* scripts):
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent AND convergent. If the table exists with an INCOMPATIBLE shape the
-- script ABORTS with an explicit error instead of silently doing nothing.
--
-- GATE-DEPENDENT PRECONDITIONS — this script runs SEPARATELY from
-- stella_0002/0003 and only after BOTH of:
--   (a) decision G5 P3 recorded (pgvector vs. lexical fallback) — see
--       docs/ops/gates/G5_PACKAGE.md;
--   (b) pgvector confirmed available on the target Supabase project
--       (Dashboard -> Database -> Extensions -> "vector").
-- LEXICAL-FALLBACK VARIANT (G5 P3 = no pgvector): delete exactly TWO things —
--   (1) the whole block delimited by the BEGIN/END PGVECTOR SECTION banner
--       comments below, and
--   (2) the `embedding vector(384),` column in the CREATE TABLE.
-- Every pgvector mention in this script lives inside that section, and the
-- shape guard does not require the `embedding` column — so nothing else needs
-- to change. Same procedure in db/prepared/README.md.

-- search_path MUST include `extensions`: on hosted Supabase, pgvector is
-- conventionally installed there (`create extension vector with schema
-- extensions;`), and narrowing the path to `public` alone would make the
-- `vector(384)` column type below fail to resolve with a confusing
-- "type vector does not exist" — right after the precondition guard reported
-- that pgvector was fine. Guard 0e re-checks resolvability explicitly.
-- Every object this script creates is still written `public.`-qualified.
SET search_path = public, extensions;

-- ============================================================
-- 0. Preconditions + shape guard
-- ============================================================
DO $$
DECLARE
  mismatched text;
BEGIN
  -- 0a. FK targets must exist.
  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.evidence_items') IS NULL THEN
    RAISE EXCEPTION 'grounding_0001 aborted: organizations or evidence_items is missing — this database is not at the expected migration baseline';
  END IF;

  -- 0b. RLS helpers must exist.
  IF to_regprocedure('public.current_user_org_ids()') IS NULL
     OR to_regprocedure('public.current_user_is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'grounding_0001 aborted: RLS helpers public.current_user_org_ids()/current_user_is_super_admin() not found — apply db/migrations/0031_rls_core.sql and 0039_grant_rls_helper_execution.sql first';
  END IF;

  -- 0c. Shape guard — only when the table already exists. Column names and
  --     types only; never row data. "embedding" is intentionally NOT required:
  --     the lexical-fallback variant omits it (G5 P3).
  IF to_regclass('public.evidence_chunks') IS NOT NULL THEN
    SELECT string_agg(
             format('%s (expected %s%s)', e.col, e.typ,
                    CASE WHEN e.nul = 'NO' THEN ' NOT NULL' ELSE ' NULL' END),
             ', ' ORDER BY e.col)
      INTO mismatched
    FROM (VALUES
      ('id',              'uuid',                          'NO'),
      ('organization_id', 'uuid',                          'NO'),
      ('evidence_id',     'uuid',                          'NO'),
      ('chunk_index',     'integer',                       'NO'),
      ('content',         'text',                          'NO'),
      ('content_hash',    'character varying',             'NO'),
      ('page',            'integer',                       'YES'),
      ('char_start',      'integer',                       'NO'),
      ('char_end',        'integer',                       'NO'),
      ('created_at',      'timestamp without time zone',   'NO')
    ) AS e(col, typ, nul)
    LEFT JOIN information_schema.columns c
           ON c.table_schema = 'public'
          AND c.table_name   = 'evidence_chunks'
          AND c.column_name  = e.col
          AND c.data_type    = e.typ
          AND c.is_nullable  = e.nul
    WHERE c.column_name IS NULL;

    IF mismatched IS NOT NULL THEN
      RAISE EXCEPTION
        'grounding_0001 aborted: public.evidence_chunks already exists with an INCOMPATIBLE shape. Missing or mismatched columns: %. This script never ALTERs COLUMNS of an existing table (it does reconcile stale constraints) — resolve manually and re-run (see "Criterios de aborto" in docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md).',
        mismatched;
    END IF;
  END IF;
END $$;

-- ============================================================
-- ===== BEGIN PGVECTOR SECTION =====
--   LEXICAL-FALLBACK VARIANT (G5 P3 = no pgvector): delete this ENTIRE
--   section, from "BEGIN PGVECTOR SECTION" to "END PGVECTOR SECTION". It is
--   self-contained: availability check, install, and resolvability guard. No
--   other guard in this script mentions pgvector, so nothing else needs to
--   change beyond the `embedding vector(384),` column in the CREATE TABLE.
-- ============================================================

-- Availability: fail with a better message than the raw "extension is not
-- available" that CREATE EXTENSION would give.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
     AND NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'grounding_0001 aborted: pgvector is neither installed nor available on this instance. Confirm it in Dashboard -> Database -> Extensions, or apply the lexical-fallback variant (delete the whole PGVECTOR SECTION and the embedding column — db/prepared/README.md) if G5 P3 chose that path.';
  END IF;
END $$;

-- Install into `extensions` when that schema exists (hosted Supabase
-- convention — keeps `public` free of extension objects, which Supabase's own
-- linter flags as `extension_in_public` and which breaks pg_dump/upgrades).
-- Fall back to the default schema only when `extensions` is absent (local dev).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
      EXECUTE 'CREATE EXTENSION vector WITH SCHEMA extensions';
    ELSE
      EXECUTE 'CREATE EXTENSION vector';
    END IF;
  END IF;
END $$;

-- Resolvability: the extension existing is NOT the same as the type being
-- resolvable from this session's search_path. Fail here — with the schema
-- named — instead of at the CREATE TABLE below.
-- Still conditional on the extension being installed, so that a partial
-- deletion of this section degrades safely rather than aborting with a message
-- claiming pgvector is installed when it is not.
DO $$
DECLARE
  ext_schema text;
BEGIN
  SELECT n.nspname INTO ext_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';

  IF ext_schema IS NOT NULL AND to_regtype('vector') IS NULL THEN
    RAISE EXCEPTION
      'grounding_0001 aborted: pgvector is installed in schema "%" but the type "vector" is not resolvable from search_path. Add that schema to the SET search_path at the top of this script, or apply the lexical-fallback variant (db/prepared/README.md).',
      ext_schema;
  END IF;
END $$;

-- ===== END PGVECTOR SECTION =====

-- ============================================================
-- 1. Table
-- ============================================================
-- Chunked, anchored evidence content. Derived data: regenerable at any time
-- from Supabase Storage + lib/grounding (extract -> chunk -> embed), so this
-- table is NOT an audit trail — the SHA-256-sealed evidence file remains the
-- source of truth (lib/pipeline/evidence.ts). char_start/char_end are offsets
-- into the CRLF->LF normalized source text (page-scoped when page is set),
-- per the anchor contract in docs/19_DOCUMENT_GROUNDING_SPEC.md §5.
CREATE TABLE IF NOT EXISTS public.evidence_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  evidence_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  -- SHA-256 (hex) of content; chains the chunk to the evidence contentHash
  content_hash varchar(64) NOT NULL,
  page integer,
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  -- NULL until an embedding provider is chosen (G5 P3); backfilled on reindex
  embedding vector(384),
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT evidence_chunks_chunk_index_check CHECK (chunk_index >= 0),
  CONSTRAINT evidence_chunks_char_range_check CHECK (char_start >= 0 AND char_end > char_start),
  CONSTRAINT evidence_chunks_page_check CHECK (page IS NULL OR page >= 1),
  CONSTRAINT evidence_chunks_evidence_chunk_unique UNIQUE (evidence_id, chunk_index)
);

-- ============================================================
-- 2. CHECK / UNIQUE reconciliation — convergent
-- ============================================================
-- Like stella_0003, this compares the DEFINITION, not just the name: a
-- constraint carrying the right name with a stale definition would otherwise
-- survive a re-run and let the gate sign off green over a weaker guarantee.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_chunk_index_check';
  IF def IS NULL OR def NOT LIKE '%chunk_index >= 0%' THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_chunk_index_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_chunk_index_check CHECK (chunk_index >= 0);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_char_range_check';
  IF def IS NULL OR def NOT LIKE '%char_start >= 0%' OR def NOT LIKE '%char_end > char_start%' THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_char_range_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_char_range_check CHECK (char_start >= 0 AND char_end > char_start);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_page_check';
  IF def IS NULL OR def NOT LIKE '%page IS NULL%' OR def NOT LIKE '%page >= 1%' THEN
    IF def IS NOT NULL THEN
      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_page_check;
    END IF;
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_page_check CHECK (page IS NULL OR page >= 1);
  END IF;

  -- UNIQUE is handled differently on purpose: silently DROPping a uniqueness
  -- guarantee to re-add a variant is riskier than stopping. Add when missing;
  -- abort when present with a different definition.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = 'public.evidence_chunks'::regclass
    AND conname = 'evidence_chunks_evidence_chunk_unique';
  IF def IS NULL THEN
    ALTER TABLE public.evidence_chunks
      ADD CONSTRAINT evidence_chunks_evidence_chunk_unique UNIQUE (evidence_id, chunk_index);
  ELSIF def NOT LIKE '%UNIQUE (evidence_id, chunk_index)%' THEN
    RAISE EXCEPTION
      'grounding_0001 aborted: constraint evidence_chunks_evidence_chunk_unique exists with an unexpected definition (%). Resolve manually — this script will not drop a uniqueness guarantee.',
      def;
  END IF;
END $$;

-- ============================================================
-- 3. Indexes (no CONCURRENTLY — this script runs inside one transaction)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_evidence_chunks_organization_id ON public.evidence_chunks (organization_id);
CREATE INDEX IF NOT EXISTS idx_evidence_chunks_evidence_id ON public.evidence_chunks (evidence_id);

-- ANN index deliberately NOT created here: ivfflat/hnsw index creation needs
-- representative data (lists sizing) and only makes sense after G5 chooses
-- pgvector and a backfill has run. It ships as a follow-up prepared script.

-- ============================================================
-- 4. Grants — SELECT only for authenticated (service role writes)
-- ============================================================
GRANT SELECT ON public.evidence_chunks TO authenticated;
-- Defensive convergence: REVOKE of an absent privilege is a no-op.
-- Supabase's bootstrap grants CRUD on new public tables to anon/authenticated;
-- 0033 revoked the DEFAULT PRIVILEGES for anon but that is per-grantor, so a
-- table created by a different role can still arrive wide open. RLS already
-- denies anon (no policy matches it), this is defense in depth.
REVOKE INSERT, UPDATE, DELETE ON public.evidence_chunks FROM authenticated;
REVOKE ALL ON public.evidence_chunks FROM anon;

-- ============================================================
-- 5. RLS (mirrors db/migrations/0032_rls_specialized.sql style)
-- ============================================================
-- Same posture as stella_interactions:
--   - SELECT: org members read their own org's chunks; super_admin sees all
--   - No INSERT policy: writes are strictly server-side via the service-role
--     Drizzle client (DATABASE_URL), which bypasses RLS — the grounding
--     ingest/reindex paths, never the browser client
--   - No UPDATE policy: chunks are immutable (append-consistency); reindex is
--     a server-side delete + insert
--   - No DELETE policy: client-side deletion denied; deletion happens
--     server-side (reindex) or via the ON DELETE CASCADE from evidence_items

ALTER TABLE public.evidence_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_chunks_select" ON public.evidence_chunks;
CREATE POLICY "evidence_chunks_select"
ON public.evidence_chunks FOR SELECT
USING (
  organization_id = ANY(public.current_user_org_ids())
  OR public.current_user_is_super_admin()
);

-- No INSERT policy -> INSERT denied via RLS (service role only)
-- No UPDATE policy -> UPDATE denied (append-consistency)
-- No DELETE policy -> DELETE denied (server-side reindex / FK cascade only)

COMMENT ON TABLE public.evidence_chunks IS
  'Derived, regenerable grounding index over evidence files (WS5). Not an audit trail; source of truth is the hashed file in Storage. Managed outside the drizzle chain: see docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md.';
