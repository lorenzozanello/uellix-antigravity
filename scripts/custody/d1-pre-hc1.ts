// scripts/custody/d1-pre-hc1.ts
//
// THE NON-SECRET PRECONDITIONS OF HC-1 (DAG NODE N10), EVALUATED.
//
//   pnpm custody:pre-hc1        measure this worktree and print the evaluation
//
// N10's HARD predecessors are read from the graph. Each repository-plane node
// is evaluated here from facts measured with git and from the governing
// artifacts, never from a status some earlier record wrote down:
//
//   N01  class-D machine gate: branch, HEAD, tree, clean-including-untracked,
//        origin/integration/commercial-v1 against the recorded frozen base,
//        and the six CANDIDATE_BINDING blobs of the ratification record.
//   N02  the certified mechanism that resolved it, re-verified by blob, and
//        valid only with an N01 measured at THE SAME base.
//   N03  the ratification record's six decisions, blob-bound.
//   N04  arm A of target identity: the ref from every governed source, the
//        code pin, the repository's own deriveConnectionIdentity, and the
//        production veto. No session exists and none is opened.
//   N07  the certified evidence skeleton and the pre-written rollback
//        statements, checked against N07's own text.
//   N10  READY_FOR_HUMAN_CONFIRMATION at best. Only the owner's HC-1 answer can
//        make it SATISFIED, and nothing here can supply one.
//
// Nothing in this file opens a socket, reads a credential or writes a file.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  deriveConnectionIdentity,
  productionDenylistStatus,
} from '../../db/hosted/target-identity'
import { AUDITOR_DATABASE_ROLE } from '../../db/safety/database-role'
import { hardPredecessorsOf } from './d1-dag-validate'
import { evaluateN06InRepo, type NodeState as N06NodeState } from './d1-n06-closure'
import { computeValidUntilUtc } from './d1-n09-valid-until'

export type Gate = 'PASS' | 'STOP'
export type NodeState = 'SATISFIED' | 'NOT_SATISFIED'

const REL = 'docs/ops/release/'
export const PATHS = {
  capability: `${REL}FIBDB053_D1_AUDITOR_CAPABILITY_PROVISIONING_AUTHORITY_v1.0.0.json`,
  dag: `${REL}FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.0.json`,
  dagV101: `${REL}FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.1.json`,
  ratification: 'docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_CAPABILITY_OWNER_DECISIONS_v1.0.0.json',
  n07Schema: `${REL}FIBDB053_D1_AUDITOR_N07_EVIDENCE_SKELETON_SCHEMA_v1.0.1.json`,
  n07Template: `${REL}FIBDB053_D1_AUDITOR_N07_EVIDENCE_SKELETON_TEMPLATE_v1.0.1.json`,
  consolidated: `${REL}FIBDB053_D1_AUDITOR_CONSOLIDATED_CLOSURE_AUTHORITY_v1.0.0.json`,
  inventory: 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json',
  registry: `${REL}FIBDB053_D1_AUDITOR_CERTIFICATION_OCCURRENCE_REGISTRY_v1.0.0.json`,
  n06Record: `${REL}FIBDB053_D1_AUDITOR_N06_CLOSURE_EXECUTION_RECORD_v1.0.0.json`,
  evidenceDir: 'docs/ops/staging/evidence',
} as const

export interface BlobPin {
  readonly path: string
  readonly blob_sha: string
}

// ---------------------------------------------------------------------------
// Measurement (git only)
// ---------------------------------------------------------------------------

export interface RepoFacts {
  readonly branch: string
  readonly head: string
  readonly tree: string
  readonly clean: boolean
  readonly integrationRef: string | null
  /** git rev-parse HEAD:<path> for every path asked about; null when absent. */
  readonly blobs: Readonly<Record<string, string | null>>
}

