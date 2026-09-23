// scripts/custody/d1-pre-hc1-post-mint.ts
//
// THE POST-MINT READINESS CONJUNCTS OF N10, READ FROM THE AUTHORITY AND
// EVALUATED FROM THE REPOSITORY.
//
// The PRE-HC1 evaluator reported N10 READY_FOR_HUMAN_CONFIRMATION at 3def3c5b
// although the mint route was undecided, N06 listed the old topology and two
// consumers did not exist: its readiness was N10's seven HARD predecessors and
// nothing else. DAG amendment v1.0.5 declares, as N10_PRE_HC1_READINESS_CONJUNCTS,
// the further conditions the post-mint path makes necessary. This module does
// not hard-code that list: it READS it from the amendment and evaluates each
// id with the evaluator registered for it. A missing amendment, an empty list,
// or an id with no registered evaluator is NOT_READY.
//
// Each evaluator is a pure function of a gathered input, so every negative
// control is a test that changes one input and watches the conjunct fail.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { compensationGate } from './d1-post-mint'
import { checkInventorySurfaces, deriveDeliveries, type Delivery } from './d1-delivery-matrix'
import { PRODUCTION_ENTRY_POINTS, deriveClosure } from './build-production-entrypoints'
import { CONSUMER_ENTRY } from './d1-deliver-n13'
import { AUTHORITY_CONFLICTS } from '../../db/custody/p1-reads'

export const AMENDMENT_V105 = 'docs/ops/release/FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.5.json'
export const OWNER_DECISION = 'docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_ROUTE_OWNER_DECISION_v1.0.0.json'
export const COMPLETENESS_RECORD = 'docs/ops/release/FIBDB053_D1_AUDITOR_POST_MINT_COMPLETENESS_EXECUTION_RECORD_v1.0.0.json'
export const REGISTRY = 'docs/ops/release/FIBDB053_D1_AUDITOR_CERTIFICATION_OCCURRENCE_REGISTRY_v1.0.0.json'
const INVENTORY = 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'

/** The launcher and the delivery closure every in-DAG consumer runs inside. */
const LAUNCHER = 'scripts/custody/d1-deliver-n13.ts'

export interface PostMintInputs {
  readonly conjunctIds: readonly string[] | null
  readonly ownerDecision: Readonly<Record<string, string>> | null
  readonly operatorToolFeasibility: { verdict: string; driver: string } | null
  readonly driverResolvable: boolean
  readonly inventorySurfaceReasons: readonly string[]
  readonly deliveries: readonly Delivery[]
  readonly deliveryGaps: readonly string[]
  readonly productionEntryPoints: readonly string[]
  readonly entryFilesPresent: Readonly<Record<string, boolean>>
  /** Per delivery id: the demonstration verdict and the closure blobs it was run on. */
  readonly demonstrations: Readonly<Record<string, { overall: string; closureBlobs: Record<string, string> }>>
  /** Per delivery id: the closure blobs NOW. */
  readonly currentClosureBlobs: Readonly<Record<string, Record<string, string>>>
  readonly openConflicts: readonly string[]
  readonly conflictRulings: Readonly<Record<string, string>>
  /** Blob SHAs of the package files a certification must bind to, now. */
  readonly packageBlobs: Readonly<Record<string, string>>
  /** Every (path, blob) pair a PASS occurrence in the registry certified. */
  readonly certifiedPairs: readonly string[]
}

type Evaluator = (i: PostMintInputs) => string[]

const inDag = (i: PostMintInputs): Delivery[] => i.deliveries.filter((d) => d.ownedBy === 'THIS_DAG')

