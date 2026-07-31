// lib/grounding/__tests__/prepared-sql.test.ts
// U5: offline sanity lint for the PREPARED (not applied) grounding SQL in
// db/prepared/. This is intentionally a basic structural lint — balanced
// parentheses, terminated statements, expected/forbidden keywords — not a
// Postgres parse. Full validation against a real database is part of the
// external gate G2 (docs/ops/gates/G2_PACKAGE_GROUNDING_ADDENDUM.md).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')
const read = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

/** Strip -- line comments, block comments and single-quoted strings. */
function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^']|'')*'/g, "''")
}

function statements(sql: string): string[] {
  return stripCommentsAndStrings(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
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
      expect(stmt).toMatch(/^(CREATE|ALTER|DROP POLICY|COMMENT)\b/i)
    }
  })

  it('creates the evidence_chunks table with org and evidence FKs', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS evidence_chunks/i)
    expect(code).toMatch(/organization_id uuid NOT NULL REFERENCES organizations\(id\)/i)
    expect(code).toMatch(/evidence_id uuid NOT NULL REFERENCES evidence_items\(id\) ON DELETE CASCADE/i)
    expect(code).toMatch(/embedding vector\(384\)/i)
    for (const column of ['chunk_index', 'content_hash', 'char_start', 'char_end', 'created_at']) {
      expect(code).toContain(column)
    }
  })

  it('guards the pgvector extension and flags it as gate-dependent in comments', () => {
    expect(code).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/i)
    expect(raw).toMatch(/G2/)
    expect(raw).toMatch(/pgvector/i)
  })

  it('enables RLS with an org-scoped SELECT policy mirroring 0032_rls_specialized', () => {
    expect(code).toMatch(/ALTER TABLE evidence_chunks ENABLE ROW LEVEL SECURITY/i)
    expect(code).toMatch(/DROP POLICY IF EXISTS "evidence_chunks_select"/i)
    expect(code).toMatch(/CREATE POLICY "evidence_chunks_select"/i)
    expect(code).toMatch(/organization_id = ANY\(current_user_org_ids\(\)\)/)
    expect(code).toMatch(/current_user_is_super_admin\(\)/)
    // append-consistency: no client-side INSERT/UPDATE/DELETE policies at all
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)/i)
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

  it('tears down exactly the objects the forward script creates', () => {
    expect(code).toMatch(/DROP TABLE IF EXISTS evidence_chunks/i)
    // policies and indexes fall with the table; the extension must NOT be
    // dropped blindly (other tables may adopt pgvector later)
    expect(code).not.toMatch(/DROP EXTENSION/i)
    expect(raw).toMatch(/extension/i) // but the decision is documented
  })

  it('touches no other table', () => {
    const dropTargets = [...code.matchAll(/DROP TABLE IF EXISTS (\w+)/gi)].map((m) => m[1])
    expect(dropTargets).toEqual(['evidence_chunks'])
  })
})
