// scripts/custody/d1-delivery-matrix.ts
//
// EVERY DELIVERY OF THE D-1 AUDITOR CREDENTIAL BEFORE THE FINAL WITNESS, AND
// EVERY SURFACE THAT WILL HOLD IT — DERIVED, NOT LISTED.
//
// DELIVERIES. A delivery is one process receiving the value by the N05 path
// (OD-2; N23.ONLY_THIS_PROCESS: "A second consuming process ... requires its
// OWN delivery"; DAG v1.0.4 HOSTED_SQL_SESSION_DELIVERY_RULE). They are derived
// from the DAG itself:
//
//   - every HOSTED_SQL node whose act is a SESSION as uellix_auditor. A
//     HOSTED_SQL node whose act is a role or privilege MUTATION (ALTER ROLE,
//     GRANT) is executed by a privileged identity, not by the auditor, and is
//     not a delivery of this credential;
//   - N23, the delivery to the PRECHECK process;
//   - the FINAL WITNESS, named by N28's precondition and by the capability
//     authority's REMOVAL_AFTER_USE ("after PRECHECK-R2 and again after the
//     FINAL WITNESS").
//
// SURFACES. What will hold the value follows from the production topology the
// post-mint path built: the operator's ephemeral mint tool, the target's
// backend during the credential-set transaction, the N30 depositor, the WCM
// store, the bridge, one launcher per delivery, and one consumer environment
// per delivery. The custody inventory's processes_or_environments must list
// exactly these; N06 checks it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DAG_V100 = 'docs/ops/release/FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.0.json'

export type DeliveryId = 'DL-N13' | 'DL-N14' | 'DL-N21' | 'DL-N22' | 'DL-N23' | 'DL-FINAL-WITNESS'

export interface Delivery {
  readonly id: DeliveryId
  readonly node: string
  readonly conditional: boolean
  /** The built consumer entry in this repository, or null when another lane owns it. */
  readonly consumerEntry: string | null
  readonly consumerArgs: readonly string[]
  readonly ownedBy: 'THIS_DAG' | 'CV1-D1-OLDDB-PRECHECK-EXEC-R2 (N27)' | 'MACRO_CHAIN_NODE_9 (outside this DAG)'
  readonly why: string
  readonly cleanupBoundary: string
}

/** The consumer registered for each in-DAG session node. A derived node with no entry here is a gap. */
const IN_DAG_CONSUMERS: Readonly<Record<string, { entry: string; args: readonly string[]; why: string }>> = {
  N13: { entry: 'scripts/custody/d1-auditor-n13-consumer.ts', args: [], why: 'KP-1, KP-2, target identity arm B; N11 closure (v1.0.4 EXIT_SPLIT_N11)' },
  N14: { entry: 'scripts/custody/d1-auditor-n14-consumer.ts', args: [], why: 'P1 prestate observation (KP-3..KP-6 and every other prestate)' },
  N21: { entry: 'scripts/custody/d1-auditor-n22-consumer.ts', args: ['--node=N21'], why: 'MR-3 poststate: USAGE true, CREATE false, EXECUTE false' },
  N22: { entry: 'scripts/custody/d1-auditor-n22-consumer.ts', args: [], why: 'P3 poststate PV-1..PV-34 and READ_ONLY_PROOF' },
}

interface DagNode {
  readonly id: string
  readonly plane?: string
  readonly act?: string
}

const MUTATION_ACT = /^(ALTER ROLE|GRANT|REVOKE)\b/

/** The in-DAG session nodes, by the rule above, from the DAG's own node list. */
export function deriveSessionNodes(repoRoot: string): { sessions: string[]; excludedMutations: string[] } {
  const dag = JSON.parse(readFileSync(join(repoRoot, DAG_V100), 'utf8')) as { DAG_NODES: { nodes: DagNode[] } }
  const hosted = dag.DAG_NODES.nodes.filter((n) => n.plane === 'HOSTED_SQL')
  return {
    sessions: hosted.filter((n) => !MUTATION_ACT.test(n.act ?? '')).map((n) => n.id),
    excludedMutations: hosted.filter((n) => MUTATION_ACT.test(n.act ?? '')).map((n) => n.id),
  }
}

