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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  expect(code).not.toMatch(/\b(DROP SCHEMA|DELETE FROM|DROP EXTENSION)\b/i)
  expect(code).not.toMatch(/ALTER TABLE\s+[\w."]+\s+DROP COLUMN/i)
  expectNoTruncateCommand(code)
}

/**
 * TRUNCATE plays three unrelated roles in this package, so banning the bare
 * word — as this helper originally did — would forbid the very defence that
 * stella_0002b exists to add:
 *
 *   1. trigger EVENT    `BEFORE TRUNCATE ON t ... FOR EACH STATEMENT`  (the guard)
 *   2. privilege NAME   `REVOKE TRUNCATE, REFERENCES, TRIGGER ON t ...` (removing it)
 *   3. COMMAND          `TRUNCATE TABLE t`                              (destructive)
 *
 * Only (3) is forbidden, and only (3) can begin a statement — as a command
 * TRUNCATE is always the first token. Classifying by statement position is
 * therefore stricter than a substring ban, not looser: it still rejects every
 * executable TRUNCATE while allowing the two declarative uses.
 */
function expectNoTruncateCommand(code: string) {
  const offenders = code
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^TRUNCATE\b/i.test(s))
  expect(offenders, `TRUNCATE used as a command: ${offenders.join(' | ')}`).toEqual([])
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
  //
  // One further form is admitted: `EXECUTE '<fixed literal>'`. After
  // stripCommentsAndStrings a genuine single-quoted literal collapses to `''`,
  // so this lookahead passes ONLY when the argument was a self-contained
  // literal in the source. `EXECUTE v_sql`, `EXECUTE format(...)` and
  // `EXECUTE 'x' || ident` all still fail, because none of them leaves a bare
  // `''` immediately after the keyword. stella_0002b needs this to defer
  // PARSING (not composition) of `REVOKE MAINTAIN`, which is a syntax error
  // before PostgreSQL 17; the literal it executes is pinned by its own test.
  expect(
    stripCommentsAndStrings(sql).match(/\bEXECUTE\b(?!\s*(?:FUNCTION\b|PROCEDURE\b|''))/gi),
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

  it('every statement starts with a known DDL keyword (incl. DROP TRIGGER)', () => {
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(SET|CREATE|ALTER|DROP POLICY|DROP TRIGGER|GRANT|REVOKE|DO|COMMENT)\b/i)
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

  it('revokes ALL from every role before granting anything back', () => {
    // Hardened 2026-08-01. Enumerating privileges to revoke is a losing game:
    // it cannot anticipate what a future PostgreSQL or Supabase bootstrap adds
    // to ALTER DEFAULT PRIVILEGES. Inheriting `Dxtm` that way is exactly what
    // left the four pre-existing audit tables TRUNCATE-able. REVOKE ALL is the
    // only formulation that cannot inherit a surplus it was not written for.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(code, `missing REVOKE ALL for ${role}`).toMatch(
        new RegExp(`REVOKE ALL ON public\\.stella_suggestion_decisions FROM ${role}`, 'i'),
      )
    }
  })

  it('grants authenticated SELECT only, and service_role nothing', () => {
    expect(code).toMatch(/GRANT SELECT ON public\.stella_suggestion_decisions TO authenticated/i)
    expect(code).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL)\b[^;]*TO authenticated/i)
    // service_role gets no grant at all: the only writer is the Drizzle client,
    // which connects as the table OWNER, whose access comes from ownership.
    expect(code).not.toMatch(/GRANT[^;]*TO service_role/i)
  })

  it('adds both append-only triggers so the table never has the 0002b gap', () => {
    expect(code).toMatch(
      /CREATE TRIGGER trg_stella_suggestion_decisions_append_only\s+BEFORE UPDATE OR DELETE ON public\.stella_suggestion_decisions\s+FOR EACH ROW EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i,
    )
    expect(code).toMatch(
      /CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate\s+BEFORE TRUNCATE ON public\.stella_suggestion_decisions\s+FOR EACH STATEMENT EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i,
    )
    // Idempotent: each CREATE is preceded by its own DROP ... IF EXISTS.
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_append_only/i)
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_no_truncate/i)
    // And it must guard the function it depends on.
    expect(raw).toMatch(/uellix_forbid_mutation\(\) not found/)
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
      // position(), not LIKE: `_` is a LIKE wildcard, so the old form also
      // accepted a stale 'acceptedXedited'. See MIN-A.
      expect(raw).toContain(`position('''${value}''' in def)`)
    }
    expect(raw).toMatch(/DROP CONSTRAINT stella_suggestion_decisions_decision_check/)
    expect(raw).toMatch(/DROP CONSTRAINT stella_suggestion_decisions_prev_hash_check/)
  })

  it('pins the ANCHORED hash regex, not just the character class (audit N3)', () => {
    // Matching the bare class would accept a stale UNANCHORED constraint
    // ('[0-9a-f]{64}' without ^$), which admits "<raw text><64 hex><more>" —
    // exactly the leak the hash-not-content invariant exists to prevent.
    expect(raw).toContain("position('''^[0-9a-f]{64}$''' in def)")
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
    // DROP TABLE is checked here rather than in the shared helper: the 0003
    // ROLLBACK legitimately drops the table this script creates.
    expect(code).not.toMatch(/\bDROP TABLE\b/i)
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
    expect(code).not.toMatch(/\b(DROP SCHEMA|DELETE FROM|DROP EXTENSION|DROP FUNCTION)\b/i)
    // TRUNCATE is named in the operator-facing NOTICEs ("the append-only
    // triggers forbid UPDATE/DELETE/TRUNCATE"), so classify by position rather
    // than banning the word: only a TRUNCATE *command* is forbidden.
    expectNoTruncateCommand(code)
  })

  it('documents the flag precondition and export-first warning', () => {
    expect(raw).toMatch(/STELLA_DECISIONS_PERSISTENCE_ENABLED/)
    expect(raw).toMatch(/[Ee]xport/)
  })
})

// ---------------------------------------------------------------------------
// stella_0002b — append-only TRUNCATE hardening (added 2026-08-01)
// ---------------------------------------------------------------------------
// Repairs the privilege surplus that Supabase's ALTER DEFAULT PRIVILEGES leaves
// on every table created in `public` (`authenticated=Dxtm`), which made the four
// append-only tables TRUNCATE-able. Demonstrated on a real PostgreSQL 17 before
// this script was written.

