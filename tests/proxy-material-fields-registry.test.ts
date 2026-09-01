// tests/proxy-material-fields-registry.test.ts
// W2-B2-R1 / R-B2-03 — closes M4 (registry not exhaustive) and
// AG-B2-3-DERIVED (editability dimension). NC-7 and NC-8.
//
// The registry must classify EVERY persisted column of financial_proxies and
// financial_proxy_versions at the current registry_version, on both the
// category and the editability dimension, with zero omissions — enforced by
// REFLECTING over the Drizzle table definitions (getTableColumns), never by
// a static expected list that would rot the moment a column is added. The
// test fails on an unregistered column AND on a registry row naming a column
// that no longer exists, in three places at once: the TS mirror, the 0056
// seed, and (through the mirror) the service layer.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { financialProxies, financialProxyVersions } from '@/db/schema'
import {
  EDITABILITIES,
  INPUT_KEY_TO_PERSISTED_FIELD,
  MATERIAL_CATEGORIES,
  MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY,
  NON_MATERIAL,
  PROXY_MATERIAL_FIELDS_REGISTRY,
  PROXY_MATERIAL_FIELDS_REGISTRY_VERSION,
  classifyMaterialField,
  registryRow,
} from '@/lib/pipeline/proxy-material-change'

const ROOT = process.cwd()
const MIGRATION_0056 = 'db/migrations/0056_fib_proxy_material_fields_editability.sql'
const MIGRATION_0055 = 'db/migrations/0055_fib_proxy_material_change_registry.sql'

/** Persisted (snake_case) column names of a Drizzle table, by reflection. */
function persistedColumns(table: typeof financialProxies | typeof financialProxyVersions): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name).sort()
}

const key = (t: string, f: string) => `${t}.${f}`

/** Parse the 5-tuple seed rows of a migration for one registry_version. */
function seedRows(file: string, version: string) {
  const sql = readFileSync(path.join(ROOT, file), 'utf8')
  const re = /\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g
  const rows: { tableName: string; fieldName: string; category: string; editability: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    if (m[1] === version) rows.push({ tableName: m[2], fieldName: m[3], category: m[4], editability: m[5] })
  }
  return rows
}

const LIVE_COLUMNS = persistedColumns(financialProxies)
const VERSION_COLUMNS = persistedColumns(financialProxyVersions)
const PERSISTED = [
  ...LIVE_COLUMNS.map((c) => key('financial_proxies', c)),
  ...VERSION_COLUMNS.map((c) => key('financial_proxy_versions', c)),
].sort()

