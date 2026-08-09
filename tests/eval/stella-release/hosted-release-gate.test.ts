// tests/eval/stella-release/hosted-release-gate.test.ts
// TRAIN 5B — Phase 13.
//
// Seven gates, and one prohibition that outranks all seven: none of them may
// ever assert that staging was applied, that hosted is ready, or that the
// provider is ready. Those three are facts about the world, and this module
// only sees the repository.

import { describe, expect, it } from 'vitest'
import {
  HOSTED_GATE_IDS,
  buildHostedGateEvidence,
  computeHostedGateReport,
} from './hosted-release-gate'

const REAL = buildHostedGateEvidence()

describe('the seven gates', () => {
  it('is exactly the set Phase 13 names, in a fixed order', () => {
    expect([...HOSTED_GATE_IDS]).toEqual([
      'hosted-capability-preflight-ready',
      'managed-role-bootstrap-ready',
      'hosted-package-manifest-ready',
      'hosted-package-order-ready',
      'staging-target-identity-ready',
      'hosted-migrator-dry-run-ready',
      'r6h-audit-ready',
    ])
  })

  it('all seven pass on the real repository', () => {
    const report = computeHostedGateReport(REAL)
    const failed = report.gates.filter((g) => !g.passed)

    expect(failed.map((g) => `${g.id}: ${g.detail}`)).toEqual([])
  })

  it('every gate carries a detail an operator can act on', () => {
    for (const gate of computeHostedGateReport(REAL).gates) {
      expect(gate.detail.length).toBeGreaterThan(20)
    }
  })
})

