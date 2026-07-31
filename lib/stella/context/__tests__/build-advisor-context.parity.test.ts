// lib/stella/context/__tests__/build-advisor-context.parity.test.ts
// FABLE MOONSHOT WS1 / U1: production-context parity test.
// Asserts that buildAdvisorContext populates EVERY ContextualAdvisorContext
// field with real persisted values — no hardcoded [] / null / '' placeholders.
// Mocks the db layer only; no real DB, no real Gemini.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildAdvisorContext } from '../build-advisor-context'
import type { ContextualAdvisorContext, CalculationReadinessSummary } from '../types'

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(),
  },
}))

const PROJECT_ID = 'proj-parity-0001'
const ORG_ID = 'org-parity-0001'

const projectRow = {
  id: PROJECT_ID,
  organizationId: ORG_ID,
  name: 'Programa de Empleo Juvenil',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
}

const narrativeRow = {
  narrativeText: 'El proyecto mejora la empleabilidad juvenil.',
  theoryOfChangeSummary: 'Capacitación conduce a empleo formal.',
}

const stakeholderRows = [
  { id: 'sh-1', name: 'Jóvenes participantes', type: 'beneficiary' },
  { id: 'sh-2', name: 'Empleadores locales', type: 'secondary' },
]

const outcomeRows = [
  { id: 'out-1', title: 'Mayor tasa de empleo', outcomeType: 'social', status: 'active', stakeholderGroupId: 'sh-1' },
  { id: 'out-2', title: 'Mayor confianza', outcomeType: 'psychological', status: 'active', stakeholderGroupId: 'sh-2' },
]

const indicatorRows = [
  { id: 'ind-1', outcomeId: 'out-1', name: 'Empleos conseguidos en 6 meses', unit: 'count' },
]

const evidenceRows = [
  {
    id: 'ev-1',
    type: 'file',
    title: 'Encuesta 2026',
    status: 'approved',
    contentHash: 'abcdef1234567890',
    createdAt: new Date('2026-03-01T00:00:00Z'),
    outcomeId: 'out-1',
    indicatorId: 'ind-1',
  },
]

const assignmentRows = [
  {
    assignmentId: 'asgn-1',
    proxyId: 'proxy-1',
    proxyName: 'Costo de tratamiento de depresión leve',
    confidenceLevel: 'high',
    methodologicalRisk: 'low',
    sourceId: 'src-1',
    value: '1200.5000',
    currency: 'USD',
  },
]

const sourceRows = [{ id: 'src-1', name: 'HACT Database' }]

const activityRows = [
  { id: 'act-1', title: 'Talleres de formación laboral' },
  { id: 'act-2', title: 'Mentorías con empleadores' },
]

const filterSetRows = [
  {
    assignmentId: 'asgn-1',
    deadweightPct: '10',
    displacementPct: '5',
    attributionPct: '80',
    dropoffPct: '15',
    durationYears: 3,
  },
]

const latestRunRow = {
  id: 'run-1',
  version: 3,
  currency: 'USD',
  totalInvestment: '10000.0000',
  grossSocialValue: '25000.0000',
  netSocialValue: '15000.0000',
  sroiRatio: '1.500000',
  runDate: new Date('2026-05-01T00:00:00Z'),
}

const lineItemRows = [{ id: 'li-1' }, { id: 'li-2' }]

const sectionRows = [
  { id: 'sec-1', sectionType: 'executive_summary', title: 'Resumen ejecutivo', content: 'Borrador del resumen.' },
]

// ---------------------------------------------------------------------------
// Key-based db.select mock: each query is identified by the sorted keys of
// its projection, so the mock is insensitive to query ordering.
// ---------------------------------------------------------------------------

type QueryFixtures = Record<string, unknown[]>

function defaultFixtures(): QueryFixtures {
  return {
    'createdAt,id,name,organizationId,status,updatedAt': [projectRow],
    'narrativeText,theoryOfChangeSummary': [narrativeRow],
    'id,name,type': stakeholderRows,
    'id,outcomeType,stakeholderGroupId,status,title': outcomeRows,
    'id,name,outcomeId,unit': indicatorRows,
    'contentHash,createdAt,id,indicatorId,outcomeId,status,title,type': evidenceRows,
    'assignmentId,confidenceLevel,currency,methodologicalRisk,proxyId,proxyName,sourceId,value': assignmentRows,
    'id,name': sourceRows,
    'id,title': activityRows,
    'assignmentId,attributionPct,deadweightPct,displacementPct,dropoffPct,durationYears': filterSetRows,
    'currency,grossSocialValue,id,netSocialValue,sroiRatio,totalInvestment,version': [latestRunRow],
    id: lineItemRows,
    'content,id,sectionType,title': sectionRows,
  }
}

function makeChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.then = vi
    .fn()
    .mockImplementation((cb: (v: unknown) => unknown) => Promise.resolve(cb(resolvedValue)))
  return chain
}

async function installFixtures(fixtures: QueryFixtures) {
  const { db } = await import('@/db/client')
  vi.mocked(db.select).mockImplementation(((projection: Record<string, unknown>) => {
    const key = Object.keys(projection ?? {}).sort().join(',')
    if (!(key in fixtures)) {
      throw new Error(`Unexpected advisor context query with projection: ${key}`)
    }
    return makeChain(fixtures[key])
  }) as never)
}

// Every field of the explicit contextual data contract.
const CONTEXTUAL_FIELDS: readonly (keyof ContextualAdvisorContext)[] = [
  'projectId',
  'organizationId',
  'projectName',
  'narrativeSummary',
  'outcomesSnapshot',
  'indicatorsSnapshot',
  'stakeholderCount',
  'stakeholdersSnapshot',
  'activitiesSummary',
  'evidenceMetadata',
  'evidenceTotal',
  'proxySummary',
  'filterSetsSummary',
  'calculationSnapshot',
  'calculationReadiness',
  'reportSections',
  'projectCreatedAt',
  'lastUpdatedAt',
]

describe('buildAdvisorContext — ContextualAdvisorContext parity (U1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('populates every ContextualAdvisorContext field with real persisted values', async () => {
    await installFixtures(defaultFixtures())

    const ctx: ContextualAdvisorContext = await buildAdvisorContext(PROJECT_ID, ORG_ID, 'calculation')

    for (const field of CONTEXTUAL_FIELDS) {
      expect(ctx[field], `field ${String(field)} must be populated`).toBeDefined()
    }

    // No hardcoded placeholders: each collection reflects the persisted rows.
    expect(ctx.projectName).toBe('Programa de Empleo Juvenil')
    expect(ctx.narrativeSummary).toBe(
      'El proyecto mejora la empleabilidad juvenil. Capacitación conduce a empleo formal.'
    )
    expect(ctx.outcomesSnapshot).toEqual([
      { id: 'out-1', name: 'Mayor tasa de empleo', description: 'social', stakeholderGroups: ['sh-1'] },
      { id: 'out-2', name: 'Mayor confianza', description: 'psychological', stakeholderGroups: ['sh-2'] },
    ])
    expect(ctx.indicatorsSnapshot).toEqual([
      { id: 'ind-1', outcomeId: 'out-1', name: 'Empleos conseguidos en 6 meses', unit: 'count' },
    ])
    expect(ctx.stakeholderCount).toBe(2)
    expect(ctx.evidenceTotal).toBe(1)
    expect(ctx.projectCreatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(ctx.lastUpdatedAt).toBe('2026-06-01T00:00:00.000Z')
    expect(ctx.stakeholdersSnapshot).toEqual([
      { id: 'sh-1', name: 'Jóvenes participantes', type: 'beneficiary' },
      { id: 'sh-2', name: 'Empleadores locales', type: 'secondary' },
    ])
    expect(ctx.activitiesSummary).toEqual([
      { id: 'act-1', title: 'Talleres de formación laboral' },
      { id: 'act-2', title: 'Mentorías con empleadores' },
    ])
    expect(ctx.filterSetsSummary).toEqual([
      { assignmentId: 'asgn-1', deadweightPct: 10, attributionPct: 80, displacementPct: 5, dropoffPct: 15, durationYears: 3 },
    ])
    expect(ctx.calculationSnapshot).toMatchObject({
      totalInvestment: 10000,
      grossSocialValue: 25000,
      netSocialValue: 15000,
      sroiRatio: 1.5,
      currency: 'USD',
      lineItemCount: 2,
      version: 3,
    })
    expect(ctx.reportSections).toEqual([
      { id: 'sec-1', sectionType: 'executive_summary', title: 'Resumen ejecutivo', contentLength: 'Borrador del resumen.'.length, status: 'in_progress' },
    ])
  })

  it('links each outcome to its stakeholder group at group level only (FIX 1)', async () => {
    await installFixtures(defaultFixtures())

    const ctx = await buildAdvisorContext(PROJECT_ID, ORG_ID, 'outcomes')

    const stakeholderIds = new Set((ctx.stakeholdersSnapshot ?? []).map((s) => s.id))
    expect(ctx.outcomesSnapshot?.length).toBeGreaterThan(0)
    for (const outcome of ctx.outcomesSnapshot ?? []) {
      expect(outcome.stakeholderGroups?.length).toBeGreaterThan(0)
      for (const groupId of outcome.stakeholderGroups ?? []) {
        // Group-level ids only — resolvable via stakeholdersSnapshot, no PII.
        expect(stakeholderIds.has(groupId)).toBe(true)
      }
    }
  })

  it('populates proxy value and currency from the proxies table — never hardcoded empty strings', async () => {
    await installFixtures(defaultFixtures())

    const ctx = await buildAdvisorContext(PROJECT_ID, ORG_ID, 'proxies')

    expect(ctx.proxySummary).toHaveLength(1)
    expect(ctx.proxySummary?.[0]?.value).toBe('1200.5000')
    expect(ctx.proxySummary?.[0]?.currency).toBe('USD')
  })

  it('keeps evidence linkage (outcomeId/indicatorId) and resolves related titles — still no filePath', async () => {
    await installFixtures(defaultFixtures())

    const ctx = await buildAdvisorContext(PROJECT_ID, ORG_ID, 'evidence')

    expect(ctx.evidenceMetadata?.[0]).toMatchObject({
      id: 'ev-1',
      outcomeId: 'out-1',
      indicatorId: 'ind-1',
      relatedOutcomeTitle: 'Mayor tasa de empleo',
      relatedIndicatorName: 'Empleos conseguidos en 6 meses',
    })
    expect(JSON.stringify(ctx)).not.toContain('filePath')
  })

  it('exposes stakeholder metadata at name/type level only — no PII fields', async () => {
    await installFixtures(defaultFixtures())

    const ctx = await buildAdvisorContext(PROJECT_ID, ORG_ID, 'stakeholders')

    for (const stakeholder of ctx.stakeholdersSnapshot ?? []) {
      expect(Object.keys(stakeholder).sort()).toEqual(['id', 'name', 'type'])
    }
    expect(ctx.stakeholderCount).toBe(2)
  })

  it('derives a minimal calculation readiness summary from persisted data when none is injected', async () => {
    await installFixtures(defaultFixtures())

    const ctx = await buildAdvisorContext(PROJECT_ID, ORG_ID, 'calculation')

    expect(ctx.calculationReadiness).toMatchObject({
      ready: true,
      source: 'derived_from_persisted',
      latestCalculatedRunExists: true,
      activeProxyAssignmentCount: 1,
      activeFilterSetCount: 1,
    })
    expect(ctx.calculationReadiness?.blockingReasons).toEqual([])
  })

  it('derives a not-ready summary with blocking reasons when no persisted run exists', async () => {
    const fixtures = defaultFixtures()
    fixtures['currency,grossSocialValue,id,netSocialValue,sroiRatio,totalInvestment,version'] = []
    await installFixtures(fixtures)

    const ctx = await buildAdvisorContext(PROJECT_ID, ORG_ID, 'calculation')

    expect(ctx.calculationSnapshot).toBeNull()
    expect(ctx.calculationReadiness?.ready).toBe(false)
    expect(ctx.calculationReadiness?.latestCalculatedRunExists).toBe(false)
    expect((ctx.calculationReadiness?.blockingReasons ?? []).length).toBeGreaterThan(0)
  })

  it('prefers an injected calculationReadiness over the derived one', async () => {
    await installFixtures(defaultFixtures())
    const injected: CalculationReadinessSummary = {
      ready: false,
      blockingReasons: ['Falta revisar la asignación de proxies'],
      warnings: ['Advertencia de prueba'],
      source: 'injected',
      latestCalculatedRunExists: true,
      activeProxyAssignmentCount: 1,
      activeFilterSetCount: 1,
    }

    const ctx = await buildAdvisorContext(PROJECT_ID, ORG_ID, 'calculation', {
      calculationReadiness: injected,
    })

    expect(ctx.calculationReadiness).toEqual(injected)
  })
})