/** The registered evaluator for each conjunct id the amendment may name. Each returns its failure reasons. */
export const CONJUNCT_EVALUATORS: Readonly<Record<string, Evaluator>> = {
  'PMR-1_MINT_ROUTE_RATIFIED': (i) => {
    const d = i.ownerDecision
    if (d === null) return ['no mint-route owner decision record']
    const r: string[] = []
    if (d.D1_MINT_ROUTE !== 'B_SQL_BOUND_PARAMETER') r.push(`mint route is ${String(d.D1_MINT_ROUTE)}, not the ratified B_SQL_BOUND_PARAMETER`)
    if (d.D1_MINT_OPERATOR_TOOL !== 'EPHEMERAL_NODE_PG_OUTSIDE_REPOSITORY') r.push('operator tool decision absent or different')
    if (d.SIGNED !== 'YES') r.push('owner decision not signed')
    return r
  },
  'PMR-2_OPERATOR_TOOL_FEASIBLE': (i) => {
    const r: string[] = []
    if (i.operatorToolFeasibility?.verdict !== 'FEASIBLE') r.push(`operator tool feasibility is ${String(i.operatorToolFeasibility?.verdict ?? 'unrecorded')}`)
    if (!i.driverResolvable) r.push('the measured driver no longer resolves from the repository root')
    return r
  },
  'PMR-3_PASSWORD_NULL_SEMANTICS': (i) => {
    const r: string[] = []
    if (i.ownerDecision?.D1_PASSWORD_NULL_REQUIRES_SEPARATE_HUMAN_CONFIRMATION !== 'YES') r.push('PASSWORD NULL confirmation decision absent')
    // The semantics must be the code's, not a sentence: an HC-1 must never open the PASSWORD NULL gate.
    const viaHc1 = compensationGate({ action: 'PASSWORD_NULL', confirmation: { id: 'probe-hc1', kind: 'HC-1', signed: true }, spent: [] })
    if (viaHc1.permitted) r.push('compensationGate lets an HC-1 authorize PASSWORD NULL')
    const viaSpent = compensationGate({ action: 'ROTATE_AGAIN', confirmation: { id: 'spent', kind: 'HC-1', signed: true }, spent: ['spent'] })
    if (viaSpent.permitted) r.push('compensationGate lets a spent HC-1 authorize ROTATE AGAIN')
    return r
  },
  'PMR-4_N06_REDERIVED_FOR_TOPOLOGY': (i) => [...i.inventorySurfaceReasons],
  'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED': (i) => {
    const r: string[] = [...i.deliveryGaps]
    if (inDag(i).length === 0) r.push('no in-DAG delivery was derived')
    for (const d of inDag(i)) {
      const e = d.consumerEntry!
      if (!i.entryFilesPresent[e]) r.push(`${d.id}: consumer ${e} is absent`)
      if (!i.productionEntryPoints.includes(e)) r.push(`${d.id}: consumer ${e} is not built as a production entry point`)
      if (!CONSUMER_ENTRY.test(e.replace(/\.ts$/, '.js'))) r.push(`${d.id}: the launcher does not deliver to ${e}`)
    }
    return r
  },
  'PMR-6_TOPOLOGY_DEMONSTRATED_PER_CONSUMER': (i) => {
    const r: string[] = []
    for (const d of inDag(i)) {
      const demo = i.demonstrations[d.id]
      if (demo === undefined) {
        r.push(`${d.id}: no topology demonstration recorded`)
        continue
      }
      if (demo.overall !== 'SATISFIED_CANDIDATE') r.push(`${d.id}: demonstration is ${demo.overall}`)
      const now = i.currentClosureBlobs[d.id] ?? {}
      const paths = new Set([...Object.keys(now), ...Object.keys(demo.closureBlobs)])
      if (paths.size === 0) r.push(`${d.id}: empty closure`)
      for (const p of paths) if (now[p] !== demo.closureBlobs[p]) r.push(`${d.id}: ${p} changed since it was demonstrated`)
    }
    return r
  },
  'PMR-7_NO_OPEN_AUTHORITY_CONFLICT': (i) => i.openConflicts.filter((c) => i.conflictRulings[c] === undefined).map((c) => `authority conflict ${c} is open`),
  'PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS': (i) => {
    const r: string[] = []
    if (Object.keys(i.packageBlobs).length === 0) r.push('no package files to bind')
    for (const [p, b] of Object.entries(i.packageBlobs)) if (!i.certifiedPairs.includes(`${p}@${b}`)) r.push(`${p} at ${b.slice(0, 8)} is not covered by a PASS certification occurrence`)
    return r
  },
}

export interface ConjunctResult {
  readonly id: string
  readonly satisfied: boolean
  readonly reasons: readonly string[]
}

export function evaluatePostMintConjuncts(i: PostMintInputs): { readonly conjuncts: readonly ConjunctResult[]; readonly unsatisfied: readonly string[] } {
  if (i.conjunctIds === null || i.conjunctIds.length === 0) {
    return { conjuncts: [], unsatisfied: ['(no N10 post-mint readiness conjuncts could be read from the authority)'] }
  }
  const conjuncts = i.conjunctIds.map((id) => {
    const ev = CONJUNCT_EVALUATORS[id]
    const reasons = ev === undefined ? [`no evaluator is registered for ${id}`] : ev(i)
    return { id, satisfied: reasons.length === 0, reasons }
  })
  return { conjuncts, unsatisfied: conjuncts.filter((c) => !c.satisfied).map((c) => c.id) }
}

// ---------------------------------------------------------------------------
// Gathering, from the repository as it stands
// ---------------------------------------------------------------------------

const readJson = <T>(root: string, p: string): T | null => (existsSync(join(root, p)) ? (JSON.parse(readFileSync(join(root, p), 'utf8')) as T) : null)