/** The four tables whose append-only guarantee is documented and load-bearing. */
const APPEND_ONLY_TABLES = [
  'stella_interactions',
  'audit_logs',
  'sroi_calculation_runs',
  'sroi_calculation_line_items',
] as const

/** Row-level UPDATE/DELETE guards that must survive 0002b untouched. */
const ROW_TRIGGERS = [
  'trg_stella_interactions_append_only',
  'trg_audit_logs_append_only',
  'trg_sroi_runs_append_only',
  'trg_sroi_line_items_append_only',
] as const

/** Statement-level TRUNCATE guards that 0002b introduces. */
const TRUNCATE_TRIGGERS = [
  ['stella_interactions', 'trg_stella_interactions_no_truncate'],
  ['audit_logs', 'trg_audit_logs_no_truncate'],
  ['sroi_calculation_runs', 'trg_sroi_calculation_runs_no_truncate'],
  ['sroi_calculation_line_items', 'trg_sroi_calculation_line_items_no_truncate'],
] as const

describe('db/prepared/stella_0002b_append_only_truncate_hardening.sql', () => {
  const raw = read('stella_0002b_append_only_truncate_hardening.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminates every statement', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('declares an explicit search_path and documents single-transaction use', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('every statement starts with a known keyword', () => {
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(SET|CREATE|DROP TRIGGER|DO|REVOKE|COMMENT)\b/i)
    }
  })

  it('covers exactly the four append-only tables', () => {
    for (const table of APPEND_ONLY_TABLES) {
      expect(code, `missing ${table}`).toMatch(new RegExp(`public\\.${table}\\b`))
    }
    // Never reaches into the objects later gates create.
    expect(code).not.toMatch(/stella_suggestion_decisions/i)
    expect(code).not.toMatch(/evidence_chunks/i)
  })

  it('revokes TRUNCATE, REFERENCES and TRIGGER from authenticated', () => {
    const stmt = statements(raw).find(
      (s) => /^REVOKE\b/i.test(s) && /FROM authenticated$/i.test(s),
    )
    expect(stmt, 'no REVOKE ... FROM authenticated statement').toBeDefined()
    for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(stmt, `authenticated keeps ${priv}`).toMatch(new RegExp(`\\b${priv}\\b`, 'i'))
    }
    for (const table of APPEND_ONLY_TABLES) {
      expect(stmt).toMatch(new RegExp(`public\\.${table}\\b`))
    }
    // SELECT and INSERT are the documented append-only posture — never revoked.
    expect(stmt).not.toMatch(/\bSELECT\b/i)
    expect(stmt).not.toMatch(/\bINSERT\b/i)
  })

  it('revokes UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER from service_role', () => {
    const stmt = statements(raw).find(
      (s) => /^REVOKE\b/i.test(s) && /FROM service_role$/i.test(s),
    )
    expect(stmt, 'no REVOKE ... FROM service_role statement').toBeDefined()
    for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(stmt, `service_role keeps ${priv}`).toMatch(new RegExp(`\\b${priv}\\b`, 'i'))
    }
    expect(stmt).not.toMatch(/\bSELECT\b/i)
    expect(stmt).not.toMatch(/\bINSERT\b/i)
  })

  it('handles MAINTAIN version-aware, via a fixed literal and never below PG17', () => {
    expect(raw).toMatch(/server_version_num/)
    expect(raw).toMatch(/>=\s*170000/)
    // The REVOKE MAINTAIN text must exist ONLY inside a quoted literal, so a
    // pre-17 server never parses it. After stripping strings it is gone.
    expect(raw).toMatch(/REVOKE MAINTAIN ON /)
    expect(code).not.toMatch(/REVOKE MAINTAIN/i)
    // Both roles lose it.
    expect(raw).toMatch(/FROM authenticated, service_role/)
  })

  it('creates one BEFORE TRUNCATE FOR EACH STATEMENT trigger per table', () => {
    for (const [table, trigger] of TRUNCATE_TRIGGERS) {
      expect(code, `missing CREATE for ${trigger}`).toMatch(
        new RegExp(
          `CREATE TRIGGER ${trigger}\\s+BEFORE TRUNCATE ON public\\.${table}\\s+FOR EACH STATEMENT EXECUTE FUNCTION public\\.uellix_forbid_mutation\\(\\)`,
          'i',
        ),
      )
      // Idempotency: every CREATE is preceded by its own DROP ... IF EXISTS.
      expect(code, `missing DROP for ${trigger}`).toMatch(
        new RegExp(`DROP TRIGGER IF EXISTS ${trigger} ON public\\.${table}`, 'i'),
      )
    }
    // FOR EACH ROW on TRUNCATE is rejected by PostgreSQL outright.
    expect(code).not.toMatch(/BEFORE TRUNCATE[^;]*FOR EACH ROW/i)
  })

  it('creates exactly four triggers and drops exactly those four', () => {
    expect([...code.matchAll(/CREATE TRIGGER/gi)]).toHaveLength(4)
    const dropped = [...code.matchAll(/DROP TRIGGER IF EXISTS (\w+)/gi)].map((m) => m[1]).sort()
    expect(dropped).toEqual(TRUNCATE_TRIGGERS.map(([, t]) => t).slice().sort())
  })

  it('guards its preconditions instead of failing obscurely', () => {
    expect(raw).toMatch(/uellix_forbid_mutation\(\) not found/)
    expect(raw).toMatch(/missing target table/)
    // Requires the row-level protection to already exist, so it can never
    // produce a table that rejects TRUNCATE but still accepts UPDATE.
    expect(raw).toMatch(/missing UPDATE\/DELETE append-only trigger/)
    for (const trigger of ROW_TRIGGERS) {
      expect(raw, `precondition does not check ${trigger}`).toContain(trigger)
    }
  })

  it('never drops the pre-existing row-level triggers', () => {
    for (const trigger of ROW_TRIGGERS) {
      expect(code).not.toMatch(new RegExp(`DROP TRIGGER IF EXISTS ${trigger}\\b`, 'i'))
    }
  })

  it('touches no data, no RLS and no constraints', () => {
    expect(code).not.toMatch(/\b(INSERT INTO|DELETE FROM|MERGE)\b/i)
    expect(code).not.toMatch(/ROW LEVEL SECURITY/i)
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY/i)
    expect(code).not.toMatch(/ADD CONSTRAINT|DROP CONSTRAINT/i)
  })

  it('is transaction-compatible and contains no destructive statements', () => {
    // Check STATEMENTS, not raw lines: statements() collapses `DO $$ ... $$`
    // bodies, so the PL/pgSQL `BEGIN` of a guard block is not mistaken for
    // transaction control. Only a top-level COMMIT/ROLLBACK/BEGIN would break
    // `psql -1`.
    for (const stmt of statements(raw)) {
      expect(stmt, `transaction control statement: ${stmt}`).not.toMatch(
        /^(COMMIT|ROLLBACK|BEGIN)\b/i,
      )
    }
    expect(code).not.toMatch(/CONCURRENTLY/i)
    expectNoDestructiveStatements(code)
    expectNoExecutedDdl(raw)
    expectNoAnonOrPublicGrants(code)
  })

  it('grants nothing to anyone — it only removes privileges', () => {
    expect(code).not.toMatch(/\bGRANT\b/i)
  })
})

