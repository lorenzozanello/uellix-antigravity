// scripts/infra-read/executor.ts
//
// The safe-read executor. It is not a CLI passthrough: callers name an
// operation from the closed registry and pass typed parameters. For every
// call it (1) refuses ops outside the registry or outside their freshness
// class, (2) enforces the ordering the authority requires, (3) builds the
// invocation and re-validates its exact shape, (4) runs it, (5) parses and
// projects the output in-process, (6) re-checks the projection against the
// allowlist and the supplemental secret detectors, and only then (7) returns a
// frozen evidence record. Raw provider output is never returned, logged or
// written by this module.

import {
  ANTIGRAVITY_PROJECT, FIXED_PROTECTED_BRANCHES, GH_OWNER, GH_REPO, PRESTATE_VALIDITY, Refusal, getOp,
  type OpDef, type Params,
} from './ops'
import { asXcc1Refusal, assertInvocationSafe, assertProjectionConforms, buildInvocation, project, type Invocation, type ToolContext } from './guards'
import { scanText } from './evidence-scan'
import { SecretDetectedRefusal, localizeFindings, locateFindingsInternal } from './safe-diagnostic'
import { ADJUDICATION_BASIS, ADJUDICATION_CLASSIFICATION, GITHUB_REPOSITORY_NAME_RE, RepositoryInventoryWitness, isRepoId, type WitnessTarget } from './repo-witness'
import { XCC1_PREFLIGHT_ARGS, assertIsolationListing, assertXcc1Env } from './xcc1'
import { assertXcc1NormativeEnv, assertXcc1NormativePreflightArgv, assertXcc1NormativePreflightListing } from './xcc1-normative'

export interface RunResult { readonly status: number | null; readonly stdout: string; readonly stderr: string }
export type ProviderRunner = (inv: Invocation) => RunResult
export type ExecutionMode = 'READ_ONLY_CONTROL_PLANE_PHASE'

export interface EvidenceRecord {
  readonly record_kind: 'GOVERNED_READ_EVIDENCE' | 'PACMI_EVIDENCE'
  readonly op_id: string
  readonly read_id: string
  readonly plane: string
  readonly node_ids: readonly string[]
  readonly freshness: string
  readonly prestate_validity: typeof PRESTATE_VALIDITY
  readonly operation: { readonly tool: string; readonly method: 'GET' | 'CLI_METADATA' | 'GIT_LS_REMOTE'; readonly endpoint?: string; readonly fixed_args?: readonly string[] }
  readonly request_utc: string
  readonly response_utc: string
  readonly http_status: number | null
  readonly outcome: string
  readonly projection: unknown
  readonly absent_fields: readonly { path: string; kind: string }[]
  readonly assertions: Readonly<Record<string, boolean | string>>
  /** v1.0.7: same-run scanner adjudications carried by this record (empty for almost every record). */
  readonly scanner_adjudications: readonly ScannerAdjudication[]
}

export interface ScannerAdjudication {
  readonly normalized_schema_path: 'projects[*].link.repo'
  readonly project_id: string
  readonly detector_id: 'OPAQUE_HIGH_ENTROPY'
  readonly classification: typeof ADJUDICATION_CLASSIFICATION | 'PENDING_SAME_RUN_WITNESS'
  readonly basis: typeof ADJUDICATION_BASIS
}

const VALIDATED = new WeakSet<object>()