export function deriveDeliveries(repoRoot: string): { deliveries: Delivery[]; gaps: string[] } {
  const { sessions } = deriveSessionNodes(repoRoot)
  const gaps: string[] = []
  const deliveries: Delivery[] = []
  for (const node of sessions) {
    const c = IN_DAG_CONSUMERS[node]
    if (c === undefined) {
      gaps.push(`${node} opens a session as uellix_auditor and has no registered consumer`)
      continue
    }
    deliveries.push({
      id: `DL-${node}` as DeliveryId,
      node,
      conditional: node === 'N21',
      consumerEntry: c.entry,
      consumerArgs: c.args,
      ownedBy: 'THIS_DAG',
      why: c.why,
      cleanupBoundary: 'The consumer process exits (the N05 delivery is removed with it); the launcher zeroes its buffer and exits. The WCM entry is NOT removed here.',
    })
  }
  deliveries.push({
    id: 'DL-N23',
    node: 'N23',
    conditional: false,
    consumerEntry: null,
    consumerArgs: [],
    ownedBy: 'CV1-D1-OLDDB-PRECHECK-EXEC-R2 (N27)',
    why: 'PRECHECK_OLD_DB, the parent authority\'s SQ-1..SQ-8 observation (PRECHECK_R2_ENTRY_CONTRACT: this DAG does not derive its contents)',
    cleanupBoundary: 'N24: remove immediately after the consuming process exits, then a POSITIVE absence check recorded as a boolean.',
  })
  deliveries.push({
    id: 'DL-FINAL-WITNESS',
    node: 'FINAL WITNESS',
    conditional: false,
    consumerEntry: null,
    consumerArgs: [],
    ownedBy: 'MACRO_CHAIN_NODE_9 (outside this DAG)',
    why: 'D1_OLD_DB_FINAL_WITNESS, the one observation citable as D1-8 (parent PRE_DEPLOYMENT_OBSERVATION)',
    cleanupBoundary: 'N28: mandatory rotation after the witness, removal of the delivered value with positive absence verification, and custody closure.',
  })
  return { deliveries, gaps }
}

export type SurfaceId =
  | 'MINT_OPERATOR_TRANSIENT_SURFACE'
  | 'TARGET_BACKEND_TRANSACTION_GUC'
  | 'N30_DEPOSITOR_TRANSIENT_SURFACE'
  | 'WCM_PERSISTENT_STORE'
  | 'BRIDGE_TRANSIENT_SURFACE'
  | 'N05_LAUNCHER_SURFACE'
  | 'CONSUMER_ENVIRONMENT_PER_DELIVERY'

export interface Surface {
  readonly surface: SurfaceId
  readonly kind: string
  readonly holds_the_value: string
  readonly lifetime: string
  readonly basis: string
  readonly entry_key_recorded_here?: false
  readonly why_no_entry_key?: string
  readonly deliveries?: readonly { delivery: DeliveryId; node: string; conditional: boolean; consumer: string; owned_by: string; cleanup_boundary: string }[]
}

