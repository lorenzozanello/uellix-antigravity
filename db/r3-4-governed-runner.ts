// db/r3-4-governed-runner.ts
//
// The closed local prepared-chain authority for MSC-07B.8 R3.4.
//
// This is intentionally a manifest, not a generic SQL package registry. A
// caller can choose only whether to display or execute this exact chain; it
// cannot name a file, supply SQL, reorder phases, or select a client identity.

export type R3_4RunnerMode = 'plan' | 'apply'
export type R3_4PhaseIdentity = 'admin' | 'migrator'

export interface R3_4LocalPhase {
  readonly id:
    | 'baseline-admin'
    | 'role-topology-admin'
    | 'decision-migrator'
    | 'role-separation-admin'
    | 'admin-bootstrap'
    | 'runtime-migrator'
  readonly identity: R3_4PhaseIdentity
  readonly file: string
  /** Only 0003 precedes the ownership reconciliation, so its own SQL check is authoritative. */
  readonly verifyOwnershipAfterApply: boolean
}

export const R3_4_LOCAL_PHASES: readonly R3_4LocalPhase[] = Object.freeze([
  {
    id: 'baseline-admin',
    identity: 'admin',
    file: 'stella_0002_interactions_hardening.sql',
    verifyOwnershipAfterApply: false,
  },
  {
    id: 'baseline-admin',
    identity: 'admin',
    file: 'stella_0002b_append_only_truncate_hardening.sql',
    verifyOwnershipAfterApply: false,
  },
  {
    id: 'role-topology-admin',
    identity: 'admin',
    file: 'stella_0001_role_topology_bootstrap.sql',
    verifyOwnershipAfterApply: false,
  },
  {
    id: 'decision-migrator',
    identity: 'migrator',
    file: 'stella_0003_suggestion_decisions.sql',
    verifyOwnershipAfterApply: false,
  },
  {
    id: 'role-separation-admin',
    identity: 'admin',
    file: 'stella_0004_role_separation.sql',
    verifyOwnershipAfterApply: true,
  },
  {
    id: 'admin-bootstrap',
    identity: 'admin',
    file: 'stella_0005b_admin_bootstrap.sql',
    verifyOwnershipAfterApply: true,
  },
  {
    id: 'runtime-migrator',
    identity: 'migrator',
    file: 'stella_0005_runtime_cutover.sql',
    verifyOwnershipAfterApply: true,
  },
  {
    id: 'runtime-migrator',
    identity: 'migrator',
    file: 'stella_0005c_runtime_policy_scope.sql',
    verifyOwnershipAfterApply: true,
  },
])

/** Parse the deliberately tiny command surface of the R3.4 local runner. */
export function parseR3_4RunnerMode(args: readonly string[]): R3_4RunnerMode {
  if (args.length !== 1) {
    throw new Error(
      'The R3.4 governed runner does not accept SQL filenames, SQL text, or extra arguments. ' +
        'Use exactly one mode: apply or plan.'
    )
  }

  const [mode] = args
  if (mode === 'apply' || mode === 'plan') return mode

  throw new Error('The R3.4 governed runner only accepts apply or plan.')
}