function blobOf(root: string, rel: string): string {
  return execFileSync('git', ['hash-object', '--', rel], { cwd: root, encoding: 'utf8' }).trim()
}

/** The closure a delivery runs: the launcher's and the consumer's, derived from emitted requires. */
export function deliveryClosure(root: string, d: Delivery): string[] {
  return [...deriveClosure(root, [LAUNCHER, d.consumerEntry!]).keys()].sort()
}

export const PACKAGE_FILES = [
  'db/custody/mint-route-b-contract.ts',
  'db/custody/p1-reads.ts',
  'db/custody/auditor-read-session.ts',
  'db/custody/n14-observation.ts',
  'db/custody/n22-poststate.ts',
  'scripts/custody/d1-delivery-matrix.ts',
  'scripts/custody/d1-post-mint.ts',
  'scripts/custody/d1-pre-hc1-post-mint.ts',
  AMENDMENT_V105,
  OWNER_DECISION,
] as const

export function gatherPostMintInputs(root: string): PostMintInputs {
  const amendment = readJson<{ N10_PRE_HC1_READINESS_CONJUNCTS?: Array<{ id: string }>; AUTHORITY_CONFLICTS_OPEN?: Array<{ id: string }>; AUTHORITY_CONFLICT_RULINGS?: Record<string, string> }>(root, AMENDMENT_V105)
  const owner = readJson<{ DECISIONS_VERBATIM: Record<string, string> }>(root, OWNER_DECISION)
  const record = readJson<{
    OPERATOR_TOOL_FEASIBILITY?: { verdict: string; driver: string }
    TOPOLOGY_DEMONSTRATION?: { per_delivery?: Record<string, { overall: string; closure_blobs: Record<string, string> }> }
  }>(root, COMPLETENESS_RECORD)
  const inv = readJson<{ entries: Array<Record<string, unknown>> }>(root, INVENTORY)
  const registry = readJson<{ OCCURRENCES: Array<{ VERDICT: string; certified_artifacts: Array<{ path: string; blob_sha: string }> }> }>(root, REGISTRY)

  let driverResolvable = false
  try {
    createRequire(join(root, 'package.json')).resolve('postgres')
    driverResolvable = true
  } catch {
    driverResolvable = false
  }

  const { deliveries, gaps } = deriveDeliveries(root)
  const entries = deliveries.filter((d) => d.consumerEntry !== null).map((d) => d.consumerEntry!)
  const entryFilesPresent = Object.fromEntries(entries.map((e) => [e, existsSync(join(root, e))]))
  const currentClosureBlobs: Record<string, Record<string, string>> = {}
  for (const d of deliveries.filter((x) => x.ownedBy === 'THIS_DAG' && existsSync(join(root, x.consumerEntry!)))) {
    currentClosureBlobs[d.id] = Object.fromEntries(deliveryClosure(root, d).map((p) => [p, blobOf(root, p)]))
  }
  const demonstrations: Record<string, { overall: string; closureBlobs: Record<string, string> }> = {}
  for (const [id, v] of Object.entries(record?.TOPOLOGY_DEMONSTRATION?.per_delivery ?? {})) demonstrations[id] = { overall: v.overall, closureBlobs: v.closure_blobs }

  const packageBlobs = Object.fromEntries(PACKAGE_FILES.filter((p) => existsSync(join(root, p))).map((p) => [p, blobOf(root, p)]))
  const certifiedPairs = (registry?.OCCURRENCES ?? [])
    .filter((o) => /PASS/.test(o.VERDICT) && !/_FAIL$/.test(o.VERDICT))
    .flatMap((o) => o.certified_artifacts.map((a) => `${a.path}@${a.blob_sha}`))

  return {
    conjunctIds: amendment?.N10_PRE_HC1_READINESS_CONJUNCTS?.map((c) => c.id) ?? null,
    ownerDecision: owner?.DECISIONS_VERBATIM ?? null,
    operatorToolFeasibility: record?.OPERATOR_TOOL_FEASIBILITY ?? null,
    driverResolvable,
    inventorySurfaceReasons: inv === null ? ['custody inventory absent'] : checkInventorySurfaces(root, inv.entries[0]?.processes_or_environments),
    deliveries,
    deliveryGaps: gaps,
    productionEntryPoints: [...PRODUCTION_ENTRY_POINTS],
    entryFilesPresent,
    demonstrations,
    currentClosureBlobs,
    openConflicts: (amendment?.AUTHORITY_CONFLICTS_OPEN ?? AUTHORITY_CONFLICTS).map((c) => c.id),
    conflictRulings: amendment?.AUTHORITY_CONFLICT_RULINGS ?? {},
    packageBlobs,
    certifiedPairs,
  }
}
