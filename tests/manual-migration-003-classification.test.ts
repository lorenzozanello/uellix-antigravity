// tests/manual-migration-003-classification.test.ts
// G2/G3 local rehearsal (2026-08-01).
//
// `db/manual-migrations/003_numeric_columns.sql` converts the money / quantity
// / ratio columns from varchar to numeric. Its own PRECHECK uses the regex
// operator `!~`, which only exists for text-like types — so on a database
// rebuilt from scratch through the drizzle chain (where 0016 already lands
// those columns as numeric) the PRECHECK cannot even be parsed:
//
//     ERROR: operator does not exist: numeric !~ unknown
//
// That failure is the SIGNAL, not the problem: it means the conversion is
// already done. This test pins the reasoning down so nobody re-derives it by
// hand, and — just as importantly — so nobody deletes 003 as "dead code". A
// LEGACY database whose columns are still varchar (one that never applied
// 0016, e.g. a restore of a pre-July-2026 dump) still needs it.
//
// Classification: CONDITIONAL_LEGACY_ONLY.
// Decision for a fresh drizzle build: ALREADY_SATISFIED_ON_FRESH_DRIZZLE_BUILD.
//
// Fully offline: reads repository files only. No database, no network.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const readRoot = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8')

const script003 = readRoot('db', 'manual-migrations', '003_numeric_columns.sql')
const migration0016 = readRoot('db', 'migrations', '0016_fat_mac_gargan.sql')
const schemaTs = readRoot('db', 'schema.ts')
const runbook = readRoot('docs', 'ops', 'LOCAL_STAGING_G2_REHEARSAL.md')

/**
 * The authoritative target matrix, transcribed from 003 by hand so that a
 * silent edit to the script shows up as a test failure rather than as a
 * quietly-relaxed expectation. Note sroi_ratio is the one column at scale 6 —
 * a blanket "all money columns are numeric(20,4)" assumption would be wrong.
 */
const TARGET_MATRIX = [
  { table: 'project_investments', column: 'amount', precision: 20, scale: 4 },
  { table: 'financial_proxies', column: 'value', precision: 20, scale: 4 },
  { table: 'sroi_assignment_inputs', column: 'quantity', precision: 20, scale: 4 },
  { table: 'sroi_calculation_runs', column: 'total_investment', precision: 20, scale: 4 },
  { table: 'sroi_calculation_runs', column: 'gross_social_value', precision: 20, scale: 4 },
  { table: 'sroi_calculation_runs', column: 'net_social_value', precision: 20, scale: 4 },
  { table: 'sroi_calculation_runs', column: 'sroi_ratio', precision: 20, scale: 6 },
  { table: 'sroi_calculation_line_items', column: 'quantity', precision: 20, scale: 4 },
  { table: 'sroi_calculation_line_items', column: 'proxy_value', precision: 20, scale: 4 },
  { table: 'sroi_calculation_line_items', column: 'gross_value', precision: 20, scale: 4 },
  { table: 'sroi_calculation_line_items', column: 'adjusted_value', precision: 20, scale: 4 },
] as const

type TargetColumn = { table: string; column: string; precision: number; scale: number }

/**
 * Parse `ALTER COLUMN <col> TYPE numeric(p,s)` out of a SQL script, attributing
 * each column to the nearest preceding `ALTER TABLE <t>`. Handles both the
 * one-statement-per-column form and the multi-column form 003 uses for
 * sroi_calculation_runs / sroi_calculation_line_items.
 */
function parseNumericConversions(sql: string): TargetColumn[] {
  const tableMarks: Array<{ at: number; table: string }> = []
  for (const m of sql.matchAll(/ALTER TABLE\s+"?(\w+)"?/g)) {
    tableMarks.push({ at: m.index!, table: m[1] })
  }

  const found: TargetColumn[] = []
  const columnRe = /ALTER COLUMN\s+"?(\w+)"?\s+(?:TYPE|SET DATA TYPE)\s+numeric\((\d+),\s*(\d+)\)/g
  for (const m of sql.matchAll(columnRe)) {
    const owner = [...tableMarks].reverse().find((t) => t.at < m.index!)
    expect(owner, `no ALTER TABLE precedes column "${m[1]}"`).toBeDefined()
    found.push({
      table: owner!.table,
      column: m[1],
      precision: Number(m[2]),
      scale: Number(m[3]),
    })
  }
  return found
}

/** Isolate one `export const X = pgTable('<name>', {...})` block from schema.ts. */
function tableBlock(source: string, tableName: string): string {
  const start = source.indexOf(`pgTable('${tableName}'`)
  expect(start, `pgTable('${tableName}') not found in db/schema.ts`).toBeGreaterThan(-1)
  const next = source.indexOf('\nexport const ', start)
  return source.slice(start, next === -1 ? source.length : next)
}

