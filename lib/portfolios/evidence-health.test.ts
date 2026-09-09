// lib/portfolios/evidence-health.test.ts
// PORTFOLIO_PF3_EXECUTION_AUTHORITY_v1.0.0.json — binds POS-EH-1, POS-EH-2,
// NEG-PF3-EH-1, and evidence-health.ts's share of MUT-PF3-TENANT-1.
//
// Every EH-N computation is exercised through its PURE half (eh1FromRows,
// eh2FromActiveAndApproved, eh3FromDeterminations, eh4FromRows, eh5FromRows,
// eh6FromRows) rather than through a mocked db/client — the same DB-free-math
// split lib/portfolios/read-model.ts uses for buildPortfolioReadModelFromSummaries,
// so these controls test the CALCULATION the authority actually freezes, not
// a drizzle mock's fidelity to Postgres.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  eh1FromRows,
  eh2FromActiveAndApproved,
  eh3FromDeterminations,
  eh4FromRows,
  eh5FromRows,
  eh6FromRows,
  type RunScopedMember,
} from './evidence-health'

/* -------------------------------------------------------------------------- */
/* POS-EH-1 — every indicator: count + explicit denominator + drill/source ids */
/* -------------------------------------------------------------------------- */

describe('POS-EH-1 — count, explicit denominator, drill identifiers', () => {
  it('EH-1: per-project counts sum to the stated denominator, with a drill URL', () => {
    const members = [
      { id: 'p1', name: 'Project 1' },
      { id: 'p2', name: 'Project 2' },
    ]
    const rows = [
      { projectId: 'p1', status: 'approved' },
      { projectId: 'p1', status: 'draft' },
      { projectId: 'p1', status: 'rejected' },
      { projectId: 'p2', status: 'approved' },
    ]
    const result = eh1FromRows(members, rows)
    const p1 = result.byProject.find((p) => p.projectId === 'p1')!
    const p2 = result.byProject.find((p) => p.projectId === 'p2')!

    expect(p1.denominator).toBe(3)
    expect(p1.counts.approved + p1.counts.draft + p1.counts.under_review + p1.counts.rejected + p1.counts.archived).toBe(
      p1.denominator
    )
    expect(p1.drillUrl).toBe('/app/projects/p1/pipeline/evidence')
    expect(p2.denominator).toBe(1)
  })

  it('EH-2: numerator/denominator are explicit and drill identifiers (outcome ids) are attached', () => {
    const members: RunScopedMember[] = [{ projectId: 'p1', projectName: 'Project 1', runId: 'run-1', calculatedAt: new Date() }]
    const activeByRun = new Map([['run-1', ['outcome-1', 'outcome-2', 'outcome-3']]])
    const approved = new Set(['outcome-1', 'outcome-2'])

    const result = eh2FromActiveAndApproved(members, activeByRun, approved)

    expect(result.denominator).toBe(3)
    expect(result.numerator).toBe(2)
    expect(result.coveredOutcomeIds.sort()).toEqual(['outcome-1', 'outcome-2'])
    expect(result.activeOutcomeIds.sort()).toEqual(['outcome-1', 'outcome-2', 'outcome-3'])
  })

  it('EH-3: sufficient + insufficient + undetermined sum to the denominator, with outcome-id drill lists', () => {
    const members: RunScopedMember[] = [{ projectId: 'p1', projectName: 'Project 1', runId: 'run-1', calculatedAt: new Date() }]
    const activeByRun = new Map([['run-1', ['o1', 'o2', 'o3']]])
    const determinationsByRun = new Map([
      [
        'run-1',
        new Map([
          ['o1', { determination: 'sufficient' }],
          ['o2', { determination: 'insufficient' }],
        ]),
      ],
    ])

    const result = eh3FromDeterminations(members, activeByRun, determinationsByRun)

    expect(result.sufficient).toBe(1)
    expect(result.insufficient).toBe(1)
    expect(result.undetermined).toBe(1)
    expect(result.denominator).toBe(3)
    expect(result.sufficientOutcomeIds).toEqual(['o1'])
    expect(result.insufficientOutcomeIds).toEqual(['o2'])
    expect(result.undeterminedOutcomeIds).toEqual(['o3'])
  })

  it('EH-4: monetized + notMonetized sum to the denominator, byReason is visible, drill ids attached', () => {
    const rows = [
      { outcomeId: 'o1', disposition: 'monetized', reason: null },
      { outcomeId: 'o2', disposition: 'not_monetized', reason: 'insufficient_evidence' },
      { outcomeId: 'o3', disposition: 'not_monetized', reason: 'insufficient_evidence' },
    ]
    const result = eh4FromRows(rows)

    expect(result.monetized).toBe(1)
    expect(result.notMonetized).toBe(2)
    expect(result.denominator).toBe(3)
    expect(result.byReason.insufficient_evidence).toBe(2)
    expect(result.monetizedOutcomeIds).toEqual(['o1'])
    expect(result.notMonetizedOutcomeIds).toEqual(['o2', 'o3'])
  })

  it('EH-6: count + denominator per project, with evidence-item drill ids for the "newer" subset', () => {
    const calculatedAt = new Date('2026-01-01T00:00:00Z')
    const members: RunScopedMember[] = [{ projectId: 'p1', projectName: 'Project 1', runId: 'run-1', calculatedAt }]
    const rows = [
      { id: 'e1', projectId: 'p1', updatedAt: new Date('2026-02-01T00:00:00Z') }, // newer
      { id: 'e2', projectId: 'p1', updatedAt: new Date('2025-12-01T00:00:00Z') }, // older
    ]
    const result = eh6FromRows(members, rows)
    const p1 = result.byProject[0]

    expect(p1.denominator).toBe(2)
    expect(p1.count).toBe(1)
    expect(p1.evidenceItemIds).toEqual(['e1'])
  })
})

