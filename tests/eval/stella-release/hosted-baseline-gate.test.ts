// tests/eval/stella-release/hosted-baseline-gate.test.ts
// TRAIN 5C0 — Phase 13.

import { describe, expect, it } from 'vitest'

import {
  HOSTED_BASELINE_GATE_IDS,
  buildHostedBaselineGateEvidence,
  computeHostedBaselineGateReport,
  evaluateHostedBaselineGates,
} from './hosted-baseline-gate'

const evidence = buildHostedBaselineGateEvidence()

describe('the six baseline gates', () => {
  it('all pass', () => {
    const failed = evaluateHostedBaselineGates(evidence).filter((g) => !g.passed)
    expect(failed.map((g) => `${g.id}: ${g.detail}`)).toEqual([])
  })

  it('are exactly the six Phase 13 asked for, and no more', () => {
    expect([...HOSTED_BASELINE_GATE_IDS]).toEqual([
      'hosted-baseline-manifest-ready',
      'hosted-baseline-order-ready',
      'hosted-baseline-managed-compatible',
      'hosted-baseline-rehearsal-ready',
      'hosted-baseline-postconditions-ready',
      'hosted-baseline-recovery-ready',
    ])
    expect(evaluateHostedBaselineGates(evidence).map((g) => g.id)).toEqual([...HOSTED_BASELINE_GATE_IDS])
  })

  it('are not tautological: each rests on evidence gathered by doing the work', () => {
    // The order gate is only meaningful because the checker was OBSERVED
    // refusing a mutation, and the postcondition gate only because every check
    // was OBSERVED failing its own negative control.
    expect(evidence.orderProblemsOnMutation).toBeGreaterThan(0)
    expect(evidence.dependencyViolationDetected).toBe(true)
    expect(evidence.postconditionsSurvivingOwnNegativeControl).toEqual([])
    expect(evidence.phaseSkipRefused).toBe(true)
    expect(evidence.sentinelAutomationRefused).toBe(true)
    expect(evidence.firstProvisioningPlannable).toBe(true)
  })

  it('measures the corpus rather than restating the manifest', () => {
    expect(evidence.unitCount).toBe(59)
    expect(evidence.superuserFreeUnits).toBe(59)
    expect(evidence.serviceRoleGranters).toEqual(['0033_public_api_grants.sql'])
    expect(evidence.dmlUnits).toEqual([
      '0018_redundant_firebird.sql',
      '0040_governed_model_registry.sql',
      '0041_pc01b_regime_boundary_backfill.sql',
      '0047_fib_taxonomy_mapping_governance_regime.sql',
    ])
    expect(evidence.literalRowSources).toBe(1)
    expect(evidence.mustNotRunUnits).toEqual([])
  })
})

describe('the four words this report may not say', () => {
  it('reports baselineApplied, stagingApplied, hostedReady and providerReady as false — unconditionally', () => {
    const report = computeHostedBaselineGateReport(evidence)

    expect(report.gates.every((g) => g.passed)).toBe(true)
    expect(report.baselineApplied).toBe(false)
    expect(report.stagingApplied).toBe(false)
    expect(report.hostedReady).toBe(false)
    expect(report.providerReady).toBe(false)
  })

  it('says so even if every gate were failing, because they are not computed from the gates', () => {
    const broken = computeHostedBaselineGateReport({
      ...evidence,
      manifestProblems: ['[SHA_MISMATCH] everything'],
      postconditionsSurvivingOwnNegativeControl: ['B0-01-schemas'],
      recoveryDefaultsToDestroy: false,
    })
    expect(broken.baselineApplied).toBe(false)
    expect(broken.hostedReady).toBe(false)
    expect(broken.gates.some((g) => !g.passed)).toBe(true)
  })

  it('lists what is still missing, including the honest limits of a local rehearsal', () => {
    const report = computeHostedBaselineGateReport(evidence)
    const missing = report.missingForHostedBaselineApply.join(' ')

    expect(missing).toContain('NEVER been applied to any hosted database')
    expect(missing).toContain('CHECKPOINT B0 has no result')
    expect(missing).toContain('CREATE TRIGGER on auth.users')
    expect(missing).toContain('regression test')
    expect(missing).toMatch(/authorization for the first hosted write/)
  })
})