describe('db/prepared/stella_0002b_rollback.sql', () => {
  const raw = read('stella_0002b_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminated statements', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('declares the SAFE_NON_REVERSING_ROLLBACK policy', () => {
    expect(raw).toMatch(/SAFE_NON_REVERSING_ROLLBACK/)
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('never re-grants any of the dangerous privileges', () => {
    // The whole point: a rollback must not be a one-command way to reopen an
    // audit-trail hole. No executable GRANT may survive comment stripping.
    expect(code).not.toMatch(/\bGRANT\b/i)
    for (const priv of ['TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN', 'UPDATE', 'DELETE']) {
      expect(code, `rollback re-grants ${priv}`).not.toMatch(
        new RegExp(`GRANT[^;]*\\b${priv}\\b`, 'i'),
      )
    }
  })

  it('never drops the TRUNCATE or row-level protections', () => {
    expect(code).not.toMatch(/DROP TRIGGER/i)
    for (const [, trigger] of TRUNCATE_TRIGGERS) {
      expect(code).not.toMatch(new RegExp(`DROP[^;]*${trigger}`, 'i'))
    }
  })

  it('changes nothing at all: no DDL, no DML, no grants', () => {
    for (const stmt of statements(raw)) {
      expect(stmt, `unexpected mutating statement: ${stmt.slice(0, 60)}`).toMatch(/^(SET|DO)\b/i)
    }
    expect(code).not.toMatch(/\b(INSERT INTO|DELETE FROM|ALTER TABLE|CREATE TABLE|DROP TABLE)\b/i)
    expectNoDestructiveStatements(code)
  })

  it('verifies all three protections and reports gaps', () => {
    for (const [, trigger] of TRUNCATE_TRIGGERS) {
      expect(raw).toContain(trigger)
    }
    for (const trigger of ROW_TRIGGERS) {
      expect(raw).toContain(trigger)
    }
    expect(raw).toMatch(/RAISE WARNING/)
    expect(raw).toMatch(/RAISE NOTICE/)
  })

  it('explains why reversing would contradict the audit-ready guarantee', () => {
    expect(raw).toMatch(/audit-ready|audit trail/i)
    // Must distinguish itself from the bug-compatible stella_0002 rollback.
    expect(raw).toMatch(/BUG-COMPATIBLE/i)
    expect(raw).toMatch(/DBA/)
  })
})

// ---------------------------------------------------------------------------
// Correcciones de la auditoría independiente (2026-08-01)
// ---------------------------------------------------------------------------
// Pin the fixes for MAJ-01, MAJ-02 and the correctness MINORs so they cannot be
// silently undone. Each test names the finding it closes.

describe('audit fixes — MAJ-01: bounded lock acquisition', () => {
  it('stella_0002b sets a lock_timeout before taking ACCESS EXCLUSIVE', () => {
    const raw = read('stella_0002b_append_only_truncate_hardening.sql')
    // Every DROP/CREATE TRIGGER takes ACCESS EXCLUSIVE and holds it to COMMIT.
    // audit_logs is written on essentially every request, so an unbounded wait
    // behind a long reader would stall all traffic to it.
    expect(raw).toMatch(/SET lock_timeout = '\d+s'/)
    const stmts = statements(raw)
    const lockIdx = stmts.findIndex((s) => /^SET lock_timeout/i.test(s))
    const firstDdlIdx = stmts.findIndex((s) => /^(DROP TRIGGER|CREATE TRIGGER|REVOKE)\b/i.test(s))
    expect(lockIdx, 'lock_timeout missing').toBeGreaterThan(-1)
    expect(lockIdx, 'lock_timeout must precede any lock-taking statement').toBeLessThan(firstDdlIdx)
  })

  it('stella_0003 sets a lock_timeout too (its section 6 also takes the lock)', () => {
    const raw = read('stella_0003_suggestion_decisions.sql')
    expect(raw).toMatch(/SET lock_timeout = '\d+s'/)
  })
})

describe('audit fixes — MAJ-02: stella_0003 asserts its own write path', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')

  it('aborts if the declared writer role has no working INSERT path', () => {
    // Superseded 2026-08-01 (MAJ-A). The original assertion pinned
    // has_table_privilege(current_user, ...), which returns true for ANY
    // superuser and proved the installer's access rather than the
    // application's. The replacement resolves a DECLARED writer role.
    expect(raw).toMatch(/has no working INSERT path/)
    expect(raw).toMatch(/stella\.writer_role/)
  })

  it('verifies the RLS helpers are EXECUTABLE, not merely present (MIN-08)', () => {
    // 0033:18 revokes EXECUTE from authenticated and 0039 grants it back. An
    // environment with the first and not the second passes an existence check
    // but denies every read through the SELECT policy.
    expect(raw).toMatch(/has_function_privilege\('authenticated', 'public\.current_user_org_ids\(\)', 'EXECUTE'\)/)
    expect(raw).toMatch(/has_function_privilege\('authenticated', 'public\.current_user_is_super_admin\(\)', 'EXECUTE'\)/)
  })

  it('no longer claims service_role bypasses RLS on this table (MIN-07)', () => {
    // After section 4, service_role holds NO privilege here. Reads/writes work
    // because the OWNER bypasses RLS (no FORCE ROW LEVEL SECURITY).
    expect(raw).toMatch(/it is OWNERSHIP that bypasses RLS/i)
    expect(raw).not.toMatch(/via the service-role\s*\n?--\s*client \(recordStellaDecision\), which bypasses RLS/i)
  })
})

describe('audit fixes — stella_0002b hardening details', () => {
  const raw = read('stella_0002b_append_only_truncate_hardening.sql')
  const code = stripCommentsAndStrings(raw)

  it('guards that the grantee roles exist (MIN-02)', () => {
    expect(raw).toMatch(/FROM pg_roles WHERE rolname = r\.name/)
    expect(raw).toMatch(/missing role\(s\)/)
  })

  it('writes the MAINTAIN literal on one line, with no implicit concatenation (MIN-01)', () => {
    // Adjacent string constants concatenate ONLY when separated by a newline.
    // Splitting the literal would make any reformatting that joined the lines a
    // silent syntax error, so it must be a single self-contained literal.
    const m = /EXECUTE '(REVOKE MAINTAIN[^']*)'/.exec(raw)
    expect(m, 'MAINTAIN literal not found as a single quoted string').not.toBeNull()
    expect(m![1]).toContain('FROM authenticated, service_role')
    for (const t of ['stella_interactions', 'audit_logs', 'sroi_calculation_runs', 'sroi_calculation_line_items']) {
      expect(m![1]).toContain(`public.${t}`)
    }
    // No adjacent-literal concatenation anywhere in the file.
    expect(raw).not.toMatch(/'\s*\n\s*'/)
  })

  it('verifies its own end state inside the same transaction (MIN-10)', () => {
    // A REVOKE only removes grants from the current grantor and merely WARNs
    // when there is nothing to revoke — so "I ran REVOKE" is not evidence.
    expect(raw).toMatch(/FAILED verification: privileges still present after REVOKE/)
    expect(raw).toMatch(/FAILED verification: TRUNCATE trigger\(s\) not attached/)
    // Over-revoking must fail too: the posture is SELECT+INSERT, not read-only.
    expect(raw).toMatch(/FAILED verification: authenticated LOST expected privilege/)
    // Verification must come after the changes it checks. Compare positions in
    // `raw`: the messages live inside string literals, which `code` blanks.
    expect(raw.lastIndexOf('CREATE TRIGGER')).toBeLessThan(raw.indexOf('FAILED verification'))
  })

  it('uses to_regclass rather than a ::regclass cast (MIN-03)', () => {
    // `('public.'||t)::regclass` throws when the table is absent, and PostgreSQL
    // does not guarantee WHERE-qual evaluation order, so a sibling
    // `IS NOT NULL` guard cannot be relied on to run first. to_regclass()
    // already returns regclass and yields NULL instead of raising.
    expect(code).not.toMatch(/\)::regclass/)
    // Positive check must read `raw`: stripCommentsAndStrings blanks the
    // 'public.' literal, so this pattern can never match in `code`.
    expect(raw).toMatch(/to_regclass\('public\.' \|\| t\.tbl\)/)
  })
})