describe('003 target matrix — the script still says what we think it says', () => {
  const parsed = parseNumericConversions(script003)

  it('converts exactly the 11 columns in the authoritative matrix', () => {
    const key = (c: TargetColumn) => `${c.table}.${c.column}`
    expect(parsed.map(key).sort()).toEqual(TARGET_MATRIX.map(key).sort())
  })

  it.each(TARGET_MATRIX)(
    'targets $table.$column as numeric($precision,$scale)',
    ({ table, column, precision, scale }) => {
      const actual = parsed.find((c) => c.table === table && c.column === column)
      expect(actual, `${table}.${column} not converted by 003`).toBeDefined()
      expect(actual!.precision).toBe(precision)
      expect(actual!.scale).toBe(scale)
    },
  )

  it('keeps sroi_ratio at a different scale than the money columns', () => {
    // Guards against a future "normalize everything to (20,4)" edit that would
    // silently truncate the ratio's precision.
    const ratio = parsed.find((c) => c.column === 'sroi_ratio')!
    const money = parsed.filter((c) => c.column !== 'sroi_ratio')
    expect(ratio.scale).toBe(6)
    expect(new Set(money.map((c) => c.scale))).toEqual(new Set([4]))
  })
})

describe('db/schema.ts declares the same target state 003 aims at', () => {
  it.each(TARGET_MATRIX)(
    'declares $table.$column as numeric with precision $precision, scale $scale',
    ({ table, column, precision, scale }) => {
      const block = tableBlock(schemaTs, table)
      const re = new RegExp(
        `numeric\\('${column}',\\s*\\{\\s*precision:\\s*(\\d+),\\s*scale:\\s*(\\d+)\\s*\\}\\)`,
      )
      const m = re.exec(block)
      expect(m, `${table}.${column} is not declared as numeric() in db/schema.ts`).not.toBeNull()
      expect(Number(m![1])).toBe(precision)
      expect(Number(m![2])).toBe(scale)
    },
  )

  it.each(TARGET_MATRIX)('does not declare $table.$column as varchar/text', ({ table, column }) => {
    const block = tableBlock(schemaTs, table)
    expect(block).not.toMatch(new RegExp(`varchar\\('${column}'`))
    expect(block).not.toMatch(new RegExp(`text\\('${column}'`))
  })
})

describe('migration 0016 is what makes 003 unnecessary on a fresh build', () => {
  const folded = parseNumericConversions(migration0016)

  it('converts the same 11 columns to the same precision and scale', () => {
    const norm = (c: TargetColumn) => `${c.table}.${c.column}:${c.precision},${c.scale}`
    expect(folded.map(norm).sort()).toEqual(TARGET_MATRIX.map(norm).sort())
  })

  it('carries explicit USING clauses so a fresh varchar->numeric cast succeeds', () => {
    // Without USING, PostgreSQL refuses varchar -> numeric outright. This is
    // precisely the fix 0016 added over the raw 003 statements.
    const usingCount = [...migration0016.matchAll(/USING\s+NULLIF/g)].length
    expect(usingCount).toBe(TARGET_MATRIX.length)
  })

  it('re-adds the two CHECK constraints in native numeric form', () => {
    // 0009 spelled these as cast(nullif(col,'') as numeric) > 0 — a text-era
    // expression that is invalid once the column is numeric.
    expect(migration0016).toMatch(/ADD CONSTRAINT "project_investments_amount_check"/)
    expect(migration0016).toMatch(/ADD CONSTRAINT "sroi_assignment_inputs_quantity_check"/)
    expect(migration0016).not.toMatch(/cast\(nullif/i)
  })

  it('is registered in the drizzle journal, so `db:migrate:local` applies it', () => {
    const journal = readRoot('db', 'migrations', 'meta', '_journal.json')
    expect(journal).toContain('0016_fat_mac_gargan')
  })
})

describe('003 stays CONDITIONAL_LEGACY_ONLY — never universally deprecated', () => {
  it('is still present on disk and still performs the conversion', () => {
    // A legacy database restored from a pre-0016 dump has varchar columns and
    // genuinely needs this script. Deleting it would strip that capability.
    expect(script003).toMatch(/ALTER COLUMN/)
    expect(script003).not.toMatch(/DEPRECATED|OBSOLETE|DO NOT USE/i)
  })

  it('has a PRECHECK that is only meaningful against text-like columns', () => {
    // Documents the root cause of the observed failure: `!~` has no numeric
    // overload, so this PRECHECK cannot run on an already-converted database.
    expect(script003).toMatch(/!~/)
  })

  it('is not referenced by the drizzle journal (it is out-of-band by design)', () => {
    const journal = readRoot('db', 'migrations', 'meta', '_journal.json')
    expect(journal).not.toContain('003_numeric_columns')
  })
})

describe('the local runbook records 003 as conditional, not unconditional', () => {
  it('carries the MANUAL MIGRATION 003 DECISION section', () => {
    expect(runbook).toContain('MANUAL MIGRATION 003 DECISION')
  })

  it('states both the classification and the decision for this build', () => {
    expect(runbook).toContain('CONDITIONAL_LEGACY_ONLY')
    expect(runbook).toContain('ALREADY_SATISFIED_ON_FRESH_DRIZZLE_BUILD')
  })

  it('records that the APPLY block was not executed', () => {
    expect(runbook).toMatch(/APPLY.*no se ejecut/i)
  })

  it('names 0016 as the migration that satisfies it', () => {
    expect(runbook).toContain('0016_fat_mac_gargan')
  })

  it('still tells a legacy (varchar) database to run 003', () => {
    expect(runbook).toMatch(/legacy/i)
  })
})
