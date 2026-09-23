// scripts/custody/d1-pre-hc1-post-mint.ts
//
// THE POST-MINT READINESS CONJUNCTS OF N10, READ FROM THE AUTHORITY CHAIN AND
// EVALUATED FROM THE REPOSITORY.
//
// DAG v1.0.5 declared N10_PRE_HC1_READINESS_CONJUNCTS; v1.0.6 added two and
// superseded one. The effective list is computed across the WHOLE append-only
// chain (every graph source of d1-dag-validate, in order): a conjunct is
// added by id and removed only by an explicit supersession that names its
// successor. Nothing is hard-coded here: a missing chain, an empty effective
// list, a supersession without a declared successor, or an id with no
// registered evaluator is NOT_READY.
//
// The same chain supplies the authority conflicts and their rulings (PMR-7),
// so a successor amendment's ruling is seen without editing history — the
// recertification found v1.0.5 read as a fixed path.
//
// Each evaluator is a pure function of a gathered input, so every negative
// control is a test that changes one input and watches one conjunct fail.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { compensationGate } from './d1-post-mint'
import { checkInventorySurfaces, deriveDeliveries, type Delivery } from './d1-delivery-matrix'
import { PRODUCTION_ENTRY_POINTS, deriveClosure } from './build-production-entrypoints'
import { CONSUMER_ENTRY } from './d1-deliver-n13'
import { GRAPH_SOURCES } from './d1-dag-validate'
import { evaluateCandidateBinding, gatherCandidateFacts, type CandidateFacts } from './d1-candidate-certification'
import { AC1_AUTHORIZED_SURFACE, P1_STATEMENTS } from '../../db/custody/p1-reads'
import { N14_BODY } from '../../db/custody/n14-observation'
import { AC3_DEFERRED_ROWS, N21_BODY, N22_BODY, n21ExitFromRows, n22ExitFromRows, n22Rows, type PvRow } from '../../db/custody/n22-poststate'

export const OWNER_DECISION = 'docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_ROUTE_OWNER_DECISION_v1.0.0.json'
export const REGISTRY = 'docs/ops/release/FIBDB053_D1_AUDITOR_CERTIFICATION_OCCURRENCE_REGISTRY_v1.0.0.json'
const RELEASE = 'docs/ops/release'
const INVENTORY = 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'
const EXECUTION_RECORD = /^FIBDB053_D1_AUDITOR_.*_EXECUTION_RECORD_v\d+\.\d+\.\d+\.json$/

/** The launcher every in-DAG consumer runs under. */
const LAUNCHER = 'scripts/custody/d1-deliver-n13.ts'

export interface Ruling {
  readonly source: string
  readonly kind: string
  readonly outcome: string
  /** For an OWNER_POLICY_DECISION: the owner record exists, is SIGNED, and carries this outcome for this id. */
  readonly ownerRecordConfirms: boolean
}

export interface ChainState {
  readonly sourcesRead: readonly string[]
  readonly conjunctIds: readonly string[]
  readonly chainErrors: readonly string[]
  readonly declaredConflicts: readonly string[]
  readonly rulings: Readonly<Record<string, readonly Ruling[]>>
  /** Pinned successor SQL, by name, from SUCCESSOR_AUTHORIZED_SQL. */
  readonly successorSql: Readonly<Record<string, string>>
}

/** What the implementation actually does, measured by calling it — the object PMR-10 compares rulings against. */
export interface ImplementationFacts {
  readonly tablePrivileges: { disposition: string; authority: string; sql: string; inN14: boolean; inN22: boolean }
  /** Every (relation, privilege) any statement passes to has_table_privilege. */
  readonly tablePrivilegePairs: readonly string[]
  readonly reachIsKeyed: boolean
  /** PV-14's verdict on a canned input where only the AC-2 structural proof fails (datdba is the auditor). */
  readonly pv14WhenProofFails: string
  readonly functionExecute: { disposition: string; inN14: boolean; inN21: boolean; inN22: boolean }
  /** On a canned clean input: PV-24/PV-25 verdicts, and whether N22's and N21's exits are met. */
  readonly deferredRowVerdicts: readonly string[]
  readonly n22ExitOnCleanInput: boolean
  readonly n21ExitOnCleanInput: boolean
}

