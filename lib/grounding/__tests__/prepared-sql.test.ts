// lib/grounding/__tests__/prepared-sql.test.ts
// U5: offline sanity lint for the PREPARED (not applied) grounding SQL in
// db/prepared/. This is intentionally a basic structural lint — balanced
// parentheses, terminated statements, expected/forbidden keywords — not a
// Postgres parse. Full validation against a real database is part of the
// external gate G2 (docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md).
//
// Extended 2026-07-31 (G2 pre-execution hardening) with assertions for:
// explicit search_path, public-qualified objects, precondition + shape guards,
// convergent reconciliation, and transaction compatibility.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')
const read = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

/** Strip -- line comments and block comments, KEEPING string literals. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Strip -- line comments, block comments and single-quoted strings. */
function stripCommentsAndStrings(sql: string): string {
  return stripComments(sql).replace(/'(?:[^']|'')*'/g, "''")
}

/**
 * Collapse $$-quoted DO bodies so that ';' splitting does not break statements
 * apart mid-procedure. The hardened grounding script uses DO $$ blocks for its
 * precondition/shape guard and for convergent constraint reconciliation.
 */
function stripDollarBodies(sql: string): string {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$')
}

function statements(sql: string): string[] {
  return stripDollarBodies(stripCommentsAndStrings(sql))
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * DDL hidden inside `EXECUTE '...'` is invisible to every assertion based on
 * `code`, because stripCommentsAndStrings blanks string literals. Extract those
 * literals so they can be linted too — otherwise an
 * `EXECUTE 'DROP TABLE public.evidence_items'` inside a DO block would sail
 * through the entire suite.
 */
function executedStatements(sql: string): string[] {
  return [...sql.matchAll(/EXECUTE\s+'((?:[^']|'')*)'/gi)].map((m) => m[1].replace(/''/g, "'"))
}

