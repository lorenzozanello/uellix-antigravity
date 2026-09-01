// tests/financial-proxy-versions.service.test.ts
// FIBIU-08 — direct unit coverage of lib/pipeline/financial-proxy-versions.ts,
// the FIBC-002 specialization for financial proxies (FIBDB-006/FIBC-010/
// FIBC-012). Mirrors evidence-versions' own coverage shape (createEvidence
// Version/getLatestEvidenceVersion tested via the evidence service suite)
// but stands alone here since no other suite yet exercises ordinal/
// supersedes lineage mechanics directly.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDbData = vi.hoisted(() => ({
  financialProxyVersions: [] as any[],
}))

// Recursively walks a Drizzle eq()/and() condition object to extract the
// literal comparison values it embeds — same proven technique as
// lib/stella/context/__tests__/build-composer-context.test.ts and
// tests/evidence-erasure-multiversion.service.test.ts, so the WHERE clause
// actually filters instead of being a decorative no-op.
function extractEqValues(val: any): string[] {
  if (!val) return []
  if (typeof val === 'string') return [val]
  if (Array.isArray(val)) return val.flatMap(extractEqValues)
  const res: string[] = []
  if (val.value !== undefined) {
    if (typeof val.value === 'string') res.push(val.value)
    else if (Array.isArray(val.value)) res.push(...val.value.flatMap(extractEqValues))
    else res.push(...extractEqValues(val.value))
  }
  if (val.right !== undefined) res.push(...extractEqValues(val.right))
  if (val.left !== undefined) res.push(...extractEqValues(val.left))
  if (Array.isArray(val.conditions)) res.push(...val.conditions.flatMap(extractEqValues))
  if (Array.isArray(val.queryChunks)) res.push(...val.queryChunks.flatMap(extractEqValues))
  return res
}

vi.mock('@/db/client', () => {
  const database: any = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => {
        const query: any = {
          where: vi.fn().mockImplementation((cond: any) => {
            const wanted = new Set(extractEqValues(cond))
            query.__filtered = mockDbData.financialProxyVersions.filter(
              (v) => wanted.has(v.financialProxyId) || wanted.has(v.id)
            )
            return query
          }),
          orderBy: vi.fn().mockImplementation((orderExpr: any) => {
            // desc(column) carries a literal ' desc' chunk; a bare column
            // reference (ascending) does not — real direction detection,
            // not an assumption, since getLatestFinancialProxyVersion uses
            // desc() and listFinancialProxyVersions does not.
            const isDesc = orderExpr?.queryChunks?.some((c: any) => c?.value?.[0] === ' desc')
            const data = query.__filtered ?? mockDbData.financialProxyVersions
            query.__filtered = [...data].sort((a, b) => (isDesc ? b.ordinal - a.ordinal : a.ordinal - b.ordinal))
            return query
          }),
          limit: vi.fn().mockImplementation((n: number) => {
            query.__filtered = (query.__filtered ?? mockDbData.financialProxyVersions).slice(0, n)
            return query
          }),
          then: (cb: (rows: any[]) => unknown) => Promise.resolve(cb(query.__filtered ?? mockDbData.financialProxyVersions)),
        }
        return query
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: any) => ({
        returning: vi.fn().mockImplementation(() => {
          const row = { id: `ver-${mockDbData.financialProxyVersions.length + 1}`, createdAt: new Date(), ...vals }
          mockDbData.financialProxyVersions.push(row)
          return Promise.resolve([row])
        }),
      })),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: any) => ({
        where: vi.fn().mockImplementation(() => {
          const current = [...mockDbData.financialProxyVersions].sort((a, b) => b.ordinal - a.ordinal)[0]
          if (current) Object.assign(current, values)
          return {
            returning: vi.fn().mockImplementation(() => Promise.resolve(current ? [current] : [])),
          }
        }),
      })),
    })),
  }
  return { db: database }
})

import {
  createFinancialProxyVersion,
  getLatestFinancialProxyVersion,
  listFinancialProxyVersions,
  updateCurrentFinancialProxyVersion,
  assertApprovableProvenance,
  APPROVAL_BLOCKING_PROVENANCE_ITEMS,
} from '@/lib/pipeline/financial-proxy-versions'

const PROXY_A = 'proxy-a'
const BASE_INPUT = {
  organizationId: 'org-1',
  financialProxyId: PROXY_A,
  sourceId: 'source-1',
  value: '100',
  currency: 'USD',
  unit: 'person',
  referenceYear: 2025,
  valueUsd: null,
  fxRateId: null,
  country: null,
  territory: null,
  thematicArea: null,
  methodology: null,
  geographicContextualScope: null,
  linkedOutcomeContext: null,
  recoverableReference: null,
  relevanceJustification: null,
  documentedTransformations: null,
  consultationDate: null,
  reviewStatus: 'draft',
  createdBy: 'user-1',
}

beforeEach(() => {
  mockDbData.financialProxyVersions = []
})

