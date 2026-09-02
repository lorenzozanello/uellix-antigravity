// tests/hosted/baseline-recovery.test.ts
// TRAIN 5C0 — Phase 11. The recovery table, exercised rather than read.
//
// A recovery plan written as prose is a plan whose worst branch nobody has ever
// evaluated. These tests walk the branches, and the invariant they enforce is
// directional: as the situation gets LESS certain, the answer must get MORE
// conservative. A table that answers "indeterminate" with "retry" would pass a
// prose review and fail here.

import { describe, expect, it } from 'vitest'

import { BASELINE_ORDER, baselineUnit } from '@/db/hosted/baseline-manifest'
import { decideRecovery, type RecoverySituation } from '@/db/hosted/baseline-recovery'

const base: RecoverySituation = {
  phase: 'PHASE_BASELINE',
  failedUnit: '0018_redundant_firebird.sql',
  failureKind: 'statement-error',
  singleTransaction: true,
  manualWritesOccurred: false,
  holdsIrreplaceableData: false,
}

const at = (overrides: Partial<RecoverySituation>) => decideRecovery({ ...base, ...overrides })

describe('the premises the table rests on are still true of the corpus', () => {
  it('the baseline has no rollback scripts, so ROLLBACK_SQL is unreachable from a baseline failure', () => {
    for (const id of BASELINE_ORDER) {
      const decision = at({ phase: 'PHASE_BASELINE', failedUnit: id })
      expect(decision.strategy, id).not.toBe('ROLLBACK_SQL')
    }
  })

  it('most of the chain cannot be re-applied, which is why resuming is not offered', () => {
    const reapplyable = BASELINE_ORDER.filter((id) => baselineUnit(id).reapply === 'idempotent')
    expect(reapplyable.length).toBeLessThan(BASELINE_ORDER.length / 2)
    // RESUME_AT_NEXT_UNIT is declared but must never be the answer to a baseline
    // statement error — the units BEFORE the failure are what make it unsafe.
    for (const id of BASELINE_ORDER) {
      expect(at({ failedUnit: id }).strategy).not.toBe('RESUME_AT_NEXT_UNIT')
    }
  })
})

describe('PHASE_BASELINE', () => {
  it('a failure on unit 1 is retried: the target is still virgin', () => {
    const d = at({ failedUnit: BASELINE_ORDER[0] })
    expect(d.strategy).toBe('RETRY_UNIT')
    expect(d.rationale).toContain('unit 1')
  })

  it('a failure anywhere after unit 1 destroys and reprovisions', () => {
    for (const id of BASELINE_ORDER.slice(1)) {
      expect(at({ failedUnit: id }).strategy, id).toBe('DESTROY_AND_REPROVISION')
    }
  })

  it('destroys the PROJECT, not the schema — and says why', () => {
    const d = at({ failedUnit: '0031_rls_core.sql' })
    expect(d.steps.join(' ')).toMatch(/Delete the Supabase project\. Not the schemas/)
    expect(d.steps.join(' ')).toMatch(/roles, extensions, grants and default privileges/)
  })

  it('names the failed unit and its position, so the log says where it stopped', () => {
    const d = at({ failedUnit: '0033_public_api_grants.sql' })
    expect(d.rationale).toContain('0033_public_api_grants.sql')
    expect(d.rationale).toContain(`of ${BASELINE_ORDER.length}`)
  })

  it('an unknown unit id halts rather than guessing', () => {
    const d = at({ failedUnit: '9999_not_a_unit.sql' })
    expect(d.strategy).toBe('HALT_AND_ESCALATE')
  })
})

