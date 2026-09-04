// tests/sroi-sensitivity.service.test.ts
// FIBIU-18 (FIBC-022, W2-B5, HPO-ODS-W2-17) — declared test host for the
// model that SUPERSEDES the uniform ±10pp scenarioFilterPct shortcut. Pure,
// DB-free controls on the candidate register construction, completeness
// semantics and scenario envelope. Real-PG/RLS/ACL controls run exclusively
// through tests/postgres/b5-completeness.pg.test.ts.

import { describe, it, expect } from 'vitest'
import {
  buildSensitivityCandidateDrafts,
  computeSensitivityCompleteness,
  computeScenarioEnvelope,
  FIB_FILTER_NAMES,
  type CandidateDraft,
} from '@/lib/pipeline/sroi-sensitivity'
import type { AssignmentData } from '@/lib/pipeline/sroi-calculation'

function assignment(overrides: Partial<{ id: string; outcomeId: string; deadweightPct: string | null; attributionPct: string | null; displacementPct: string | null; dropoffPct: string | null; durationYears: number | null; proxyVersion: { id: string; valueUsd: string } | null }> = {}): AssignmentData {
  const id = overrides.id ?? 'assign-1'
  const outcomeId = overrides.outcomeId ?? 'outcome-1'
  return {
    assignment: { id, outcomeId } as AssignmentData['assignment'],
    input: { quantity: '10' } as AssignmentData['input'],
    filterSet: {
      deadweightPct: overrides.deadweightPct ?? '20',
      attributionPct: overrides.attributionPct ?? '10',
      displacementPct: overrides.displacementPct ?? '0',
      dropoffPct: overrides.dropoffPct ?? '5',
      durationYears: overrides.durationYears ?? 3,
    } as AssignmentData['filterSet'],
    proxy: { id: 'proxy-1' } as AssignmentData['proxy'],
    proxyVersion: overrides.proxyVersion === null ? null : ({ id: overrides.proxyVersion?.id ?? 'pv-1', valueUsd: overrides.proxyVersion?.valueUsd ?? '100' } as AssignmentData['proxyVersion']),
    outcome: { id: outcomeId } as AssignmentData['outcome'],
  }
}

describe('FIB_FILTER_NAMES', () => {
  it('is exactly the five FIBC-022 adjustment dimensions, in the authority\'s own naming', () => {
    expect(FIB_FILTER_NAMES).toEqual(['deadweight', 'attribution', 'displacement', 'drop_off', 'duration'])
  })
})