describe('the three things no gate may ever declare', () => {
  it('reports stagingApplied=false, hostedReady=false, providerReady=false — unconditionally', () => {
    const report = computeHostedGateReport(REAL)

    expect(report.stagingApplied).toBe(false)
    expect(report.hostedReady).toBe(false)
    expect(report.providerReady).toBe(false)
  })

  it('keeps them false even with every gate passing and every optional field maximal', () => {
    const report = computeHostedGateReport({
      ...REAL,
      artefactsVerified: true,
      bootstrapRefusesSuperuser: true,
    })

    expect(report.stagingApplied).toBe(false)
    expect(report.hostedReady).toBe(false)
    expect(report.providerReady).toBe(false)
  })

  it('enumerates what is still missing for hosted, naming the remote inspection', () => {
    const report = computeHostedGateReport(REAL)

    expect(report.missingForHosted.join(' | ')).toMatch(/read-only/i)
    expect(report.missingForHosted.some((m) => m.includes('provision'))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Negative controls — a gate that cannot fail is not a gate                   */
/* -------------------------------------------------------------------------- */

describe('negative controls', () => {
  function gate(id: string, evidence = REAL) {
    const found = computeHostedGateReport(evidence).gates.find((g) => g.id === id)
    if (!found) throw new Error(`no gate ${id}`)
    return found
  }

  it('hosted-capability-preflight-ready FAILS if the shim check reverts to the bare search_path spelling', () => {
    // The BLOCKER adversarial review A found: PostgreSQL stores
    // `SET search_path = ''` as `search_path=""`, so a bare-form-only predicate
    // is always true and the package aborts on every apply.
    const evidence = { ...REAL, bootstrapSql: REAL.bootstrapSql.replaceAll("search_path=\"\"", 'search_path=') }
    expect(gate('hosted-capability-preflight-ready', evidence).passed).toBe(false)
  })

  it('hosted-capability-preflight-ready FAILS if the owner check reverts from SET to MEMBER', () => {
    const evidence = {
      ...REAL,
      bootstrapSql: REAL.bootstrapSql.replaceAll("'uellix_owner', 'SET'", "'uellix_owner', 'MEMBER'"),
    }
    expect(gate('hosted-capability-preflight-ready', evidence).passed).toBe(false)
  })

  it('hosted-capability-preflight-ready FAILS if the ledger ownership transfer is removed', () => {
    const evidence = {
      ...REAL,
      bootstrapSql: REAL.bootstrapSql.replaceAll(
        'ALTER TABLE public.stella_interactions OWNER TO uellix_owner',
        '-- removed',
      ),
    }
    expect(gate('hosted-capability-preflight-ready', evidence).passed).toBe(false)
  })

  it('hosted-capability-preflight-ready FAILS if the bootstrap stops probing a capability', () => {
    const evidence = {
      ...REAL,
      bootstrapSql: REAL.bootstrapSql.replaceAll('rolcreaterole', 'rolcanlogin'),
    }
    expect(gate('hosted-capability-preflight-ready', evidence).passed).toBe(false)
  })

  it('managed-role-bootstrap-ready TOLERATES the word SUPERUSER in prose — it refuses STATEMENTS', () => {
    const evidence = {
      ...REAL,
      bootstrapSql: `${REAL.bootstrapSql}\n-- a comment mentioning SUPERUSER and BYPASSRLS and service_role\n`,
    }
    expect(gate('managed-role-bootstrap-ready', evidence).passed).toBe(true)
  })

  it('managed-role-bootstrap-ready tolerates a comment QUOTING a GRANT ... TO service_role', () => {
    // S1-DEFECT-002 documents the mechanism that caused it: managed Supabase
    // carries `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon,
    // authenticated, service_role`. Writing that sentence down is how the next
    // reader avoids re-diagnosing PUBLIC for an afternoon — and it made this
    // gate refuse the package, because the rule matched the whole file instead
    // of its statements. The gate's own comment already claimed prose was safe.
    const evidence = {
      ...REAL,
      bootstrapSql:
        `${REAL.bootstrapSql}\n` +
        '-- Supabase carries ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS\n' +
        '-- TO anon, authenticated, service_role, which is why the REVOKEs name them.\n',
    }
    expect(gate('managed-role-bootstrap-ready', evidence).passed).toBe(true)
  })

  it('managed-role-bootstrap-ready still FAILS on a real GRANT ... TO service_role', () => {
    // The positive control for the test above. Tolerating prose must not cost
    // the rule its teeth.
    const evidence = {
      ...REAL,
      bootstrapSql: `${REAL.bootstrapSql}\nGRANT EXECUTE ON FUNCTION public.uellix_auth_uid() TO service_role;\n`,
    }
    expect(gate('managed-role-bootstrap-ready', evidence).passed).toBe(false)
  })

  it('managed-role-bootstrap-ready FAILS if a CREATE ROLE statement grants CREATEROLE', () => {
    const evidence = {
      ...REAL,
      bootstrapSql: `${REAL.bootstrapSql}\nCREATE ROLE uellix_sneaky WITH NOLOGIN CREATEROLE;\n`,
    }
    expect(gate('managed-role-bootstrap-ready', evidence).passed).toBe(false)
  })

  it('managed-role-bootstrap-ready FAILS if the bootstrap would grant BYPASSRLS', () => {
    const evidence = { ...REAL, bootstrapSql: REAL.bootstrapSql.replace(/NOBYPASSRLS/g, 'BYPASSRLS') }
    expect(gate('managed-role-bootstrap-ready', evidence).passed).toBe(false)
  })

  it('managed-role-bootstrap-ready FAILS if the bootstrap mentions service_role as a grantee', () => {
    const evidence = {
      ...REAL,
      bootstrapSql: `${REAL.bootstrapSql}\nGRANT USAGE ON SCHEMA uellix_bootstrap TO service_role;\n`,
    }
    expect(gate('managed-role-bootstrap-ready', evidence).passed).toBe(false)
  })

  it('managed-role-bootstrap-ready FAILS if the bootstrap stops refusing a superuser installer', () => {
    const evidence = {
      ...REAL,
      bootstrapSql: REAL.bootstrapSql.replace(
        'IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN',
        'IF false THEN',
      ),
    }
    expect(gate('managed-role-bootstrap-ready', evidence).passed).toBe(false)
  })

  it('hosted-package-manifest-ready FAILS when an artefact diverges from its source', () => {
    expect(gate('hosted-package-manifest-ready', { ...REAL, artefactsVerified: false }).passed).toBe(
      false,
    )
  })

  it('hosted-package-order-ready FAILS when a supersession rule disappears', () => {
    expect(gate('hosted-package-order-ready', { ...REAL, supersessionRuleCount: 7 }).passed).toBe(
      false,
    )
  })

  it('staging-target-identity-ready FAILS when a production host stops being refused', () => {
    expect(
      gate('staging-target-identity-ready', { ...REAL, productionHostRefused: false }).passed,
    ).toBe(false)
  })

  it('staging-target-identity-ready FAILS when a missing sentinel stops being refused', () => {
    expect(gate('staging-target-identity-ready', { ...REAL, sentinelMissingRefused: false }).passed).toBe(
      false,
    )
  })

  // The pooler half of the contract, in BOTH directions. Failing only the first
  // of these would let the gate be satisfied by a planner that refuses the
  // pooler outright — which is exactly the state an audit found and refuted.
  it('staging-target-identity-ready FAILS when the session pooler stops being plannable at all', () => {
    expect(
      gate('staging-target-identity-ready', { ...REAL, poolerAcceptedWithLoginRole: false }).passed,
    ).toBe(false)
  })

  it('staging-target-identity-ready FAILS when a pooler host is accepted without its login role', () => {
    expect(
      gate('staging-target-identity-ready', { ...REAL, poolerRefusedWithoutLoginRole: false }).passed,
    ).toBe(false)
  })

  it('staging-target-identity-ready FAILS when the transaction pooler stops being refused', () => {
    expect(
      gate('staging-target-identity-ready', { ...REAL, poolerTransactionPortRefused: false }).passed,
    ).toBe(false)
  })

  it('hosted-migrator-dry-run-ready FAILS when a dry run reports writes permitted', () => {
    expect(
      gate('hosted-migrator-dry-run-ready', { ...REAL, dryRunPermitsWrites: true }).passed,
    ).toBe(false)
  })

  it('hosted-migrator-dry-run-ready FAILS when the plan does not cover all ten packages', () => {
    expect(gate('hosted-migrator-dry-run-ready', { ...REAL, dryRunStepCount: 9 }).passed).toBe(false)
  })

  it('r6h-audit-ready FAILS if the plan ever emits VALIDATE CONSTRAINT', () => {
    expect(gate('r6h-audit-ready', { ...REAL, r6hValidateConstraintAbsent: false }).passed).toBe(
      false,
    )
  })

  it('r6h-audit-ready FAILS if the generated stella_0017 no longer keeps the CHECK NOT VALID', () => {
    expect(gate('r6h-audit-ready', { ...REAL, r6hCheckStaysNotValid: false }).passed).toBe(false)
  })
})

describe('the evidence builder is not a rubber stamp', () => {
  it('reads the real bootstrap, not a fixture', () => {
    expect(REAL.bootstrapSql).toContain('stella_hosted_0001')
    expect(REAL.bootstrapSql.length).toBeGreaterThan(5000)
  })

  it('actually ran a dry run — the step count comes from the planner', () => {
    expect(REAL.dryRunStepCount).toBe(10)
    expect(REAL.dryRunPermitsWrites).toBe(false)
  })
})