export interface PostMintInputs {
  readonly chain: ChainState
  readonly ownerDecision: Readonly<Record<string, string>> | null
  readonly operatorToolFeasibility: { verdict: string; driver: string } | null
  readonly driverResolvable: boolean
  readonly inventorySurfaceReasons: readonly string[]
  readonly deliveries: readonly Delivery[]
  readonly deliveryGaps: readonly string[]
  readonly productionEntryPoints: readonly string[]
  readonly entryFilesPresent: Readonly<Record<string, boolean>>
  /** Per delivery id: EVERY recorded demonstration (across execution records) with the closure blobs it ran on. */
  readonly demonstrations: Readonly<Record<string, ReadonlyArray<{ overall: string; closureBlobs: Record<string, string> }>>>
  /** Per delivery id: the closure blobs NOW. */
  readonly currentClosureBlobs: Readonly<Record<string, Record<string, string>>>
  readonly implementation: ImplementationFacts
  readonly candidate: CandidateFacts
}

type Evaluator = (i: PostMintInputs) => string[]

const inDag = (i: PostMintInputs): Delivery[] => i.deliveries.filter((d) => d.ownedBy === 'THIS_DAG')

/** The one active ruling per declared conflict, or the reason there is none. */
export function effectiveRulings(chain: ChainState): { active: Record<string, Ruling>; reasons: string[] } {
  const reasons: string[] = []
  const active: Record<string, Ruling> = {}
  for (const id of Object.keys(chain.rulings)) if (!chain.declaredConflicts.includes(id)) reasons.push(`a ruling names ${id}, which no amendment declared`)
  for (const id of chain.declaredConflicts) {
    const rs = chain.rulings[id] ?? []
    if (rs.length === 0) {
      reasons.push(`authority conflict ${id} has no ruling in the chain`)
      continue
    }
    if (new Set(rs.map((r) => `${r.kind}|${r.outcome}`)).size > 1) {
      reasons.push(`authority conflict ${id} has contradictory rulings`)
      continue
    }
    const r = rs[rs.length - 1]!
    if (r.kind !== 'OWNER_POLICY_DECISION' && r.kind !== 'TECHNICAL_AUTHORITY_RULING') {
      reasons.push(`ruling on ${id} has unknown kind ${r.kind}`)
      continue
    }
    if (r.kind === 'OWNER_POLICY_DECISION' && !r.ownerRecordConfirms) {
      reasons.push(`ruling on ${id} claims an owner decision the owner record does not carry`)
      continue
    }
    active[id] = r
  }
  return { active, reasons }
}