export function deriveCustodySurfaces(repoRoot: string): Surface[] {
  const { deliveries } = deriveDeliveries(repoRoot)
  return [
    {
      surface: 'MINT_OPERATOR_TRANSIENT_SURFACE',
      kind: 'TRANSIENT_PROCESS_OUTSIDE_THE_REPOSITORY',
      holds_the_value:
        'The ephemeral Node mint tool (owner decision D1_MINT_OPERATOR_TOOL), for one run: it generates the value, binds it as a set_config parameter, composes the auditor DSN and writes it to the N30 depositor stdin, as JavaScript strings that are not zeroable. Its environment also holds the operator\'s privileged connection material until it removes it.',
      lifetime: 'One mint run (N11 act through N30 handoff).',
      basis: 'ROUTE_B_CONTRACT (db/custody/mint-route-b-contract.ts), measured on a fake-only fixture by scripts/custody/d1-mint-tool-contract-harness.ts.',
    },
    {
      surface: 'TARGET_BACKEND_TRANSACTION_GUC',
      kind: 'REMOTE_SERVER_TRANSIENT',
      holds_the_value:
        'The target\'s backend for the operator\'s session holds the value as the transaction-local GUC uellix.rotating_password (set_config is_local true) between SET_PASSWORD and COMMIT or ROLLBACK; the server then keeps only its password verifier.',
      lifetime: 'One transaction.',
      basis: 'The set_config bound-parameter pattern (SECRET_GENERATION_CONTRACT.WHERE_THE_PASSWORD_MUST_NOT_TRAVEL) as pinned by ROUTE_B_STATEMENTS.',
    },
    {
      surface: 'N30_DEPOSITOR_TRANSIENT_SURFACE',
      kind: 'TRANSIENT_PROCESS',
      holds_the_value: 'The built d1-n30-deposit.js under bare node: the value arrives on its stdin pipe and is held as a Buffer, zeroed after the deposit; the DSN-shape check reads bytes only.',
      lifetime: 'One deposit.',
      basis: 'PRODUCTION_DEPOSITOR, demonstrated on a synthetic value (post-mint path record).',
    },
    {
      surface: 'WCM_PERSISTENT_STORE',
      kind: 'CUSTODY_STORE',
      holds_the_value: 'At rest, DPAPI-protected, CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE, in the human custodian\'s Windows user profile, in exactly one entry outside every sweepable namespace.',
      lifetime: 'From the N30 deposit until the governed removal (N24 for a re-rotated value, N28 at closure, or a post-mint compensation). It survives an abrupt kill of any process by design.',
      basis: 'CERTIFIED_MECHANISM_SURFACE (N05).',
      entry_key_recorded_here: false,
      why_no_entry_key: 'OF-DAG-6: a vault entry key or lookup token is never recorded in the inventory or any evidence artifact.',
    },
    {
      surface: 'BRIDGE_TRANSIENT_SURFACE',
      kind: 'TRANSIENT_PROCESS',
      holds_the_value: 'powershell.exe running the fixed bridge for ONE deposit or ONE retrieval: .NET strings and zeroed-then-freed unmanaged buffers; environment is an allowlist; the value crosses only its stdin/stdout pipes.',
      lifetime: 'One call.',
      basis: 'CERTIFIED_MECHANISM_SURFACE (N05).',
    },
    {
      surface: 'N05_LAUNCHER_SURFACE',
      kind: 'PROCESS_HEAP_RESIDUAL',
      holds_the_value: 'The built d1-deliver-n13.js, one run per delivery: after reading the entry its heap holds the one environment string spawn requires and the strings Node/libuv derive from it; NOT zeroed (OF-CUST-1). It never carries the value in its own environment block.',
      lifetime: 'One delivery. Short-lived, from a console, under bare node.',
      basis: 'CERTIFIED_MECHANISM_SURFACE (N05), re-demonstrated per consumer topology by this lane.',
    },
    {
      surface: 'CONSUMER_ENVIRONMENT_PER_DELIVERY',
      kind: 'PROCESS_ENVIRONMENT_BLOCK',
      holds_the_value: 'UELLIX_AUDITOR_DATABASE_URL in the environment block of exactly ONE consuming process per delivery, created at CreateProcess, sharing the launcher\'s console, inside its kill-on-close job, with no descendant.',
      lifetime: 'The consumer\'s lifetime; destroyed by the OS at exit, including on kill.',
      basis: 'One entry per delivery below; in-DAG consumers demonstrated on synthetic values, external consumers carried with their owning lane.',
      deliveries: deliveries.map((d) => ({
        delivery: d.id,
        node: d.node,
        conditional: d.conditional,
        consumer: d.consumerEntry === null ? 'EXTERNAL (built and re-demonstrated by its owning lane before it holds a real value)' : `${d.consumerEntry}${d.consumerArgs.length > 0 ? ` ${d.consumerArgs.join(' ')}` : ''}`,
        owned_by: d.ownedBy,
        cleanup_boundary: d.cleanupBoundary,
      })),
    },
  ]
}

/** What the inventory must list: every surface id, and every delivery id under the consumer surface. */
export function checkInventorySurfaces(repoRoot: string, listed: unknown): string[] {
  const reasons: string[] = []
  if (!Array.isArray(listed)) return ['processes_or_environments is not a list']
  const derived = deriveCustodySurfaces(repoRoot)
  const byId = new Map((listed as Array<Record<string, unknown>>).map((s) => [String(s.surface), s]))
  for (const s of derived) {
    const got = byId.get(s.surface)
    if (got === undefined) {
      reasons.push(`processes_or_environments omits surface ${s.surface}`)
      continue
    }
    if (s.deliveries !== undefined) {
      const gotDeliveries = new Set(((got.deliveries as Array<Record<string, unknown>> | undefined) ?? []).map((d) => String(d.delivery)))
      for (const d of s.deliveries) if (!gotDeliveries.has(d.delivery)) reasons.push(`processes_or_environments omits delivery ${d.delivery} (${d.node})`)
    }
  }
  for (const id of byId.keys()) if (!derived.some((s) => s.surface === id)) reasons.push(`processes_or_environments lists ${id}, which the production topology does not have`)
  return reasons
}
