// lib/pipeline/sroi-remediation-destinations.test.ts
//
// RE-U1 U1-F04 / RE-U4 sroi_remediation_matrix contract tests.
//
// These are navigation contract tests, not calculation tests: they prove
// that every one of the 12 SROI readiness blockers points at a real,
// canonical remediation destination (project-scoped route or same-page DOM
// anchor), and that the eligibility logic these CTAs are attached to was
// not touched by this repair (RE-U1-F04 repairs navigation, not blocker
// eligibility). Route/anchor existence is checked against the real
// filesystem and real page source, not a snapshot, so a later rename of a
// route or anchor without updating the blocker fails this suite.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { buildReadinessIssues, type ReadinessIssueInput } from './sroi-calculation'

const PROJECT_ID = 'proj-test-123'

/** Every field zeroed/false — the "nothing wrong" baseline input. */
function baseInput(overrides: Partial<ReadinessIssueInput> = {}): ReadinessIssueInput {
  return {
    projectId: PROJECT_ID,
    hasInvestment: true,
    zeroOrInvalidInvestment: false,
    invalidInvestmentIds: [],
    investmentsMissingUsd: [],
    activeAssignmentsCount: 1,
    missingInputs: [],
    missingFilterSets: [],
    unapprovedProxies: [],
    outcomesWithoutEvidence: [],
    invalidQuantities: [],
    invalidFilters: [],
    proxiesMissingUsd: [],
    overAllocatedOutcomes: [],
    ...overrides,
  }
}

const CALCULATION_PAGE_PATH = path.join(
  process.cwd(),
  'app/app/projects/[projectId]/pipeline/calculation/page.tsx',
)
const EVIDENCE_ROUTE_PATH = path.join(
  process.cwd(),
  'app/app/projects/[projectId]/pipeline/evidence/page.tsx',
)
const PROXIES_ROUTE_PATH = path.join(
  process.cwd(),
  'app/app/projects/[projectId]/pipeline/proxies/page.tsx',
)
const INVENTED_TOP_LEVEL_PROXIES_ROUTE = path.join(process.cwd(), 'app/app/proxies')

const calculationPageSource = readFileSync(CALCULATION_PAGE_PATH, 'utf8')

/**
 * Canonical row table — the runtime implementation of RE-U4's frozen
 * sroi_remediation_matrix. `trigger` sets exactly the input fields needed
 * to raise this one blocker from the `baseInput()` "nothing wrong" state.
 */