describe('audit fixes — stella_0002b rollback', () => {
  const raw = read('stella_0002b_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('uses to_regclass rather than a ::regclass cast (MIN-03)', () => {
    expect(code).not.toMatch(/\)::regclass/)
    // Positive check must read `raw`: stripCommentsAndStrings blanks the
    // 'public.' literal, so this pattern can never match in `code`.
    expect(raw).toMatch(/to_regclass\('public\.' \|\| t\.tbl\)/)
  })

  it('exits non-zero when it detects a gap (MIN-04)', () => {
    // It changes nothing, so raising is free — and a gate that trusts the exit
    // code must not see green while the script just reported the protection is
    // gone.
    expect(raw).toMatch(/RAISE EXCEPTION 'stella_0002b_rollback: append-only hardening is NOT intact/)
  })
})

describe('audit fixes — MIN-09: order hazard is documented', () => {
  it('stella_0002_rollback warns that it leaves an asymmetric state after 0002b', () => {
    const raw = read('stella_0002_rollback.sql')
    expect(raw).toMatch(/ORDER HAZARD vs stella_0002b/)
    expect(raw).toMatch(/asymmetric/i)
  })
})

// ---------------------------------------------------------------------------
// stella_0003 pre-apply hardening (2026-08-01) — MAJ-A / MAJ-B / MAJ-C
// ---------------------------------------------------------------------------
// Pins the fixes made before this script's FIRST application anywhere. Each
// test names the finding it closes.

describe('stella_0003 MAJ-A — the write-path guard is not vacuous', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  // Absence assertions must read the EXECUTABLE sql: the comments legitimately
  // quote the old, rejected patterns while explaining why they were replaced.
  const code = stripCommentsAndStrings(raw)

  it('never uses has_table_privilege(current_user, ...)', () => {
    // The old guard did exactly this. has_table_privilege() returns true
    // unconditionally for any role with rolsuper, so it was blind precisely in
    // the case its own comment named: the script being applied by tooling
    // running as supabase_admin.
    // Read `code`, not `raw`: the replacement's own comment quotes the old
    // pattern verbatim while explaining why it was removed.
    expect(code).not.toMatch(/has_table_privilege\(\s*current_user/i)
  })

  it('declares an explicit writer role instead of assuming the installer', () => {
    expect(raw).toMatch(/current_setting\('stella\.writer_role', true\)/)
    // And documents how it is set, how it fails when absent, how it is verified.
    expect(raw).toMatch(/SET stella\.writer_role/)
    expect(raw).toMatch(/WHEN UNSET/)
    expect(raw).toMatch(/ASSUMPTION, not a verification/)
  })

  it('resolves privileges through aclexplode, so inheritance cannot satisfy it', () => {
    // aclexplode() over relacl reads the ACL literally: privileges reached via
    // role membership do not appear, and there is no superuser short-circuit.
    expect(raw).toMatch(/aclexplode\(COALESCE\(c\.relacl, acldefault\('r', c\.relowner\)\)\)/)
    // Superseded by m3: the grantee OID is resolved by exact rolname rather
    // than through ::regrole, which lowercases and dot-splits its input.
    expect(raw).toMatch(/a\.grantee = writer_oid/)
  })

  it('requires ownership OR (direct INSERT+SELECT AND rolbypassrls)', () => {
    // RLS is enabled with no INSERT policy, so a bare INSERT grant is not a
    // working write path. INSERT ... RETURNING id also needs SELECT.
    expect(raw).toMatch(/owner_is_writer/)
    expect(raw).toMatch(/rolbypassrls/)
    expect(raw).toMatch(/direct_insert/)
    expect(raw).toMatch(/direct_select/)
    expect(raw).toMatch(/RETURNING id/)
  })

  it('refuses a PostgREST role as table owner', () => {
    expect(raw).toMatch(/a PostgREST role/)
  })

  it('tells the operator NOT to grant INSERT just to satisfy the guard', () => {
    expect(raw).toMatch(/Do NOT grant INSERT to authenticated or service_role/)
  })

  it('separates what SQL proves from what it cannot', () => {
    // Structural guard / offline code test / human gate precondition.
    expect(raw).toMatch(/STRUCTURAL GUARD/)
    expect(raw).toMatch(/OFFLINE CODE TEST/)
    expect(raw).toMatch(/HUMAN GATE PRECONDITION/)
  })
})

