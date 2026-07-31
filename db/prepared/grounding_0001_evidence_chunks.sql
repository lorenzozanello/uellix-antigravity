-- db/prepared/grounding_0001_evidence_chunks.sql
-- WS5 (document grounding): evidence_chunks table + org-scoped RLS.
--
-- PREPARED ONLY — NOT A MIGRATION. This file lives in db/prepared/ (never in
-- db/migrations/, where drizzle-kit would apply it). Application to any
-- database is the external gate G2, executed manually by Lorenzo following
-- docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md and the process in
-- docs/ops/SUPABASE_MIGRATION_GATE.md. Rollback: grounding_0001_rollback.sql.
--
-- GATE-DEPENDENT PRECONDITION (G2 + G5): the pgvector extension. Its
-- availability on the hosted Supabase project must be confirmed BEFORE running
-- this script (Dashboard -> Database -> Extensions -> "vector"), and enabling
-- embeddings at all is G5 question P3. The CREATE EXTENSION below is guarded
-- with IF NOT EXISTS; if G5 decides for the lexical fallback, the embedding
-- column simply stays NULL — the table is still useful without pgvector, but
-- the extension must exist for the vector(384) column type to parse. If
-- pgvector is NOT available and G5 chose the lexical fallback, apply the
-- variant noted in the README (embedding column omitted) instead.
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunked, anchored evidence content. Derived data: regenerable at any time
-- from Supabase Storage + lib/grounding (extract -> chunk -> embed), so this
-- table is NOT an audit trail — the SHA-256-sealed evidence file remains the
-- source of truth (lib/pipeline/evidence.ts). char_start/char_end are offsets
-- into the CRLF->LF normalized source text (page-scoped when page is set),
-- per the anchor contract in docs/19_DOCUMENT_GROUNDING_SPEC.md §5.
CREATE TABLE IF NOT EXISTS evidence_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  evidence_id uuid NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_evidence_chunks_organization_id ON evidence_chunks (organization_id);
CREATE INDEX IF NOT EXISTS idx_evidence_chunks_evidence_id ON evidence_chunks (evidence_id);

-- ANN index deliberately NOT created here: ivfflat/hnsw index creation needs
-- representative data (lists sizing) and only makes sense after G5 chooses
-- pgvector and a backfill has run. It ships as a follow-up prepared script.

-- ============================================================
-- RLS (mirrors db/migrations/0032_rls_specialized.sql style)
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

ALTER TABLE evidence_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_chunks_select" ON evidence_chunks;
CREATE POLICY "evidence_chunks_select"
ON evidence_chunks FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

-- No INSERT policy -> INSERT denied via RLS (service role only)
-- No UPDATE policy -> UPDATE denied (append-consistency)
-- No DELETE policy -> DELETE denied (server-side reindex / FK cascade only)

COMMENT ON TABLE evidence_chunks IS
  'Derived, regenerable grounding index over evidence files (WS5). Not an audit trail; source of truth is the hashed file in Storage.';