// ------------------------------------------------------------- envelope allowlist
//
// SEPARATE from the per-op projection allowlist. The projection allowlist
// governs what may appear INSIDE `projection`; this governs the record that
// carries it. Without it, a raw provider key added to the envelope would be
// serializable whenever its value happened not to trip a secret detector (the
// independent IC's I08 mutant died only because fixtures carried token-shaped
// strings).
export const ENVELOPE_KEYS = [
  'record_kind', 'op_id', 'read_id', 'plane', 'node_ids', 'freshness', 'prestate_validity', 'operation',
  'request_utc', 'response_utc', 'http_status', 'outcome', 'projection', 'absent_fields', 'assertions',
  'scanner_adjudications',
] as const
export const SCANNER_ADJUDICATION_KEYS = ['normalized_schema_path', 'project_id', 'detector_id', 'classification', 'basis'] as const
export const OPERATION_KEYS = ['tool', 'method', 'endpoint', 'fixed_args'] as const
export const ABSENT_FIELD_KEYS = ['path', 'kind'] as const
export const ASSERTION_KEYS = [
  'TI13_full_name_matches', 'rc9b_permission_object_captured', 'branch_resolves', 'pagination_terminal',
  'TI2_link_repo_matches', 'name_matches', 'identity_established',
] as const

function onlyKeys(obj: unknown, allowed: readonly string[], where: string): void {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', `${where} is not an object`)
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', `${where} carries key ${k} outside the envelope allowlist`)
  }
}

export function assertEnvelopeConforms(record: unknown): void {
  onlyKeys(record, ENVELOPE_KEYS, 'record')
  const r = record as Record<string, unknown>
  for (const k of ENVELOPE_KEYS) if (!(k in r)) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', `record lacks ${k}`)
  onlyKeys(r.operation, OPERATION_KEYS, 'record.operation')
  onlyKeys(r.assertions, ASSERTION_KEYS, 'record.assertions')
  for (const v of Object.values(r.assertions as Record<string, unknown>)) {
    if (typeof v !== 'boolean' && typeof v !== 'string') throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', 'assertion value is not scalar')
  }
  if (!Array.isArray(r.absent_fields)) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', 'absent_fields is not an array')
  if (!Array.isArray(r.scanner_adjudications)) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', 'scanner_adjudications is not an array')
  for (const a of r.scanner_adjudications) {
    onlyKeys(a, SCANNER_ADJUDICATION_KEYS, 'record.scanner_adjudications[]')
    const x = a as Record<string, unknown>
    if (r.op_id !== 'V-R2.S2' || x.normalized_schema_path !== 'projects[*].link.repo' || x.detector_id !== 'OPAQUE_HIGH_ENTROPY' ||
      (x.classification !== ADJUDICATION_CLASSIFICATION && x.classification !== 'PENDING_SAME_RUN_WITNESS') || x.basis !== ADJUDICATION_BASIS ||
      typeof x.project_id !== 'string') {
      throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', 'scanner adjudication outside its single permitted form')
    }
  }
  for (const a of r.absent_fields) onlyKeys(a, ABSENT_FIELD_KEYS, 'record.absent_fields[]')
  if (!Array.isArray(r.node_ids) || r.node_ids.some((n) => typeof n !== 'string')) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', 'node_ids malformed')
  for (const k of ['record_kind', 'op_id', 'read_id', 'plane', 'freshness', 'prestate_validity', 'request_utc', 'response_utc', 'outcome']) {
    if (typeof r[k] !== 'string') throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', `${k} is not a string`)
  }
  if (r.http_status !== null && typeof r.http_status !== 'number') throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', 'http_status malformed')
}
export function isValidatedEvidence(r: unknown): boolean {
  return typeof r === 'object' && r !== null && VALIDATED.has(r)
}

export interface Clock { now(): string }
export const systemClock: Clock = { now: () => new Date().toISOString() }

const REPO_FULL_NAME = `${GH_OWNER}/${GH_REPO}`

function statusOf(op: OpDef, res: RunResult): number {
  if (res.status === 0) return 200
  // RECALLED, confirm at execution (RC-8): gh reports "(HTTP 404)" on stderr.
  // Anything unparseable fails closed rather than being read as absence.
  const m = op.tool === 'gh'
    ? /\(HTTP ([0-9]{3})\)/.exec(res.stderr)
    : /(?:status|code|HTTP)[^0-9]{0,12}([45][0-9]{2})\b/i.exec(res.stderr)
  if (!m) throw new Refusal('STOP_PROVIDER_STATUS_UNRESOLVED', `${op.id} failed without a parseable HTTP status`)
  return Number(m[1])
}