describe('buildSensitivityCandidateDrafts', () => {
  it('registers all five filter dimensions for a monetized assignment, including a zero and an unchanged-from-default value', () => {
    const drafts = buildSensitivityCandidateDrafts({
      monetizedAssignments: [assignment({ displacementPct: '0', durationYears: 1 })],
      materialAssumptions: [],
      discountRatePct: null,
    })
    const filterDrafts = drafts.filter((d) => d.candidateKind === 'methodological_filter')
    expect(filterDrafts).toHaveLength(5)
    expect(filterDrafts.map((d) => d.inputReference.filter).sort()).toEqual(
      ['attribution', 'deadweight', 'displacement', 'drop_off', 'duration'].sort()
    )
    // MUT-18-4 — the zero-valued displacement candidate is present, not omitted.
    const displacement = filterDrafts.find((d) => d.inputReference.filter === 'displacement')!
    expect(displacement.baseValue).toBe('0')
    const duration = filterDrafts.find((d) => d.inputReference.filter === 'duration')!
    expect(duration.baseValue).toBe('1')
  })

  it('registers a proxy_value candidate when a proxy version is bound, and omits it when not', () => {
    const withProxy = buildSensitivityCandidateDrafts({ monetizedAssignments: [assignment()], materialAssumptions: [], discountRatePct: null })
    expect(withProxy.filter((d) => d.candidateKind === 'proxy_value')).toHaveLength(1)

    const withoutProxy = buildSensitivityCandidateDrafts({ monetizedAssignments: [assignment({ proxyVersion: null })], materialAssumptions: [], discountRatePct: null })
    expect(withoutProxy.filter((d) => d.candidateKind === 'proxy_value')).toHaveLength(0)
  })

  it('registers one structured_assumption candidate per material assumption', () => {
    const drafts = buildSensitivityCandidateDrafts({
      monetizedAssignments: [],
      materialAssumptions: [{ id: 'a-1', formulation: 'Some assumption' } as never, { id: 'a-2', formulation: 'Another' } as never],
      discountRatePct: null,
    })
    const structured = drafts.filter((d) => d.candidateKind === 'structured_assumption')
    expect(structured).toHaveLength(2)
    expect(structured.map((d) => d.candidateKey).sort()).toEqual(['structured_assumption:a-1', 'structured_assumption:a-2'])
  })

  it('always registers exactly one other_quantitative_input candidate for discount_rate_pct, even with zero assignments and zero assumptions', () => {
    const drafts = buildSensitivityCandidateDrafts({ monetizedAssignments: [], materialAssumptions: [], discountRatePct: '5.00' })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ candidateKind: 'other_quantitative_input', candidateKey: 'other_quantitative_input:discount_rate_pct', baseValue: '5.00' })
  })

  it('produces deterministic, assignment-scoped candidate keys — two assignments never collide', () => {
    const drafts = buildSensitivityCandidateDrafts({
      monetizedAssignments: [assignment({ id: 'a1', outcomeId: 'o1' }), assignment({ id: 'a2', outcomeId: 'o2' })],
      materialAssumptions: [],
      discountRatePct: null,
    })
    const keys = drafts.map((d: CandidateDraft) => d.candidateKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('computeSensitivityCompleteness', () => {
  const candidate = (id: string, disposition: 'pending' | 'variation_required' | 'no_additional_variation_required') =>
    ({ id, disposition } as never)

  it('is incomplete while any candidate is pending', () => {
    const result = computeSensitivityCompleteness([candidate('c1', 'pending')], new Map())
    expect(result.complete).toBe(false)
    expect(result.pendingCandidateIds).toEqual(['c1'])
  })

  it('is incomplete when a variation_required candidate has zero scenarios', () => {
    const result = computeSensitivityCompleteness([candidate('c1', 'variation_required')], new Map())
    expect(result.complete).toBe(false)
    expect(result.variationRequiredWithoutScenarioIds).toEqual(['c1'])
  })

  it('is complete when a variation_required candidate has >=1 scenario', () => {
    const result = computeSensitivityCompleteness([candidate('c1', 'variation_required')], new Map([['c1', 1]]))
    expect(result.complete).toBe(true)
  })

  it('is complete when the only candidate is no_additional_variation_required — no scenario needed', () => {
    const result = computeSensitivityCompleteness([candidate('c1', 'no_additional_variation_required')], new Map())
    expect(result.complete).toBe(true)
    expect(result.pendingCandidateIds).toHaveLength(0)
    expect(result.variationRequiredWithoutScenarioIds).toHaveLength(0)
  })
})

describe('computeScenarioEnvelope', () => {
  it('spans the base run and every scenario — min/max, never a confidence interval label', () => {
    const envelope = computeScenarioEnvelope(
      { netSocialValueExact: '1000.0000', sroiRatioExact: '2.000000' },
      [
        { netSocialValueExact: '800.0000', sroiRatioExact: '1.600000' },
        { netSocialValueExact: '1200.0000', sroiRatioExact: '2.400000' },
      ]
    )
    expect(envelope.label).toBe('scenario_envelope')
    expect(envelope.netSocialValueMinExact).toBe('800.0000')
    expect(envelope.netSocialValueMaxExact).toBe('1200.0000')
    expect(envelope.sroiRatioMinExact).toBe('1.600000')
    expect(envelope.sroiRatioMaxExact).toBe('2.400000')
  })

  it('handles a null sroiRatio (no-ratio state) without fabricating a value', () => {
    const envelope = computeScenarioEnvelope(
      { netSocialValueExact: '1000.0000', sroiRatioExact: null },
      [{ netSocialValueExact: '900.0000', sroiRatioExact: null }]
    )
    expect(envelope.sroiRatioMinExact).toBeNull()
    expect(envelope.sroiRatioMaxExact).toBeNull()
  })

  it('with zero scenarios, the envelope collapses to the base run alone', () => {
    const envelope = computeScenarioEnvelope({ netSocialValueExact: '500.0000', sroiRatioExact: '1.000000' }, [])
    expect(envelope.netSocialValueMinExact).toBe('500.0000')
    expect(envelope.netSocialValueMaxExact).toBe('500.0000')
  })
})