/* -------------------------------------------------------------------------- */
/* R2's binding requirement on the POS-EH-1 fixture: EH-5 must be exercised    */
/* with at least one NULL-bound assignment, so EH5_UNBOUND is non-vacuous.     */
/* -------------------------------------------------------------------------- */

describe('POS-EH-1 (EH-5) — EH5_EXACT_SEMANTICS, exercised with a NULL-bound assignment', () => {
  it('unbound assignments are counted separately, outside both numerator and denominator', () => {
    const assignments = [
      { id: 'a1', projectId: 'p1', proxyId: 'proxy-1', financialProxyVersionId: 'v1' },
      { id: 'a2', projectId: 'p1', proxyId: 'proxy-2', financialProxyVersionId: 'v2' },
      // R2's binding requirement: at least one NULL-bound assignment.
      { id: 'a3', projectId: 'p1', proxyId: 'proxy-3', financialProxyVersionId: null },
    ]
    const reviewStatusByVersionId = new Map([
      ['v1', 'approved'],
      ['v2', 'rejected'],
    ])

    const result = eh5FromRows(assignments, reviewStatusByVersionId)

    expect(result.denominator).toBe(2) // v1 + v2 — the two BOUND assignments
    expect(result.numerator).toBe(1) // v1 only — approved
    expect(result.unbound).toBe(1) // a3 — outside numerator AND denominator
    expect(result.unboundRows.map((r) => r.assignmentId)).toEqual(['a3'])
    expect(result.unboundRows[0].financialProxyVersionId).toBeNull()
    expect(result.denominatorRows.map((r) => r.assignmentId).sort()).toEqual(['a1', 'a2'])
  })
})

/* -------------------------------------------------------------------------- */
/* POS-EH-2 — the selected-run rule: a determination recorded for another run  */
/* must never satisfy this one.                                               */
/* -------------------------------------------------------------------------- */

