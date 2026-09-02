// lib/pipeline/governance-regime.ts
// FIBIU-01 — single authoritative regime-stamping mechanism (FIBC-004 /
// FIBDB-003). Every governed-object creation path stamps through this module
// instead of inlining the literal, so the PC-01B boundary can never drift
// across call sites.

export const GOVERNANCE_REGIME_PC01B = 'pc01b' as const
export const GOVERNANCE_REGIME_PRE_PC01B = 'pre_pc01b' as const

export type GovernanceRegime = typeof GOVERNANCE_REGIME_PC01B | typeof GOVERNANCE_REGIME_PRE_PC01B

/** The regime every governed object created from this point forward receives. */
export function currentGovernanceRegime(): GovernanceRegime {
  return GOVERNANCE_REGIME_PC01B
}
