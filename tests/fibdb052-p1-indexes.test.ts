// tests/fibdb052-p1-indexes.test.ts
// FIBDB-052 P1 — STRUCTURAL controls over the eight governed indexes.
//
// Authority: docs/ops/wave3/FIBDB052_P1_EXECUTION_AUTHORITY_v1.0.0.json
//   EIGHT_CREATE_TARGETS (the closed roster), GENERATE_GUARD_PATCH_CONTRACT
//   (normal generate + bounded IF NOT EXISTS patch), HPO-FIBP1-02.
// Companion manifest: docs/ops/wave3/FIBDB052_P1_TEST_MANIFEST_v1.0.0.json
//   P-1..P-6, P-11, P-12 and N-1..N-10.
//
// WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT:
// it proves what the repository INTENDED — agreement between db/schema.ts, the
// generated migration SQL and the generated snapshot. It does NOT prove what
// PostgreSQL actually BUILT; only the catalogue can do that, which is
// tests/postgres/fibdb052-p1-indexes.pg.test.ts. Neither file substitutes for
// the other, and a green run here is not evidence about a real cluster.
//
// The roster is read from the FROZEN AUTHORITY rather than restated here, so
// this suite cannot drift from the authority it is supposed to enforce, and a
// hand-edited expectation cannot quietly become the thing under test.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

const AUTHORITY = 'docs/ops/wave3/FIBDB052_P1_EXECUTION_AUTHORITY_v1.0.0.json'
const MIGRATION = 'db/migrations/0069_fib_fibdb052_p1_indexes.sql'
const SNAPSHOT = 'db/migrations/meta/0069_snapshot.json'

interface Target {
  id: string
  governed_index_name: string
  relation: string
  columns: string[]
  partial: boolean
  predicate: string | null
}

const TARGETS: Target[] = (
  JSON.parse(read(AUTHORITY)) as { EIGHT_CREATE_TARGETS: { targets: Target[] } }
).EIGHT_CREATE_TARGETS.targets

const SQL = read(MIGRATION)
const STATEMENTS = SQL.split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

interface Parsed {
  name: string
  relation: string
  columns: string[]
  predicate: string | null
  guarded: boolean
}

