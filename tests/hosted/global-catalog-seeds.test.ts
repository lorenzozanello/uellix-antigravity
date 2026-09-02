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

describe('the manifest carries exactly one dml=\'global-catalog\' unit', () => {
  it('grep-equivalent independent count over BASELINE_UNITS, not the registry', () => {
    const globalCatalogUnits = BASELINE_UNITS.filter((u) => u.dml === 'global-catalog')
    expect(globalCatalogUnits.map((u) => u.id)).toEqual(['0040_governed_model_registry.sql'])
  })
})

describe('the registry names exactly that unit, and nothing else', () => {
  it('one spec, bound to 0040 and public.governed_model_registry', () => {
    expect(GLOBAL_CATALOG_SEED_SPECS).toHaveLength(1)
    expect(GLOBAL_CATALOG_SEED_SPECS[0]).toMatchObject({
      unitId: '0040_governed_model_registry.sql',
      file: 'db/migrations/0040_governed_model_registry.sql',
      table: 'public.governed_model_registry',
    })
  })

  it('the pinned hash matches the LIVE manifest unit — no drift, checked against the corpus, not a copy of a copy', () => {
    const unit = BASELINE_UNITS.find((u) => u.id === GLOBAL_CATALOG_SEED_SPECS[0]!.unitId) as BaselineUnit
    expect(unit.sha256).toBe(GLOBAL_CATALOG_SEED_SPECS[0]!.expectedMigrationSha256)
  })

  it('the pinned hash also matches the FILE ON DISK, independently recomputed', () => {
    const sql = read(GLOBAL_CATALOG_SEED_SPECS[0]!.file)
    expect(currentMigrationSha256(sql)).toBe(GLOBAL_CATALOG_SEED_SPECS[0]!.expectedMigrationSha256)
    expect(sha256OfSql(sql)).toBe(GLOBAL_CATALOG_SEED_SPECS[0]!.expectedMigrationSha256)
  })
})

describe('the expected row count is mechanically re-derivable from the migration text — a second opinion, no shared code with the registry', () => {
  it('exactly 8 literal tuples in the VALUES list, counted by a dumb line scan', () => {
    const sql = read(GLOBAL_CATALOG_SEED_SPECS[0]!.file)
    const valuesBlockStart = sql.indexOf('INSERT INTO "governed_model_registry"')
    expect(valuesBlockStart).toBeGreaterThan(-1)
    const valuesBlockEnd = sql.indexOf('ON CONFLICT', valuesBlockStart)
    expect(valuesBlockEnd).toBeGreaterThan(valuesBlockStart)
    const block = sql.slice(valuesBlockStart, valuesBlockEnd)
    // One opening paren per tuple, at the start of a trimmed line.
    const tuples = block.split('\n').filter((l) => l.trim().startsWith('('))
    expect(tuples).toHaveLength(GLOBAL_CATALOG_SEED_SPECS[0]!.expectedRowCount)
    expect(GLOBAL_CATALOG_SEED_SPECS[0]!.expectedRowCount).toBe(8)
  })

  it('the insert is idempotent (ON CONFLICT DO NOTHING) — a rerun cannot inflate the count', () => {
    const sql = read(GLOBAL_CATALOG_SEED_SPECS[0]!.file)
    expect(sql).toMatch(/ON CONFLICT\s*\("model_id",\s*"version"\)\s*DO NOTHING/)
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

  it('two specs naming the same unit is DUPLICATE_SEED_SPEC, and the second is not otherwise re-validated', () => {
    const twice = [GLOBAL_CATALOG_SEED_SPECS[0]!, GLOBAL_CATALOG_SEED_SPECS[0]!]
    const result = validateGlobalCatalogClosedWorld(BASELINE_UNITS, twice)
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]!.kind).toBe('DUPLICATE_SEED_SPEC')
  })

  it('an EMPTY registry is a violation whenever ANY manifest unit is global-catalog — the exception cannot silently disappear', () => {
    const result = validateGlobalCatalogClosedWorld(BASELINE_UNITS, [])
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.kind)).toEqual(['UNREGISTERED_GLOBAL_CATALOG_UNIT'])
  })
})

describe('expectedRowCountsFromClosedWorld', () => {
  it('zero for every table except the seed table, which is exact', () => {
    const tables = ['public.users', 'public.governed_model_registry', 'public.organizations']
    const map = expectedRowCountsFromClosedWorld(tables)
    expect(map.get('public.users')).toBe(0)
    expect(map.get('public.organizations')).toBe(0)
    expect(map.get('public.governed_model_registry')).toBe(8)
  })

  it('a table the seed does not name defaults to zero even with a non-empty spec list', () => {
    const map = expectedRowCountsFromClosedWorld(['public.completely_unrelated_table'])
    expect(map.get('public.completely_unrelated_table')).toBe(0)
  })
})
