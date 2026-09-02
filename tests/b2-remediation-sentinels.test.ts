// tests/b2-remediation-sentinels.test.ts
// W2-B2-R1 / R-B2-09 — NC-11: sentinels pinning the two CLOSED surfaces the
// remediation touches around (preserved_closed_surfaces):
//
//  FIBIU-09 — the rubric derivation was independently validated (4096
//  confidence x 16384 risk combinations, real PostgreSQL, 0 mismatches).
//  This sentinel recomputes EVERY one of those 20480 combinations and pins a
//  SHA-256 over the outputs, so any change to the derivation, its ceilings,
//  its floors or its thresholds under this remediation fails here at once.
//
//  MNB-1 — every write site in lib/admin/proxies.ts was corrected to a
//  specific audit verb whose object prefix matches its entityType, and the
//  correspondence scan was extended to lib/admin. R-B2-04 and R-B2-08 edit
//  that module; this sentinel pins the exact ordered (entityType, action)
//  pairs of every logAuditAction call there and the scan root.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_FACTOR_KEYS,
  RISK_FACTOR_KEYS,
  deriveRubricClassification,
  type RubricFactors,
} from '@/lib/pipeline/financial-proxy-rubric'
import { AUDIT_ACTIONS } from '@/lib/audit/logger'

const ROOT = process.cwd()

// -----------------------------------------------------------------------------
// FIBIU-09 sentinel
// -----------------------------------------------------------------------------
const RUBRIC_SENTINEL_SHA256 = 'd20ae5caa2b94f0cdd321f2533a88a60033d4347a5e0ea0e77e39f5c5674c3c0'
const RUBRIC_COMBINATIONS = 4 ** 6 + 4 ** 7 // 4096 + 16384 = 20480

function rubricDigest(): { digest: string; combos: number } {
  const h = createHash('sha256')
  let combos = 0
  for (let i = 0; i < 4 ** 6; i++) {
    const c = [...Array(6)].map((_, k) => Math.floor(i / 4 ** k) % 4)
    const f = {} as RubricFactors
    CONFIDENCE_FACTOR_KEYS.forEach((key, k) => { f[key] = c[k] })
    RISK_FACTOR_KEYS.forEach((key) => { f[key] = 0 })
    const r = deriveRubricClassification(f)
    h.update(`C${c.join('')}:${r.confidenceScore}:${r.confidenceLevel};`)
    combos++
  }
  for (let i = 0; i < 4 ** 7; i++) {
    const rr = [...Array(7)].map((_, k) => Math.floor(i / 4 ** k) % 4)
    const f = {} as RubricFactors
    CONFIDENCE_FACTOR_KEYS.forEach((key) => { f[key] = 3 })
    RISK_FACTOR_KEYS.forEach((key, k) => { f[key] = rr[k] })
    const r = deriveRubricClassification(f)
    h.update(`R${rr.join('')}:${r.methodologicalRiskScore}:${r.methodologicalRisk};`)
    combos++
  }
  return { digest: h.digest('hex'), combos }
}

describe('FIBIU-09 sentinel — rubric derivation pinned over every combination', () => {
  it('recomputes all 20480 combinations and matches the pinned digest', () => {
    const { digest, combos } = rubricDigest()
    expect(combos).toBe(RUBRIC_COMBINATIONS)
    expect(digest).toBe(RUBRIC_SENTINEL_SHA256)
  })

  it('spot checks the sealed ceilings and floors (redundant with the digest, legible on failure)', () => {
    const base = {} as RubricFactors
    CONFIDENCE_FACTOR_KEYS.forEach((k) => { base[k] = 3 })
    RISK_FACTOR_KEYS.forEach((k) => { base[k] = 0 })
    expect(deriveRubricClassification(base)).toMatchObject({ confidenceScore: 100, confidenceLevel: 'high', methodologicalRiskScore: 0, methodologicalRisk: 'low' })
    expect(deriveRubricClassification({ ...base, c1SourceQualityVerifiability: 0 }).confidenceLevel).toBe('low')
    expect(deriveRubricClassification({ ...base, c3StakeholderPopulationFit: 0 }).confidenceLevel).toBe('medium')
    expect(deriveRubricClassification({ ...base, r4GeographicPopulationTransferRisk: 2 }).methodologicalRisk).toBe('medium')
    expect(deriveRubricClassification({ ...base, r6TransformationRisk: 3 }).methodologicalRisk).toBe('high')
  })

  it('MUTATION: the digest is sensitive to a single changed output', () => {
    // Re-derive with one output perturbed; the pinned digest must not match.
    const h = createHash('sha256')
    for (let i = 0; i < 4 ** 6; i++) {
      const c = [...Array(6)].map((_, k) => Math.floor(i / 4 ** k) % 4)
      const f = {} as RubricFactors
      CONFIDENCE_FACTOR_KEYS.forEach((key, k) => { f[key] = c[k] })
      RISK_FACTOR_KEYS.forEach((key) => { f[key] = 0 })
      const r = deriveRubricClassification(f)
      const level = i === 0 ? 'high' : r.confidenceLevel
      h.update(`C${c.join('')}:${r.confidenceScore}:${level};`)
    }
    for (let i = 0; i < 4 ** 7; i++) {
      const rr = [...Array(7)].map((_, k) => Math.floor(i / 4 ** k) % 4)
      const f = {} as RubricFactors
      CONFIDENCE_FACTOR_KEYS.forEach((key) => { f[key] = 3 })
      RISK_FACTOR_KEYS.forEach((key, k) => { f[key] = rr[k] })
      const r = deriveRubricClassification(f)
      h.update(`R${rr.join('')}:${r.methodologicalRiskScore}:${r.methodologicalRisk};`)
    }
    expect(h.digest('hex')).not.toBe(RUBRIC_SENTINEL_SHA256)
  })
})