function parseJson(op: OpDef, stdout: string): unknown {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { throw new Refusal('STOP_PROVIDER_OUTPUT_UNPARSABLE', `${op.id} returned non-JSON output`) }
  // gh --paginate --slurp over an array endpoint yields an array of pages.
  if (op.ghPaginate && Array.isArray(v) && v.length > 0 && v.every((p) => Array.isArray(p))) v = (v as unknown[][]).flat()
  return v
}

function parseLsRemote(stdout: string): Record<string, unknown> {
  const refs: { name: string; sha: string }[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const m = /^([0-9a-f]{40}|[0-9a-f]{64})\t(\S+)$/.exec(line)
    if (!m) throw new Refusal('STOP_GIT_REF_READ_FAILED', 'unexpected ls-remote line shape')
    refs.push({ sha: m[1], name: m[2] })
  }
  if (refs.length === 0) throw new Refusal('STOP_REF_LISTING_EMPTY_WITNESS_FAILED', 'total ref count is zero')
  const main = refs.find((r) => r.name === 'refs/heads/main')
  return {
    total_ref_count: refs.length,
    refs,
    release_heads: refs.filter((r) => r.name.startsWith('refs/heads/release/')).map((r) => r.name),
    release_tags: refs.filter((r) => r.name.startsWith('refs/tags/release/')).map((r) => r.name),
    main_head: main ? main.sha : null,
  }
}