describe('stella_0003 MAJ-C — roles guard runs before anything is created', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')

  it('checks anon, authenticated and service_role exist', () => {
    expect(raw).toMatch(/FROM \(VALUES \('anon'\), \('authenticated'\), \('service_role'\)\) AS r\(name\)/)
    expect(raw).toMatch(/missing role\(s\)/)
  })

  it('places that guard before the CREATE TABLE', () => {
    // Anchor on the guard's VALUES list and on the fully-qualified CREATE
    // TABLE: the bare phrase 'CREATE TABLE IF NOT EXISTS' also appears in a
    // header comment far above the real statement, and the guard's message
    // lives inside a string literal (blanked by stripCommentsAndStrings), so
    // neither raw-substring nor code-substring alone is reliable here.
    const guardAt = raw.indexOf("('anon'), ('authenticated'), ('service_role')")
    const createAt = raw.indexOf('CREATE TABLE IF NOT EXISTS public.stella_suggestion_decisions')
    expect(guardAt, 'roles guard not found').toBeGreaterThan(-1)
    expect(createAt, 'CREATE TABLE statement not found').toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(createAt)
  })

  it('does not fold the writer role into the fixed-role guard', () => {
    // The installer is explicitly NOT assumed to be the writer.
    expect(raw).toMatch(/installer is NOT assumed to be it/)
  })
})

describe('stella_0003 MAJ-B — final self-verification', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')

  it('exists and runs after the objects it checks', () => {
    expect(raw).toMatch(/Self-verification/)
    expect(raw.lastIndexOf('CREATE TRIGGER')).toBeLessThan(raw.indexOf('FAILED verification'))
  })

  it('explains why running REVOKE is not evidence', () => {
    expect(raw).toMatch(/only removes grants made by the CURRENT grantor/)
    expect(raw).toMatch(/WARNING — never an error/)
  })

  it.each([
    ['table exists', /does not exist after the script ran/],
    ['owner is not a PostgREST role', /FAILED verification: table owner is/],
    ['column contract', /column contract broken/],
    ['primary key', /PRIMARY KEY on \(id\) missing/],
    ['foreign keys', /missing FOREIGN KEY\(s\)/],
    ['no unexpected UNIQUE', /unexpected UNIQUE constraint/],
    ['decision CHECK', /decision CHECK missing or incomplete/],
    ['hash CHECK anchored', /CHECK missing or not anchored/],
    ['RLS enabled', /ROW LEVEL SECURITY is not enabled/],
    ['exactly one policy', /expected exactly 1 RLS policy/],
    ['row trigger', /expected exactly 1 BEFORE UPDATE OR DELETE FOR EACH ROW trigger/],
    ['truncate trigger', /expected exactly 1 BEFORE TRUNCATE FOR EACH STATEMENT trigger/],
    ['both bound to the shared function', /triggers bound to public\.uellix_forbid_mutation/],
    ['no extra triggers', /unexpected extra trigger/],
    ['no residual privileges', /unexpected DIRECT privilege\(s\) present/],
    ['not over-revoked', /authenticated LOST its direct SELECT grant/],
    // NOTE: the former checks (19) evidence_chunks-absent and (20)
    // default-privileges-untouched were REMOVED in review round 2 — see the
    // 'review round 2' describe below. (19) broke convergence once
    // grounding_0001 is applied under its own gate; (20) was unfalsifiable.
    ['no unexpected columns', /expected exactly 11 columns/],
    ['FORCE RLS off', /FORCE ROW LEVEL SECURITY is ON/],
  ])('asserts: %s', (_label, pattern) => {
    expect(raw).toMatch(pattern)
  })

  it('reads pg_catalog, not information_schema, for privileges', () => {
    // Strip comments: the block's own prose explains WHY
    // information_schema.role_table_grants is unusable here.
    const verify = stripCommentsAndStrings(raw.slice(raw.indexOf('Self-verification')))
    expect(verify).toMatch(/aclexplode/)
    expect(verify).not.toMatch(/information_schema/)
  })

  it('uses pg_policy/pg_trigger/pg_constraint rather than views', () => {
    // Strip comments: this block's own prose explains WHY
    // information_schema.role_table_grants is unusable here.
    const verify = stripCommentsAndStrings(raw.slice(raw.indexOf('Self-verification')))
    for (const cat of ['pg_policy', 'pg_trigger', 'pg_constraint', 'pg_attribute', 'pg_class']) {
      expect(verify, `self-verification does not read ${cat}`).toMatch(new RegExp(`\\b${cat}\\b`))
    }
  })
})

describe('stella_0003 MIN-A — accepted_edited is matched literally', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')

  it('uses position(), never LIKE, for the decision literals', () => {
    // `_` is a LIKE wildcard: LIKE '%''accepted_edited''%' would also accept a
    // stale constraint spelling 'acceptedXedited' and leave it in place.
    // Absence is asserted on the executable sql: the explanatory comments
    // quote the rejected LIKE form on purpose.
    const codeOnly = stripCommentsAndStrings(raw)
    expect(codeOnly).not.toMatch(/\bLIKE\b/i)
    expect(raw).toMatch(/position\('''accepted_edited''' in def\)/)
  })

  it('matches the anchored hash pattern literally too', () => {
    expect(raw).toMatch(/position\('''\^\[0-9a-f\]\{64\}\$''' in def\)/)
  })
})