// -----------------------------------------------------------------------------
// MNB-1 sentinel
// -----------------------------------------------------------------------------

/** Every balanced `logAuditAction(` … `)` call block, in source order. */
function auditBlocks(src: string): string[] {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const start = src.indexOf('logAuditAction(', from)
    if (start < 0) break
    let depth = 0
    let i = start + 'logAuditAction'.length
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    blocks.push(src.slice(start, i + 1))
    from = i + 1
  }
  return blocks
}

/** The (entityType, action-constant-or-expression) pair of one call block. */
function auditPair(block: string): { entityType: string; action: string } {
  const entityType = block.match(/entityType:\s*'([^']+)'/)?.[1] ?? 'MISSING'
  const action = block.match(/action:\s*([^,\n]+)/)?.[1]?.trim() ?? 'MISSING'
  return { entityType, action }
}

// The frozen list. Order = source order of lib/admin/proxies.ts. A change
// here is a change to the closed MNB-1 surface and must be a deliberate,
// authority-backed edit, never a drift.
const MNB1_PINNED_ADMIN_AUDIT_SITES = [
  // createGlobalProxySource
  { entityType: 'proxy_source', action: 'AUDIT_ACTIONS.PROXY_SOURCE_CREATED' },
  // createGlobalFinancialProxy
  { entityType: 'financial_proxy_version', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED' },
  { entityType: 'financial_proxy', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_CREATED' },
  // updateGlobalProxyReviewStatus
  { entityType: 'financial_proxy', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED' },
  { entityType: 'financial_proxy_version', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_REVIEW_STATUS_CHANGED' },
  // setGlobalProxyManualFxRate (R-B2-04: reset verb when forked, update otherwise)
  { entityType: 'financial_proxy', action: 'forked ? AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED : AUDIT_ACTIONS.FINANCIAL_PROXY_UPDATED' },
  { entityType: 'financial_proxy_version', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE' },
  { entityType: 'financial_proxy_version', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED' },
  // promoteProxyToGlobal
  { entityType: 'proxy_source', action: 'AUDIT_ACTIONS.PROXY_SOURCE_CREATED' },
  { entityType: 'financial_proxy_version', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED' },
  { entityType: 'financial_proxy', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_CREATED' },
  { entityType: 'financial_proxy_version', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_REVIEW_STATUS_CHANGED' },
  { entityType: 'financial_proxy', action: 'AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED' },
]

describe('MNB-1 sentinel — every write site in lib/admin/proxies.ts keeps its specific audit verb', () => {
  const src = readFileSync(path.join(ROOT, 'lib/admin/proxies.ts'), 'utf8')
  const pairs = auditBlocks(src).map(auditPair)

  it('pins the exact ordered (entityType, action) pairs of every logAuditAction call', () => {
    expect(pairs).toEqual(MNB1_PINNED_ADMIN_AUDIT_SITES)
  })

  it('every action resolves to a real AUDIT_ACTIONS constant whose object prefix matches its entityType (the MNB-1 correspondence)', () => {
    const singular: Record<string, string> = {}
    for (const { entityType, action } of pairs) {
      const constants = [...action.matchAll(/AUDIT_ACTIONS\.([A-Z_]+)/g)].map((m) => m[1])
      expect(constants.length, action).toBeGreaterThan(0)
      for (const c of constants) {
        const value = (AUDIT_ACTIONS as Record<string, string>)[c]
        expect(value, c).toBeDefined()
        const prefix = value.split('.')[0]
        singular[entityType] = prefix
        expect(prefix, `${entityType} -> ${value}`).toBe(entityType)
      }
    }
  })

  it('no admin site uses the organization.* catch-all MNB-1 closed out', () => {
    for (const { action } of pairs) expect(action).not.toMatch(/ORGANIZATION_/)
  })

  it('the correspondence scan still covers lib/admin (CORRESPONDENCE_SCAN_ROOTS not narrowed)', () => {
    const test = readFileSync(path.join(ROOT, 'tests/audit-action-contract.test.ts'), 'utf8')
    const block = test.slice(test.indexOf('const CORRESPONDENCE_SCAN_ROOTS'), test.indexOf(']', test.indexOf('const CORRESPONDENCE_SCAN_ROOTS')))
    expect(block).toMatch(/'lib\/admin'/)
  })
})
