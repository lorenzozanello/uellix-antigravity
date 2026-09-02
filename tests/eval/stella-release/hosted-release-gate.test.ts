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
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'

const REAL = buildHostedGateEvidence()

// HPO-ODS-W2-05. Shared by the negative controls above and the dedicated
// P/N/M block below — one definition, so the two never drift into scanning
// role statements two different ways.
const ROLE_STATEMENT = /\b(CREATE|ALTER)\s+ROLE\b[^;]*/gi
const executable = (sql: string) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')

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
      // HPO-ODS-W2-05: the same tolerance must hold on the identity source,
      // which is where the real statements — and therefore the real risk of a
      // false positive from prose — now live.
      roleIdentitySql: `${REAL.roleIdentitySql}\n-- a comment mentioning SUPERUSER and BYPASSRLS and service_role\n`,
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

  it('managed-role-bootstrap-ready FAILS if a CREATE ROLE statement on the identity source grants CREATEROLE', () => {
    // HPO-ODS-W2-05: the sneaky statement has to land on the IDENTITY source
    // (0000) to exercise the CREATEROLE-per-statement scan at all — that scan
    // no longer reads bootstrapSql (0001).
    const evidence = {
      ...REAL,
      roleIdentitySql: `${REAL.roleIdentitySql}\nCREATE ROLE uellix_sneaky WITH NOLOGIN CREATEROLE;\n`,
    }
    expect(gate('managed-role-bootstrap-ready', evidence).passed).toBe(false)
  })

  it('managed-role-bootstrap-ready FAILS if the bootstrap mentions service_role as a grantee, from EITHER source', () => {
    const fromBootstrap = {
      ...REAL,
      bootstrapSql: `${REAL.bootstrapSql}\nGRANT USAGE ON SCHEMA uellix_bootstrap TO service_role;\n`,
    }
    expect(gate('managed-role-bootstrap-ready', fromBootstrap).passed).toBe(false)

    const fromIdentity = {
      ...REAL,
      roleIdentitySql: `${REAL.roleIdentitySql}\nGRANT USAGE ON SCHEMA uellix_bootstrap TO service_role;\n`,
    }
    expect(gate('managed-role-bootstrap-ready', fromIdentity).passed).toBe(false)
  })

  it('managed-role-bootstrap-ready FAILS if the identity source would grant BYPASSRLS', () => {
    // HPO-ODS-W2-05. This is the exact control that was silently vacuous: it
    // used to mutate bootstrapSql (0001), which the gate no longer scans for
    // role attributes — and its own only NOBYPASSRLS occurrence in 0001 lives
    // in a comment, so the old mutation was undetectable by construction. The
    // fix moves it to the identity source, where the real ten role statements
    // (five CREATE ROLE, five convergent ALTER ROLE) actually live.
    const evidence = { ...REAL, roleIdentitySql: REAL.roleIdentitySql.replace(/NOBYPASSRLS/g, 'BYPASSRLS') }
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

  /* P1 --------------------------------------------------------------------- */
  it('P1: the current stella_hosted_0000 + stella_hosted_0001 pair PASSES', () => {
    expect(gate('managed-role-bootstrap-ready', REAL).passed).toBe(true)
  })

  /* P2 --------------------------------------------------------------------- */
  it('P2: role-statement discovery is sourced from EXECUTABLE statements in 0000, mechanically re-derived here (not from the gate\'s own count)', () => {
    const statements = executable(REAL.roleIdentitySql).match(ROLE_STATEMENT) ?? []
    expect(statements.length).toBeGreaterThan(0)
    expect(statements).toHaveLength(10) // 5 CREATE ROLE + 5 convergent ALTER ROLE
    for (const s of statements) expect(s).toMatch(/NOBYPASSRLS/)
  })

  /* P3 --------------------------------------------------------------------- */
  it('P3: 0001 (the post-baseline bootstrap) is positively confirmed to define zero roles', () => {
    const statements = executable(REAL.bootstrapSql).match(ROLE_STATEMENT) ?? []
    expect(statements).toEqual([])
  })

  /* N1 --------------------------------------------------------------------- */
  it('N1: mutating an executable NOBYPASSRLS in 0000 to BYPASSRLS FAILS the gate', () => {
    const evidence = { ...REAL, roleIdentitySql: REAL.roleIdentitySql.replace(/NOBYPASSRLS/g, 'BYPASSRLS') }
    const result = gate('managed-role-bootstrap-ready', evidence)
    expect(result.passed).toBe(false)
    expect(result.detail).toMatch(/BYPASSRLS/)
  })

  /* N2 --------------------------------------------------------------------- */
  it('N2: removing one of the five expected CREATE ROLE statements from 0000 FAILS, naming the missing role', () => {
    const evidence = {
      ...REAL,
      roleIdentitySql: REAL.roleIdentitySql.replace(
        /CREATE ROLE uellix_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;/,
        '-- removed',
      ),
    }
    const result = gate('managed-role-bootstrap-ready', evidence)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('does not create uellix_app')
  })

  /* N3 --------------------------------------------------------------------- */
  it('N3: commenting out the real CREATE ROLE statements in 0000 FAILS, even though an identical-looking statement still exists as a comment', () => {
    // Every real statement is turned into a `-- ` line (so it is stripped by
    // the executable-line filter exactly like the historical NOBYPASSRLS
    // comment was), while the ORIGINAL uncommented text is quoted nowhere new
    // — the point is that a statement inside a comment must never be read as
    // evidence, no matter how exactly it matches what the gate wants to see.
    const commented = REAL.roleIdentitySql
      .split('\n')
      .map((line) => (ROLE_STATEMENT.test(line) ? `-- ${line}` : line))
      .join('\n')
    // Sanity: the mutation actually removed every executable role statement.
    expect(executable(commented).match(ROLE_STATEMENT) ?? []).toEqual([])
    const result = gate('managed-role-bootstrap-ready', { ...REAL, roleIdentitySql: commented })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('declares no executable CREATE/ALTER ROLE statement')
  })

  /* N4 --------------------------------------------------------------------- */
  it('N4: reintroducing an executable CREATE ROLE statement into 0001 FAILS the single-source assertion, independent of 0000', () => {
    const evidence = {
      ...REAL,
      bootstrapSql: `${REAL.bootstrapSql}\nCREATE ROLE uellix_reintroduced WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;\n`,
    }
    const result = gate('managed-role-bootstrap-ready', evidence)
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('stella_hosted_0001 contains')
    expect(result.detail).toContain('exactly one source, stella_hosted_0000')
  })

  /* M1 ----------------------------------------------------------------------
   * The regression this whole authority exists to prevent: pointing the
   * evidence builder's role-identity source back at 0001 — the pre-fix,
   * vacuous shape. If this mutation did NOT make the P1/N1/N2 controls fail,
   * those controls would be testing new plumbing instead of proving the old
   * vacuity is actually closed.
   * ------------------------------------------------------------------------- */
  it('M1: pointing roleIdentitySql back at 0001 (the pre-fix shape) reproduces the vacuity — P1 would falsely pass with corrupted evidence, N1/N2 would falsely PASS', () => {
    const vacuous = { ...REAL, roleIdentitySql: REAL.bootstrapSql }

    // The zero-statement guard (N3's own failure mode) catches the regression
    // immediately: 0001 has no role statements, so "reading identity from
    // 0001" is indistinguishable from "reading identity from nothing".
    const baseline = gate('managed-role-bootstrap-ready', vacuous)
    expect(baseline.passed).toBe(false)
    expect(baseline.detail).toContain('declares no executable CREATE/ALTER ROLE statement')

    // And with the vacuous plumbing restored, N1's own mutation (which now has
    // nothing to mutate, since roleIdentitySql has no NOBYPASSRLS statement to
    // flip) can no longer be told apart from a clean pass by its OWN reasoning
    // — it fails for the zero-statement reason instead of the BYPASSRLS
    // reason, proving the specific BYPASSRLS detection this authority exists
    // for is gone the moment the source repoint regresses.
    const n1UnderVacuity = gate('managed-role-bootstrap-ready', {
      ...vacuous,
      roleIdentitySql: vacuous.roleIdentitySql.replace(/NOBYPASSRLS/g, 'BYPASSRLS'),
    })
    expect(n1UnderVacuity.detail).not.toMatch(/role identity grants BYPASSRLS/)
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
    // The BOOTSTRAP plus the governed chain. Derived, because the number is the
    // planner's answer and not a fact about this test: M-8 made it eleven, and
    // a literal here would have to be re-typed on every growth — which is how
    // "the step count comes from the planner" quietly becomes "the step count
    // comes from whatever somebody last wrote down".
    expect(REAL.dryRunStepCount).toBe(HOSTED_CHAIN.length)
    expect(REAL.dryRunPermitsWrites).toBe(false)
  })
})