describe('stella_0003 — append-only triggers and grant targets', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  const code = stripCommentsAndStrings(raw)

  it('creates exactly the two append-only triggers, idempotently', () => {
    expect(code).toMatch(
      /CREATE TRIGGER trg_stella_suggestion_decisions_append_only\s+BEFORE UPDATE OR DELETE ON public\.stella_suggestion_decisions\s+FOR EACH ROW EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i,
    )
    expect(code).toMatch(
      /CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate\s+BEFORE TRUNCATE ON public\.stella_suggestion_decisions\s+FOR EACH STATEMENT EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i,
    )
    expect([...code.matchAll(/CREATE TRIGGER/gi)]).toHaveLength(2)
    expect([...code.matchAll(/DROP TRIGGER IF EXISTS/gi)]).toHaveLength(2)
  })

  it('leaves no Dxtm residue: REVOKE ALL for all three roles, then SELECT only', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON public\\.stella_suggestion_decisions FROM ${role}`, 'i'))
    }
    expect(code).toMatch(/GRANT SELECT ON public\.stella_suggestion_decisions TO authenticated/i)
    expect(code).not.toMatch(/GRANT[^;]*TO service_role/i)
    expect(code).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL)\b[^;]*TO/i)
  })

  it('sets a lock_timeout', () => {
    expect(raw).toMatch(/SET lock_timeout = '\d+s'/)
  })
})

describe('stella_0003 rollback — destructive, and protected accordingly', () => {
  const raw = read('stella_0003_rollback.sql')

  it('sets a lock_timeout before taking ACCESS EXCLUSIVE', () => {
    expect(raw).toMatch(/SET lock_timeout = '\d+s'/)
  })

  it('is a no-op when the table does not exist', () => {
    expect(raw).toMatch(/does not exist — nothing to do \(idempotent no-op\)/)
  })

  it('counts rows and reports the count before dropping', () => {
    expect(raw).toMatch(/SELECT count\(\*\) FROM public\.stella_suggestion_decisions/)
    expect(raw).toMatch(/RAISE NOTICE 'Rows currently stored: %'/)
  })

  it('aborts when rows exist and destruction was not authorised', () => {
    expect(raw).toMatch(/stella\.confirm_destroy_decisions/)
    expect(raw).toMatch(/destruction was NOT authorised/)
    expect(raw).toMatch(/RAISE EXCEPTION 'stella_0003_rollback aborted/)
  })

  it('warns that DROP TABLE erases the audit trail and triggers cannot stop it', () => {
    expect(raw).toMatch(/erases this human-decision audit trail/)
    expect(raw).toMatch(/cannot stop DROP TABLE/)
  })

  it('names the four meanings of rollback and the human responsibility', () => {
    for (const m of [
      /TECHNICAL ROLLBACK, BEFORE USE/,
      /DESTRUCTION WITH DATA/,
      /EMERGENCY OPERATION/,
      /HUMAN RESPONSIBILITY/,
    ]) {
      expect(raw).toMatch(m)
    }
  })

  it('never restores unsafe grants and never touches 0002/0002b', () => {
    const code = stripCommentsAndStrings(raw)
    expect(code).not.toMatch(/\bGRANT\b/i)
    expect(code).not.toMatch(/stella_interactions|audit_logs|sroi_calculation/i)
    expect(code).not.toMatch(/DROP FUNCTION/i)
  })

  it('drops exactly the one table this package creates', () => {
    const code = stripCommentsAndStrings(raw)
    const targets = [...code.matchAll(/DROP TABLE IF EXISTS ([\w.]+)/gi)].map((m) => m[1])
    expect(targets).toEqual(['public.stella_suggestion_decisions'])
  })
})

describe('G2 verification must not use the ambiguous grants view', () => {
  const g2 = readFileSync(
    path.resolve(process.cwd(), 'docs', 'ops', 'gates', 'G2_PACKAGE.md'),
    'utf8',
  )

  it('checks stella_suggestion_decisions grants via aclexplode, not role_table_grants', () => {
    // information_schema.role_table_grants expands privileges reached through
    // role MEMBERSHIP, and postgres is a member of authenticated/service_role
    // in Supabase — so it returns owner and inherited rows and reads as a false
    // red. Measured on this stack: 11 rows vs 4 real direct grants.
    const section = g2.slice(g2.indexOf('-- 6.'), g2.indexOf('-- 7.'))
    expect(section).not.toMatch(/role_table_grants\s*\n?\s*WHERE/i)
    expect(section).toMatch(/aclexplode\(COALESCE\(c\.relacl, acldefault\('r', c\.relowner\)\)\)/)
    expect(section).toMatch(/a\.grantee = 0/) // PUBLIC check
  })

  it('explains why the view is wrong, so it does not come back', () => {
    expect(g2).toMatch(/NO uses information_schema\.role_table_grants/)
    expect(g2).toMatch(/MEMBRESÍA|membres/i)
    expect(g2).toMatch(/falso rojo/i)
  })
})

describe('retention policy states the real FK semantics', () => {
  const pol = readFileSync(
    path.resolve(process.cwd(), 'docs', 'ops', 'STELLA_RETENTION_POLICY.md'),
    'utf8',
  )

  it('no longer claims an organizational delete cascade', () => {
    expect(pol).toMatch(/NO existe ninguna cascada/i)
    expect(pol).toMatch(/NO ACTION/)
  })

  it('says the rows BLOCK the parent delete and what to do first', () => {
    expect(pol).toMatch(/bloquean/i)
    expect(pol).toMatch(/violates foreign key constraint/)
    expect(pol).toMatch(/Exportar/i)
  })

  it('records that nothing is automated and that 4.2 is now trigger-blocked', () => {
    expect(pol).toMatch(/NO está automatizado/i)
    expect(pol).toMatch(/bloqueada por el trigger append-only/i)
  })
})

describe('the hardening did not touch the drizzle chain', () => {
  it('db/schema.ts does not mention the gate-managed tables', () => {
    const schema = readFileSync(path.resolve(process.cwd(), 'db', 'schema.ts'), 'utf8')
    expect(schema).not.toMatch(/stella_suggestion_decisions|suggestionDecisions/)
    expect(schema).not.toMatch(/evidence_chunks|evidenceChunks/)
  })

  it('no migration references the prepared scripts', () => {
    const journal = readFileSync(
      path.resolve(process.cwd(), 'db', 'migrations', 'meta', '_journal.json'),
      'utf8',
    )
    expect(journal).not.toContain('stella_0003')
    expect(journal).not.toContain('stella_0002b')
  })
})

// ---------------------------------------------------------------------------
// Independent review round 2 (2026-08-01) — M1 + m1..m7
// ---------------------------------------------------------------------------
// Regression tests for the findings of the second independent review of the
// stella_0003 pre-apply hardening. Each names the finding it closes.

describe('review round 2 — stella_0003 forward', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  const code = stripCommentsAndStrings(raw)

  it('M1: never aborts because evidence_chunks exists', () => {
    // grounding_0001 legitimately creates public.evidence_chunks on the SAME
    // database under its own gate (G5 P3). Raising here would make every
    // re-run of this script abort once that gate is applied, breaking the
    // convergence the header promises. The real invariant — that THIS file
    // never creates it — is static and covered offline.
    expect(code).not.toMatch(/evidence_chunks/i)
    expect(raw).toMatch(/NOT CHECKED AT RUNTIME, deliberately/)
    expect(raw).toMatch(/grounding_0001_evidence_chunks\.sql legitimately creates/)
  })

  it('m1: drops the pg_default_acl check that could never fire', () => {
    // defaclacl is aclitem[] — 'grantee=privs/grantor' — and never contains a
    // table name, so position('stella_suggestion_decisions' in ...) was always
    // 0: a check that reported itself verified while being unfalsifiable.
    expect(code).not.toMatch(/pg_default_acl/)
    expect(raw).toMatch(/unfalsifiable/)
  })

  it('m2: requires FORCE ROW LEVEL SECURITY to be OFF, in both places', () => {
    // The whole write path rests on the owner bypassing RLS. With FORCE ON the
    // owner stops bypassing and, with no INSERT policy, every write fails —
    // while the script would still report VERIFIED.
    expect(code).toMatch(/relforcerowsecurity/)
    expect([...code.matchAll(/relforcerowsecurity/g)].length).toBeGreaterThanOrEqual(2)
    expect(raw).toMatch(/FORCE ROW LEVEL SECURITY is ON/)
  })

  it('m3: resolves the writer OID by rolname, never through ::regrole', () => {
    // regrolein parses its argument as an SQL identifier: it lowercases
    // unquoted input and splits on dots, so a role named "AppWriter" or
    // "app.writer" would pass the existence check and then fail resolving.
    expect(code).not.toMatch(/::regrole/)
    expect(code).toMatch(/SELECT oid INTO writer_oid FROM pg_roles WHERE rolname = writer/)
    expect(code).toMatch(/a\.grantee = writer_oid/)
  })

  it('m4: the decision CHECK must contain the four states AND no others', () => {
    // position() proves presence, not exclusivity: a stale CHECK also allowing
    // 'deleted' would satisfy four probes and pass.
    expect(code).toMatch(/regexp_matches\(def/)
    expect(raw).toMatch(/Presence is not exclusivity/)
    expect(raw).toMatch(/allows unexpected state\(s\)/)
  })

  it('m5: a grantable SELECT is not treated as the allowed plain SELECT', () => {
    // authenticated=r*/postgres would let authenticated re-grant SELECT to anon.
    expect(code).toMatch(/NOT a\.is_grantable/)
  })

  it('m6: rejects extra columns, extra FKs, and non-NO-ACTION delete rules', () => {
    expect(raw).toMatch(/expected exactly 11 columns/)
    expect(raw).toMatch(/expected exactly 4 foreign keys/)
    // confdeltype 'a' = NO ACTION — a deliberate invariant per RK-04f.
    // Read `raw`: stripCommentsAndStrings blanks the 'a' literal.
    expect(raw).toMatch(/c\.confdeltype = 'a'/)
    expect(raw).toMatch(/not ON DELETE NO ACTION/)
  })

  it('m7: refuses a PostgREST role as the declared writer', () => {
    expect(raw).toMatch(/declared writer role % is a PostgREST role/)
  })
})

describe('review round 2 — stella_0003 rollback authorization', () => {
  const raw = read('stella_0003_rollback.sql')

  it("accepts only the exact string 'true' as destruction authorization", () => {
    // No ambiguous values: 'yes', 'y', '1' and anything else must NOT authorise
    // erasing an audit trail.
    expect(raw).toMatch(/current_setting\('stella\.confirm_destroy_decisions', true\), ''\) = 'true'/)
    expect(raw).not.toMatch(/= 'yes'/)
    expect(raw).toMatch(/SET stella\.confirm_destroy_decisions = 'true'/)
  })
})

// ---------------------------------------------------------------------------
// Review round 3 (2026-08-01) — MAJOR-1: the OFFLINE CODE TEST §4b cites
// ---------------------------------------------------------------------------
// stella_0003 §4b splits its assurance into three parts and names this file as
// part 2: "the application's only write path is db/client.ts (postgres-js over
// DATABASE_URL), not a service_role/PostgREST client".
//
// That claim was TRUE but UNENFORCED — nothing tested it. Which is exactly the
// defect M1 and m1 closed elsewhere in this package: a verification declared
// and not performed. It is load-bearing here, because it is the stated reason
// the SQL guard is allowed to stop where it does.

const REPO = process.cwd()
const readRepo = (...p: string[]) => readFileSync(path.join(REPO, ...p), 'utf8')

describe('MAJOR-1 — the write path stella_0003 §4b relies on is pinned here', () => {
  const client = readRepo('db', 'client.ts')
  const decisions = readRepo('app', 'actions', 'stella', 'decisions.ts')

  it('db/client.ts is a direct postgres-js connection over DATABASE_URL', () => {
    // If this ever became a supabase-js client, the writer would stop being the
    // DATABASE_URL role and the SQL guard's owner check would be verifying the
    // wrong thing.
    expect(client).toMatch(/from 'postgres'/)
    expect(client).toMatch(/process\.env\.DATABASE_URL/)
    expect(client).toMatch(/drizzle\(client/)
    expect(client).not.toMatch(/createClient|@supabase\/supabase-js/)
    expect(client).not.toMatch(/SERVICE_ROLE/)
  })

  it('recordStellaDecision writes through that client, not through supabase-js', () => {
    expect(decisions).toMatch(/import \{ db \} from '@\/db\/client'/)
    expect(decisions).toMatch(/db\.execute\(/)
    // No PostgREST/service-role path to this table.
    expect(decisions).not.toMatch(/@supabase\/supabase-js/)
    expect(decisions).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
    expect(decisions).not.toMatch(/createClient\(/)
  })

  it('no other module reaches stella_suggestion_decisions at all', () => {
    // The SQL grants authenticated SELECT and service_role nothing. If some
    // other module started reading or writing this table through PostgREST,
    // that posture would need revisiting — so fail loudly if one appears.
    const roots = ['app', 'lib', 'components']
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue
          walk(full)
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const src = readFileSync(full, 'utf8')
          // Ignore comments: several files legitimately DESCRIBE the table.
          const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
          if (code.includes('stella_suggestion_decisions')) {
            offenders.push(path.relative(REPO, full).replace(/\\/g, '/'))
          }
        }
      }
    }
    for (const r of roots) {
      const dir = path.join(REPO, r)
      if (existsSync(dir)) walk(dir)
    }
    // decisions.ts is the one legitimate consumer (its INSERT).
    expect(offenders.sort()).toEqual(['app/actions/stella/decisions.ts'])
  })

  it('stella_0003 §4b describes this split honestly and points at a real test', () => {
    const sql = read('stella_0003_suggestion_decisions.sql')
    expect(sql).toMatch(/OFFLINE CODE TEST/)
    // The cited file must be this one, and it must actually read db/client.ts.
    expect(sql).toMatch(/tests\/prepared-stella-sql\.test\.ts/)
  })
})

describe('review round 3 — MINOR-2..7', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  const code = stripCommentsAndStrings(raw)

  it('MINOR-2: the (19) comment attributes enforcement to the right test', () => {
    // It previously credited prepared-sql-source-of-truth.test.ts, which only
    // isolates the drizzle chain, and claimed the script "does not mention
    // evidence_chunks anywhere" — literally false, it appears in comments.
    expect(raw).toMatch(/EXECUTABLE sql never mentions evidence_chunks/)
    expect(raw).toMatch(/tests\/prepared-stella-sql\.test\.ts pins/)
    expect(raw).not.toMatch(/tests\/prepared-sql-source-of-truth\.test\.ts enforces the separation/)
  })

  it('MINOR-3: literal extraction is not limited to [a-z_]', () => {
    // `'([a-z_]+)'` produced NO match for 'accepted2', 'Deleted' or 'v2', so a
    // stale CHECK admitting them passed the exclusivity test silently.
    // Read `raw`: stripCommentsAndStrings blanks the SQL pattern literal.
    // Both call sites (section 2 reconciliation and section 7 verification)
    // must use the wide class.
    const calls = [...raw.matchAll(/regexp_matches\(def, '''([^\n]*?)''', 'g'\)/g)].map((m) => m[1])
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c).toBe("([^'']+)")
  })

  it('MINOR-4: section 2 reconciles on the same test section 7 enforces', () => {
    // Otherwise a pre-existing SUPERSET CHECK survived reconciliation and then
    // made the final verification abort the whole transaction — the header
    // promises convergence, not a noisy failure.
    const sec2 = raw.slice(raw.indexOf('-- 2. CHECK reconciliation'), raw.indexOf('-- 3. Indexes'))
    expect(sec2).toMatch(/regexp_matches/)
    expect(sec2).toMatch(/lit NOT IN \('accepted', 'accepted_edited', 'rejected', 'undone'\)/)
  })

  it('MINOR-5: PUBLIC is revoked and then verified', () => {
    // PUBLIC is grantee OID 0 and has no pg_roles row, so a JOIN to pg_roles
    // cannot see it. Revoke by construction, and check it explicitly.
    expect(code).toMatch(/REVOKE ALL ON public\.stella_suggestion_decisions FROM PUBLIC/i)
    expect(code).toMatch(/a\.grantee = 0/)
    expect(raw).toMatch(/PUBLIC holds privilege\(s\)/)
  })

  it('MINOR-A: the "no ALTER DEFAULT PRIVILEGES" claim is actually enforced', () => {
    // The (20) comment says this is "a static property enforced offline".
    // Nothing enforced it — the same declared-but-unverified defect MINOR-2
    // closed two lines above. Global default privileges are RK-04c's territory
    // and belong to a cross-cutting gate, never to a single-table script.
    expect(code).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i)
    const rollback = read('stella_0003_rollback.sql')
    expect(stripCommentsAndStrings(rollback)).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i)
  })

  it('MINOR-C: narrowing the CHECK reports offending states, not a bare PG error', () => {
    // Rebuilding a CHECK that existing rows violate fails with PostgreSQL's
    // generic 'check constraint "..." is violated by some row' — without the
    // 'stella_0003 aborted:' prefix the header and the G2 abort criteria tell
    // the operator to look for. Report the distinct STATES (never row data).
    expect(raw).toMatch(/existing rows hold decision state\(s\) outside the contract/)
    expect(code).toMatch(/string_agg\(DISTINCT d\.decision/)
    expect(raw).toMatch(/No row data is shown, only the distinct states/)
  })

  it('MINOR-6: a standalone UNIQUE index is caught, not just a constraint', () => {
    // CREATE UNIQUE INDEX enforces uniqueness without creating a constraint.
    expect(code).toMatch(/FROM pg_index i/)
    expect(code).toMatch(/i\.indisunique AND NOT i\.indisprimary/)
    expect(raw).toMatch(/unexpected UNIQUE index\(es\)/)
  })
})

describe('review round 3 — documentation is in sync with the SQL', () => {
  const readme = readFileSync(path.join(PREPARED, 'README.md'), 'utf8')
  const g2 = readFileSync(
    path.resolve(process.cwd(), 'docs', 'ops', 'gates', 'G2_PACKAGE.md'),
    'utf8',
  )

  it('MINOR-1: the registry no longer claims the two removed checks', () => {
    expect(readme).not.toMatch(/20 comprobaciones/)
    expect(readme).toMatch(/18 comprobaciones/)
    // ...and says explicitly which two went, so they are not reintroduced.
    expect(readme).toMatch(/Dos comprobaciones fueron retiradas/)
    expect(readme).toMatch(/infalsificable/)
  })

  it('MINOR-7: every documented apply path says how to declare the writer', () => {
    // `supabase db execute --file` and the SQL Editor cannot emit a prior SET,
    // so without ALTER DATABASE ... SET they always land in ASSUMPTION mode.
    expect(g2).toMatch(/ALTER DATABASE .* SET stella\.writer_role/)
    expect(g2).toMatch(/supabase db execute --file/)
    expect(g2).toMatch(/rama ASSUMPTION/)
  })
})