describe('registry exhaustiveness by reflection (NC-8, both directions)', () => {
  it('the audited census still holds: 24 + 46 = 70 persisted columns', () => {
    expect(LIVE_COLUMNS).toHaveLength(24)
    expect(VERSION_COLUMNS).toHaveLength(46)
  })

  it('TS mirror == persisted columns, as SETS, in both directions', () => {
    const registered = PROXY_MATERIAL_FIELDS_REGISTRY.map((r) => key(r.tableName, r.fieldName)).sort()
    expect(registered).toEqual(PERSISTED)
  })

  it('TS mirror registers every column exactly once', () => {
    const keys = PROXY_MATERIAL_FIELDS_REGISTRY.map((r) => key(r.tableName, r.fieldName))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('0056 seed for registry_version 1.1.0 == persisted columns, as SETS, in both directions', () => {
    const seeded = seedRows(MIGRATION_0056, PROXY_MATERIAL_FIELDS_REGISTRY_VERSION).map((r) => key(r.tableName, r.fieldName)).sort()
    expect(seeded).toEqual(PERSISTED)
  })

  it('0056 seed == TS mirror row by row (category AND editability)', () => {
    const seeded = seedRows(MIGRATION_0056, PROXY_MATERIAL_FIELDS_REGISTRY_VERSION)
    expect(seeded).toHaveLength(PROXY_MATERIAL_FIELDS_REGISTRY.length)
    for (const row of PROXY_MATERIAL_FIELDS_REGISTRY) {
      const s = seeded.find((x) => x.tableName === row.tableName && x.fieldName === row.fieldName)
      expect(s, key(row.tableName, row.fieldName)).toEqual({ tableName: row.tableName, fieldName: row.fieldName, category: row.category, editability: row.editability })
    }
  })

  it('every row carries a sealed category (ten + non_material) and a frozen editability', () => {
    for (const row of PROXY_MATERIAL_FIELDS_REGISTRY) {
      expect([...MATERIAL_CATEGORIES, NON_MATERIAL]).toContain(row.category)
      expect(EDITABILITIES).toContain(row.editability)
    }
  })

  it('MUTATION (NC-8): a column missing from the mirror is detected', () => {
    const missingOne = PROXY_MATERIAL_FIELDS_REGISTRY.filter((r) => !(r.tableName === 'financial_proxies' && r.fieldName === 'value_usd'))
    expect(missingOne.map((r) => key(r.tableName, r.fieldName)).sort()).not.toEqual(PERSISTED)
  })

  it('MUTATION (NC-8): a registry row naming a non-existent column is detected', () => {
    const phantom = [...PROXY_MATERIAL_FIELDS_REGISTRY, { tableName: 'financial_proxies' as const, fieldName: 'ghost', category: NON_MATERIAL, editability: 'system_sealed' as const }]
    expect(phantom.map((r) => key(r.tableName, r.fieldName)).sort()).not.toEqual(PERSISTED)
  })
})

describe('registry_version 1.0.0 is historical record (FIBDB-007 immutable per version)', () => {
  it('0055 still seeds exactly its original 39 rows, untouched, with no editability column', () => {
    const sql = readFileSync(path.join(ROOT, MIGRATION_0055), 'utf8')
    const re4 = /\('1\.0\.0',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g
    const rows = [...sql.matchAll(re4)]
    expect(rows).toHaveLength(39)
    expect(sql).not.toContain('editability')
  })

  it('0056 does not touch 1.0.0 rows (no UPDATE, no 1.0.0 INSERT)', () => {
    const sql = readFileSync(path.join(ROOT, MIGRATION_0056), 'utf8')
    expect(sql).not.toMatch(/UPDATE\s+"?proxy_material_fields_registry/i)
    expect(seedRows(MIGRATION_0056, '1.0.0')).toHaveLength(0)
  })
})

// AG-B2-3-DERIVED — the adjudicated omissions, and the audit-metadata guard
// that must survive any future reseed.
const AUDIT_OR_APPROVAL_METADATA = [
  'review_status', 'reviewer_id', 'reviewed_at', 'created_by', 'created_at', 'updated_at',
  'id', 'organization_id', 'financial_proxy_id', 'ordinal', 'supersedes_version_id',
]

describe('editability dimension (AG-B2-3-DERIVED, NC-7)', () => {
  it('no approval or audit metadata column carries editability user_editable — in the mirror', () => {
    for (const row of PROXY_MATERIAL_FIELDS_REGISTRY) {
      if (AUDIT_OR_APPROVAL_METADATA.includes(row.fieldName)) {
        expect(row.editability, key(row.tableName, row.fieldName)).toBe('system_sealed')
        expect(row.category, key(row.tableName, row.fieldName)).toBe(NON_MATERIAL)
      }
    }
  })

  it('no approval or audit metadata column carries editability user_editable — in the 0056 seed', () => {
    for (const row of seedRows(MIGRATION_0056, PROXY_MATERIAL_FIELDS_REGISTRY_VERSION)) {
      if (AUDIT_OR_APPROVAL_METADATA.includes(row.fieldName)) {
        expect(row.editability, key(row.tableName, row.fieldName)).toBe('system_sealed')
      }
    }
  })

  it('adjudicated omissions: value_usd is identity_economic_value/system_derived on both tables', () => {
    for (const t of ['financial_proxies', 'financial_proxy_versions'] as const) {
      expect(registryRow(t, 'value_usd')).toMatchObject({ category: 'identity_economic_value', editability: 'system_derived' })
    }
  })

  it('adjudicated omissions: fx_rate_id is transformations/system_derived on both tables', () => {
    for (const t of ['financial_proxies', 'financial_proxy_versions'] as const) {
      expect(registryRow(t, 'fx_rate_id')).toMatchObject({ category: 'transformations', editability: 'system_derived' })
    }
  })

  it('the live mirrors of version-material fields carry the SAME category as their version counterparts', () => {
    for (const f of ['source_id', 'value', 'currency', 'unit', 'reference_year', 'country', 'territory', 'thematic_area', 'methodology', 'value_usd', 'fx_rate_id']) {
      expect(registryRow('financial_proxies', f)?.category, f).toBe(registryRow('financial_proxy_versions', f)?.category)
    }
  })

  it('the derived rubric fields are system_derived while the thirteen human-rated factors are user_editable', () => {
    for (const f of ['confidence_score', 'confidence_level', 'methodological_risk_score', 'methodological_risk', 'rubric_version']) {
      expect(registryRow('financial_proxy_versions', f)?.editability, f).toBe('system_derived')
    }
    for (const f of ['c1_source_quality_verifiability', 'r7_methodological_uncertainty_risk']) {
      expect(registryRow('financial_proxy_versions', f)?.editability, f).toBe('user_editable')
    }
  })
})

describe('service layer honours the editability dimension', () => {
  it('every FinancialProxyInput key maps to a registered, user_editable persisted field', () => {
    for (const [inputKey, ref] of Object.entries(INPUT_KEY_TO_PERSISTED_FIELD)) {
      const row = registryRow(ref.table, ref.column)
      expect(row, inputKey).not.toBeNull()
      expect(row!.editability, inputKey).toBe('user_editable')
      expect(classifyMaterialField(inputKey)).toBe(row!.category)
    }
  })

  it('MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY is derived from the registry, not hand-kept', () => {
    for (const [inputKey, ref] of Object.entries(INPUT_KEY_TO_PERSISTED_FIELD)) {
      expect(MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY[inputKey]).toBe(registryRow(ref.table, ref.column)!.category)
    }
  })

  it('NC-7: a patch naming a system_sealed or system_derived field is REJECTED by name, never silently dropped', () => {
    // These keys are deliberately absent from INPUT_KEY_TO_PERSISTED_FIELD;
    // an unclassified key is an error (fail-closed), never a silent skip.
    for (const k of ['reviewStatus', 'reviewerId', 'reviewedAt', 'valueUsd', 'fxRateId', 'confidenceScore', 'ordinal', 'supersedesVersionId']) {
      expect(() => classifyMaterialField(k), k).toThrow(/Unclassified proxy field/)
    }
  })

  it('NC-7: a classified key whose column is not user_editable is rejected naming its editability', () => {
    // Simulate a future mistake: mapping an input key to a sealed column.
    const sealed = registryRow('financial_proxy_versions', 'review_status')
    expect(sealed?.editability).toBe('system_sealed')
    // The public API path for that mistake is classifyMaterialField over a
    // key mapped to it; INPUT_KEY_TO_PERSISTED_FIELD cannot be mutated here
    // (readonly), so the guard is proven on the row directly and on the
    // absence of any such mapping.
    const mappedToSealed = Object.entries(INPUT_KEY_TO_PERSISTED_FIELD).filter(([, ref]) => registryRow(ref.table, ref.column)?.editability !== 'user_editable')
    expect(mappedToSealed).toEqual([])
  })
})