describe('db/prepared/grounding_0001_evidence_chunks.sql', () => {
  const raw = read('grounding_0001_evidence_chunks.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses outside comments and strings', () => {
    let depth = 0
    for (const ch of code) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      expect(depth).toBeGreaterThanOrEqual(0)
    }
    expect(depth).toBe(0)
  })

  it('terminates every statement with a semicolon', () => {
    // after stripping comments, the last non-whitespace character must be ';'
    expect(code.trim().endsWith(';')).toBe(true)
    expect(statements(raw).length).toBeGreaterThan(3)
  })

  it('every statement starts with a known DDL keyword', () => {
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(SET|CREATE|ALTER|DROP POLICY|GRANT|REVOKE|DO|COMMENT)\b/i)
    }
  })

  // --- hardening: search_path + qualification -----------------------------

  it('pins search_path to public AND extensions as its first statement', () => {
    // audit BLOCKER B1: narrowing to `public` alone breaks resolution of the
    // `vector` type when pgvector lives in the `extensions` schema (the hosted
    // Supabase convention) — the CREATE TABLE would fail with "type vector does
    // not exist" right after the guard reported pgvector was fine.
    expect(statements(raw)[0]).toMatch(/^SET search_path = public, extensions$/i)
  })

  it('verifies the vector TYPE is resolvable, not merely that the extension exists', () => {
    expect(raw).toMatch(/to_regtype\('vector'\) IS NULL/)
    // the failure message must name the schema pgvector actually lives in
    expect(raw).toMatch(/pg_extension e JOIN pg_namespace n/)
    expect(raw).toMatch(/is installed in schema/)
  })

  it('installs pgvector into the extensions schema when that schema exists', () => {
    expect(raw).toMatch(/CREATE EXTENSION vector WITH SCHEMA extensions/)
    expect(raw).toMatch(/nspname = 'extensions'/)
  })

  it('schema-qualifies every object it creates or references', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.evidence_chunks/i)
    expect(code).toMatch(/REFERENCES public\.organizations\(id\)/i)
    expect(code).toMatch(/REFERENCES public\.evidence_items\(id\) ON DELETE CASCADE/i)
    expect(code).toMatch(/ALTER TABLE public\.evidence_chunks ENABLE ROW LEVEL SECURITY/i)
    expect(code).toMatch(/ON public\.evidence_chunks/i)
    expect(code).toMatch(/public\.current_user_org_ids\(\)/)
    expect(code).toMatch(/public\.current_user_is_super_admin\(\)/)
  })

  // --- hardening: guards ---------------------------------------------------

  it('guards its preconditions (FK targets, RLS helpers, pgvector) before any DDL', () => {
    const firstGuard = code.indexOf('RAISE EXCEPTION')
    expect(firstGuard).toBeGreaterThan(-1)
    expect(firstGuard).toBeLessThan(code.indexOf('CREATE TABLE'))
    // the pgvector install + resolvability guard also precede the table
    expect(raw.indexOf('pg_available_extensions')).toBeLessThan(raw.indexOf('CREATE TABLE IF NOT EXISTS'))
    expect(raw.indexOf("to_regtype('vector')")).toBeLessThan(raw.indexOf('CREATE TABLE IF NOT EXISTS'))
    expect(code).toMatch(/to_regclass\(''\)/) // literal blanked by the stripper
    expect(raw).toMatch(/to_regclass\('public\.organizations'\)/)
    expect(raw).toMatch(/to_regclass\('public\.evidence_items'\)/)
    expect(raw).toMatch(/to_regprocedure\('public\.current_user_org_ids\(\)'\)/)
    expect(raw).toMatch(/pg_available_extensions/)
  })

  it('aborts instead of no-op when the table pre-exists with an incompatible shape', () => {
    expect(raw).toMatch(/INCOMPATIBLE shape/)
    expect(raw).toMatch(/information_schema\.columns/)
    // never ALTERs a pre-existing table's columns
    expect(code).not.toMatch(/ALTER TABLE[^;]*\b(DROP COLUMN|ALTER COLUMN)\b/i)
  })

  it('reports only column names and types in guard errors, never row data', () => {
    // the shape guard aggregates from information_schema, not from the table
    expect(raw).toMatch(/Missing or mismatched columns/)
    expect(raw).not.toMatch(/SELECT \* FROM public\.evidence_chunks/i)
  })

  it('is actually applicable in the G5 lexical-fallback variant', () => {
    // Not just "the shape guard tolerates a missing embedding column" — that
    // would pass even while the variant was unusable (audit N1/N5/R2).
    // 1. the shape guard must not require the embedding column,
    const guard = raw.slice(raw.indexOf('0c. Shape guard'), raw.indexOf('END $$;'))
    expect(guard).not.toMatch(/\('embedding'/)
    // 2. the resolvability guard must be conditional on pgvector being
    //    installed, or it would abort the variant outright,
    expect(raw).toMatch(/ext_schema IS NOT NULL AND to_regtype\('vector'\) IS NULL/)
    // 3. the documented procedure must name things that exist,
    expect(raw).toMatch(/delete exactly TWO things/i)
    expect(raw).toMatch(/BEGIN PGVECTOR SECTION/)
    expect(raw).toMatch(/embedding vector\(384\),` column/)
    // 4. ...and deleting that ONE section must actually suffice: every live
    //    pgvector reference has to live inside it, otherwise the operator is
    //    told to delete two things and still hits a third (audit R1/R2).
    const start = raw.indexOf('===== BEGIN PGVECTOR SECTION =====')
    const end = raw.indexOf('===== END PGVECTOR SECTION =====')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    // stripComments, NOT stripCommentsAndStrings: blanking literals would hide
    // an `EXECUTE 'CREATE EXTENSION vector'` moved outside the section.
    const outside = stripComments(raw.slice(0, start) + raw.slice(end))
    expect(outside).not.toMatch(/pg_extension|pg_available_extensions|CREATE EXTENSION|to_regtype/i)
    // ANN index methods are pgvector-only and would belong inside the section
    // too (the script announces the ANN index as a follow-up script).
    expect(outside).not.toMatch(/\b(hnsw|ivfflat)\b/i)
    // The only `vector` left outside is the embedding column type (item 2).
    // NB: \b does not match inside "PGVECTOR", so the banners cannot inflate
    // this count even when they survive in a slice.
    expect([...outside.matchAll(/\bvector\b/gi)]).toHaveLength(1)
  })

  it('hides no DDL inside EXECUTE, in any form (audit N4/R3)', () => {
    // Every EXECUTE must be either `EXECUTE FUNCTION|PROCEDURE ...` (trigger
    // syntax) or `EXECUTE '<literal>'`. This bans EXECUTE format(...),
    // EXECUTE $q$...$q$, EXECUTE <variable> and EXECUTE(<expr>) — none of
    // which the extractor below could inspect.
    // The whitespace MUST live inside the lookahead: with `EXECUTE\s*(?!...)`
    // the engine backtracks \s* to empty, the lookahead then sees " FUNCTION"
    // instead of "FUNCTION", and every legitimate EXECUTE FUNCTION matches.
    // Run on comment-stripped SQL so prose mentioning EXECUTE cannot trip it.
    expect(stripComments(raw).match(/\bEXECUTE\b(?!\s*(?:FUNCTION\b|PROCEDURE\b|'))/gi)).toBeNull()

    const executed = executedStatements(raw)
    expect(executed.length).toBeGreaterThan(0) // the pgvector install block
    for (const stmt of executed) {
      expect(stmt).toMatch(/^CREATE EXTENSION vector\b/i)
      expect(stmt).not.toMatch(/\b(DROP|TRUNCATE|DELETE|ALTER|GRANT|REVOKE)\b/i)
    }
  })

  // --- hardening: convergence + transaction --------------------------------

  it('reconciles constraint DEFINITIONS, not just names (audit M1)', () => {
    for (const name of [
      'evidence_chunks_chunk_index_check',
      'evidence_chunks_char_range_check',
      'evidence_chunks_page_check',
      'evidence_chunks_evidence_chunk_unique',
    ]) {
      // each constraint is both declared inline AND reconciled below
      expect(raw).toMatch(new RegExp(`ADD CONSTRAINT ${name}`))
    }
    expect(raw).toMatch(/pg_get_constraintdef/)
    // the three CHECKs are rebuilt when stale...
    for (const name of [
      'evidence_chunks_chunk_index_check',
      'evidence_chunks_char_range_check',
      'evidence_chunks_page_check',
    ]) {
      expect(raw).toMatch(new RegExp(`DROP CONSTRAINT ${name}`))
    }
    // ...but UNIQUE is never silently dropped: a mismatch aborts instead.
    expect(raw).not.toMatch(/DROP CONSTRAINT evidence_chunks_evidence_chunk_unique/)
    expect(raw).toMatch(/will not drop a uniqueness guarantee/)
  })

  it('is compatible with single-transaction execution (no CONCURRENTLY)', () => {
    expect(code).not.toMatch(/CONCURRENTLY/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('documents that it runs separately and never before the G5 P3 decision', () => {
    expect(raw).toMatch(/G5 P3/)
    expect(raw).toMatch(/SEPARATELY from/i)
  })

  it('points at the source-of-truth ADR instead of db/schema.ts', () => {
    expect(raw).toMatch(/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR\.md/)
  })

  // --- unchanged semantics -------------------------------------------------

  it('creates the evidence_chunks table with org and evidence FKs', () => {
    expect(code).toMatch(/embedding vector\(384\)/i)
    for (const column of ['chunk_index', 'content_hash', 'char_start', 'char_end', 'created_at']) {
      expect(code).toContain(column)
    }
  })

  it('guards the pgvector extension and flags it as gate-dependent in comments', () => {
    // The install is wrapped in a DO block so it can target the `extensions`
    // schema when present, so the DDL lives inside EXECUTE string literals.
    expect(raw).toMatch(/CREATE EXTENSION vector WITH SCHEMA extensions/i)
    expect(raw).toMatch(/EXECUTE 'CREATE EXTENSION vector'/i)
    expect(raw).toMatch(/pg_extension WHERE extname = 'vector'/i)
    expect(raw).toMatch(/G2/)
    expect(raw).toMatch(/pgvector/i)
  })

  it('enables RLS with an org-scoped SELECT policy mirroring 0032_rls_specialized', () => {
    expect(code).toMatch(/DROP POLICY IF EXISTS "evidence_chunks_select"/i)
    expect(code).toMatch(/CREATE POLICY "evidence_chunks_select"/i)
    expect(code).toMatch(/organization_id = ANY\(public\.current_user_org_ids\(\)\)/)
    // append-consistency: no client-side INSERT/UPDATE/DELETE policies at all
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)/i)
  })

  it('grants authenticated SELECT only and converges away from wider grants', () => {
    expect(code).toMatch(/GRANT SELECT ON public\.evidence_chunks TO authenticated/i)
    expect(code).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*TO authenticated/i)
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.evidence_chunks FROM authenticated/i)
  })

  it('never grants to anon or PUBLIC, and revokes anon defensively', () => {
    expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/i)
    expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\bPUBLIC\b/i)
    expect(code).toMatch(/REVOKE ALL ON public\.evidence_chunks FROM anon/i)
  })

  it('creates the supporting indexes and uniqueness constraint', () => {
    expect(code).toMatch(/UNIQUE \(evidence_id, chunk_index\)/i)
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_evidence_chunks_organization_id/i)
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_evidence_chunks_evidence_id/i)
  })

  it('contains no destructive statements', () => {
    expect(code).not.toMatch(/\b(DROP TABLE|DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION)\b/i)
  })
})

describe('db/prepared/grounding_0001_rollback.sql', () => {
  const raw = read('grounding_0001_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminated statements', () => {
    let depth = 0
    for (const ch of code) {
      if (ch === '(') depth++
      if (ch === ')') depth--
    }
    expect(depth).toBe(0)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('is consistent with the forward script: search_path and public-qualified', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(code).toMatch(/DROP TABLE IF EXISTS public\.evidence_chunks/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('tears down exactly the objects the forward script creates', () => {
    // policies and indexes fall with the table; the extension must NOT be
    // dropped blindly (other tables may adopt pgvector later)
    expect(code).not.toMatch(/DROP EXTENSION/i)
    // ...and that omission must be a documented decision, not an oversight.
    // (a bare /extension/i match would be tautological — pin the reasoning)
    expect(raw).toMatch(/intentionally NOT dropped/i)
    expect(raw).toMatch(/pg_depend/)
  })

  it('touches no other table', () => {
    const dropTargets = [...code.matchAll(/DROP TABLE IF EXISTS ([\w.]+)/gi)].map((m) => m[1])
    expect(dropTargets).toEqual(['public.evidence_chunks'])
  })
})