function get(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj
  for (const seg of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function paginationNext(projection: unknown): string | undefined {
  const n = get(projection, 'pagination.next')
  return typeof n === 'number' || (typeof n === 'string' && n !== '') ? String(n) : undefined
}

function adjudication(projectId: string, classification: ScannerAdjudication['classification']): ScannerAdjudication {
  return { normalized_schema_path: 'projects[*].link.repo', project_id: projectId, detector_id: 'OPAQUE_HIGH_ENTROPY', classification, basis: ADJUDICATION_BASIS }
}

/**
 * v1.0.7: the V-R2.S2 findings that may await the same-run witness, or
 * undefined (-> STOP now, with the certified safe diagnostic). EVERY finding
 * must be OPAQUE_HIGH_ENTROPY at exactly projects[*].link.repo, the leaf itself
 * must trip no other detector, and its project must carry a github link with a
 * numeric repoId, an org and an id. Anything else is not deferrable.
 */
function linkRepoTargets(projection: unknown, serialized: string, hits: readonly { detector: string; offset: number }[]): WitnessTarget[] | undefined {
  const located = locateFindingsInternal(projection, serialized, hits)
  if (!located) return undefined
  const byProject = new Map<number, WitnessTarget>()
  for (const l of located) {
    if (l.detector !== 'OPAQUE_HIGH_ENTROPY' || l.generic !== 'projects[].link.repo' || typeof l.value !== 'string') return undefined
    // v1.0.8: only a value inside GitHub's documented repository-name grammar can await the witness.
    if (!GITHUB_REPOSITORY_NAME_RE.test(l.value)) return undefined
    if (scanText(l.value).some((f) => f.detector !== 'OPAQUE_HIGH_ENTROPY')) return undefined
    const c = l.concrete
    if (c.length !== 4 || c[0] !== 'projects' || typeof c[1] !== 'number' || c[2] !== 'link' || c[3] !== 'repo') return undefined
    const pr = (get(projection, 'projects') as Record<string, unknown>[] | undefined)?.[c[1]]
    const link = pr?.link as Record<string, unknown> | undefined
    if (!pr || !link || typeof pr.id !== 'string' || link.type !== 'github' || !isRepoId(link.repoId) ||
      typeof link.org !== 'string' || link.org === '' || link.repo !== l.value) return undefined
    byProject.set(c[1], { projectId: pr.id, repoId: link.repoId, linkType: link.type, linkRepo: l.value, linkOrg: link.org })
  }
  return byProject.size > 0 ? [...byProject.values()] : undefined
}

export class SafeReadExecutor {
  readonly state = {
    ghRepo: undefined as undefined | { id: unknown; fullName: string },
    rc9bDischarged: false,
    defaultBranch: undefined as string | undefined,
    rulesetIds: new Set<string>(),
    commitShas: new Set<string>(),
    teams: new Set<string>(),
    teamsComplete: false,
    inventory: new Map<string, Map<string, string>>(),
    inventoryComplete: new Set<string>(),
    antigravityIds: new Set<string>(),
    nextUntil: new Map<string, string>(),
    vercelUsername: undefined as string | undefined,
    xcc1PreflightPassed: false,
    executed: [] as string[],
  }

  /** v1.0.7: same-run witness; a new executor (a new execution) always starts empty. */
  readonly witness = new RepositoryInventoryWitness()
  private readonly pendingAdjudications = new Map<EvidenceRecord, readonly WitnessTarget[]>()
  private readonly adjudicatedValues = new Set<string>()
  private witnessPages = 0
  private witnessFirstRequestUtc: string | undefined
  private witnessLastResponseUtc: string | undefined

  constructor(
    private readonly runner: ProviderRunner,
    private readonly ctx: ToolContext,
    private readonly clock: Clock = systemClock,
    readonly mode: ExecutionMode = 'READ_ONLY_CONTROL_PLANE_PHASE',
  ) {}

  /** Key under which the next pagination cursor for an op+scope is held. */
  pageKey(opId: string, p: Params): string {
    return [opId, p.teamId ?? '', p.projectId ?? ''].join('|')
  }

  nextUntilFor(opId: string, p: Params): string | undefined {
    return this.state.nextUntil.get(this.pageKey(opId, p))
  }

  private preconditions(op: OpDef, p: Params): void {
    const s = this.state
    if (op.freshness !== 'EXECUTE_NOW') {
      throw new Refusal('STOP_FRESHNESS_CLASS_NOT_EXECUTABLE_IN_THIS_PHASE', `${op.id} is ${op.freshness}; ${this.mode} may not run it`)
    }
    if (op.cls === 'PACMI') {
      if (op.id === 'PACMI-V3' && !s.vercelUsername) throw new Refusal('STOP_RC9_UNRESOLVED', 'PACMI-V3 requires the PACMI-V1 identity for minimization')
      return
    }
    if (op.plane === 'PLANE-G' && op.id !== 'G-R1') {
      // TI-14: every later GitHub read is bound to the identity G-R1 established.
      if (!s.ghRepo) throw new Refusal('STOP_GR1_NOT_FIRST', `${op.id} before G-R1`)
      if (op.read === 'G-R2' && !s.rc9bDischarged) {
        throw new Refusal('STOP_RC9B_NOT_DISCHARGED', 'G-R2 requires a successful G-R1 with its permission object in this execution context')
      }
      if (p.branch !== undefined) {
        const allowed: string[] = [...FIXED_PROTECTED_BRANCHES]
        if (s.defaultBranch) allowed.push(s.defaultBranch)
        if (!allowed.includes(p.branch)) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'branch is not a governed target')
      }
      if (op.id === 'G-R2.B.DETAIL' && !s.rulesetIds.has(p.rulesetId ?? '')) {
        throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'ruleset id was not returned by the G-R2.B inventory')
      }
      if (op.read === 'G-R4' && !s.commitShas.has(p.sha ?? '')) {
        throw new Refusal('STOP_SHA_IDENTITY_MISMATCH', 'G-R4 SHA has no recorded provenance')
      }
      if (op.id === 'G-R5') {
        // Only for adjudication targets of THIS run, strictly in page order, never after completion.
        if (p.page !== String(this.witness.expectedPage())) throw new Refusal('STOP_PAGINATION_INCOMPLETE', 'G-R5 page is not the next expected page')
        if ([...this.pendingAdjudications.keys()].length === 0) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'G-R5 without a pending adjudication')
      }
    }
    if (op.plane === 'PLANE-V') {
      if (op.id !== 'V-R2.S1') {
        if (!s.teamsComplete) throw new Refusal('STOP_SCOPE_ENUMERATION_INCOMPLETE', `${op.id} before the scope set was enumerated`)
        if (!s.teams.has(p.teamId ?? '')) throw new Refusal('STOP_SCOPE_AMBIGUOUS', 'teamId was not returned by scope enumeration')
      }
      if (['V-R2.L1', 'V-R2.L3', 'V-R2.L5', 'V-R2.L7'].includes(op.id)) {
        const team = p.teamId ?? ''
        const prj = p.projectId ?? ''
        if (!s.inventoryComplete.has(team)) {
          throw new Refusal('STOP_RNA1_BOUNDARY_UNVERIFIABLE', 'role limbs require a complete inventory of the scope first')
        }
        const name = s.inventory.get(team)?.get(prj)
        if (name === undefined) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'project is not in the enumerated inventory')
        // v1.0.4 RNA-1 resolution: V-R2 step_4 covers projects OTHER THAN uellix-antigravity only.
        if (name === ANTIGRAVITY_PROJECT || s.antigravityIds.has(prj)) {
          throw new Refusal('STOP_RNA1_ANTIGRAVITY_EXCLUDED', `${op.id} may not target ${ANTIGRAVITY_PROJECT}`)
        }
      }
    }
    if (p.until !== undefined) {
      const expected = this.nextUntilFor(op.id, p)
      if (expected !== p.until) throw new Refusal('STOP_PAGINATION_INCOMPLETE', 'until is not the cursor the previous page returned')
    }
    if (op.id === 'X-R1' && !s.xcc1PreflightPassed) {
      throw new Refusal('STOP_XCC1_ISOLATION_BREACH', 'X-R1 requires the isolation preflight immediately before it')
    }
  }

  /** Runtime XCC-1 proof: must pass immediately before X-R1 (and for RC-9a PLANE-X). */
  xcc1Preflight(): void {
    const inv: Invocation = { opId: 'XCC-1.PREFLIGHT', tool: 'git', file: 'git', argv: [...XCC1_PREFLIGHT_ARGS], env: this.ctx.xcc1Env, cwd: this.ctx.xcc1Cwd }
    assertXcc1Env(inv.env, inv.cwd!)
    asXcc1Refusal(() => assertXcc1NormativePreflightArgv(inv.argv))
    asXcc1Refusal(() => assertXcc1NormativeEnv(inv.env, inv.cwd!))
    const res = this.runner(inv)
    if (res.status !== 0) throw new Refusal('STOP_XCC1_ISOLATION_BREACH', 'isolation preflight failed to run')
    assertIsolationListing(res.stdout)
    asXcc1Refusal(() => assertXcc1NormativePreflightListing(res.stdout))
    this.state.xcc1PreflightPassed = true
  }

  run(opId: string, params: Params = {}): EvidenceRecord {
    const op = getOp(opId)
    this.preconditions(op, params)
    const inv = buildInvocation(op, params, this.ctx)
    assertInvocationSafe(inv, op, this.ctx)

    const request_utc = this.clock.now()
    const res = this.runner(inv)
    const response_utc = this.clock.now()
    if (op.id === 'X-R1') this.state.xcc1PreflightPassed = false

    let http_status: number | null = null
    let outcome = 'OK'
    let source: unknown
    if (op.tool === 'git') {
      if (res.status !== 0) throw new Refusal('STOP_GIT_REF_READ_FAILED', 'ls-remote exited non-zero')
      source = parseLsRemote(res.stdout)
    } else {
      const status = statusOf(op, res)
      http_status = op.cls === 'PACMI' ? null : status
      if (status !== 200) {
        if (!op.acceptedStatuses?.includes(status)) throw new Refusal('STOP_PROVIDER_ERROR', `${op.id} returned HTTP ${status}`)
        outcome = `HTTP_${status}`
        source = {}
      } else {
        source = parseJson(op, res.stdout)
      }
    }
    if (op.id === 'PACMI-V3') source = this.minimizeMembers(source)

    // G-R5's completion signal is an EMPTY page; an empty array has no allowlisted
    // leaf and would otherwise project to {} (v1.0.7).
    const emptyInventoryPage = op.id === 'G-R5' && Array.isArray(source) && source.length === 0
    const projected = outcome === 'OK' ? project(op, source) : { projection: {} as unknown, absent: [] }
    const absent = projected.absent
    let projection: unknown = projected.projection
    source = undefined // the raw object goes out of scope here and is never serialized
    assertProjectionConforms(op, projection)
    if (op.id === 'G-R5') {
      // v1.0.7: the page is reduced to target matches BEFORE any scan or record;
      // non-matching repositories are discarded here and go nowhere.
      if (outcome !== 'OK') throw new Refusal('STOP_PROVIDER_ERROR', 'G-R5 page did not return 200')
      if (this.witnessFirstRequestUtc === undefined) this.witnessFirstRequestUtc = request_utc
      this.witnessLastResponseUtc = response_utc
      projection = this.witness.ingestPage(Number(params.page), emptyInventoryPage ? [] : projection)
      this.witnessPages++
    }
    const serialized = JSON.stringify(projection)
    const hits = scanText(serialized)
    let deferred: WitnessTarget[] | undefined
    if (hits.length > 0) {
      // v1.0.7: exactly ONE finding class may be deferred to the same-run witness.
      deferred = op.id === 'V-R2.S2' ? linkRepoTargets(projection, serialized, hits) : undefined
      // The decision above is unchanged; the diagnostic only names the field class (v1.0.6).
      if (!deferred) throw new SecretDetectedRefusal(op, [...new Set(hits.map((h) => h.detector))], localizeFindings(op, projection, serialized, hits))
    }

    const assertions = this.postconditions(op, params, projection, outcome)
    this.state.executed.push(op.id)
    const record: EvidenceRecord = Object.freeze({
      record_kind: op.cls === 'PACMI' ? 'PACMI_EVIDENCE' : 'GOVERNED_READ_EVIDENCE',
      op_id: op.id,
      read_id: op.read,
      plane: op.plane,
      node_ids: [...op.nodeIds],
      freshness: op.freshness,
      prestate_validity: PRESTATE_VALIDITY,
      operation: Object.freeze(
        op.tool === 'git'
          ? { tool: 'git', method: 'GIT_LS_REMOTE' as const, fixed_args: [...op.fixedArgs!] }
          : op.fixedArgs
            ? { tool: op.tool, method: 'CLI_METADATA' as const, fixed_args: [...op.fixedArgs] }
            : { tool: op.tool, method: 'GET' as const, endpoint: inv.endpoint },
      ),
      request_utc,
      response_utc,
      http_status,
      outcome,
      projection,
      absent_fields: absent,
      assertions: Object.freeze(assertions),
      scanner_adjudications: Object.freeze((deferred ?? []).map((t) => Object.freeze(adjudication(t.projectId, 'PENDING_SAME_RUN_WITNESS')))),
    })
    assertEnvelopeConforms(record)
    if (deferred) {
      // NOT validated: an unadjudicated record can never be written as evidence.
      for (const t of deferred) this.witness.addTarget(t)
      this.pendingAdjudications.set(record, deferred)
      return record
    }
    VALIDATED.add(record)
    return record
  }

  hasPendingAdjudications(): boolean {
    return this.pendingAdjudications.size > 0
  }

  /** Same-run exact value lookup for the entry point's evidence re-scan. In memory only. */
  isAdjudicatedValue(value: string): boolean {
    return this.adjudicatedValues.has(value)
  }

  /**
   * v1.0.7: after the G-R5 traversal completes, render the witness verdict
   * (throws on ANY failure), return the G-R5 witness record (matched id and
   * owner.login only, never the repository name), and replace every pending
   * V-R2.S2 record by its adjudicated, validated form.
   */
  finalizeRepositoryWitness(): { readonly witnessRecord: EvidenceRecord; readonly replacements: ReadonlyMap<EvidenceRecord, EvidenceRecord> } {
    const verdict = this.witness.verdict()
    const op = getOp('G-R5')
    const projection = { pages_traversed: this.witnessPages, terminal: 'EMPTY_PAGE', matched: verdict.resolved }
    const serialized = JSON.stringify(projection)
    const hits = scanText(serialized)
    if (hits.length > 0) throw new SecretDetectedRefusal(op, [...new Set(hits.map((h) => h.detector))], localizeFindings(op, projection, serialized, hits))
    const witnessRecord: EvidenceRecord = Object.freeze({
      record_kind: 'GOVERNED_READ_EVIDENCE', op_id: op.id, read_id: op.read, plane: op.plane, node_ids: [...op.nodeIds],
      freshness: op.freshness, prestate_validity: PRESTATE_VALIDITY,
      operation: Object.freeze({ tool: 'gh', method: 'GET' as const, endpoint: `/user/repos?per_page=100&page=1..${this.witnessPages}` }),
      request_utc: this.witnessFirstRequestUtc ?? this.clock.now(), response_utc: this.witnessLastResponseUtc ?? this.clock.now(),
      http_status: 200, outcome: 'OK', projection, absent_fields: [],
      assertions: Object.freeze({ identity_established: true }),
      scanner_adjudications: Object.freeze([]),
    })
    assertEnvelopeConforms(witnessRecord)
    const adjudicatedProjects = new Set(verdict.adjudicated.map((t) => t.projectId))
    const replacements = new Map<EvidenceRecord, EvidenceRecord>()
    for (const [pending, targets] of this.pendingAdjudications) {
      if (!targets.every((t) => adjudicatedProjects.has(t.projectId))) throw new Refusal('STOP_WITNESS_UNKNOWN', 'a pending V-R2.S2 location was not adjudicated')
      const resolved: EvidenceRecord = Object.freeze({
        ...pending,
        scanner_adjudications: Object.freeze(targets.map((t) => Object.freeze(adjudication(t.projectId, ADJUDICATION_CLASSIFICATION)))),
      })
      assertEnvelopeConforms(resolved)
      VALIDATED.add(resolved)
      replacements.set(pending, resolved)
    }
    for (const t of verdict.adjudicated) this.adjudicatedValues.add(t.linkRepo)
    this.pendingAdjudications.clear()
    VALIDATED.add(witnessRecord)
    return { witnessRecord, replacements }
  }

  private minimizeMembers(source: unknown): unknown {
    const members = get(source, 'members')
    if (!Array.isArray(members)) return { members: [] }
    return { members: members.filter((m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>).username === this.state.vercelUsername) }
  }

  private postconditions(op: OpDef, p: Params, proj: unknown, outcome: string): Record<string, boolean | string> {
    const s = this.state
    const a: Record<string, boolean | string> = {}
    const trackPage = (complete: () => void) => {
      const key = this.pageKey(op.id, p)
      const next = paginationNext(proj)
      if (next !== undefined) s.nextUntil.set(key, next)
      else { s.nextUntil.delete(key); complete() }
      a.pagination_terminal = next === undefined
    }
    switch (op.id) {
      case 'G-R1': {
        const full = get(proj, 'full_name')
        if (full !== REPO_FULL_NAME) throw new Refusal('STOP_REPOSITORY_IDENTITY_MISMATCH', 'G-R1 full_name is not the governed repository')
        s.ghRepo = { id: get(proj, 'id'), fullName: REPO_FULL_NAME }
        const perms = get(proj, 'permissions')
        const captured = typeof perms === 'object' && perms !== null && Object.values(perms).some((v) => typeof v === 'boolean')
        s.rc9bDischarged = captured
        a.TI13_full_name_matches = true
        a.rc9b_permission_object_captured = captured
        break
      }
      case 'G-R3': {
        if (get(proj, 'full_name') !== REPO_FULL_NAME) throw new Refusal('STOP_REPOSITORY_IDENTITY_MISMATCH', 'G-R3 full_name drifted')
        const db = get(proj, 'default_branch')
        if (typeof db !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(db)) throw new Refusal('STOP_DEFAULT_BRANCH_UNRESOLVED', 'default_branch absent or malformed')
        if (s.defaultBranch !== undefined && s.defaultBranch !== db) throw new Refusal('STOP_DEFAULT_BRANCH_CHANGED_MID_LANE', 'default branch changed within the lane')
        s.defaultBranch = db
        break
      }
      case 'G-R2.WITNESS':
        a.branch_resolves = outcome === 'OK' && get(proj, 'name') === p.branch
        break
      case 'G-R2.B':
        if (Array.isArray(proj)) for (const r of proj) {
          const id = (r as Record<string, unknown>).id
          if (typeof id === 'number' || typeof id === 'string') s.rulesetIds.add(String(id))
        }
        break
      case 'V-R2.S1':
        for (const t of (get(proj, 'teams') as unknown[] | undefined) ?? []) {
          const id = (t as Record<string, unknown>).id
          if (typeof id === 'string') s.teams.add(id)
        }
        trackPage(() => { s.teamsComplete = true })
        break
      case 'V-R2.S2': {
        const team = p.teamId!
        const inv = s.inventory.get(team) ?? new Map<string, string>()
        for (const pr of (get(proj, 'projects') as unknown[] | undefined) ?? []) {
          const r = pr as Record<string, unknown>
          if (typeof r.id === 'string' && typeof r.name === 'string') {
            inv.set(r.id, r.name)
            if (r.name === ANTIGRAVITY_PROJECT) s.antigravityIds.add(r.id)
          }
        }
        s.inventory.set(team, inv)
        trackPage(() => { s.inventoryComplete.add(team) })
        break
      }
      case 'V-R1':
      case 'V-R3': {
        const id = get(proj, 'id')
        if (typeof id === 'string') s.antigravityIds.add(id)
        // v1.0.7 TI-2: the Vercel link TUPLE against the governed GitHub identity G-R1
        // established in THIS run (link.repo is the repository NAME; the owner is link.org).
        const ti2 = get(proj, 'link.type') === 'github' && get(proj, 'link.org') === GH_OWNER && get(proj, 'link.repo') === GH_REPO &&
          isRepoId(get(proj, 'link.repoId')) && s.ghRepo !== undefined && get(proj, 'link.repoId') === s.ghRepo.id
        a.TI2_link_repo_matches = ti2
        if (op.id === 'V-R1' && !ti2) throw new Refusal('STOP_PROJECT_IDENTITY_MISMATCH', 'TI-2: the Vercel link tuple is not the governed repository')
        a.name_matches = get(proj, 'name') === ANTIGRAVITY_PROJECT
        break
      }
      case 'V-R2.L1': case 'V-R2.L3': case 'V-R2.L5': case 'V-R2.L7':
        trackPage(() => undefined)
        break
      case 'PACMI-V1': {
        const u = get(proj, 'username')
        if (typeof u === 'string' && u !== '') s.vercelUsername = u
        a.identity_established = typeof u === 'string' && u !== ''
        break
      }
    }
    return a
  }
}
