// tests/hosted/global-catalog-seeds.test.ts
// HPO-ODS-W2-04 — the closed-world global-catalog seed registry, independent
// of B0-11's own test file (tests/hosted/baseline-postconditions.test.ts),
// which exercises the same contract through the postcondition's check().
// This file asserts the registry and the derivation directly, and re-derives
// the seed count from the migration text with NO shared code with the
// registry's own literal — the same "second opinion" discipline
// deriveExpectedBaselineState's own test applies to table enumeration.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BASELINE_UNITS, type BaselineUnit } from '@/db/hosted/baseline-manifest'
import { sha256OfSql } from '@/db/hosted/hosted-package-manifest'
import {
  GLOBAL_CATALOG_SEED_SPECS,
  currentMigrationSha256,
  expectedRowCountsFromClosedWorld,
  validateGlobalCatalogClosedWorld,
} from '@/db/hosted/global-catalog-seeds'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

// COMMERCIAL-V1-WAVE2-RECONCILIATION-R1 (HPO-ODS-W2-08) — re-derived on the
// reconciled 73-unit corpus: the closed Wave2 B2 units 0055 and 0056 are
// classified dml='global-catalog' by the manifest (0055: 39 field->category
// rows; 0056: 70 registry_version 1.1.0 rows + 1 governed-model append), so
// the closed world now holds three units and four (unit, table) seeds. Every
// HPO-ODS-W2-04 assertion below is preserved and applied per seed.
describe("the manifest carries exactly three dml='global-catalog' units", () => {
  it('grep-equivalent independent count over BASELINE_UNITS, not the registry', () => {
    const globalCatalogUnits = BASELINE_UNITS.filter((u) => u.dml === 'global-catalog')
    expect(globalCatalogUnits.map((u) => u.id)).toEqual([
      '0040_governed_model_registry.sql',
      '0055_fib_proxy_material_change_registry.sql',
      '0056_fib_proxy_material_fields_editability.sql',
    ])
  })
})

describe('the registry names exactly those units, one spec per (unit, table) seed, and nothing else', () => {
  it('four specs: 0040 -> governed_model_registry, 0055 -> proxy_material_fields_registry, 0056 -> both', () => {
    expect(GLOBAL_CATALOG_SEED_SPECS).toHaveLength(4)
    expect(GLOBAL_CATALOG_SEED_SPECS.map((s) => ({ unitId: s.unitId, file: s.file, table: s.table }))).toEqual([
      { unitId: '0040_governed_model_registry.sql', file: 'db/migrations/0040_governed_model_registry.sql', table: 'public.governed_model_registry' },
      { unitId: '0055_fib_proxy_material_change_registry.sql', file: 'db/migrations/0055_fib_proxy_material_change_registry.sql', table: 'public.proxy_material_fields_registry' },
      { unitId: '0056_fib_proxy_material_fields_editability.sql', file: 'db/migrations/0056_fib_proxy_material_fields_editability.sql', table: 'public.proxy_material_fields_registry' },
      { unitId: '0056_fib_proxy_material_fields_editability.sql', file: 'db/migrations/0056_fib_proxy_material_fields_editability.sql', table: 'public.governed_model_registry' },
    ])
  })

  it.each(GLOBAL_CATALOG_SEED_SPECS.map((s) => [s.unitId, s.table, s] as const))(
    '%s -> %s: the pinned hash matches the LIVE manifest unit — no drift, checked against the corpus, not a copy of a copy',
    (_unitId, _table, spec) => {
      const unit = BASELINE_UNITS.find((u) => u.id === spec.unitId) as BaselineUnit
      expect(unit.sha256).toBe(spec.expectedMigrationSha256)
    },
  )

  it.each(GLOBAL_CATALOG_SEED_SPECS.map((s) => [s.unitId, s.table, s] as const))(
    '%s -> %s: the pinned hash also matches the FILE ON DISK, independently recomputed',
    (_unitId, _table, spec) => {
      const sql = read(spec.file)
      expect(currentMigrationSha256(sql)).toBe(spec.expectedMigrationSha256)
      expect(sha256OfSql(sql)).toBe(spec.expectedMigrationSha256)
    },
  )
})