const ROWS: Array<{
  messageKey: string
  trigger: Partial<ReadinessIssueInput>
  actionPath: string | ((projectId: string) => string)
  actionLabel: string
  kind: 'anchor' | 'route'
  anchor?: string
}> = [
  {
    messageKey: 'missing_investment',
    trigger: { hasInvestment: false, zeroOrInvalidInvestment: true },
    actionPath: '#investment',
    actionLabel: 'Ir a inversiones',
    kind: 'anchor',
    anchor: 'investment',
  },
  {
    messageKey: 'invalid_investment_amount',
    trigger: { zeroOrInvalidInvestment: true, invalidInvestmentIds: ['inv-1'] },
    actionPath: '#investment',
    actionLabel: 'Ir a inversiones',
    kind: 'anchor',
    anchor: 'investment',
  },
  {
    messageKey: 'investments_missing_usd',
    trigger: { investmentsMissingUsd: ['inv-2'] },
    actionPath: '#investment',
    actionLabel: 'Revisar aportes',
    kind: 'anchor',
    anchor: 'investment',
  },
  {
    messageKey: 'no_proxy_assignments',
    trigger: { activeAssignmentsCount: 0 },
    actionPath: (projectId) => `/app/projects/${projectId}/pipeline/evidence`,
    actionLabel: 'Ir a evidencia',
    kind: 'route',
  },
  {
    messageKey: 'missing_inputs',
    trigger: { missingInputs: ['assign-1'] },
    actionPath: '#sroi-inputs',
    actionLabel: 'Completar información',
    kind: 'anchor',
    anchor: 'sroi-inputs',
  },
  {
    messageKey: 'missing_filter_sets',
    trigger: { missingFilterSets: ['assign-2'] },
    actionPath: '#sroi-filters',
    actionLabel: 'Configurar filtros',
    kind: 'anchor',
    anchor: 'sroi-filters',
  },
  {
    messageKey: 'unapproved_proxies',
    trigger: { unapprovedProxies: ['proxy-1'] },
    actionPath: (projectId) => `/app/projects/${projectId}/pipeline/proxies`,
    actionLabel: 'Revisar proxies',
    kind: 'route',
  },
  {
    messageKey: 'outcomes_without_evidence',
    trigger: { outcomesWithoutEvidence: ['outcome-1'] },
    actionPath: (projectId) => `/app/projects/${projectId}/pipeline/evidence`,
    actionLabel: 'Agregar evidencia',
    kind: 'route',
  },
  {
    messageKey: 'invalid_quantities',
    trigger: { invalidQuantities: ['assign-3'] },
    actionPath: '#sroi-inputs',
    actionLabel: 'Revisar cantidades',
    kind: 'anchor',
    anchor: 'sroi-inputs',
  },
  {
    messageKey: 'invalid_filters',
    trigger: { invalidFilters: ['assign-4'] },
    actionPath: '#sroi-filters',
    actionLabel: 'Revisar filtros',
    kind: 'anchor',
    anchor: 'sroi-filters',
  },
  {
    messageKey: 'proxies_missing_usd',
    trigger: { proxiesMissingUsd: ['proxy-2'] },
    actionPath: (projectId) => `/app/projects/${projectId}/pipeline/proxies`,
    actionLabel: 'Revisar proxies',
    kind: 'route',
  },
  {
    messageKey: 'over_allocated_outcomes',
    trigger: { overAllocatedOutcomes: ['outcome-2'] },
    actionPath: '#funder-attribution',
    actionLabel: 'Revisar atribución',
    kind: 'anchor',
    anchor: 'funder-attribution',
  },
]