describe('POS-EH-2 — sufficiency determinations are bound to the SELECTED run', () => {
  it('a determination recorded for a DIFFERENT run does not satisfy the selected one', () => {
    const members: RunScopedMember[] = [{ projectId: 'p1', projectName: 'Project 1', runId: 'run-selected', calculatedAt: new Date() }]
    const activeByRun = new Map([['run-selected', ['o1']]])

    // The determination exists, but is recorded against run-other — the map
    // passed for the selected run carries nothing for it.
    const determinationsByRun = new Map([['run-other', new Map([['o1', { determination: 'sufficient' }]])]])

    const result = eh3FromDeterminations(members, activeByRun, determinationsByRun)

    expect(result.sufficient).toBe(0)
    expect(result.undetermined).toBe(1)
    expect(result.undeterminedOutcomeIds).toEqual(['o1'])
  })

  it('the SAME outcome, determined for its own selected run, is read correctly', () => {
    const members: RunScopedMember[] = [{ projectId: 'p1', projectName: 'Project 1', runId: 'run-selected', calculatedAt: new Date() }]
    const activeByRun = new Map([['run-selected', ['o1']]])
    const determinationsByRun = new Map([['run-selected', new Map([['o1', { determination: 'sufficient' }]])]])

    const result = eh3FromDeterminations(members, activeByRun, determinationsByRun)

    expect(result.sufficient).toBe(1)
    expect(result.undetermined).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* NEG-PF3-EH-1 — no evidence content/body column is ever selected             */
/* -------------------------------------------------------------------------- */

const FORBIDDEN_EVIDENCE_COLUMNS = [
  'description',
  'url',
  'filePath',
  'reviewNotes',
  'title',
  'contentHash',
  'mimeType',
]

describe('NEG-PF3-EH-1 — the module never selects evidence content or body columns', () => {
  it('every db.select({...}) block touching evidenceItems projects only status/timestamps/identifiers/FKs', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib', 'portfolios', 'evidence-health.ts'), 'utf8')

    // Every `.select({ ... })` object literal in the file, matched
    // non-greedily. The module issues exactly two selects against
    // evidenceItems (EH-1's status projection, EH-6's id/projectId/updatedAt
    // projection) plus one against evidenceItems.outcomeId for EH-2 — this
    // asserts none of the THREE ever grows a content-bearing column.
    const selectBlocks = [...source.matchAll(/\.select\(\{([\s\S]*?)\}\)/g)].map((m) => m[1])
    expect(selectBlocks.length).toBeGreaterThan(0)

    for (const block of selectBlocks) {
      if (!block.includes('evidenceItems.')) continue
      for (const forbidden of FORBIDDEN_EVIDENCE_COLUMNS) {
        expect(
          block.includes(`evidenceItems.${forbidden}`),
          `found forbidden content-bearing column evidenceItems.${forbidden} in a select() block:\n${block}`
        ).toBe(false)
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/* MUT-PF3-TENANT-1 (evidence-health share) — the global-proxy join must bite  */
/* -------------------------------------------------------------------------- */

describe('MUT-PF3-TENANT-1 (evidence-health share) — the assignment-bound join must be load-bearing', () => {
  it('dropping a globally-approved version (simulating an organization_id predicate on financial_proxy_versions) makes EH-5 wrong', () => {
    const assignments = [
      { id: 'a1', projectId: 'p1', proxyId: 'proxy-1', financialProxyVersionId: 'v-global' },
      { id: 'a2', projectId: 'p1', proxyId: 'proxy-2', financialProxyVersionId: 'v-org' },
    ]

    // CORRECT: bound through outcome_proxy_assignments, no organization
    // predicate on financial_proxy_versions — the global version is reachable.
    const correctReviewStatus = new Map([
      ['v-global', 'approved'], // organization_id IS NULL in the real schema
      ['v-org', 'approved'],
    ])
    const correct = eh5FromRows(assignments, correctReviewStatus)
    expect(correct.numerator).toBe(2)
    expect(correct.denominator).toBe(2)

    // MUTATED: a predicate on financial_proxy_versions.organization_id would
    // silently drop the NULL-organization global row before it ever reaches
    // this map — simulated here by its absence.
    const mutatedReviewStatus = new Map([['v-org', 'approved']])
    const mutated = eh5FromRows(assignments, mutatedReviewStatus)

    expect(mutated.numerator).not.toBe(correct.numerator)
    expect(mutated.numerator).toBe(1)
    // The denominator is unaffected (it counts BOUND assignments, not
    // resolved review statuses) — the mutation's damage is specifically to
    // the numerator, which is exactly the silently-wrong-ratio failure mode
    // TENANCY_CONTRACT warns about.
    expect(mutated.denominator).toBe(correct.denominator)
  })
})