describe('the expected row count is mechanically re-derivable from the migration text — a second opinion, no shared code with the registry', () => {
  /** Every INSERT block into the spec's (unqualified) table, up to its ON CONFLICT clause. */
  const insertBlocks = (sql: string, table: string): string[] => {
    const marker = `INSERT INTO "${table.replace(/^public\./, '')}"`
    const blocks: string[] = []
    let from = 0
    for (;;) {
      const start = sql.indexOf(marker, from)
      if (start < 0) break
      const end = sql.indexOf('ON CONFLICT', start)
      expect(end).toBeGreaterThan(start)
      blocks.push(sql.slice(start, end))
      from = end
    }
    return blocks
  }
  // One opening paren per tuple, at the start of a trimmed line.
  const tupleCount = (block: string) => block.split('\n').filter((l) => l.trim().startsWith('(')).length

  it.each([
    ['0040_governed_model_registry.sql', 'public.governed_model_registry', 8],
    ['0055_fib_proxy_material_change_registry.sql', 'public.proxy_material_fields_registry', 39],
    ['0056_fib_proxy_material_fields_editability.sql', 'public.proxy_material_fields_registry', 70],
    ['0056_fib_proxy_material_fields_editability.sql', 'public.governed_model_registry', 1],
  ] as const)('%s -> %s: exactly %i literal tuples in the VALUES list(s), counted by a dumb line scan', (unitId, table, expected) => {
    const spec = GLOBAL_CATALOG_SEED_SPECS.find((s) => s.unitId === unitId && s.table === table)!
    expect(spec).toBeDefined()
    const blocks = insertBlocks(read(spec.file), table)
    expect(blocks.length).toBeGreaterThan(0)
    const tuples = blocks.reduce((n, b) => n + tupleCount(b), 0)
    expect(tuples).toBe(spec.expectedRowCount)
    expect(spec.expectedRowCount).toBe(expected)
  })

  it('every seed insert is idempotent (ON CONFLICT … DO NOTHING) — a rerun cannot inflate the count', () => {
    expect(read('db/migrations/0040_governed_model_registry.sql')).toMatch(/ON CONFLICT\s*\("model_id",\s*"version"\)\s*DO NOTHING/)
    expect(read('db/migrations/0055_fib_proxy_material_change_registry.sql')).toMatch(/ON CONFLICT\s*\("registry_version",\s*"table_name",\s*"field_name"\)\s*DO NOTHING/)
    const sql0056 = read('db/migrations/0056_fib_proxy_material_fields_editability.sql')
    expect(sql0056).toMatch(/ON CONFLICT\s*\("registry_version",\s*"table_name",\s*"field_name"\)\s*DO NOTHING/)
    expect(sql0056).toMatch(/ON CONFLICT\s*\("model_id",\s*"version"\)\s*DO NOTHING/)
    // No seed INSERT anywhere in the three files lacks the guard.
    for (const file of ['db/migrations/0040_governed_model_registry.sql', 'db/migrations/0055_fib_proxy_material_change_registry.sql', 'db/migrations/0056_fib_proxy_material_fields_editability.sql']) {
      const sql = read(file)
      const inserts = (sql.match(/INSERT INTO/g) ?? []).length
      const guards = (sql.match(/ON CONFLICT[^;]*DO NOTHING/g) ?? []).length
      expect(guards, file).toBe(inserts)
    }
  })
})