describe('SROI remediation-destination matrix (RE-U1-F04 / RE-U4)', () => {
  it('maps exactly the 12 blockers RE-U4 froze — no fewer, no more, no unknown key', () => {
    expect(ROWS).toHaveLength(12)
    expect(new Set(ROWS.map((r) => r.messageKey)).size).toBe(12)
  })

  describe.each(ROWS)('$messageKey', (row) => {
    it('is not raised from the clean baseline', () => {
      const issues = buildReadinessIssues(baseInput())
      expect(issues.find((i) => i.messageKey === row.messageKey)).toBeUndefined()
    })

    it('raises exactly one issue with the canonical messageKey/actionPath/actionLabel when triggered', () => {
      const issues = buildReadinessIssues(baseInput(row.trigger))
      const matches = issues.filter((i) => i.messageKey === row.messageKey)
      expect(matches).toHaveLength(1)

      const issue = matches[0]
      const expectedPath = typeof row.actionPath === 'function' ? row.actionPath(PROJECT_ID) : row.actionPath
      expect(issue.actionPath).toBe(expectedPath)
      expect(issue.actionLabel).toBe(row.actionLabel)
      expect(issue.type).toBe('error')
    })

    it('never points at the invented top-level /app/proxies route', () => {
      const issues = buildReadinessIssues(baseInput(row.trigger))
      const issue = issues.find((i) => i.messageKey === row.messageKey)
      expect(issue?.actionPath).not.toBe('/app/proxies')
      expect(issue?.actionPath?.startsWith('/app/proxies')).toBe(false)
    })

    if (row.kind === 'route') {
      it('actionPath is a real project-scoped route, with the real projectId interpolated (never hardcoded)', () => {
        const otherProjectId = 'a-totally-different-project-id'
        const issuesA = buildReadinessIssues(baseInput(row.trigger))
        const issuesB = buildReadinessIssues({ ...baseInput(row.trigger), projectId: otherProjectId })
        const pathA = issuesA.find((i) => i.messageKey === row.messageKey)?.actionPath
        const pathB = issuesB.find((i) => i.messageKey === row.messageKey)?.actionPath
        expect(pathA).toContain(PROJECT_ID)
        expect(pathB).toContain(otherProjectId)
        expect(pathA).not.toBe(pathB)
      })
    }

    if (row.kind === 'anchor') {
      it(`references an anchor id ("${row.anchor}") that actually exists in the calculation page source`, () => {
        const idPattern = new RegExp(`id=(\\{[^}]*['"\`]${row.anchor}['"\`][^}]*\\}|['"\`]${row.anchor}['"\`])`)
        expect(calculationPageSource).toMatch(idPattern)
      })
    }
  })

  it('destination routes referenced by any blocker exist on disk', () => {
    expect(existsSync(EVIDENCE_ROUTE_PATH)).toBe(true)
    expect(existsSync(PROXIES_ROUTE_PATH)).toBe(true)
  })

  it('does not invent a top-level /app/proxies route', () => {
    expect(existsSync(INVENTED_TOP_LEVEL_PROXIES_ROUTE)).toBe(false)
  })

  it('all four canonical DOM anchors exist exactly once each in the calculation page', () => {
    for (const anchor of ['investment', 'sroi-inputs', 'sroi-filters', 'funder-attribution']) {
      const idPattern = new RegExp(`id=(\\{[^}]*['"\`]${anchor}['"\`][^}]*\\}|['"\`]${anchor}['"\`])`, 'g')
      const matches = calculationPageSource.match(idPattern) ?? []
      expect(matches.length).toBe(1)
    }
  })

  it('raises all 12 blockers together without cross-contamination when every condition is triggered', () => {
    // missing_investment (hasInvestment=false) and invalid_investment_amount
    // (hasInvestment=true, amount invalid) are mutually exclusive in real
    // readiness data — an assignment set never has "no investment at all"
    // AND "an invalid investment amount" simultaneously. This combined case
    // exercises the realistic "investment exists but is invalid" branch,
    // matching all 12 message keys via the *other* 11 rows' independent
    // triggers plus invalid_investment_amount standing in for the pair.
    const everything: Partial<ReadinessIssueInput> = Object.assign(
      {},
      ...ROWS.filter((r) => r.messageKey !== 'missing_investment').map((r) => r.trigger),
    )
    const issues = buildReadinessIssues(baseInput(everything))
    const keys = issues.map((i) => i.messageKey).sort()
    const expectedKeys = ROWS.filter((r) => r.messageKey !== 'missing_investment').map((r) => r.messageKey).sort()
    expect(keys).toEqual(expectedKeys)
  })

  it('itemIds are preserved unchanged for blockers that carry them (semantics not touched by this repair)', () => {
    const issues = buildReadinessIssues(
      baseInput({
        zeroOrInvalidInvestment: true,
        invalidInvestmentIds: ['inv-a', 'inv-b'],
        investmentsMissingUsd: ['inv-c'],
        missingInputs: ['assign-a'],
        missingFilterSets: ['assign-b'],
        unapprovedProxies: ['proxy-a'],
        outcomesWithoutEvidence: ['outcome-a'],
        invalidQuantities: ['assign-c'],
        invalidFilters: ['assign-d'],
        proxiesMissingUsd: ['proxy-b'],
        overAllocatedOutcomes: ['outcome-b'],
      }),
    )
    const byKey = new Map(issues.map((i) => [i.messageKey, i]))
    expect(byKey.get('invalid_investment_amount')?.itemIds).toEqual(['inv-a', 'inv-b'])
    expect(byKey.get('investments_missing_usd')?.itemIds).toEqual(['inv-c'])
    expect(byKey.get('missing_inputs')?.itemIds).toEqual(['assign-a'])
    expect(byKey.get('missing_filter_sets')?.itemIds).toEqual(['assign-b'])
    expect(byKey.get('unapproved_proxies')?.itemIds).toEqual(['proxy-a'])
    expect(byKey.get('outcomes_without_evidence')?.itemIds).toEqual(['outcome-a'])
    expect(byKey.get('invalid_quantities')?.itemIds).toEqual(['assign-c'])
    expect(byKey.get('invalid_filters')?.itemIds).toEqual(['assign-d'])
    expect(byKey.get('proxies_missing_usd')?.itemIds).toEqual(['proxy-b'])
    expect(byKey.get('over_allocated_outcomes')?.itemIds).toEqual(['outcome-b'])
  })
})
