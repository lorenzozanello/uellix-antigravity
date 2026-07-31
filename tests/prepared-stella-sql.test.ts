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
//
// Extended 2026-07-31 (G2 pre-execution hardening) with assertions for:
// explicit search_path, public-qualified objects, precondition + shape guards,
// convergent reconciliation, and transaction compatibility.

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
 * break statements apart mid-procedure. The stella_0002/0003 scripts use DO $$
 * blocks (precondition guards, shape guard, idempotent reconciliation).
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
  // [\w.]+ (not \w+): `\w` does not cross the dot, so the qualified form
  // `ALTER TABLE public.stella_interactions DROP COLUMN ...` would slip past a
  // \w+ pattern — and stella_0002 is exactly the script that touches a
  // pre-existing table holding audit data.
  expect(code).not.toMatch(/\b(DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION)\b/i)
  expect(code).not.toMatch(/ALTER TABLE\s+[\w."]+\s+DROP COLUMN/i)
}

/**
 * DDL hidden inside a dynamic `EXECUTE` is invisible to assertions based on
 * `code` (string literals are blanked) and to any literal extractor
 * (`EXECUTE format(...)`, `EXECUTE $q$...$q$`, `EXECUTE v_sql`).
 * The stella_* scripts must contain no dynamic EXECUTE at all — the only
 * legitimate occurrence is the `EXECUTE FUNCTION` of a CREATE TRIGGER.
 */
function expectNoExecutedDdl(sql: string) {
  // Strip comments first: prose like "EXECUTE is granted by 0039_..." is not
  // a dynamic EXECUTE. `EXECUTE FUNCTION|PROCEDURE` is CREATE TRIGGER syntax,
  // not dynamic SQL. The whitespace must live INSIDE the lookahead — with
  // `EXECUTE\s*(?!FUNCTION)` the engine backtracks \s* to empty and the
  // lookahead sees " FUNCTION", so every legitimate trigger clause matches.
  expect(
    stripCommentsAndStrings(sql).match(/\bEXECUTE\b(?!\s*(?:FUNCTION\b|PROCEDURE\b))/gi),
  ).toBeNull()
}

/** No table in this package may be reachable by anon or PUBLIC. */
function expectNoAnonOrPublicGrants(code: string) {
  expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/i)
  expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\bPUBLIC\b/i)
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
      expect(stmt).toMatch(/^(SET|CREATE|ALTER|DROP TRIGGER|DO|REVOKE|COMMENT|END|BEGIN|RAISE|IF|SELECT)\b/i)
    }
  })

  // --- hardening: search_path + qualification -----------------------------

  it('pins search_path to public as its first statement', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
  })

  it('schema-qualifies every object it touches', () => {
    expect(code).toMatch(/ON public\.stella_interactions/i)
    expect(code).toMatch(/ALTER TABLE public\.stella_interactions/i)
    expect(code).toMatch(/EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i)
    // no unqualified references to the target table remain in live statements
    expect(code).not.toMatch(/ON stella_interactions\b/i)
  })

  // --- hardening: guards ---------------------------------------------------

  it('guards on uellix_forbid_mutation existing before attaching anything', () => {
    expect(code).toMatch(/uellix_forbid_mutation/)
    expect(raw).toMatch(/0030_immutability/)
    // guard block appears before the CREATE TRIGGER statement
    expect(code.indexOf('RAISE EXCEPTION')).toBeGreaterThan(-1)
    expect(code.indexOf('RAISE EXCEPTION')).toBeLessThan(code.indexOf('CREATE TRIGGER'))
  })

  it('also guards that the target table exists, with an actionable message', () => {
    expect(raw).toMatch(/to_regclass\('public\.stella_interactions'\) IS NULL/)
    expect(raw).toMatch(/stella_0002 aborted:/)
    expect(raw).toMatch(/migraciones base al día/)
  })

  it('is compatible with single-transaction execution (no CONCURRENTLY)', () => {
    expect(code).not.toMatch(/CONCURRENTLY/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('points at the source-of-truth ADR', () => {
    expect(raw).toMatch(/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR\.md/)
  })

  // --- unchanged semantics -------------------------------------------------

  it('attaches the append-only trigger for UPDATE and DELETE, 0030 style', () => {
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON public\.stella_interactions/i)
    expect(code).toMatch(/CREATE TRIGGER trg_stella_interactions_append_only\s+BEFORE UPDATE OR DELETE ON public\.stella_interactions\s+FOR EACH ROW EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i)
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
    expectNoExecutedDdl(raw)
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

  it('is consistent with the forward script: search_path and public-qualified', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(code).toMatch(/ON public\.stella_interactions/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('detaches the trigger without dropping the shared function', () => {
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON public\.stella_interactions/i)
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
      expect(stmt).toMatch(/^(SET|CREATE|ALTER|DROP POLICY|GRANT|REVOKE|DO|COMMENT)\b/i)
    }
  })

  // --- hardening: search_path + qualification -----------------------------

  it('pins search_path to public as its first statement', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
  })

  it('schema-qualifies every object it creates or references', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.stella_suggestion_decisions/i)
    expect(code).toMatch(/REFERENCES public\.organizations\(id\)/i)
    expect(code).toMatch(/REFERENCES public\.projects\(id\)/i)
    expect(code).toMatch(/REFERENCES public\.stella_interactions\(id\)/i)
    expect(code).toMatch(/REFERENCES public\.users\(id\)/i)
    expect(code).toMatch(/ALTER TABLE public\.stella_suggestion_decisions ENABLE ROW LEVEL SECURITY/i)
    expect(code).toMatch(/public\.current_user_org_ids\(\)/)
    expect(code).toMatch(/public\.current_user_is_super_admin\(\)/)
  })

  // --- hardening: guards ---------------------------------------------------

  it('guards FK targets and RLS helpers before any DDL', () => {
    const firstGuard = code.indexOf('RAISE EXCEPTION')
    expect(firstGuard).toBeGreaterThan(-1)
    expect(firstGuard).toBeLessThan(code.indexOf('CREATE TABLE'))
    expect(raw).toMatch(/to_regclass\('public\.organizations'\)/)
    expect(raw).toMatch(/to_regclass\('public\.stella_interactions'\)/)
    expect(raw).toMatch(/to_regprocedure\('public\.current_user_org_ids\(\)'\)/)
  })

  it('aborts instead of no-op when the table pre-exists with an incompatible shape', () => {
    expect(raw).toMatch(/INCOMPATIBLE shape/)
    expect(raw).toMatch(/information_schema\.columns/)
    expect(raw).toMatch(/stella_0003 aborted:/)
    // the guard lists every contract column
    for (const col of [
      'organization_id', 'project_id', 'interaction_id', 'suggestion_key',
      'decision', 'previous_value_hash', 'applied_text', 'rejection_reason',
      'decided_by', 'decided_at',
    ]) {
      expect(raw).toContain(`('${col}'`)
    }
  })

  it('never ALTERs columns of a pre-existing table', () => {
    expect(code).not.toMatch(/ALTER TABLE[^;]*\b(DROP COLUMN|ALTER COLUMN)\b/i)
  })

  it('reports only column names and types in guard errors, never row data', () => {
    expect(raw).toMatch(/Missing or mismatched columns/)
    expect(raw).not.toMatch(/SELECT \* FROM public\.stella_suggestion_decisions/i)
  })

  // --- hardening: convergence + transaction --------------------------------

  it('reconciles CHECK constraints convergently, not only via CREATE TABLE IF NOT EXISTS', () => {
    for (const name of [
      'stella_suggestion_decisions_decision_check',
      'stella_suggestion_decisions_prev_hash_check',
    ]) {
      expect(raw).toMatch(new RegExp(`ADD CONSTRAINT ${name}`))
    }
    expect(raw).toMatch(/pg_constraint/)
  })

  it('is compatible with single-transaction execution (no CONCURRENTLY)', () => {
    expect(code).not.toMatch(/CONCURRENTLY/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('points at the source-of-truth ADR instead of db/schema.ts', () => {
    expect(raw).toMatch(/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR\.md/)
    expect(raw).toMatch(/deliberately absent from db\/schema\.ts/)
  })

  // --- unchanged semantics -------------------------------------------------

  it('creates the stella_suggestion_decisions table with the agreed shape', () => {
    expect(code).toMatch(/id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\) NOT NULL/i)
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
    expect(code).toMatch(/DROP POLICY IF EXISTS "stella_suggestion_decisions_select"/i)
    expect(code).toMatch(/CREATE POLICY "stella_suggestion_decisions_select"/i)
    expect(code).toMatch(/organization_id = ANY\(public\.current_user_org_ids\(\)\)/)
    // no client-side INSERT/UPDATE/DELETE policies at all
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)/i)
  })

  it('grants authenticated SELECT only and converges away from wider grants', () => {
    expect(code).toMatch(/GRANT SELECT ON public\.stella_suggestion_decisions TO authenticated/i)
    expect(code).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*TO authenticated/i)
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.stella_suggestion_decisions FROM authenticated/i)
  })

  it('never grants to anon or PUBLIC, and revokes anon defensively', () => {
    expectNoAnonOrPublicGrants(code)
    expect(code).toMatch(/REVOKE ALL ON public\.stella_suggestion_decisions FROM anon/i)
  })

  it('reconciles CHECK definitions, not just constraint names (audit M1)', () => {
    // A constraint carrying the right NAME with a stale DEFINITION (e.g. a
    // decision_check missing 'undone') must be rebuilt, not skipped.
    expect(raw).toMatch(/pg_get_constraintdef/)
    for (const value of ['accepted', 'accepted_edited', 'rejected', 'undone']) {
      expect(raw).toContain(`def NOT LIKE '%''${value}''%'`)
    }
    expect(raw).toMatch(/DROP CONSTRAINT stella_suggestion_decisions_decision_check/)
    expect(raw).toMatch(/DROP CONSTRAINT stella_suggestion_decisions_prev_hash_check/)
  })

  it('pins the ANCHORED hash regex, not just the character class (audit N3)', () => {
    // Matching the bare class would accept a stale UNANCHORED constraint
    // ('[0-9a-f]{64}' without ^$), which admits "<raw text><64 hex><more>" —
    // exactly the leak the hash-not-content invariant exists to prevent.
    expect(raw).toContain("def NOT LIKE '%''^[0-9a-f]{64}$''%'")
  })

  it('guards PK, id default and unexpected NOT NULL columns (audit M2)', () => {
    expect(raw).toMatch(/without a PRIMARY KEY/)
    expect(raw).toMatch(/has no DEFAULT/)
    expect(raw).toMatch(/unexpected NOT NULL columns without a default/)
  })

  it('creates the org+decided_at and interaction_id indexes', () => {
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_org_decided_at\s+ON public\.stella_suggestion_decisions \(organization_id, decided_at\)/i)
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_interaction_id\s+ON public\.stella_suggestion_decisions \(interaction_id\)/i)
  })

  it('contains no destructive statements', () => {
    expect(code).not.toMatch(/\b(DROP TABLE|DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION)\b/i)
    expectNoDestructiveStatements(code)
    expectNoExecutedDdl(raw)
  })
})

describe('db/prepared/stella_0003_rollback.sql', () => {
  const raw = read('stella_0003_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminated statements', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('is consistent with the forward script: search_path and public-qualified', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('drops exactly the one NEW table this package creates, nothing pre-existing', () => {
    const dropTargets = [...code.matchAll(/DROP TABLE IF EXISTS ([\w.]+)/gi)].map((m) => m[1])
    expect(dropTargets).toEqual(['public.stella_suggestion_decisions'])
    expect(code).not.toMatch(/\b(DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION|DROP FUNCTION)\b/i)
  })

  it('documents the flag precondition and export-first warning', () => {
    expect(raw).toMatch(/STELLA_DECISIONS_PERSISTENCE_ENABLED/)
    expect(raw).toMatch(/[Ee]xport/)
  })
})