describe('validateGlobalCatalogClosedWorld — the bijection, both directions', () => {
  it('the CURRENT manifest + registry satisfy it with zero violations', () => {
    const result = validateGlobalCatalogClosedWorld()
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('N4: a manifest unit reclassified global-catalog with no spec is UNREGISTERED_GLOBAL_CATALOG_UNIT', () => {
    const mutated = BASELINE_UNITS.map((u) =>
      u.id === '0041_pc01b_regime_boundary_backfill.sql' ? { ...u, dml: 'global-catalog' as const } : u,
    )
    const result = validateGlobalCatalogClosedWorld(mutated, GLOBAL_CATALOG_SEED_SPECS)
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: 'UNREGISTERED_GLOBAL_CATALOG_UNIT', detail: expect.stringContaining('0041_pc01b_regime_boundary_backfill.sql') }),
    ])
  })

  it('N5a: a spec naming a unit not classified global-catalog is SEED_SPEC_UNIT_NOT_GLOBAL_CATALOG', () => {
    const mutated = BASELINE_UNITS.map((u) => (u.id === GLOBAL_CATALOG_SEED_SPECS[0]!.unitId ? { ...u, dml: 'none' as const } : u))
    const result = validateGlobalCatalogClosedWorld(mutated, GLOBAL_CATALOG_SEED_SPECS)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.kind)).toContain('SEED_SPEC_UNIT_NOT_GLOBAL_CATALOG')
    // AND it becomes unregistered too — the classification moved off the real unit, not away.
    expect(result.violations.map((v) => v.kind)).not.toContain('UNREGISTERED_GLOBAL_CATALOG_UNIT')
  })

  it('N5b: a spec naming a unit that does not exist is ORPHANED_SEED_SPEC', () => {
    const withoutUnit = BASELINE_UNITS.filter((u) => u.id !== GLOBAL_CATALOG_SEED_SPECS[0]!.unitId)
    const result = validateGlobalCatalogClosedWorld(withoutUnit, GLOBAL_CATALOG_SEED_SPECS)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.kind)).toEqual(['ORPHANED_SEED_SPEC'])
  })

  it('N6: a spec pinned to a hash the manifest no longer carries is SEED_SPEC_HASH_DRIFT', () => {
    const drifted = BASELINE_UNITS.map((u) => (u.id === GLOBAL_CATALOG_SEED_SPECS[0]!.unitId ? { ...u, sha256: '0'.repeat(64) } : u))
    const result = validateGlobalCatalogClosedWorld(drifted, GLOBAL_CATALOG_SEED_SPECS)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.kind)).toEqual(['SEED_SPEC_HASH_DRIFT'])
  })

  it('a spec whose declared file disagrees with the manifest unit is SEED_SPEC_FILE_MISMATCH', () => {
    const spec = { ...GLOBAL_CATALOG_SEED_SPECS[0]!, file: 'db/migrations/9999_wrong.sql' }
    const result = validateGlobalCatalogClosedWorld(BASELINE_UNITS, [spec])
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.kind)).toContain('SEED_SPEC_FILE_MISMATCH')
  })

  it('two specs naming the same (unit, table) seed is DUPLICATE_SEED_SPEC, and the second is not otherwise re-validated', () => {
    const twice = [...GLOBAL_CATALOG_SEED_SPECS, GLOBAL_CATALOG_SEED_SPECS[0]!]
    const result = validateGlobalCatalogClosedWorld(BASELINE_UNITS, twice)
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]!.kind).toBe('DUPLICATE_SEED_SPEC')
  })

  it('one unit carrying two seeds into two DIFFERENT tables (0056) is NOT a duplicate — the key is (unit, table)', () => {
    const specs0056 = GLOBAL_CATALOG_SEED_SPECS.filter((s) => s.unitId === '0056_fib_proxy_material_fields_editability.sql')
    expect(specs0056).toHaveLength(2)
    expect(new Set(specs0056.map((s) => s.table)).size).toBe(2)
    const result = validateGlobalCatalogClosedWorld()
    expect(result.violations.filter((v) => v.kind === 'DUPLICATE_SEED_SPEC')).toEqual([])
  })

  it('an EMPTY registry is a violation for EVERY global-catalog unit — the exception cannot silently disappear', () => {
    const result = validateGlobalCatalogClosedWorld(BASELINE_UNITS, [])
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.kind)).toEqual([
      'UNREGISTERED_GLOBAL_CATALOG_UNIT',
      'UNREGISTERED_GLOBAL_CATALOG_UNIT',
      'UNREGISTERED_GLOBAL_CATALOG_UNIT',
    ])
    expect(result.violations.map((v) => v.detail).join(' ')).toContain('0040_governed_model_registry.sql')
    expect(result.violations.map((v) => v.detail).join(' ')).toContain('0055_fib_proxy_material_change_registry.sql')
    expect(result.violations.map((v) => v.detail).join(' ')).toContain('0056_fib_proxy_material_fields_editability.sql')
  })

  it('dropping ONLY the 0055/0056 specs (the pre-reconciliation registry shape) is caught — the new seeds cannot be silently un-registered', () => {
    const result = validateGlobalCatalogClosedWorld(BASELINE_UNITS, [GLOBAL_CATALOG_SEED_SPECS[0]!])
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.kind)).toEqual(['UNREGISTERED_GLOBAL_CATALOG_UNIT', 'UNREGISTERED_GLOBAL_CATALOG_UNIT'])
  })
})

describe('expectedRowCountsFromClosedWorld', () => {
  it('zero for every table except the seeded tables, which are exact SUMS of their specs', () => {
    const tables = ['public.users', 'public.governed_model_registry', 'public.organizations', 'public.proxy_material_fields_registry']
    const map = expectedRowCountsFromClosedWorld(tables)
    expect(map.get('public.users')).toBe(0)
    expect(map.get('public.organizations')).toBe(0)
    // 0040 (8) + 0056's governed-model append (1).
    expect(map.get('public.governed_model_registry')).toBe(9)
    // 0055 (39, registry_version 1.0.0) + 0056 (70, registry_version 1.1.0).
    expect(map.get('public.proxy_material_fields_registry')).toBe(109)
  })

  it('MUTATION: a last-writer-wins implementation (the pre-reconciliation shape) would under-count both shared tables', () => {
    const lastWins = new Map<string, number>()
    for (const spec of GLOBAL_CATALOG_SEED_SPECS) lastWins.set(spec.table, spec.expectedRowCount)
    const summed = expectedRowCountsFromClosedWorld([...lastWins.keys()])
    expect(lastWins.get('public.governed_model_registry')).not.toBe(summed.get('public.governed_model_registry'))
    expect(lastWins.get('public.proxy_material_fields_registry')).not.toBe(summed.get('public.proxy_material_fields_registry'))
  })

  it('a table the seed does not name defaults to zero even with a non-empty spec list', () => {
    const map = expectedRowCountsFromClosedWorld(['public.completely_unrelated_table'])
    expect(map.get('public.completely_unrelated_table')).toBe(0)
  })
})
