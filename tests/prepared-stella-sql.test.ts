// tests/prepared-stella-sql.test.ts
// WS3b U1: offline sanity lint for the PREPARED (not applied) stella_* SQL in
// db/prepared/. Sibling of lib/grounding/__tests__/prepared-sql.test.ts (which
// covers the grounding_* scripts) — kept in its own file because db/prepared
// is not a test directory and the grounding test is owned by WS5.
//
// This is intentionally a basic structural lint — balanced parentheses,
// terminated statements, expected/forbidden keywords — not a Postgres parse.
// Full validation against a real database is part of the external gate G2
// (docs/ops/gates/G2_PACKAGE.md).

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

/**
 * Additionally collapse $$-quoted DO bodies so that ';' splitting does not
 * break statements apart mid-procedure. The stella_0002 script uses DO $$
 * blocks (precondition guard + idempotent CHECK reconciliation).
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

function expectBalancedParens(code: string) {
  let depth = 0
  for (const ch of code) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    expect(depth).toBeGreaterThanOrEqual(0)
  }
  expect(depth).toBe(0)
}

// Destructive statements are forbidden against PRE-EXISTING tables. The only
// documented exceptions in this package are: DROP TRIGGER / REVOKE on
// stella_interactions (0002 hardening + rollback) and DROP TABLE of the NEW
// stella_suggestion_decisions table (0003 rollback).
function expectNoDestructiveStatements(code: string) {
  expect(code).not.toMatch(/\b(DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION|ALTER TABLE \w+ DROP COLUMN)\b/i)
}

describe('db/prepared/stella_0002_interactions_hardening.sql', () => {
  const raw = read('stella_0002_interactions_hardening.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses outside comments and strings', () => {
    expectBalancedParens(code)
  })

  it('terminates every statement with a semicolon', () => {
    expect(code.trim().endsWith(';')).toBe(true)
    expect(statements(raw).length).toBeGreaterThan(3)
  })

  it('every statement starts with a known keyword', () => {
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(CREATE|ALTER|DROP TRIGGER|DO|REVOKE|COMMENT|END|BEGIN|RAISE|IF|SELECT)\b/i)
    }
  })

  it('guards on uellix_forbid_mutation existing before attaching anything', () => {
    expect(code).toMatch(/uellix_forbid_mutation/)
    expect(raw).toMatch(/0030_immutability/)
    // guard block appears before the CREATE TRIGGER statement
    expect(code.indexOf('RAISE EXCEPTION')).toBeGreaterThan(-1)
    expect(code.indexOf('RAISE EXCEPTION')).toBeLessThan(code.indexOf('CREATE TRIGGER'))
  })

  it('attaches the append-only trigger for UPDATE and DELETE, 0030 style', () => {
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON stella_interactions/i)
    expect(code).toMatch(/CREATE TRIGGER trg_stella_interactions_append_only\s+BEFORE UPDATE OR DELETE ON stella_interactions\s+FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation\(\)/i)
  })

  it('revokes UPDATE and DELETE from authenticated (fixes 0033:50)', () => {
    expect(code).toMatch(/REVOKE UPDATE, DELETE ON public\.stella_interactions FROM authenticated/i)
    // it must NOT touch SELECT/INSERT — the append-only grants stay
    expect(code).not.toMatch(/REVOKE[^;]*\bSELECT\b/i)
    expect(code).not.toMatch(/REVOKE[^;]*\bINSERT\b/i)
  })

  it('reconciles the stella_role CHECK to the 6-role set from db/schema.ts, idempotently', () => {
    expect(raw).toMatch(/stella_interactions_stella_role_check/)
    for (const role of ['advisor', 'validator', 'composer', 'proxy_reviewer', 'evidence_reviewer', 'audit_assistant']) {
      expect(raw).toContain(`'${role}'`)
    }
    // idempotence: guarded by inspecting the current constraint definition
    expect(raw).toMatch(/pg_get_constraintdef/)
    expect(raw).toMatch(/IF current_def IS NULL/)
  })

  it('matches CHECK roles as QUOTED literals, not bare substrings (audit FIX 4)', () => {
    // pg_get_constraintdef renders literals quoted ('advisor'::character
    // varying ...); a bare LIKE '%advisor%' would be satisfied by a
    // superstring role like 'super_advisor'. The DO block must compare
    // against the quoted form — inside the $$ body that is ''advisor''.
    for (const role of ['advisor', 'validator', 'composer', 'proxy_reviewer', 'evidence_reviewer', 'audit_assistant']) {
      expect(raw).toContain(`NOT LIKE '%''${role}''%'`)
    }
    // and no remaining bare-substring comparisons on current_def
    expect(raw).not.toMatch(/current_def NOT LIKE '%[a-z_]+%'/)
  })

  it('creates no tables and contains no destructive statements against pre-existing tables', () => {
    expect(code).not.toMatch(/CREATE TABLE/i)
    expect(code).not.toMatch(/DROP TABLE/i)
    expectNoDestructiveStatements(code)
  })

  it('flags itself as prepared-only and gate G2 in comments', () => {
    expect(raw).toMatch(/NOT A MIGRATION/)
    expect(raw).toMatch(/G2/)
  })
})

describe('db/prepared/stella_0002_rollback.sql', () => {
  const raw = read('stella_0002_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminated statements', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('detaches the trigger without dropping the shared function', () => {
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON stella_interactions/i)
    expect(code).not.toMatch(/DROP FUNCTION/i)
  })

  it('restores the 0033 grants and documents that this is BUG-compatible', () => {
    expect(code).toMatch(/GRANT UPDATE, DELETE ON public\.stella_interactions TO authenticated/i)
    expect(raw).toMatch(/BUG-COMPATIBLE/i)
  })

  it('does not revert the stella_role CHECK (documented decision)', () => {
    expect(code).not.toMatch(/stella_role/i) // no live statement touches it
    expect(raw).toMatch(/stella_role CHECK reconciliation is intentionally NOT reverted/)
  })

  it('contains no destructive statements', () => {
    expect(code).not.toMatch(/\b(DROP TABLE|DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION)\b/i)
  })
})

describe('db/prepared/stella_0003_suggestion_decisions.sql', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses outside comments and strings', () => {
    expectBalancedParens(code)
  })

  it('terminates every statement with a semicolon', () => {
    expect(code.trim().endsWith(';')).toBe(true)
    expect(statements(raw).length).toBeGreaterThan(4)
  })

  it('every statement starts with a known DDL keyword', () => {
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(CREATE|ALTER|DROP POLICY|GRANT|COMMENT)\b/i)
    }
  })

  it('creates the stella_suggestion_decisions table with the agreed shape', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS stella_suggestion_decisions/i)
    expect(code).toMatch(/id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\) NOT NULL/i)
    expect(code).toMatch(/organization_id uuid NOT NULL REFERENCES organizations\(id\)/i)
    expect(code).toMatch(/project_id uuid NOT NULL REFERENCES projects\(id\)/i)
    expect(code).toMatch(/interaction_id uuid REFERENCES stella_interactions\(id\)/i)
    // user FK follows the stella_interactions.created_by convention
    expect(code).toMatch(/decided_by uuid NOT NULL REFERENCES users\(id\)/i)
    expect(code).toMatch(/decided_at timestamptz DEFAULT now\(\) NOT NULL/i)
    for (const column of ['suggestion_key', 'previous_value_hash', 'applied_text', 'rejection_reason']) {
      expect(code).toContain(column)
    }
  })

  it('constrains decision to the 4 allowed values', () => {
    expect(code).toMatch(/CHECK \(decision IN \('', '', '', ''\)\)/) // strings are blanked by the lint stripper
    for (const value of ['accepted', 'accepted_edited', 'rejected', 'undone']) {
      expect(raw).toContain(`'${value}'`)
    }
  })

  it('enforces hash-not-content: previous_value_hash constrained to sha256 hex', () => {
    expect(raw).toMatch(/previous_value_hash IS NULL OR previous_value_hash ~ '\^\[0-9a-f\]\{64\}\$'/)
    expect(raw).toMatch(/raw previous text is never persisted/i)
  })

  it('enables RLS with a SELECT-only org policy mirroring 002_stella_interactions_rls', () => {
    expect(code).toMatch(/ALTER TABLE stella_suggestion_decisions ENABLE ROW LEVEL SECURITY/i)
    expect(code).toMatch(/DROP POLICY IF EXISTS "stella_suggestion_decisions_select"/i)
    expect(code).toMatch(/CREATE POLICY "stella_suggestion_decisions_select"/i)
    expect(code).toMatch(/organization_id = ANY\(current_user_org_ids\(\)\)/)
    expect(code).toMatch(/current_user_is_super_admin\(\)/)
    // no client-side INSERT/UPDATE/DELETE policies at all
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)/i)
  })

  it('grants authenticated SELECT only (writes are service-role only)', () => {
    expect(code).toMatch(/GRANT SELECT ON public\.stella_suggestion_decisions TO authenticated/i)
    expect(code).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*TO authenticated/i)
  })

  it('creates the org+decided_at and interaction_id indexes', () => {
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_org_decided_at\s+ON stella_suggestion_decisions \(organization_id, decided_at\)/i)
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_interaction_id\s+ON stella_suggestion_decisions \(interaction_id\)/i)
  })

  it('contains no destructive statements', () => {
    expect(code).not.toMatch(/\b(DROP TABLE|DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION)\b/i)
    expectNoDestructiveStatements(code)
  })
})

describe('db/prepared/stella_0003_rollback.sql', () => {
  const raw = read('stella_0003_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminated statements', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('drops exactly the one NEW table this package creates, nothing pre-existing', () => {
    const dropTargets = [...code.matchAll(/DROP TABLE IF EXISTS (\w+)/gi)].map((m) => m[1])
    expect(dropTargets).toEqual(['stella_suggestion_decisions'])
    expect(code).not.toMatch(/\b(DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION|DROP FUNCTION)\b/i)
  })

  it('documents the flag precondition and export-first warning', () => {
    expect(raw).toMatch(/STELLA_DECISIONS_PERSISTENCE_ENABLED/)
    expect(raw).toMatch(/[Ee]xport/)
  })
})