describe('the uncertainty gradient', () => {
  it('no single transaction means no reasoning at all', () => {
    const d = at({ singleTransaction: false })
    expect(d.strategy).toBe('HALT_AND_ESCALATE')
    expect(d.rationale).toContain('psql -1')
  })

  it('an indeterminate outcome reprovisions rather than retrying', () => {
    // The dangerous alternative is a retry that turns out to be a SECOND
    // application of a unit that did land.
    expect(at({ failureKind: 'indeterminate' }).strategy).toBe('DESTROY_AND_REPROVISION')
    expect(at({ failureKind: 'indeterminate', failedUnit: BASELINE_ORDER[0] }).strategy).toBe(
      'DESTROY_AND_REPROVISION',
    )
  })

  it('a transport failure retries, because no SQL reached the server', () => {
    const d = at({ failureKind: 'transport', failedUnit: '0025_shallow_mattie_franklin.sql' })
    expect(d.strategy).toBe('RETRY_UNIT')
    // …but only after re-probing, because a transport error during COMMIT looks
    // identical to one before it.
    expect(d.steps[0]).toMatch(/Re-probe/)
    expect(d.steps.join(' ')).toMatch(/resume at the NEXT unit/)
  })

  it('irreplaceable data outranks everything, including the cheap-destroy argument', () => {
    for (const kind of ['statement-error', 'transport', 'indeterminate'] as const) {
      const d = at({ failureKind: kind, holdsIrreplaceableData: true })
      expect(d.strategy, kind).toBe('HALT_AND_ESCALATE')
    }
  })

  it('every decision states the conditions under which it is wrong', () => {
    const situations: Partial<RecoverySituation>[] = [
      {},
      { failureKind: 'transport' },
      { failureKind: 'indeterminate' },
      { singleTransaction: false },
      { holdsIrreplaceableData: true },
      { phase: 'PHASE_MANAGED_ROLE_IDENTITIES', failedUnit: 'stella_hosted_0000_managed_role_identity_bootstrap' },
      { phase: 'PHASE_STELLA_BOOTSTRAP', failedUnit: 'stella_hosted_0001_managed_role_bootstrap' },
      { phase: 'PHASE_STELLA_CHAIN', failedUnit: 'stella_0016_reserved_quota_semantics' },
    ]
    for (const s of situations) {
      const d = at(s)
      expect(d.rationale.length, JSON.stringify(s)).toBeGreaterThan(60)
      expect(d.steps.length, JSON.stringify(s)).toBeGreaterThan(0)
      expect(Array.isArray(d.revisitIf), JSON.stringify(s)).toBe(true)
    }
  })
})

describe('the Stella phases answer differently, and for a stated reason', () => {
  it('HPO-ODS-W2-03: an identity-package failure retries — §0 refuses before any CREATE ROLE and roles are cluster-scoped', () => {
    const d = at({ phase: 'PHASE_MANAGED_ROLE_IDENTITIES', failedUnit: 'stella_hosted_0000_managed_role_identity_bootstrap' })
    expect(d.strategy).toBe('RETRY_UNIT')
    expect(d.steps.join(' ')).toContain("rolname LIKE 'uellix\\_%'")
    expect(d.steps.join(' ')).toContain('stella_hosted_0000_managed_role_identity_bootstrap.sql')
    expect(d.revisitIf.join(' ')).toContain('DESTROY_AND_REPROVISION')
  })

  it('a bootstrap failure reprovisions: its rollback refuses while the chain is installed', () => {
    const d = at({ phase: 'PHASE_STELLA_BOOTSTRAP', failedUnit: 'stella_hosted_0001_managed_role_bootstrap' })
    expect(d.strategy).toBe('DESTROY_AND_REPROVISION')
    expect(d.revisitIf.join(' ')).toContain('idempotent and convergent')
  })

  it('a chain failure uses the rollback the package actually has', () => {
    const d = at({ phase: 'PHASE_STELLA_CHAIN', failedUnit: 'stella_0013_grounded_query_quota' })
    expect(d.strategy).toBe('ROLLBACK_SQL')
    // The refusals those rollbacks encode are information, and the plan says so.
    expect(d.rationale).toContain('refuse rather than degrade')
    expect(d.steps.join(' ')).toContain('db/prepared/')
  })

  it('a chain rollback that itself fails returns to the conservative answer', () => {
    const d = at({ phase: 'PHASE_STELLA_CHAIN', failedUnit: 'stella_0017_governed_stella_consumption' })
    expect(d.revisitIf.join(' ')).toContain('DESTROY_AND_REPROVISION')
  })

  it('a package that is not in the chain halts', () => {
    const d = at({ phase: 'PHASE_STELLA_CHAIN', failedUnit: 'stella_0004_role_separation' })
    expect(d.strategy).toBe('HALT_AND_ESCALATE')
  })
})