const git = (root: string, args: readonly string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()

export function measureRepoFacts(root: string, paths: readonly string[], liveIntegration: boolean): RepoFacts {
  const blobs: Record<string, string | null> = {}
  for (const p of paths) {
    try {
      blobs[p] = git(root, ['rev-parse', `HEAD:${p}`])
    } catch {
      blobs[p] = null
    }
  }
  let integrationRef: string | null = null
  if (liveIntegration) {
    // The one network read: the ref of this repository's own integration
    // branch, from its own origin. Read-only, no credential material.
    const line = git(root, ['ls-remote', 'origin', 'refs/heads/integration/commercial-v1'])
    integrationRef = line.split(/\s+/)[0] || null
  }
  return {
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(root, ['rev-parse', 'HEAD']),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    clean: git(root, ['status', '--porcelain', '--untracked-files=all']) === '',
    integrationRef,
    blobs,
  }
}

const readJson = <T>(root: string, p: string): T => JSON.parse(readFileSync(join(root, p), 'utf8')) as T

// ---------------------------------------------------------------------------
// N01
// ---------------------------------------------------------------------------

export interface N01Result {
  readonly status: Gate
  readonly tokens: readonly string[]
  /** The base this result was measured AT. N02 refuses a result from any other base. */
  readonly measuredAt: { readonly branch: string; readonly head: string; readonly tree: string }
  readonly integration: { readonly frozen: string; readonly measured: string | null }
  readonly bindings: ReadonlyArray<BlobPin & { readonly measured: string | null; readonly match: boolean }>
}

export function evaluateN01(params: {
  readonly facts: RepoFacts
  readonly declaredBase: { readonly branch: string; readonly head: string; readonly tree: string }
  readonly frozenIntegration: string
  readonly candidateBinding: readonly BlobPin[]
}): N01Result {
  const { facts, declaredBase } = params
  const tokens: string[] = []
  if (facts.integrationRef !== params.frozenIntegration) tokens.push('STOP_STALE_INTEGRATION')
  if (facts.branch !== declaredBase.branch || facts.head !== declaredBase.head) tokens.push('STOP_WRONG_HEAD')
  if (facts.tree !== declaredBase.tree) tokens.push('STOP_WRONG_TREE')
  if (!facts.clean) tokens.push('STOP_DIRTY_WORKTREE')
  const bindings = params.candidateBinding.map((b) => {
    const measured = facts.blobs[b.path] ?? null
    return { ...b, measured, match: measured === b.blob_sha }
  })
  if (bindings.length !== 6 || bindings.some((b) => !b.match)) tokens.push('STOP_RATIFICATION_BINDING_MISMATCH')
  return {
    status: tokens.length === 0 ? 'PASS' : 'STOP',
    tokens,
    measuredAt: { branch: facts.branch, head: facts.head, tree: facts.tree },
    integration: { frozen: params.frozenIntegration, measured: facts.integrationRef },
    bindings,
  }
}

// ---------------------------------------------------------------------------
// N02
// ---------------------------------------------------------------------------

export function evaluateN02(params: {
  readonly n01: N01Result
  readonly evaluatedAtHead: string
  readonly mechanism: BlobPin
  readonly parentRecord: BlobPin
  readonly facts: RepoFacts
}): { readonly status: NodeState; readonly reasons: readonly string[] } {
  const reasons: string[] = []
  if (params.n01.status !== 'PASS') reasons.push(`N01 did not pass (${params.n01.tokens.join(', ')}).`)
  if (params.n01.measuredAt.head !== params.evaluatedAtHead) {
    reasons.push(`N01 was measured at ${params.n01.measuredAt.head}, not at the base being evaluated (${params.evaluatedAtHead}); a historical N01 does not discharge N02.`)
  }
  if (params.facts.blobs[params.mechanism.path] !== params.mechanism.blob_sha) {
    reasons.push(`The certified mechanism ${params.mechanism.path} is not at blob ${params.mechanism.blob_sha}.`)
  }
  if (params.facts.blobs[params.parentRecord.path] !== params.parentRecord.blob_sha) {
    reasons.push(`The parent ratification record is not at blob ${params.parentRecord.blob_sha}.`)
  }
  return { status: reasons.length === 0 ? 'SATISFIED' : 'NOT_SATISFIED', reasons }
}

// ---------------------------------------------------------------------------
// N03
// ---------------------------------------------------------------------------

export function evaluateN03(params: {
  readonly ratificationRecord: { readonly ratifications?: ReadonlyArray<Record<string, unknown>> }
  readonly parentRecord: BlobPin
  readonly facts: RepoFacts
}): { readonly status: NodeState; readonly reasons: readonly string[] } {
  const reasons: string[] = []
  const r = params.ratificationRecord.ratifications ?? []
  const ids = r.map((x) => String(x.id ?? x.decision_id ?? ''))
  const ratified = r.filter((x) => /RATIFIED/i.test(String(x.status ?? x.disposition ?? '')))
  if (r.length !== 6) reasons.push(`The ratification record holds ${r.length} decisions, not six.`)
  if (ratified.length !== 6) reasons.push(`${ratified.length} of the decisions carry a RATIFIED status, not six.`)
  for (const want of ['OD-1', 'OD-2', 'OD-3', 'OD-4', 'OD-5', 'OD-6']) {
    if (!ids.includes(want)) reasons.push(`${want} is not in the ratification record.`)
  }
  if (params.facts.blobs[params.parentRecord.path] !== params.parentRecord.blob_sha) {
    reasons.push('The ratification record is not at the blob every downstream artifact bound.')
  }
  return { status: reasons.length === 0 ? 'SATISFIED' : 'NOT_SATISFIED', reasons }
}

// ---------------------------------------------------------------------------
// N04, arm A
// ---------------------------------------------------------------------------

export interface N04Input {
  /** The ref every governed source declares, by source. */
  readonly declaredRefs: Readonly<Record<string, string>>
  /** The direct host the DAG's TARGET_IDENTITY authorizes. Evaluated, never recorded. */
  readonly authorizedDirectHost: string
  readonly dagVetoedRef: string
  /** The role every governed source names, by source. */
  readonly declaredRoles: Readonly<Record<string, string>>
}

export function evaluateN04(input: N04Input): {
  readonly status: NodeState
  readonly projectRef: string | null
  readonly mechanism: string | null
  readonly role: string | null
  readonly reasons: readonly string[]
} {
  const reasons: string[] = []
  const refs = [...new Set(Object.values(input.declaredRefs))]
  if (refs.length !== 1) reasons.push(`Governed sources declare ${refs.length} different refs: ${JSON.stringify(input.declaredRefs)}.`)
  const ref = refs.length === 1 ? refs[0]! : null
  if (ref !== null && ref !== KNOWN_STAGING_PROJECT_REF) reasons.push(`The declared ref ${ref} is not KNOWN_STAGING_PROJECT_REF.`)
  const veto = productionDenylistStatus()
  if (!veto.loaded) reasons.push(`The production veto is not loaded: ${veto.detail}`)
  if (ref !== null && KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(ref)) {
    reasons.push('STOP_PRODUCTION_TARGET_REFUSED: the declared ref is a production ref.')
  }
  if (!KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(input.dagVetoedRef)) {
    reasons.push('The DAG-vetoed production ref is not in the code veto; the two production lists disagree.')
  }
  // The repository's own identity derivation, CALLED and not re-implemented.
  const identity = deriveConnectionIdentity({ connectionHost: input.authorizedDirectHost })
  let mechanism: string | null = null
  if (!identity.ok) reasons.push(`deriveConnectionIdentity refused the authorized host: ${identity.code}.`)
  else {
    mechanism = identity.mechanism
    if (identity.projectRef !== ref) reasons.push('STOP_TARGET_IDENTITY_CONTRADICTION: the host names a different ref than the declared one.')
    if (identity.mechanism !== 'direct-db') reasons.push(`The connection mechanism is ${identity.mechanism}; this role requires direct-db and the session pooler is refused.`)
  }
  const roles = [...new Set(Object.values(input.declaredRoles))]
  if (roles.length !== 1 || roles[0] !== AUDITOR_DATABASE_ROLE) {
    reasons.push(`The governed role sources do not all name ${AUDITOR_DATABASE_ROLE}: ${JSON.stringify(input.declaredRoles)}.`)
  }
  return {
    status: reasons.length === 0 ? 'SATISFIED' : 'NOT_SATISFIED',
    projectRef: ref,
    mechanism,
    role: roles.length === 1 ? roles[0]! : null,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// N07
// ---------------------------------------------------------------------------

interface Template {
  readonly template_status?: string
  readonly rollback_statements_pre_written?: {
    readonly mr1_rollback?: { readonly statement?: string }
    readonly mr2_compensating_action?: { readonly rollback_possible?: boolean; readonly statement_options?: readonly string[] }
    readonly mr3_rollback?: { readonly statement?: string }
  }
  readonly must_never_contain_attestation?: { readonly prohibited?: readonly string[] }
}

/** The dated, attempt-scoped naming the evidence directory uses. */
export const EVIDENCE_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9_]+)-([a-z0-9-]+)\.(json|txt)$/

export function evaluateN07(input: {
  readonly template: Template
  readonly measuredTemplateBlob: string | null
  readonly measuredSchemaBlob: string | null
  readonly certifiedTemplate: BlobPin
  readonly certifiedSchema: BlobPin
  readonly n07Act: string
  readonly mustNeverContain: readonly string[]
  readonly evidenceDirEntries: readonly string[] | null
}): {
  readonly status: NodeState
  readonly filenameRule: string | null
  readonly precedentCount: number
  readonly reasons: readonly string[]
} {
  const reasons: string[] = []
  if (input.measuredTemplateBlob !== input.certifiedTemplate.blob_sha) reasons.push('The evidence skeleton template is not the certified v1.0.1 blob.')
  if (input.measuredSchemaBlob !== input.certifiedSchema.blob_sha) reasons.push('The evidence skeleton schema is not the certified v1.0.1 blob.')
  if (input.template.template_status !== 'UNPOPULATED_TEMPLATE') reasons.push('The skeleton is not an unpopulated template.')

  // Rollback statements: every one N07's act names, verbatim.
  const rb = input.template.rollback_statements_pre_written
  const want = {
    mr1: 'ALTER ROLE uellix_auditor NOLOGIN',
    mr3: 'REVOKE USAGE ON SCHEMA uellix_stella_ops FROM uellix_auditor',
    mr2a: 'ROTATE AGAIN',
    mr2b: 'ALTER ROLE uellix_auditor PASSWORD NULL',
  }
  for (const s of Object.values(want)) {
    if (!input.n07Act.includes(s)) reasons.push(`N07's act no longer names "${s}"; the expected set must be re-derived.`)
  }
  if (rb?.mr1_rollback?.statement !== want.mr1) reasons.push('The MR-1 rollback statement is missing or differs from N07.')
  if (rb?.mr3_rollback?.statement !== want.mr3) reasons.push('The MR-3 rollback statement is missing or differs from N07.')
  if (rb?.mr2_compensating_action?.rollback_possible !== false) reasons.push('MR-2 is not recorded as having NO rollback.')
  const opts = rb?.mr2_compensating_action?.statement_options ?? []
  if (!(opts.length === 2 && opts.includes(want.mr2a) && opts.includes(want.mr2b))) reasons.push('The MR-2 compensating actions are missing or differ from N07.')

  const prohibited = input.template.must_never_contain_attestation?.prohibited ?? []
  if (JSON.stringify(prohibited) !== JSON.stringify(input.mustNeverContain)) reasons.push('The prohibited-content attestation does not match MUST_NEVER_CONTAIN.')

  // The evidence destination: the directory exists and its precedent yields a naming rule.
  let filenameRule: string | null = null
  let precedentCount = 0
  if (input.evidenceDirEntries === null) reasons.push('The evidence destination docs/ops/staging/evidence/ does not exist.')
  else {
    precedentCount = input.evidenceDirEntries.filter((e) => EVIDENCE_NAME.test(e)).length
    if (precedentCount === 0) reasons.push('The evidence directory has no dated attempt-scoped precedent to derive a name from.')
    else filenameRule = '<UTC date of the attempt, YYYY-MM-DD>-<attempt identifier>-<subject>.json'
  }
  return { status: reasons.length === 0 ? 'SATISFIED' : 'NOT_SATISFIED', filenameRule, precedentCount, reasons }
}

// ---------------------------------------------------------------------------
// N10
// ---------------------------------------------------------------------------

export type N10Readiness = 'NOT_READY' | 'READY_FOR_HUMAN_CONFIRMATION' | 'SATISFIED'

/**
 * Whether HC-1 may be ASKED. SATISFIED requires the owner's affirmative answer
 * to THIS act after all six statements; this repository cannot produce one,
 * so every caller here passes null and READY_FOR_HUMAN_CONFIRMATION is the
 * ceiling.
 */
export function evaluateN10(params: {
  readonly states: Readonly<Record<string, NodeState>>
  readonly hardPredecessors: readonly string[]
  readonly hc1Answer: { readonly affirmative: true; readonly allSixStatementsGiven: true; readonly coversThisAct: true } | null
}): { readonly readiness: N10Readiness; readonly unsatisfied: readonly string[] } {
  if (params.hardPredecessors.length === 0) return { readiness: 'NOT_READY', unsatisfied: ['(no predecessors derived)'] }
  const unsatisfied = params.hardPredecessors.filter((p) => params.states[p] !== 'SATISFIED')
  if (unsatisfied.length > 0) return { readiness: 'NOT_READY', unsatisfied }
  return { readiness: params.hc1Answer === null ? 'READY_FOR_HUMAN_CONFIRMATION' : 'SATISFIED', unsatisfied: [] }
}

// ---------------------------------------------------------------------------
// N05, N06, N09: re-derived from their own sources, not carried
// ---------------------------------------------------------------------------

export function deriveUpstreamStates(root: string): {
  readonly states: Readonly<Record<'N05' | 'N06' | 'N09', NodeState>>
  readonly reasons: readonly string[]
} {
  const reasons: string[] = []
  const registry = readJson<{ OCCURRENCES: Array<{ VERDICT: string; NODE_STATES_RULED?: Record<string, string> }> }>(root, PATHS.registry)
  const n05 = registry.OCCURRENCES.some((o) => /_PASS/.test(o.VERDICT) && o.NODE_STATES_RULED?.N05 === 'SATISFIED')
  if (!n05) reasons.push('No PASS occurrence in the registry rules N05 SATISFIED.')
  const rec = readJson<{ N08: { value: string }; N06_EVALUATION: { predecessor_states: Record<string, N06NodeState> } }>(root, PATHS.n06Record)
  const n06 = evaluateN06InRepo(root, rec.N08.value, rec.N06_EVALUATION.predecessor_states)
  if (n06.status !== 'SATISFIED') reasons.push(`N06 does not re-derive: ${n06.reasons.join(' ')}`)
  const inv = readJson<{ entries: Array<{ expiry_exact_utc: string | null }> }>(root, PATHS.inventory)
  const n09 = inv.entries[0]!.expiry_exact_utc === computeValidUntilUtc(rec.N08.value)
  if (!n09) reasons.push('The inventory expiry is not the N09 derivation from N08.')
  return {
    states: { N05: n05 ? 'SATISFIED' : 'NOT_SATISFIED', N06: n06.status, N09: n09 ? 'SATISFIED' : 'NOT_SATISFIED' },
    reasons,
  }
}

// ---------------------------------------------------------------------------
// Whole evaluation from the repository
// ---------------------------------------------------------------------------

export function evaluatePreHc1(root: string, opts: {
  readonly declaredBase: { readonly branch: string; readonly head: string; readonly tree: string }
  readonly liveIntegration: boolean
}) {
  const ratification = readJson<{ CANDIDATE_BINDING: { effective_package: BlobPin[] }; ratifications: Array<Record<string, unknown>> }>(root, PATHS.ratification)
  const capability = readJson<Record<string, unknown>>(root, PATHS.capability)
  const dag = readJson<{
    TARGET_IDENTITY: { AUTHORIZED_TARGET_REF: string; authorized_direct_host: string; PRODUCTION_VETOED_REF: string }
    DAG_NODES: { nodes: Array<{ id: string; act: string }> }
    CANDIDATE_BINDING_RE_DERIVED: { the_ratification_record_own_blob_at_this_parent: string }
  }>(root, PATHS.dag)
  const v101 = readJson<{ CANDIDATE_BINDING_EXTENDED: { NEW_BINDING: BlobPin } }>(root, PATHS.dagV101)
  const consolidated = readJson<{ N07_EXECUTION_CRITICAL_CORRECTIONS: { successors: { schema: BlobPin; template: BlobPin } } }>(root, PATHS.consolidated)
  const inventory = readJson<{ entries: Array<{ target_project_ref: string; role: string }> }>(root, PATHS.inventory)
  const template = readJson<Template>(root, PATHS.n07Template)

  const frozenIntegration = /= ([0-9a-f]{40})/.exec(String(capability.AS_OF_INTEGRATION_REF))?.[1] ?? ''
  const parentBlob = /^[0-9a-f]{40}/.exec(dag.CANDIDATE_BINDING_RE_DERIVED.the_ratification_record_own_blob_at_this_parent)?.[0] ?? ''
  const parentRecord: BlobPin = { path: PATHS.ratification, blob_sha: parentBlob }
  const mechanism = v101.CANDIDATE_BINDING_EXTENDED.NEW_BINDING
  const certified = consolidated.N07_EXECUTION_CRITICAL_CORRECTIONS.successors

  const facts = measureRepoFacts(
    root,
    [...ratification.CANDIDATE_BINDING.effective_package.map((b) => b.path), PATHS.ratification, mechanism.path, PATHS.n07Schema, PATHS.n07Template],
    opts.liveIntegration
  )
  const n01 = evaluateN01({ facts, declaredBase: opts.declaredBase, frozenIntegration, candidateBinding: ratification.CANDIDATE_BINDING.effective_package })
  const n02 = evaluateN02({ n01, evaluatedAtHead: opts.declaredBase.head, mechanism, parentRecord, facts })
  const n03 = evaluateN03({ ratificationRecord: ratification, parentRecord, facts })
  const n04 = evaluateN04({
    declaredRefs: { dag_TARGET_IDENTITY: dag.TARGET_IDENTITY.AUTHORIZED_TARGET_REF, custody_inventory: inventory.entries[0]!.target_project_ref },
    authorizedDirectHost: dag.TARGET_IDENTITY.authorized_direct_host,
    dagVetoedRef: dag.TARGET_IDENTITY.PRODUCTION_VETOED_REF,
    declaredRoles: { custody_inventory: inventory.entries[0]!.role, database_role_constant: AUDITOR_DATABASE_ROLE },
  })
  const mnc = ((capability.EVIDENCE_MATERIALIZATION as { MUST_NEVER_CONTAIN?: string[] } | undefined)?.MUST_NEVER_CONTAIN) ?? []
  const n07 = evaluateN07({
    template,
    measuredTemplateBlob: facts.blobs[PATHS.n07Template] ?? null,
    measuredSchemaBlob: facts.blobs[PATHS.n07Schema] ?? null,
    certifiedTemplate: certified.template,
    certifiedSchema: certified.schema,
    n07Act: dag.DAG_NODES.nodes.find((n) => n.id === 'N07')!.act,
    mustNeverContain: mnc,
    evidenceDirEntries: existsSync(join(root, PATHS.evidenceDir)) ? readdirSync(join(root, PATHS.evidenceDir)) : null,
  })
  const upstream = deriveUpstreamStates(root)
  const states: Record<string, NodeState> = {
    ...upstream.states,
    N02: n02.status,
    N03: n03.status,
    N04: n01.status === 'PASS' ? n04.status : 'NOT_SATISFIED',
    N07: n07.status,
  }
  const hardPredecessors = hardPredecessorsOf('N10')
  const n10 = evaluateN10({ states, hardPredecessors, hc1Answer: null })
  return { facts, frozenIntegration, n01, n02, n03, n04, n07, upstream, states, hardPredecessors, n10 }
}

// CLI: measure this worktree against its own HEAD as the declared base.
if (process.argv[1] !== undefined && /d1-pre-hc1\.ts$/.test(process.argv[1])) {
  const root = process.cwd()
  const f = measureRepoFacts(root, [], false)
  const ev = evaluatePreHc1(root, {
    declaredBase: { branch: f.branch, head: f.head, tree: f.tree },
    liveIntegration: true,
  })
  // The raw facts carry every measured blob; the evaluation already reports what was compared.
  const facts = { branch: ev.facts.branch, head: ev.facts.head, tree: ev.facts.tree, clean: ev.facts.clean, integrationRef: ev.facts.integrationRef }
  process.stdout.write(`${JSON.stringify({ ...ev, facts }, null, 2)}\n`)
}
