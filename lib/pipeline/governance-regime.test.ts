// lib/pipeline/governance-regime.test.ts
import { describe, it, expect } from 'vitest'
import {
  GOVERNANCE_REGIME_PC01B,
  GOVERNANCE_REGIME_PRE_PC01B,
  currentGovernanceRegime,
} from './governance-regime'

describe('governance regime vocabulary', () => {
  it('matches the frozen FIBDB-042 vocabulary exactly', () => {
    expect(GOVERNANCE_REGIME_PC01B).toBe('pc01b')
    expect(GOVERNANCE_REGIME_PRE_PC01B).toBe('pre_pc01b')
  })
})

describe('currentGovernanceRegime', () => {
  it('always stamps pc01b for a newly created governed object', () => {
    expect(currentGovernanceRegime()).toBe('pc01b')
    expect(currentGovernanceRegime()).toBe(GOVERNANCE_REGIME_PC01B)
  })

  it('never returns the legacy regime — there is no path back across the boundary', () => {
    expect(currentGovernanceRegime()).not.toBe(GOVERNANCE_REGIME_PRE_PC01B)
  })
})