/** The registered evaluator for each conjunct id the chain may name. Each returns its failure reasons. */
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
      const now = i.currentClosureBlobs[d.id] ?? {}
      if (Object.keys(now).length === 0) {
        r.push(`${d.id}: empty closure`)
        continue
      }
      const same = (i.demonstrations[d.id] ?? []).filter((demo) => {
        const paths = new Set([...Object.keys(now), ...Object.keys(demo.closureBlobs)])
        return [...paths].every((p) => now[p] === demo.closureBlobs[p])
      })
      if (same.length === 0) r.push(`${d.id}: no recorded demonstration ran on the launcher+consumer closure that exists now`)
      else if (!same.some((demo) => demo.overall === 'SATISFIED_CANDIDATE')) r.push(`${d.id}: the demonstration on the current closure is not SATISFIED_CANDIDATE`)
    }
    return r
  },
  'PMR-7_NO_OPEN_AUTHORITY_CONFLICT': (i) => effectiveRulings(i.chain).reasons,
  // Superseded by PMR-9 in v1.0.6; kept registered so a chain that still carries it is evaluated, not ignored.
  'PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS': () => ['PMR-8 is superseded by PMR-9_CANDIDATE_CERTIFIED (DAG v1.0.6) and cannot be satisfied on its own'],
  'PMR-9_CANDIDATE_CERTIFIED': (i) => [...evaluateCandidateBinding(i.candidate).reasons],
  'PMR-10_RULINGS_MATCH_IMPLEMENTATION': (i) => {
    const { active } = effectiveRulings(i.chain)
    const f = i.implementation
    const r: string[] = []
    // No vacuous pass: a declared conflict with no active ruling cannot be matched to anything.
    for (const id of i.chain.declaredConflicts) if (active[id] === undefined) r.push(`${id}: no active ruling, so its correspondence cannot be verified`)
    if (i.chain.declaredConflicts.length === 0) r.push('no authority conflict is declared anywhere in the chain; nothing to verify is itself suspicious')
    const ac1 = active['AC-1']
    if (ac1?.outcome === 'AUTHORIZE_NARROW_HAS_TABLE_PRIVILEGE_OBSERVATION') {
      const pinned = i.chain.successorSql.AC1_TABLE_PRIVILEGES
      if (f.tablePrivileges.disposition !== 'ISSUABLE') r.push('AC-1 is authorized but TABLE_PRIVILEGES is not ISSUABLE')
      if (f.tablePrivileges.authority !== 'SUCCESSOR_V1_0_6_AC1') r.push('TABLE_PRIVILEGES does not carry its successor provenance')
      if (pinned === undefined || f.tablePrivileges.sql !== pinned) r.push('TABLE_PRIVILEGES text differs from the SQL the successor amendment pins')
      if (!f.tablePrivileges.inN14 || !f.tablePrivileges.inN22) r.push('AC-1 rows are not observed by both N14 and N22')
      const allowed = Object.entries(AC1_AUTHORIZED_SURFACE).flatMap(([rel, privs]) => privs.map((p) => `${rel}|${p}`))
      const extra = f.tablePrivilegePairs.filter((p) => !allowed.includes(p))
      if (extra.length > 0) r.push(`has_table_privilege names pairs outside the owner surface: ${extra.join(', ')}`)
      if (allowed.some((p) => !f.tablePrivilegePairs.includes(p))) r.push('TABLE_PRIVILEGES does not cover the whole owner surface')
    } else if (ac1 !== undefined) r.push(`AC-1 ruling outcome ${ac1.outcome} has no implementation mapping`)
    const ac2 = active['AC-2']
    if (ac2?.outcome === 'REFUTED') {
      if (!f.reachIsKeyed) r.push('AC-2 is refuted but REACH is not a keyed lookup over the named roles')
      if (f.pv14WhenProofFails !== 'FAIL') r.push('AC-2 is refuted but PV-14 does not fail when its structural proof fails')
    } else if (ac2 !== undefined) r.push(`AC-2 ruling outcome ${ac2.outcome} has no implementation mapping`)
    const ac3 = active['AC-3']
    if (ac3?.outcome === 'DEFER_FUNCTION_EXECUTE_ASSERTIONS_TO_PRECHECK_R2') {
      if (f.functionExecute.disposition !== 'DEFERRED_TO_PRECHECK_R2') r.push('AC-3 is deferred but FUNCTION_EXECUTE is still issuable')
      if (f.functionExecute.inN14 || f.functionExecute.inN21 || f.functionExecute.inN22) r.push('a provisioning node still requires FUNCTION_EXECUTE')
      if (f.deferredRowVerdicts.some((v) => v !== 'DEFERRED_TO_PRECHECK_R2')) r.push('PV-24/PV-25 are not DEFERRED_TO_PRECHECK_R2')
      if (!f.n22ExitOnCleanInput) r.push('N22 cannot meet its exit on a clean input while AC-3 defers PV-24/PV-25')
      if (!f.n21ExitOnCleanInput) r.push('N21 cannot meet its exit on a clean input while AC-3 defers its EXECUTE rows')
    } else if (ac3 !== undefined) r.push(`AC-3 ruling outcome ${ac3.outcome} has no implementation mapping`)
    return r
  },
}

export interface ConjunctResult {
  readonly id: string
  readonly satisfied: boolean
  readonly reasons: readonly string[]
}

