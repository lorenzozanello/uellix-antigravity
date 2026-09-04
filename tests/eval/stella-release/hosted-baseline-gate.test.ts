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

  // W2-B2 (FIBIU-08/09/10) — re-derived: FIB Wave 2 B1 closure left 64
  // units; this batch adds three Drizzle migrations (0053_fib_proxy_versions_
  // provenance.sql, 0054_fib_proxy_rubric_constraints.sql, no DML;
  // 0055_fib_proxy_material_change_registry.sql, one literal-row-source
  // seed INSERT — mirroring 0040_governed_model_registry.sql's own
  // treatment). 64+3=67.
  it('measures the corpus rather than restating the manifest', () => {
    // W2-B2-R1 (R-B2-03): + 0056 (two literal global-catalog seeds) = 68 units,
    // 4 literal row sources (0040:1, 0055:1, 0056:2).
    // (R-B2-07): + policies unit 010 (registry RLS) = 69.
    // COMMERCIAL-V1-WAVE2-RECONCILIATION-R1 (HPO-ODS-W2-08) — re-derived on the
    // reconciled corpus: + 0057/0058/0059 (W2-B3) = 72; + 0060 (W2-B3
    // completeness) = 73. The Product line added no unit. DML units and the
    // four literal row sources are unchanged from the W2-B2-R1 derivation
    // (0057..0060 carry no DML), re-measured by tests/hosted/baseline-manifest.test.ts.
    // HPO-ODS-W2-09 (COMMERCIAL-V1-WAVE2-RECONCILIATION successor remediation):
    // + 0061_fib_disposition_governance_function_execute_revocation.sql (the
    // B0-17 security successor to sealed 0060, REVOKE-only, no DML) = 74; still no DML, still four literal row sources.
    // HPO-ODS-W2-12 (W2-B4 assumptions and causality): + 0062/0063 (FIBIU-15/14,
    // both RLS-only, no superuser dependency, no DML) = 76.
    expect(evidence.unitCount).toBe(76)
    expect(evidence.superuserFreeUnits).toBe(76)
    expect(evidence.serviceRoleGranters).toEqual(['0033_public_api_grants.sql'])
    expect(evidence.dmlUnits).toEqual([
      '0018_redundant_firebird.sql',
      '0040_governed_model_registry.sql',
      '0041_pc01b_regime_boundary_backfill.sql',
      '0047_fib_taxonomy_mapping_governance_regime.sql',
      '0048_fib_evidence_versions.sql',
      '0055_fib_proxy_material_change_registry.sql',
      '0056_fib_proxy_material_fields_editability.sql',
    ])
    expect(evidence.literalRowSources).toBe(4)
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