describe('createFinancialProxyVersion — ordinal + lineage', () => {
  it('assigns ordinal 1 with no supersedesVersionId for the first version', async () => {
    const v1 = await createFinancialProxyVersion(BASE_INPUT)
    expect(v1.ordinal).toBe(1)
    expect(v1.supersedesVersionId).toBeNull()
  })

  it('assigns ordinal N+1 and links supersedesVersionId to the prior current version', async () => {
    const v1 = await createFinancialProxyVersion(BASE_INPUT)
    const v2 = await createFinancialProxyVersion(BASE_INPUT)
    expect(v2.ordinal).toBe(2)
    expect(v2.supersedesVersionId).toBe(v1.id)
  })

  it('never regresses ordinal — a second proxy starts its own sequence at 1', async () => {
    await createFinancialProxyVersion(BASE_INPUT)
    const otherProxyV1 = await createFinancialProxyVersion({ ...BASE_INPUT, financialProxyId: 'proxy-b' })
    expect(otherProxyV1.ordinal).toBe(1)
  })
})

describe('getLatestFinancialProxyVersion / listFinancialProxyVersions', () => {
  it('returns null for a proxy that has never been versioned', async () => {
    expect(await getLatestFinancialProxyVersion('proxy-never-versioned')).toBeNull()
  })

  it('returns the highest-ordinal version as current', async () => {
    await createFinancialProxyVersion(BASE_INPUT)
    const v2 = await createFinancialProxyVersion(BASE_INPUT)
    const latest = await getLatestFinancialProxyVersion(PROXY_A)
    expect(latest?.id).toBe(v2.id)
  })

  it('lists the full lineage, oldest first', async () => {
    const v1 = await createFinancialProxyVersion(BASE_INPUT)
    const v2 = await createFinancialProxyVersion(BASE_INPUT)
    const lineage = await listFinancialProxyVersions(PROXY_A)
    expect(lineage.map((v) => v.id)).toEqual([v1.id, v2.id])
  })
})

describe('updateCurrentFinancialProxyVersion — seals onto the CURRENT version only', () => {
  it('returns null when the proxy has no version yet', async () => {
    expect(await updateCurrentFinancialProxyVersion('proxy-never-versioned', { reviewStatus: 'approved' })).toBeNull()
  })

  it('writes reviewer_id/reviewed_at onto the current version — the actual FIBC-012 fix', async () => {
    await createFinancialProxyVersion(BASE_INPUT)
    const now = new Date('2026-01-01T00:00:00Z')
    const updated = await updateCurrentFinancialProxyVersion(PROXY_A, {
      reviewStatus: 'approved',
      reviewerId: 'reviewer-1',
      reviewedAt: now,
    })
    expect(updated?.reviewStatus).toBe('approved')
    expect(updated?.reviewerId).toBe('reviewer-1')
    expect(updated?.reviewedAt).toEqual(now)
  })
})

// R-B2-02 (B2-AR-B2) / NC-6 — FIBC-010's ten approval-blocking items, each
// refused with an error naming that item. consultation_date (item 8) is
// recordable-required but conditional ('where relevant') and MUST NOT block.
const FULL_PROVENANCE = {
  value: '100',
  unit: 'person',
  currency: 'USD',
  referenceYear: 2025,
  geographicContextualScope: 'Nacional, población urbana',
  linkedOutcomeContext: 'Reducción de ingresos perdidos por enfermedad',
  sourceId: 'source-1',
  recoverableReference: 'https://data.worldbank.org/indicator/x',
  relevanceJustification: 'Misma población y periodo que el proyecto',
  documentedTransformations: 'none',
}

describe('assertApprovableProvenance — FIBC-010 ten-item approval gate (R-B2-02 / NC-6)', () => {
  it('throws when there is no version at all', () => {
    expect(() => assertApprovableProvenance(null)).toThrow('no version to approve')
  })

  it('passes when all ten approval-blocking items are present', () => {
    expect(() => assertApprovableProvenance(FULL_PROVENANCE)).not.toThrow()
  })

  it('does NOT gate consultation_date (FIBC-010 item 8, "where relevant")', () => {
    expect(() => assertApprovableProvenance({ ...FULL_PROVENANCE, consultationDate: null } as never)).not.toThrow()
  })

  it.each(APPROVAL_BLOCKING_PROVENANCE_ITEMS)('NC-6: refuses approval naming item $item when $column is NULL', ({ column, item }) => {
    expect(() => assertApprovableProvenance({ ...FULL_PROVENANCE, [column]: null })).toThrow(
      new RegExp(`FIBC-010 item ${item}: ${column}`)
    )
  })

  it.each(APPROVAL_BLOCKING_PROVENANCE_ITEMS.filter((i) => typeof FULL_PROVENANCE[i.column] === 'string'))(
    'NC-6: refuses approval naming item $item when $column is whitespace-only',
    ({ column, item }) => {
      expect(() => assertApprovableProvenance({ ...FULL_PROVENANCE, [column]: '   ' })).toThrow(
        new RegExp(`FIBC-010 item ${item}: ${column}`)
      )
    }
  )

  it('covers exactly the ten frozen items — 1..7 and 9..11, never 8', () => {
    expect(APPROVAL_BLOCKING_PROVENANCE_ITEMS.map((i) => i.item)).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 10, 11])
  })
})