export function evaluatePostMintConjuncts(i: PostMintInputs): { readonly conjuncts: readonly ConjunctResult[]; readonly unsatisfied: readonly string[] } {
  if (i.chain.chainErrors.length > 0 || i.chain.conjunctIds.length === 0) {
    return { conjuncts: [], unsatisfied: [`(the N10 post-mint readiness conjuncts could not be derived from the authority chain: ${i.chain.chainErrors.join('; ') || 'empty'})`] }
  }
  const conjuncts = i.chain.conjunctIds.map((id) => {
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

/** The effective chain state, reading every graph source in amendment order. */
export function readChain(root: string, sources: readonly string[] = GRAPH_SOURCES): ChainState {
  const chainErrors: string[] = []
  const added: string[] = []
  const superseded = new Map<string, string>()
  const declared: string[] = []
  const rulings: Record<string, Ruling[]> = {}
  const successorSql: Record<string, string> = {}
  const sourcesRead: string[] = []
  for (const file of sources) {
    const doc = readJson<{
      N10_PRE_HC1_READINESS_CONJUNCTS?: Array<{ id: string }>
      N10_PRE_HC1_READINESS_CONJUNCTS_SUPERSEDED?: Record<string, { superseded_by?: string }>
      AUTHORITY_CONFLICTS_OPEN?: Array<{ id: string }>
      AUTHORITY_CONFLICT_RULINGS?: Record<string, { kind?: string; outcome?: string; source?: string }>
      SUCCESSOR_AUTHORIZED_SQL?: Record<string, { sql?: string }>
    }>(root, `${RELEASE}/${file}`)
    if (doc === null) {
      chainErrors.push(`graph source ${file} is missing`)
      continue
    }
    sourcesRead.push(file)
    for (const c of doc.N10_PRE_HC1_READINESS_CONJUNCTS ?? []) added.push(c.id)
    for (const [id, v] of Object.entries(doc.N10_PRE_HC1_READINESS_CONJUNCTS_SUPERSEDED ?? {})) superseded.set(id, String(v.superseded_by ?? ''))
    for (const c of doc.AUTHORITY_CONFLICTS_OPEN ?? []) if (!declared.includes(c.id)) declared.push(c.id)
    for (const [id, v] of Object.entries(doc.AUTHORITY_CONFLICT_RULINGS ?? {})) {
      if (typeof v !== 'object' || v === null) continue
      const outcome = String(v.outcome ?? '')
      let ownerRecordConfirms = false
      if (v.kind === 'OWNER_POLICY_DECISION' && typeof v.source === 'string') {
        const owner = readJson<{ DECISIONS_VERBATIM?: Record<string, unknown> }>(root, v.source)
        const d = owner?.DECISIONS_VERBATIM
        const entry = d?.[id] as Record<string, unknown> | undefined
        ownerRecordConfirms = d?.SIGNED === 'YES' && entry !== undefined && Object.values(entry).includes(outcome)
      }
      ;(rulings[id] ??= []).push({ source: file, kind: String(v.kind ?? ''), outcome, ownerRecordConfirms })
    }
    for (const [name, v] of Object.entries(doc.SUCCESSOR_AUTHORIZED_SQL ?? {})) if (typeof v.sql === 'string') successorSql[name] = v.sql
  }
  for (const [id, by] of superseded) {
    if (!added.includes(id)) chainErrors.push(`a supersession names ${id}, which no amendment declared`)
    if (!added.includes(by)) chainErrors.push(`${id} is superseded by ${by || '(nothing)'}, which no amendment declares`)
  }
  const conjunctIds = added.filter((id, k) => added.indexOf(id) === k && !superseded.has(id))
  return { sourcesRead, conjunctIds, chainErrors, declaredConflicts: declared, rulings, successorSql }
}

/** Measure the implementation by CALLING it on canned rows — never by reading prose. */
export function measureImplementation(): ImplementationFacts {
  const pairs: string[] = []
  for (const s of Object.values(P1_STATEMENTS)) {
    for (const m of s.sql.matchAll(/has_table_privilege\('uellix_auditor', '([^']+)', '([^']+)'\)/g)) pairs.push(`${m[1]}|${m[2]}`)
    if (/has_table_privilege\(/.test(s.sql) && !/has_table_privilege\('uellix_auditor', '[^']+', '[^']+'\)/.test(s.sql)) pairs.push('(non-literal has_table_privilege call)')
  }
  const clean = {
    preflight: { connected: true, kp1: true, targetIdentityArmB: true, sentinel: { environment: 'staging', projectRef: 'x' }, identity: { currentUser: 'uellix_auditor', sessionUser: 'uellix_auditor' } },
    attrs: { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false },
    memberships: [],
    reach: [],
    own: { classes: 0, namespaces: 0, procs: 0, types: 0 },
    datdba: false,
    db: { auditor_connect: true },
    schemas: new Map([
      ['public', { present: true, usage: true, create: false }],
      ['uellix_bootstrap', { present: true, usage: true, create: false }],
      ['uellix_stella_ops', { present: true, usage: true, create: false }],
    ]),
    tables: { sentinel_select: true, sentinel_insert: false, sentinel_update: false, sentinel_delete: false, sentinel_truncate: false, users_select: true },
  }
  const cleanRows = n22Rows(clean).map((r) => (r.id === 'PV-33' ? { ...r, verdict: 'PASS' as const } : r)) as PvRow[]
  const proofFails = n22Rows({ ...clean, datdba: true })
  const n21Rows: PvRow[] = [
    { id: 'N21-USAGE (PV-23)', expected: 'true', actual: 'true', verdict: 'PASS' },
    { id: 'N21-CREATE (PV-26)', expected: 'false', actual: 'false', verdict: 'PASS' },
    ...AC3_DEFERRED_ROWS.filter((x) => x.startsWith('N21')).map((id) => ({ id, expected: '', actual: '', verdict: 'DEFERRED_TO_PRECHECK_R2' as const })),
  ]
  return {
    tablePrivileges: {
      disposition: P1_STATEMENTS.TABLE_PRIVILEGES.disposition,
      authority: P1_STATEMENTS.TABLE_PRIVILEGES.authority,
      sql: P1_STATEMENTS.TABLE_PRIVILEGES.sql,
      inN14: N14_BODY.includes('TABLE_PRIVILEGES'),
      inN22: N22_BODY.includes('TABLE_PRIVILEGES'),
    },
    tablePrivilegePairs: [...new Set(pairs)].sort(),
    reachIsKeyed: /= ANY \(ARRAY\[/.test(P1_STATEMENTS.REACH.sql) && !/\bLIKE\b|SIMILAR TO|~|regexp/i.test(P1_STATEMENTS.REACH.sql),
    pv14WhenProofFails: proofFails.find((r) => r.id === 'PV-14')?.verdict ?? '(missing)',
    functionExecute: {
      disposition: P1_STATEMENTS.FUNCTION_EXECUTE.disposition,
      inN14: N14_BODY.includes('FUNCTION_EXECUTE'),
      inN21: N21_BODY.includes('FUNCTION_EXECUTE'),
      inN22: N22_BODY.includes('FUNCTION_EXECUTE'),
    },
    deferredRowVerdicts: cleanRows.filter((r) => r.id === 'PV-24' || r.id === 'PV-25').map((r) => r.verdict),
    n22ExitOnCleanInput: n22ExitFromRows(cleanRows, true),
    n21ExitOnCleanInput: n21ExitFromRows(n21Rows),
  }
}

function blobOf(root: string, rel: string): string {
  return execFileSync('git', ['hash-object', '--', rel], { cwd: root, encoding: 'utf8' }).trim()
}

/** The closure a delivery runs: the launcher's and the consumer's, derived from emitted requires. */
export function deliveryClosure(root: string, d: Delivery): string[] {
  return [...deriveClosure(root, [LAUNCHER, d.consumerEntry!]).keys()].sort()
}

export function gatherPostMintInputs(root: string): PostMintInputs {
  const owner = readJson<{ DECISIONS_VERBATIM: Record<string, string> }>(root, OWNER_DECISION)
  const records = existsSync(join(root, RELEASE)) ? readdirSync(join(root, RELEASE)).filter((n) => EXECUTION_RECORD.test(n)).sort() : []
  let feasibility: { verdict: string; driver: string } | null = null
  const demonstrations: Record<string, Array<{ overall: string; closureBlobs: Record<string, string> }>> = {}
  for (const name of records) {
    const rec = readJson<{
      OPERATOR_TOOL_FEASIBILITY?: { verdict: string; driver: string }
      TOPOLOGY_DEMONSTRATION?: { per_delivery?: Record<string, { overall: string; closure_blobs: Record<string, string> }> }
    }>(root, `${RELEASE}/${name}`)
    if (rec?.OPERATOR_TOOL_FEASIBILITY !== undefined) feasibility = rec.OPERATOR_TOOL_FEASIBILITY
    for (const [id, v] of Object.entries(rec?.TOPOLOGY_DEMONSTRATION?.per_delivery ?? {})) (demonstrations[id] ??= []).push({ overall: v.overall, closureBlobs: v.closure_blobs })
  }
  const inv = readJson<{ entries: Array<Record<string, unknown>> }>(root, INVENTORY)

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

  return {
    chain: readChain(root),
    ownerDecision: owner?.DECISIONS_VERBATIM ?? null,
    operatorToolFeasibility: feasibility,
    driverResolvable,
    inventorySurfaceReasons: inv === null ? ['custody inventory absent'] : checkInventorySurfaces(root, inv.entries[0]?.processes_or_environments),
    deliveries,
    deliveryGaps: gaps,
    productionEntryPoints: [...PRODUCTION_ENTRY_POINTS],
    entryFilesPresent,
    demonstrations,
    currentClosureBlobs,
    implementation: measureImplementation(),
    candidate: gatherCandidateFacts(root),
  }
}