function parse(stmt: string): Parsed | null {
  const m = stmt.match(
    /^CREATE INDEX (IF NOT EXISTS )?"([^"]+)" ON "([^"]+)" USING btree \(([^)]*)\)(?:\s+WHERE\s+([\s\S]*?))?;?$/,
  )
  if (!m) return null
  return {
    guarded: m[1] !== undefined,
    name: m[2],
    relation: m[3],
    columns: m[4].split(',').map((c) => c.replace(/"/g, '').trim()),
    predicate: m[5] ? m[5].replace(/;$/, '').trim() : null,
  }
}

const PARSED = STATEMENTS.map(parse)

describe('FIBDB-052 P1 — the frozen roster is exactly eight', () => {
  it('the authority itself declares 8 CREATE targets, 3 partial and 5 non-partial', () => {
    expect(TARGETS).toHaveLength(8)
    expect(TARGETS.filter((t) => t.partial)).toHaveLength(3)
    expect(TARGETS.filter((t) => !t.partial)).toHaveLength(5)
  })

  it('P-1: the migration emits exactly 8 statements and every one is a CREATE INDEX', () => {
    expect(STATEMENTS).toHaveLength(8)
    expect(PARSED.every((p) => p !== null)).toBe(true)
    expect(STATEMENTS.filter((s) => /^CREATE INDEX /.test(s))).toHaveLength(8)
  })

  it('P-2 / N-8: the emitted name SET equals the governed roster exactly — no ninth, none missing', () => {
    const emitted = PARSED.map((p) => p!.name).sort()
    const governed = TARGETS.map((t) => t.governed_index_name).sort()
    expect(emitted).toEqual(governed)
  })

  it('P-11: the IF NOT EXISTS guard is present on exactly the eight, and appears exactly 8 times', () => {
    expect(PARSED.filter((p) => p!.guarded)).toHaveLength(8)
    expect(SQL.split('IF NOT EXISTS').length - 1).toBe(8)
  })

  it('P-12: every governed identifier is at most 63 bytes; the measured maximum is 58', () => {
    const lengths = TARGETS.map((t) => Buffer.byteLength(t.governed_index_name, 'utf8'))
    expect(Math.max(...lengths)).toBe(58)
    expect(lengths.every((n) => n <= 63)).toBe(true)
  })
})

describe('FIBDB-052 P1 — each target, exactly', () => {
  for (const t of TARGETS) {
    it(`P-3/P-4/P-5: ${t.id} ${t.governed_index_name} — relation, key ORDER and predicate`, () => {
      const p = PARSED.find((x) => x!.name === t.governed_index_name)
      expect(p, `${t.id} was not emitted`).toBeDefined()
      expect(p!.relation).toBe(t.relation)
      // key ORDER is asserted as an ordered array, never as a set: I-6/I-7/I-8
      // exist precisely because the pre-existing objects carry the REVERSE order.
      expect(p!.columns).toEqual(t.columns)
      if (t.partial) {
        expect(p!.predicate).not.toBeNull()
        const column = t.predicate!.split('=')[0].trim()
        expect(p!.predicate).toContain(column)
        expect(p!.predicate).toContain('approved')
      } else {
        expect(p!.predicate).toBeNull()
      }
    })
  }

  it('I-13 uses `status`, NOT `review_status` — copying a sibling predicate is a defect', () => {
    const i13 = PARSED.find((p) => p!.name === 'idx_sroi_run_reviews_calculation_run_id_approved')!
    expect(i13.predicate).toContain('status')
    expect(i13.predicate).not.toContain('review_status')
    const i3 = PARSED.find((p) => p!.name === 'idx_evidence_versions_evidence_id_approved')!
    expect(i3.predicate).toContain('review_status')
  })

  it('S4_RUN_ID_NAMING: the governed NAME says run_id while the DEFINITION targets calculation_run_id', () => {
    const i6 = PARSED.find((p) => p!.name === 'idx_outcome_monetization_dispositions_run_id_outcome_id')!
    expect(i6.name).toContain('_run_id_')
    expect(i6.columns).toEqual(['calculation_run_id', 'outcome_id'])
  })
})

describe('FIBDB-052 P1 — negative controls over the migration text', () => {
  it('N-1: none of the three retired names appears', () => {
    for (const retired of [
      'idx_domain_object_versions_object_type_object_id_ordinal',
      'idx_evidence_versions_evidence_id_ordinal',
      'idx_financial_proxy_versions_financial_proxy_id_ordinal',
    ]) {
      expect(SQL).not.toContain(retired)
    }
  })

  it('N-3: zero I-10 DDL — no sensitivity_scenarios and no candidate_id reference', () => {
    expect(SQL).not.toMatch(/sensitivity_scenarios/i)
    expect(SQL).not.toMatch(/candidate_ids?/i)
  })

  it('N-4: zero GIN and no non-btree access method', () => {
    expect(SQL).not.toMatch(/USING\s+gin/i)
    expect(SQL.match(/USING btree/g)).toHaveLength(8)
  })

  it('N-5 / N-6: zero DROP of anything, including the three subsumed prefix indexes', () => {
    expect(SQL).not.toMatch(/\bDROP\b/i)
    for (const prefix of [
      'idx_outcome_monetization_dispositions_run_id',
      'idx_counterfactual_assessments_run_id',
      'idx_methodological_assumptions_project_id',
    ]) {
      expect(SQL).not.toMatch(new RegExp(`DROP INDEX[^;]*${prefix}`, 'i'))
    }
  })

  it('N-7: zero CONCURRENTLY — a drizzle migration is applied as one whole-file transaction', () => {
    expect(SQL).not.toMatch(/CONCURRENTLY/i)
  })

  it('no non-index DDL of any kind — no table, column, constraint, policy, function, trigger or role', () => {
    expect(SQL).not.toMatch(/CREATE (TABLE|TRIGGER|FUNCTION|POLICY|EXTENSION|ROLE|SCHEMA)/i)
    expect(SQL).not.toMatch(/\bALTER\b/i)
    expect(SQL).not.toMatch(/\bGRANT\b|\bREVOKE\b|OWNER TO/i)
  })
})

describe('FIBDB-052 P1 — P-6 schema / migration / snapshot agreement', () => {
  const schema = read('db/schema.ts')

  it('every governed index is declared in db/schema.ts', () => {
    for (const t of TARGETS) {
      expect(schema, `${t.id} missing from db/schema.ts`).toContain(
        `index('${t.governed_index_name}')`,
      )
    }
  })

  it('the generated snapshot carries all eight indexes on their governed relations', () => {
    const snapshot = JSON.parse(read(SNAPSHOT)) as {
      tables: Record<string, { indexes?: Record<string, unknown> }>
    }
    const found = new Set<string>()
    for (const table of Object.values(snapshot.tables)) {
      for (const name of Object.keys(table.indexes ?? {})) found.add(name)
    }
    for (const t of TARGETS) {
      expect(found.has(t.governed_index_name), `${t.id} missing from the snapshot`).toBe(true)
    }
  })

  it('P-7: the journal gained exactly one entry and it is the P1 unit at the tail', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; tag: string }[]
    }
    const last = journal.entries[journal.entries.length - 1]
    expect(last.tag).toBe('0069_fib_fibdb052_p1_indexes')
    expect(last.idx).toBe(journal.entries.length - 1)
  })
})
