// scripts/ops/closure-state.ts — CV1 closure-state projection + RUN_STATE validator.
//
//   pnpm ops:closure-state -- validate [--state <p>] [--now <iso>] [--previous <p> | --previous-ref <ref>]
//                                      [--genesis] [--verify-git] [--json]
//   pnpm ops:closure-state -- ci --base <ref> [--json]
//   pnpm ops:closure-state -- digest --ref <sha> --path <p> [--path <p> ...]
//   pnpm ops:closure-state -- run-state --file <p> [--repo <dir> --lane <L> --role <R> --branch <B> --base <SHA> [--candidate <SHA>]] [--json]
//   pnpm ops:closure-state -- run-state-root [--lane <L>]
//
// Path class authorized by docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.39.json
// (CV1-DEVOS R1 and its R2 successor only).
//
// docs/ops/ods/CV1_CLOSURE_STATE.json is a MUTABLE DERIVED PROJECTION, not
// authority. Each record points at evidence; this tool never decides a
// closure. It refuses projections whose claims are not supported by what
// they point at, and revisions that erase history.
//
// Layers, each fail-closed:
//   1. structural — the JSON Schema subset of CV1_CLOSURE_STATE_SCHEMA_v1.1.0.json;
//   2. vocabulary — every semantic token set is READ from that schema
//      (x-vocabulary, x-transition-graph) and checked against its enums;
//      nothing here re-lists an enum;
//   3. semantic — hermetic rules (injected `now`, no git);
//   4. transition — against the previous projection (monotonic history);
//   5. git (--verify-git) — re-derives every SHA-bound claim and every
//      durable evidence value from the local repository.
// Anything unreadable is a failure, never a silent pass.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { readBlobAtRef, readDotPath, isAncestor, pathExistsAtRef } from '../ods-program-state'

export const CLOSURE_STATE_PATH = 'docs/ops/ods/CV1_CLOSURE_STATE.json'
export const CLOSURE_STATE_SCHEMA_PATH = 'docs/ops/ods/CV1_CLOSURE_STATE_SCHEMA_v1.1.0.json'
export const RUN_STATE_SCHEMA_PATH = 'docs/ops/ods/ODS_RUN_STATE_SCHEMA_v1.1.0.json'
export const RELEASE_GATE_LEDGER_PATH = 'docs/ops/release/RELEASE_GATE_LEDGER_v1.0.0.json'
/** The only earlier projection schema a --previous may use (migration checks). */
export const MIGRATABLE_PREVIOUS_SCHEMA = '1.0.0'

export interface Issue {
  rule: string
  path: string
  message: string
}

type Schema = Record<string, unknown>

// ---------------------------------------------------------------------------
// 1. Structural layer — a deliberately small JSON Schema subset.
// ---------------------------------------------------------------------------

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'enum', 'const', 'required',
  'properties', 'additionalProperties', 'items', 'pattern', 'minLength', 'minItems', 'minimum',
])

export function validateSchema(root: Schema, value: unknown, schema: Schema = root, at = '$'): Issue[] {
  const issues: Issue[] = []
  const fail = (message: string) => issues.push({ rule: 'SCHEMA', path: at, message })
  for (const key of Object.keys(schema)) {
    // An unsupported keyword would be silently ignored — refuse instead.
    if (!SUPPORTED_KEYWORDS.has(key) && !key.startsWith('x-')) fail(`unsupported schema keyword '${key}'`)
  }
  if (typeof schema.$ref === 'string') {
    const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref)
    const target = m ? (root.$defs as Record<string, Schema> | undefined)?.[m[1]] : undefined
    if (!target) return [{ rule: 'SCHEMA', path: at, message: `unresolvable $ref ${schema.$ref}` }]
    return validateSchema(root, value, target, at)
  }
  const actual = typeOf(value)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
    if (!types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) {
      fail(`expected type ${types.join('|')}, got ${actual}`)
      return issues
    }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    fail(`expected constant ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    fail(`unknown value ${JSON.stringify(value)}; allowed: ${(schema.enum as unknown[]).join(', ')}`)
  }
  if (actual === 'string') {
    const s = value as string
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(s)) fail(`does not match ${schema.pattern}`)
    if (typeof schema.minLength === 'number' && s.length < schema.minLength) fail(`shorter than ${schema.minLength}`)
  }
  if ((actual === 'integer' || actual === 'number') && typeof schema.minimum === 'number' && (value as number) < schema.minimum) {
    fail(`below minimum ${schema.minimum}`)
  }
  if (actual === 'array') {
    const arr = value as unknown[]
    if (typeof schema.minItems === 'number' && arr.length < schema.minItems) fail(`fewer than ${schema.minItems} items`)
    if (schema.items && typeof schema.items === 'object') {
      arr.forEach((item, i) => issues.push(...validateSchema(root, item, schema.items as Schema, `${at}[${i}]`)))
    }
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, Schema>
    for (const req of (schema.required ?? []) as string[]) {
      if (!(req in obj)) fail(`missing required field '${req}'`)
    }
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) issues.push(...validateSchema(root, v, props[k], `${at}.${k}`))
      else if (schema.additionalProperties === false) fail(`unknown field '${k}'`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        issues.push(...validateSchema(root, v, schema.additionalProperties as Schema, `${at}.${k}`))
      }
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// 2. Vocabulary — read from the schema, checked against its own enums.
// ---------------------------------------------------------------------------

interface Edge {
  to: string
  basis_classes: string[]
  basis_ref: string | null
  requires_dependencies?: boolean
  requires_no_open_findings?: boolean
}

export interface Vocab {
  ladder: string[]
  passStatuses: Set<string>
  statusForOutcome: Record<string, string>
  passOutcomes: Set<string>
  positiveTokens: string[]
  negativeTokens: string[]
  uncertifiedStatuses: Set<string>
  unboundStatuses: Set<string>
  implSatisfied: Set<string>
  durableClasses: Set<string>
  executedEvidenceClasses: Set<string>
  integratedStatus: string
  notIntegratedStatus: string
  notImplementedStatus: string
  integrationScope: string
  integratedEvidenceScope: string
  independentKind: string
  openFinding: string
  resolvingFinding: Set<string>
  supersededFinding: string
  bindingKind: string
  ttl: string
  repositoryClass: string
  observationClass: string
  certificationClass: string
  humanDecisionClass: string
  inferenceClass: string
  authoredState: string
  certifiedState: string
  materializedState: string
  executionState: string
  executedState: string
  evidencedState: string
  closedState: string
  initialStates: Set<string>
  forward: Record<string, Edge>
  authoredBasis: Set<string>
  rebindStates: Set<string>
  genesisForbidden: Set<string>
  newRecordMax: string
  depMaxApplies: string
}

export class SchemaConsistencyError extends Error {}

export function loadVocabulary(schema: Schema): Vocab {
  const defs = schema.$defs as Record<string, Schema>
  const enumOf = (name: string): unknown[] => {
    const e = defs[name]?.enum
    if (!Array.isArray(e)) throw new SchemaConsistencyError(`$defs.${name} has no enum`)
    return e
  }
  const v = schema['x-vocabulary'] as Record<string, unknown>
  const binding = schema['x-vocabulary-enums'] as Record<string, string>
  const g = schema['x-transition-graph'] as Record<string, unknown>
  if (!v || !binding || !g) throw new SchemaConsistencyError('schema lacks x-vocabulary / x-vocabulary-enums / x-transition-graph')
  const TOKEN_LISTS = new Set(['positive_verdict_tokens', 'negative_verdict_tokens'])
  for (const key of Object.keys(v)) {
    if (!TOKEN_LISTS.has(key) && !(key in binding)) throw new SchemaConsistencyError(`x-vocabulary.${key} is not bound to an enum in x-vocabulary-enums`)
  }
  for (const [key, enumName] of Object.entries(binding)) {
    const allowed = enumOf(enumName)
    const raw = v[key]
    const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [raw]
    for (const x of values) {
      if (!allowed.includes(x)) throw new SchemaConsistencyError(`x-vocabulary.${key} value ${JSON.stringify(x)} is not in $defs.${enumName}`)
    }
  }
  const outcomes = enumOf('certification_outcome') as string[]
  const sfo = v.status_for_outcome as Record<string, string>
  if (JSON.stringify(Object.keys(sfo).sort()) !== JSON.stringify([...outcomes].sort())) {
    throw new SchemaConsistencyError('x-vocabulary.status_for_outcome must cover exactly the certification_outcome enum')
  }
  const outcomeTokens = new Set(outcomes.flatMap((o) => o.split('_')))
  for (const t of [...(v.positive_verdict_tokens as string[]), ...(v.negative_verdict_tokens as string[])]) {
    if (!outcomeTokens.has(t)) throw new SchemaConsistencyError(`verdict token ${t} is not a token of any certification_outcome`)
  }
  const ladder = enumOf('lifecycle_state') as string[]
  const lifecycleSet = new Set(ladder)
  const evidenceClasses = new Set(enumOf('evidence_class') as string[])
  const forward = g.forward as Record<string, Edge>
  for (let i = 0; i < ladder.length - 1; i++) {
    const edge = forward[ladder[i]]
    if (!edge || edge.to !== ladder[i + 1]) throw new SchemaConsistencyError(`x-transition-graph.forward.${ladder[i]} must lead to ${ladder[i + 1]}`)
    for (const c of edge.basis_classes) if (!evidenceClasses.has(c)) throw new SchemaConsistencyError(`forward.${ladder[i]} basis class ${c} unknown`)
  }
  if (Object.keys(forward).length !== ladder.length - 1) throw new SchemaConsistencyError('x-transition-graph.forward must have exactly one edge per non-final state')
  const statesIn = (key: string): string[] => {
    const arr = Array.isArray(g[key]) ? (g[key] as string[]) : [g[key] as string]
    for (const s of arr) if (!lifecycleSet.has(s)) throw new SchemaConsistencyError(`x-transition-graph.${key} value ${s} is not a lifecycle_state`)
    return arr
  }
  for (const c of g.authored_basis_classes as string[]) if (!evidenceClasses.has(c)) throw new SchemaConsistencyError(`authored basis class ${c} unknown`)
  for (const [name, def] of Object.entries(defs)) {
    const target = def['x-shape-equals']
    if (typeof target === 'string') {
      const t = defs[target]
      if (!t || JSON.stringify(t.properties) !== JSON.stringify(def.properties) || JSON.stringify(t.required) !== JSON.stringify(def.required)) {
        throw new SchemaConsistencyError(`$defs.${name} must have the same shape as $defs.${target}`)
      }
    }
  }
  return {
    ladder,
    passStatuses: new Set(v.pass_statuses as string[]),
    statusForOutcome: sfo,
    passOutcomes: new Set(v.pass_outcomes as string[]),
    positiveTokens: v.positive_verdict_tokens as string[],
    negativeTokens: v.negative_verdict_tokens as string[],
    uncertifiedStatuses: new Set(v.uncertified_statuses as string[]),
    unboundStatuses: new Set(v.unbound_certification_statuses as string[]),
    implSatisfied: new Set(v.implementation_satisfied as string[]),
    durableClasses: new Set(v.durable_classes as string[]),
    executedEvidenceClasses: new Set(v.executed_evidence_classes as string[]),
    integratedStatus: v.integrated_status as string,
    notIntegratedStatus: v.not_integrated_status as string,
    notImplementedStatus: v.not_implemented_status as string,
    integrationScope: v.integration_certification_scope as string,
    integratedEvidenceScope: v.integrated_evidence_scope as string,
    independentKind: v.independent_kind as string,
    openFinding: v.open_finding_status as string,
    resolvingFinding: new Set(v.resolving_finding_statuses as string[]),
    supersededFinding: v.superseded_finding_status as string,
    bindingKind: v.binding_invalidator_kind as string,
    ttl: v.ttl_freshness as string,
    repositoryClass: v.repository_class as string,
    observationClass: v.observation_class as string,
    certificationClass: v.certification_class as string,
    humanDecisionClass: v.human_decision_class as string,
    inferenceClass: v.inference_class as string,
    authoredState: v.authored_state as string,
    certifiedState: v.certified_state as string,
    materializedState: v.materialized_state as string,
    executionState: v.execution_state as string,
    executedState: v.executed_state as string,
    evidencedState: v.evidenced_state as string,
    closedState: v.closed_state as string,
    initialStates: new Set(statesIn('initial_states')),
    forward,
    authoredBasis: new Set(g.authored_basis_classes as string[]),
    rebindStates: new Set(statesIn('rebind_states')),
    genesisForbidden: new Set(statesIn('genesis_forbidden_final_states')),
    newRecordMax: statesIn('new_record_max_final_state')[0],
    depMaxApplies: statesIn('dependency_max_applies_from_state')[0],
  }
}

// ---------------------------------------------------------------------------
// Types of a structurally valid projection.
// ---------------------------------------------------------------------------

export interface EvidenceItem {
  fact_id: string
  class: string
  claim: string
  ref?: string
  path?: string
  field?: string
  value?: unknown
  observation_id?: string
  source?: string
  derived_from?: string[]
  scope?: string
}

export interface InvalidatorTarget {
  certification_id?: string
  candidate_sha?: string
  observation_id?: string
}

export interface Invalidator {
  predicate_id: string
  kind: string
  fired: boolean
  fired_at: string | null
  target: InvalidatorTarget | null
  description: string
}

export interface Certification {
  certification_id: string
  kind: string
  verdict: string
  outcome: string
  scope: string
  certified_sha: string
  certified_authority_version: string | null
  certified_package_digest: string | null
  evidence_fact_id: string
}

export interface HistoryEntry {
  to: string
  at_revision: number
  candidate_sha: string | null
  basis_fact_ids: string[]
  invalidator_id?: string
}

export interface Dependency {
  gate_id: string
  required_state: string
  applies_from_state: string
  rationale: string
}

export interface Finding {
  finding_id: string
  status: string
  summary: string
  evidence_fact_id?: string
  resolution_fact_id?: string
  superseded_by?: string
}

export interface ClosureRecord {
  gate_id: string
  milestone: string
  lifecycle_state: string
  lifecycle_history: HistoryEntry[]
  implementation_status: string
  integration_status: string
  candidate_sha: string | null
  tree_sha: string | null
  lineage_shas: { materialization?: string; evidence_head?: string }
  authority: { path: string; ref: string } | null
  authority_version: string | null
  certification: Certification | null
  certification_history: Certification[]
  certification_status: string
  certification_inherits_from: { certification_id: string; from_sha: string; rationale: string } | null
  covered_paths: string[]
  covered_package_digest: string | null
  evidence: EvidenceItem[]
  evidence_freshness: string
  evidence_expires_at: string | null
  observed_at: string | null
  invalidated_by: Invalidator[]
  dependencies: Dependency[]
  blocking_findings: Finding[]
  branch: string | null
  pr: number | null
  execution_allowed: boolean
  risk_tier: string
  next_legal_act: string
  unconfirmed: unknown[]
  notes?: string
}

export interface Observation {
  observation_id: string
  observed_at: string
  provider: string
  surface: string
  projection: string
  observed_by: string
  result_ref?: string
  result_path?: string
  consumers: string[]
  freshness_class: string
  expires_at: string | null
  invalidated_by: Invalidator[]
}

export interface ClosureState {
  state_id: string
  schema_version: string
  revision: number
  as_of: string
  integration_base: { branch: string; sha: string; tree_sha: string }
  records: ClosureRecord[]
  observations: Observation[]
  unconfirmed: unknown[]
}

// ---------------------------------------------------------------------------
// Secrets — keys and values; matched values are never printed.
// ---------------------------------------------------------------------------

const SECRET_KEY = /(^|[_-])(password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|secret[_-]?key|credentials?|authorization|auth[_-]?header|bearer|cookie|session[_-]?id|connection[_-]?string|dsn)([_-]|$)/i

const SECRET_PATTERNS: [string, RegExp][] = [
  ['connection-uri-with-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['supabase-key', /\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/],
  ['supabase-access-token', /\bsbp_[A-Za-z0-9]{20,}/],
  ['aws-access-key-id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['bearer-token', /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/i],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['assigned-credential', /\b(password|passwd|pwd|api[_-]?key|secret|token)\s*[=:]\s*["']?[A-Za-z0-9_\-+/]{12,}/i],
]

export function scanSecrets(value: unknown, at = '$'): Issue[] {
  const issues: Issue[] = []
  const walk = (v: unknown, p: string) => {
    if (typeof v === 'string') {
      for (const [name, re] of SECRET_PATTERNS) {
        if (re.test(v)) issues.push({ rule: 'NO_SECRET_MATERIAL', path: p, message: `string matches ${name} shape (value withheld)` })
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`))
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_KEY.test(k)) issues.push({ rule: 'NO_SECRET_MATERIAL', path: p, message: `secret-bearing key '${k}' (value withheld)` })
        walk(x, `${p}.${k}`)
      }
    }
  }
  walk(value, at)
  return issues
}

// ---------------------------------------------------------------------------
// 3. Semantic layer.
// ---------------------------------------------------------------------------

function ms(iso: string): number {
  return Date.parse(iso)
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** DURABLE_SOURCE: repository-backed, mechanically re-checkable (ref, path, field AND value). */
export function isDurable(e: EvidenceItem | undefined, vocab: Vocab): boolean {
  return !!e && vocab.durableClasses.has(e.class) && !!e.ref && !!e.path && e.field !== undefined && e.value !== undefined
}

/** Token-level agreement, never substring: the verdict's LAST tokens are the outcome's tokens, and PASS never mixes with a negative token. */
export function verdictAgreesWithOutcome(verdict: string, outcome: string, vocab: Vocab): boolean {
  const vt = verdict.split('_')
  const ot = outcome.split('_')
  if (vt.length < ot.length || !deepEqual(vt.slice(vt.length - ot.length), ot)) return false
  const forbidden = vocab.passOutcomes.has(outcome) ? vocab.negativeTokens : vocab.positiveTokens
  return !vt.some((t) => forbidden.includes(t))
}

function targets(v: Invalidator, c: Certification | null, candidate: string | null): boolean {
  if (!v.fired || !v.target) return false
  return (!!c && v.target.certification_id === c.certification_id) ||
    (!!c && v.target.candidate_sha === c.certified_sha) ||
    (!!candidate && v.target.candidate_sha === candidate)
}

export interface SemanticOptions {
  now: string
  genesis?: boolean
}

export function validateSemantics(state: ClosureState, vocab: Vocab, opts: SemanticOptions): Issue[] {
  const issues: Issue[] = []
  const add = (rule: string, p: string, message: string) => issues.push({ rule, path: p, message })
  const idx = (s: string) => vocab.ladder.indexOf(s)
  const AUTHORED = idx(vocab.authoredState)
  const CERT = idx(vocab.certifiedState)
  const MATERIALIZED = idx(vocab.materializedState)
  const ARMED = idx(vocab.executionState)
  const EXECUTED = idx(vocab.executedState)
  const EVIDENCED = idx(vocab.evidencedState)
  const nowMs = ms(opts.now)
  if (Number.isNaN(nowMs)) return [{ rule: 'INPUT', path: 'now', message: `unparseable now '${opts.now}'` }]

  // REFERENCES — ids and cross-links.
  const byId = new Map<string, ClosureRecord>()
  state.records.forEach((r, i) => {
    if (byId.has(r.gate_id)) add('REFERENCES', `records[${i}].gate_id`, `duplicate gate_id ${r.gate_id}`)
    byId.set(r.gate_id, r)
  })
  const obsById = new Map<string, Observation>()
  const readKeys = new Map<string, string>()
  const checkInvalidator = (v: Invalidator, p: string) => {
    if (v.fired && (!v.fired_at || !v.target || Object.keys(v.target).length === 0)) {
      add('FIRED_INVALIDATOR', p, `fired invalidator ${v.predicate_id} needs fired_at and a non-empty target`)
    }
    if (!v.fired && v.fired_at) add('FIRED_INVALIDATOR', p, `unfired invalidator ${v.predicate_id} carries fired_at`)
  }
  state.observations.forEach((o, i) => {
    const p = `observations[${i}]`
    if (obsById.has(o.observation_id)) add('REFERENCES', p, `duplicate observation_id ${o.observation_id}`)
    obsById.set(o.observation_id, o)
    const key = [o.provider, o.surface, o.projection, o.observed_at].join('\u0000')
    const prior = readKeys.get(key)
    if (prior) add('REFERENCES', p, `observation duplicates the same provider read as ${prior}; record it once with several consumers`)
    readKeys.set(key, o.observation_id)
    for (const c of o.consumers) if (!byId.has(c)) add('REFERENCES', `${p}.consumers`, `unknown consumer ${c}`)
    if (o.freshness_class === vocab.ttl && !o.expires_at) add('FRESHNESS', p, 'TTL observation requires expires_at')
    if (o.freshness_class !== vocab.ttl && o.expires_at) add('FRESHNESS', p, 'expires_at is only meaningful for TTL freshness')
    o.invalidated_by.forEach((v, j) => checkInvalidator(v, `${p}.invalidated_by[${j}]`))
  })
  const citedBy = new Map<string, Set<string>>()

  state.records.forEach((r, i) => {
    const p = `records[${i}](${r.gate_id})`
    const li = idx(r.lifecycle_state)
    const facts = new Map<string, EvidenceItem>()

    // EVIDENCE_CLASS and references.
    r.evidence.forEach((e, j) => {
      const ep = `${p}.evidence[${j}]`
      if (facts.has(e.fact_id)) add('REFERENCES', ep, `duplicate fact_id ${e.fact_id}`)
      facts.set(e.fact_id, e)
      if (e.class === vocab.repositoryClass && (!e.ref || !e.path)) add('EVIDENCE_CLASS', ep, `${vocab.repositoryClass} requires ref and path`)
      if (e.class === vocab.observationClass) {
        if (!e.observation_id) add('EVIDENCE_CLASS', ep, `${vocab.observationClass} requires observation_id`)
        else if (!obsById.has(e.observation_id)) add('REFERENCES', ep, `unknown observation ${e.observation_id}`)
      }
      if (e.observation_id) {
        const set = citedBy.get(e.observation_id) ?? new Set<string>()
        set.add(r.gate_id)
        citedBy.set(e.observation_id, set)
      }
      if (e.class === vocab.inferenceClass && !(e.derived_from && e.derived_from.length > 0)) add('EVIDENCE_CLASS', ep, `${vocab.inferenceClass} requires derived_from`)
      if ((e.class === vocab.humanDecisionClass || e.class === vocab.certificationClass) && !e.source && !(e.ref && e.path)) {
        add('EVIDENCE_CLASS', ep, `${e.class} requires source or ref+path`)
      }
      if (e.field !== undefined && (!e.ref || !e.path)) add('EVIDENCE_CLASS', ep, 'field requires ref and path')
      if (e.scope === vocab.integratedEvidenceScope && r.integration_status !== vocab.integratedStatus) {
        add('CERTIFICATION_SCOPE', ep, `evidence scoped ${e.scope} on a record whose integration_status is ${r.integration_status}; branch-local facts must not be presented as integrated`)
      }
    })
    r.invalidated_by.forEach((v, j) => checkInvalidator(v, `${p}.invalidated_by[${j}]`))
    const invById = new Map(r.invalidated_by.map((v) => [v.predicate_id, v]))
    if (invById.size !== r.invalidated_by.length) add('REFERENCES', `${p}.invalidated_by`, 'duplicate predicate_id')

    // SHA_BINDING.
    if (li >= AUTHORED) {
      if (!r.candidate_sha) add('SHA_BINDING', p, `${r.lifecycle_state} is SHA-bound: candidate_sha required`)
      if (!r.tree_sha) add('SHA_BINDING', p, `${r.lifecycle_state} is SHA-bound: tree_sha required`)
      if (!r.authority) add('SHA_BINDING', p, `${r.lifecycle_state} requires authority`)
      if (!r.authority_version) add('SHA_BINDING', p, `${r.lifecycle_state} requires authority_version`)
    }
    if (li >= MATERIALIZED && !r.lineage_shas.materialization) add('SHA_BINDING', p, `${r.lifecycle_state} requires lineage_shas.materialization`)
    if (li >= EVIDENCED && !r.lineage_shas.evidence_head) add('SHA_BINDING', p, `${r.lifecycle_state} requires lineage_shas.evidence_head`)
    if (r.covered_package_digest && r.covered_paths.length === 0) add('SHA_BINDING', p, 'covered_package_digest without covered_paths')

    // CERTIFICATION_COHERENCE.
    const certIds = new Set<string>()
    r.certification_history.forEach((c, j) => {
      const cp = `${p}.certification_history[${j}]`
      if (certIds.has(c.certification_id)) add('CERTIFICATION_COHERENCE', cp, `duplicate certification_id ${c.certification_id}; a new certification needs a NEW id`)
      certIds.add(c.certification_id)
      if (c.kind !== vocab.independentKind) add('CERTIFICATION_COHERENCE', cp, `a ${c.kind} certification cannot enter certification_history; only ${vocab.independentKind}`)
      const ev = facts.get(c.evidence_fact_id)
      if (!ev || ev.class !== vocab.certificationClass || !isDurable(ev, vocab)) {
        add('DURABLE_SOURCE', cp, `certification ${c.certification_id} needs a durable ${vocab.certificationClass} evidence item (ref, path, field, value); '${c.evidence_fact_id}' is not`)
      } else if (!deepEqual(ev.value, c.verdict)) {
        add('CERTIFICATION_COHERENCE', cp, `verdict ${c.verdict} differs from the value its evidence ${ev.fact_id} records`)
      }
      if (!verdictAgreesWithOutcome(c.verdict, c.outcome, vocab)) {
        add('CERTIFICATION_COHERENCE', cp, `outcome ${c.outcome} does not agree token-wise with verdict ${c.verdict}`)
      }
      if (c.scope === vocab.integrationScope && r.integration_status !== vocab.integratedStatus) {
        add('CERTIFICATION_SCOPE', cp, `branch-local certification presented as ${vocab.integrationScope} (integration_status ${r.integration_status})`)
      }
    })
    const last = r.certification_history.length > 0 ? r.certification_history[r.certification_history.length - 1] : null
    if (!deepEqual(r.certification, last)) {
      add('CERTIFICATION_COHERENCE', p, 'certification must equal the LAST certification_history entry (null only when the history is empty); an older certification cannot be restored')
    }
    const status = r.certification_status
    const passStatus = vocab.passStatuses.has(status)
    const inh = r.certification_inherits_from
    if (!last) {
      if (!vocab.uncertifiedStatuses.has(status)) add('CERTIFICATION_COHERENCE', p, `certification_status ${status} without any certification in certification_history`)
    } else {
      const firedAgainst = r.invalidated_by.filter((v) => targets(v, last, null))
      const inheritsValid = !!inh && inh.certification_id === last.certification_id && inh.from_sha === last.certified_sha &&
        !!last.certified_package_digest && !!r.covered_package_digest && last.certified_package_digest === r.covered_package_digest
      const bound = last.certified_sha === r.candidate_sha || inheritsValid
      if (passStatus) {
        // CERTIFICATION_BINDING — inherited only while no predicate fired.
        if (last.certified_authority_version !== r.authority_version) {
          add('CERTIFICATION_BINDING', p, `AUTHORITY_CHANGED: certified at authority ${last.certified_authority_version}, record now at ${r.authority_version}`)
        }
        if (last.certified_package_digest && r.covered_package_digest && last.certified_package_digest !== r.covered_package_digest) {
          add('CERTIFICATION_BINDING', p, 'COVERED_PATH_CHANGED: covered_package_digest differs from the certified package')
        }
        if (r.candidate_sha && last.certified_sha !== r.candidate_sha) {
          if (!inh || inh.certification_id !== last.certification_id || inh.from_sha !== last.certified_sha) {
            add('CERTIFICATION_BINDING', p, `BINDING_CHANGED: certified ${last.certified_sha} but candidate is ${r.candidate_sha} and no matching certification_inherits_from`)
          } else if (!last.certified_package_digest || !r.covered_package_digest) {
            add('CERTIFICATION_BINDING', p, 'inheritance across SHAs requires both certified and current package digests')
          }
        }
      }
      if (firedAgainst.length > 0) {
        if (!vocab.unboundStatuses.has(status)) {
          add('FIRED_INVALIDATOR', p, `fired invalidator ${firedAgainst.map((v) => `${v.predicate_id}(${v.kind})`).join(', ')} targets ${last.certification_id} but certification_status is still ${status}`)
        }
      } else if (!bound) {
        if (!vocab.unboundStatuses.has(status)) add('CERTIFICATION_BINDING', p, `candidate ${r.candidate_sha} is not bound to ${last.certification_id}; status ${status} is not allowed`)
        if (!r.invalidated_by.some((v) => v.fired && v.kind === vocab.bindingKind && v.target?.candidate_sha === last.certified_sha)) {
          add('CERTIFICATION_BINDING', p, `candidate moved off ${last.certified_sha} without a fired ${vocab.bindingKind} invalidator targeting it`)
        }
      } else if (status !== vocab.statusForOutcome[last.outcome]) {
        add('CERTIFICATION_COHERENCE', p, `certification_status ${status} does not match outcome ${last.outcome} of ${last.certification_id} (expected ${vocab.statusForOutcome[last.outcome]})`)
      }
    }

    // LIFECYCLE_CERTIFICATION.
    if (li >= CERT && !passStatus) {
      add('LIFECYCLE_CERTIFICATION', p, `${r.lifecycle_state} requires a PASS-class certification status, found ${status}`)
    }

    // LIFECYCLE_HISTORY — replay the explicit transition graph.
    const hist = r.lifecycle_history
    const basisFacts = (e: HistoryEntry) => e.basis_fact_ids.map((f) => facts.get(f))
    hist.forEach((e, j) => {
      const hp = `${p}.lifecycle_history[${j}]`
      for (const f of e.basis_fact_ids) if (!facts.has(f)) add('REFERENCES', hp, `unknown basis fact ${f}`)
      if (e.at_revision > state.revision) add('LIFECYCLE_HISTORY', hp, `at_revision ${e.at_revision} is after revision ${state.revision}`)
      if (j > 0 && e.at_revision < hist[j - 1].at_revision) add('LIFECYCLE_HISTORY', hp, 'at_revision decreases')
      if (idx(e.to) >= AUTHORED && !e.candidate_sha) add('LIFECYCLE_HISTORY', hp, `${e.to} entry needs candidate_sha`)
      const needAuthoredBasis = () => {
        if (!basisFacts(e).some((f) => isDurable(f, vocab) && vocab.authoredBasis.has(f!.class) && f!.ref === e.candidate_sha)) {
          add('LIFECYCLE_HISTORY', hp, `${e.to} needs a durable ${[...vocab.authoredBasis].join('/')} basis at candidate ${e.candidate_sha}`)
        }
      }
      if (j === 0) {
        if (!vocab.initialStates.has(e.to)) add('LIFECYCLE_HISTORY', hp, `a record cannot start in ${e.to}; initial states are ${[...vocab.initialStates].join(', ')}`)
        else if (idx(e.to) === AUTHORED) needAuthoredBasis()
        return
      }
      const prev = hist[j - 1]
      const d = idx(e.to) - idx(prev.to)
      const firedInv = e.invalidator_id ? invById.get(e.invalidator_id) : undefined
      if (d === 1) {
        const edge = vocab.forward[prev.to]
        if (e.candidate_sha !== prev.candidate_sha) add('LIFECYCLE_HISTORY', hp, `forward ${prev.to} -> ${e.to} cannot change candidate`)
        const current = e.candidate_sha === r.candidate_sha
        const ok = basisFacts(e).some((f) => {
          if (!isDurable(f, vocab) || !edge.basis_classes.includes(f!.class)) return false
          switch (edge.basis_ref) {
            case 'entry.candidate_sha':
              return f!.ref === e.candidate_sha
            case 'certification':
              return r.certification_history.some((c) => c.evidence_fact_id === f!.fact_id && vocab.passOutcomes.has(c.outcome) &&
                (c.certified_sha === e.candidate_sha || (current && inh?.certification_id === c.certification_id)))
            case 'lineage_shas.materialization':
              return !current || (!!r.lineage_shas.materialization && f!.ref === r.lineage_shas.materialization)
            case 'lineage_shas.evidence_head':
              return !current || (!!r.lineage_shas.evidence_head && f!.ref === r.lineage_shas.evidence_head)
            default:
              return true
          }
        })
        if (!ok) add('LIFECYCLE_HISTORY', hp, `${prev.to} -> ${e.to} needs a durable ${edge.basis_classes.join('/')} basis bound to ${edge.basis_ref ?? 'the record'}`)
        // Observation invalidators: a stale read cannot back a step recorded in this revision.
        if (e.at_revision === state.revision) {
          for (const f of basisFacts(e)) {
            const o = f?.observation_id ? obsById.get(f.observation_id) : undefined
            if (o && o.invalidated_by.some((v) => v.fired)) add('FIRED_INVALIDATOR', hp, `basis ${f!.fact_id} cites fired observation ${o.observation_id}`)
          }
        }
      } else if (d === 0) {
        if (e.candidate_sha === prev.candidate_sha) add('LIFECYCLE_HISTORY', hp, `repeated ${e.to} entry without a candidate change`)
        if (!vocab.rebindStates.has(e.to)) add('LIFECYCLE_HISTORY', hp, `rebind to a new candidate is not allowed at ${e.to}; regress first`)
        if (!firedInv || !firedInv.fired || firedInv.kind !== vocab.bindingKind || firedInv.target?.candidate_sha !== prev.candidate_sha) {
          add('LIFECYCLE_HISTORY', hp, `rebind needs a fired ${vocab.bindingKind} invalidator targeting ${prev.candidate_sha}`)
        }
        if (idx(e.to) === AUTHORED) needAuthoredBasis()
        else if (!(e.candidate_sha === r.candidate_sha && inh && inh.from_sha === prev.candidate_sha)) {
          add('LIFECYCLE_HISTORY', hp, `rebind at ${e.to} needs certification_inherits_from from ${prev.candidate_sha}`)
        }
      } else if (d < 0) {
        if (!firedInv || !firedInv.fired) add('LIFECYCLE_HISTORY', hp, `regression ${prev.to} -> ${e.to} requires a fired invalidator`)
        if (e.candidate_sha !== prev.candidate_sha) {
          if (idx(e.to) > AUTHORED) add('LIFECYCLE_HISTORY', hp, `a candidate change regresses to at most AUTHORED, not ${e.to}`)
          if (!firedInv || firedInv.kind !== vocab.bindingKind || firedInv.target?.candidate_sha !== prev.candidate_sha) {
            add('LIFECYCLE_HISTORY', hp, `candidate change needs a fired ${vocab.bindingKind} invalidator targeting ${prev.candidate_sha}`)
          }
        }
        if (idx(e.to) === AUTHORED) needAuthoredBasis()
      } else {
        add('LIFECYCLE_HISTORY', hp, `invalid lifecycle transition ${prev.to} -> ${e.to} skips ${d - 1} state(s)`)
      }
    })
    const lastEntry = hist[hist.length - 1]
    if (lastEntry && (lastEntry.to !== r.lifecycle_state || lastEntry.candidate_sha !== r.candidate_sha)) {
      add('LIFECYCLE_HISTORY', p, `lifecycle_state/candidate_sha (${r.lifecycle_state}, ${r.candidate_sha}) must equal the last history entry (${lastEntry.to}, ${lastEntry.candidate_sha})`)
    }
    if (opts.genesis && vocab.genesisForbidden.has(r.lifecycle_state)) {
      add('GENESIS', p, `a record cannot appear in ${r.lifecycle_state} in a projection with no previous revision`)
    }

    // Invalidators, freshness, consumed observations.
    const consumed = r.evidence.map((e) => (e.observation_id ? obsById.get(e.observation_id) : undefined)).filter((o): o is Observation => !!o)
    const firedObs = consumed.filter((o) => o.invalidated_by.some((v) => v.fired))
    const firedHere = r.invalidated_by.filter((v) => targets(v, r.certification, r.candidate_sha))
    const expired: string[] = []
    if (r.evidence_freshness === vocab.ttl) {
      if (!r.evidence_expires_at) add('FRESHNESS', p, 'TTL freshness requires evidence_expires_at')
      else if (ms(r.evidence_expires_at) <= nowMs) expired.push(`record evidence expired at ${r.evidence_expires_at}`)
    } else if (r.evidence_expires_at) add('FRESHNESS', p, 'evidence_expires_at is only meaningful for TTL freshness')
    for (const o of consumed) {
      if (o.freshness_class === vocab.ttl && o.expires_at && ms(o.expires_at) <= nowMs) expired.push(`${o.observation_id} expired at ${o.expires_at}`)
    }
    if (expired.length > 0 && (r.execution_allowed || li >= ARMED)) {
      add('FRESHNESS', p, `expired evidence (${expired.join('; ')}) cannot support ${r.execution_allowed ? 'execution_allowed=true' : r.lifecycle_state}`)
    }

    // IMPLEMENTED_VS_INTEGRATED — independent dimensions.
    if (li >= MATERIALIZED && !vocab.implSatisfied.has(r.implementation_status)) {
      add('IMPLEMENTED_VS_INTEGRATED', p, `${r.lifecycle_state} with implementation_status ${r.implementation_status}; integration_status ${r.integration_status} is a separate dimension — NOT_INTEGRATED is not NOT_IMPLEMENTED`)
    }
    if (r.integration_status === vocab.integratedStatus && r.implementation_status === vocab.notImplementedStatus) {
      add('IMPLEMENTED_VS_INTEGRATED', p, `${vocab.integratedStatus} yet ${vocab.notImplementedStatus} is contradictory`)
    }

    // EXECUTED_EVIDENCE.
    if (li >= EXECUTED) {
      if (!r.observed_at) add('EXECUTED_EVIDENCE', p, `${r.lifecycle_state} requires observed_at`)
      if (!r.evidence.some((e) => vocab.executedEvidenceClasses.has(e.class))) {
        add('EXECUTED_EVIDENCE', p, `${r.lifecycle_state} requires ${[...vocab.executedEvidenceClasses].join(' or ')} evidence; INFERENCE alone never suffices`)
      }
    }

    // DEPENDENCY — explicit required state per edge, no default.
    const depIds = new Set<string>()
    for (const d of r.dependencies) {
      const dp = `${p}.dependencies(${d.gate_id})`
      if (depIds.has(d.gate_id)) add('DEPENDENCY', dp, 'duplicate dependency edge')
      depIds.add(d.gate_id)
      if (d.gate_id === r.gate_id) { add('REFERENCES', dp, 'self-dependency'); continue }
      const dep = byId.get(d.gate_id)
      if (!dep) { add('REFERENCES', dp, `unknown dependency ${d.gate_id}`); continue }
      if (idx(d.applies_from_state) > idx(vocab.depMaxApplies)) {
        add('DEPENDENCY', dp, `applies_from_state ${d.applies_from_state} is after ${vocab.depMaxApplies}; ${vocab.depMaxApplies} and execution always need every dependency`)
      }
      const active = li >= idx(d.applies_from_state) || li >= ARMED || r.execution_allowed
      if (active && idx(dep.lifecycle_state) < idx(d.required_state)) {
        add('DEPENDENCY', dp, `dependency ${d.gate_id} is ${dep.lifecycle_state}; this edge requires ${d.required_state} from ${d.applies_from_state}${r.execution_allowed ? ' and for execution' : ''}`)
      }
    }

    // FINDING_RESOLUTION.
    const findingIds = new Set<string>()
    for (const f of r.blocking_findings) {
      const fp = `${p}.blocking_findings(${f.finding_id})`
      if (findingIds.has(f.finding_id)) add('REFERENCES', fp, 'duplicate finding_id')
      findingIds.add(f.finding_id)
      if (f.evidence_fact_id && !facts.has(f.evidence_fact_id)) add('REFERENCES', fp, `unknown evidence_fact_id ${f.evidence_fact_id}`)
      if (vocab.resolvingFinding.has(f.status)) {
        if (!f.resolution_fact_id || !isDurable(facts.get(f.resolution_fact_id), vocab)) {
          add('FINDING_RESOLUTION', fp, `${f.status} needs resolution_fact_id pointing at a durable evidence item`)
        }
      }
      if (f.status === vocab.supersededFinding) {
        if (!f.superseded_by || f.superseded_by === f.finding_id || !r.blocking_findings.some((g) => g.finding_id === f.superseded_by)) {
          add('FINDING_RESOLUTION', fp, `${f.status} needs superseded_by naming another finding of this record`)
        }
      }
    }
    const open = r.blocking_findings.filter((f) => f.status === vocab.openFinding)

    // EXECUTION_ALLOWED.
    if (r.execution_allowed) {
      if (r.lifecycle_state !== vocab.executionState) add('EXECUTION_ALLOWED', p, `execution_allowed=true requires lifecycle ${vocab.executionState}, found ${r.lifecycle_state}`)
      if (!passStatus) add('EXECUTION_ALLOWED', p, `execution_allowed=true requires a PASS-class certification, found ${status}`)
      if (open.length > 0) add('EXECUTION_ALLOWED', p, `execution_allowed=true with unresolved blocking finding(s) ${open.map((f) => f.finding_id).join(', ')}`)
      if (firedHere.length > 0) add('FIRED_INVALIDATOR', p, `fired invalidator ${firedHere.map((v) => v.predicate_id).join(', ')} but execution_allowed=true`)
      if (firedObs.length > 0) add('FIRED_INVALIDATOR', p, `consumed observation(s) ${firedObs.map((o) => o.observation_id).join(', ')} fired but execution_allowed=true`)
    }

    // CLOSED_REQUIRES.
    if (r.lifecycle_state === vocab.closedState) {
      if (open.length > 0) add('CLOSED_REQUIRES', p, `${vocab.closedState} with unresolved blocking finding(s) ${open.map((f) => f.finding_id).join(', ')}`)
      if (!r.evidence.some((e) => e.class === vocab.humanDecisionClass && isDurable(e, vocab))) {
        add('CLOSED_REQUIRES', p, `${vocab.closedState} requires a durable ${vocab.humanDecisionClass} evidence item`)
      }
    }
  })

  // An observation's consumers are exactly the records that cite it.
  for (const [id, o] of obsById) {
    const cited = citedBy.get(id) ?? new Set<string>()
    const declared = new Set(o.consumers)
    const missing = [...cited].filter((g) => !declared.has(g))
    const extra = [...declared].filter((g) => !cited.has(g))
    if (missing.length || extra.length) {
      add('REFERENCES', `observations(${id}).consumers`, `consumers must equal citing records (missing: ${missing.join(',') || '-'}; not citing: ${extra.join(',') || '-'})`)
    }
  }

  issues.push(...scanSecrets(state))
  return issues
}

// ---------------------------------------------------------------------------
// 4. Transition — a newer projection may not erase history.
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown> & { gate_id: string }

function invalidatorsMonotonic(prevList: Invalidator[], nextList: Invalidator[], p: string, add: (p: string, m: string) => void, strictShape: boolean) {
  const next = new Map(nextList.map((v) => [v.predicate_id, v]))
  for (const v of prevList) {
    const nv = next.get(v.predicate_id)
    if (!nv) { add(p, `invalidator ${v.predicate_id} removed; invalidators are never deleted`); continue }
    if (nv.kind !== v.kind || nv.description !== v.description) add(p, `invalidator ${v.predicate_id} rewritten (kind/description)`)
    if (v.fired) {
      if (!nv.fired) add(p, `invalidator ${v.predicate_id} returned to fired=false; a fired invalidator never unfires`)
      else if (strictShape && !deepEqual(nv, v)) add(p, `fired invalidator ${v.predicate_id} rewritten`)
    } else if (strictShape && !nv.fired && !deepEqual(nv, v)) add(p, `unfired invalidator ${v.predicate_id} rewritten`)
  }
}

export function validateTransition(prevRaw: unknown, next: ClosureState, vocab: Vocab): Issue[] {
  const issues: Issue[] = []
  const add = (p: string, message: string) => issues.push({ rule: 'TRANSITION', path: p, message })
  const prev = prevRaw as { schema_version: string; revision: number; as_of: string; records: AnyRecord[]; observations: Observation[] }
  const migration = prev.schema_version === MIGRATABLE_PREVIOUS_SCHEMA
  if (!migration && prev.schema_version !== next.schema_version) {
    return [{ rule: 'TRANSITION', path: 'schema_version', message: `previous schema ${prev.schema_version} is neither ${next.schema_version} nor the migratable ${MIGRATABLE_PREVIOUS_SCHEMA}` }]
  }
  if (next.revision !== prev.revision + 1) add('revision', `revision must advance by exactly 1 (${prev.revision} -> ${next.revision})`)
  if (ms(next.as_of) < ms(prev.as_of)) add('as_of', 'as_of moved backwards')
  const nextById = new Map(next.records.map((r) => [r.gate_id, r]))
  const prevIds = new Set(prev.records.map((r) => r.gate_id))
  const idx = (s: string) => vocab.ladder.indexOf(s)

  for (const pr of prev.records) {
    const p = `records(${pr.gate_id})`
    const nr = nextById.get(pr.gate_id)
    if (!nr) { add(p, 'record removed; records are superseded, never deleted'); continue }
    // Evidence identities are immutable history.
    const nextFacts = new Map(nr.evidence.map((e) => [e.fact_id, e]))
    for (const e of pr.evidence as EvidenceItem[]) {
      const ne = nextFacts.get(e.fact_id)
      if (!ne) add(p, `evidence ${e.fact_id} removed; evidence identities are never deleted`)
      else if (!deepEqual(ne, e)) add(p, `evidence ${e.fact_id} rewritten`)
    }
    // Findings keep identity, summary and evidence; only disposition may change.
    const nextFindings = new Map(nr.blocking_findings.map((f) => [f.finding_id, f]))
    for (const f of pr.blocking_findings as Finding[]) {
      const nf = nextFindings.get(f.finding_id)
      if (!nf) add(p, `finding ${f.finding_id} removed; findings are never deleted`)
      else if (nf.summary !== f.summary || nf.evidence_fact_id !== f.evidence_fact_id) add(p, `finding ${f.finding_id} rewritten`)
    }
    invalidatorsMonotonic(pr.invalidated_by as Invalidator[], nr.invalidated_by, p, add, !migration)
    // Dependency edges are never dropped or weakened.
    const nextDeps = new Map(nr.dependencies.map((d) => [d.gate_id, d]))
    for (const d of pr.dependencies as (Dependency | string)[]) {
      const id = typeof d === 'string' ? d : d.gate_id
      const nd = nextDeps.get(id)
      if (!nd) { add(p, `dependency edge ${id} removed`); continue }
      if (typeof d !== 'string') {
        if (idx(nd.required_state) < idx(d.required_state)) add(p, `dependency ${id} required_state lowered ${d.required_state} -> ${nd.required_state}`)
        if (idx(nd.applies_from_state) > idx(d.applies_from_state)) add(p, `dependency ${id} applies_from_state raised ${d.applies_from_state} -> ${nd.applies_from_state}`)
      }
    }
    if (migration) {
      // A v1.0.0 projection had no history: its state must appear in the new history, at or before its revision.
      const had = nr.lifecycle_history.some((e) => e.to === pr.lifecycle_state && e.candidate_sha === pr.candidate_sha && e.at_revision <= prev.revision)
      if (!had) add(p, `previous ${pr.lifecycle_state} at ${String(pr.candidate_sha)} is missing from lifecycle_history`)
      for (const e of nr.lifecycle_history) if (e.at_revision > next.revision) add(p, 'history entry after this revision')
      const cert = pr.certification as { certification_id: string; verdict: string; certified_sha: string; evidence_fact_id: string } | null
      const certEv = cert ? (pr.evidence as EvidenceItem[]).find((e) => e.fact_id === cert.evidence_fact_id) : undefined
      if (cert && certEv && certEv.class === vocab.certificationClass && isDurable(certEv, vocab)) {
        const kept = nr.certification_history.some((c) => c.certification_id === cert.certification_id && c.verdict === cert.verdict && c.certified_sha === cert.certified_sha)
        if (!kept) add(p, `durable certification ${cert.certification_id} missing from certification_history`)
      }
    } else {
      const ph = pr.lifecycle_history as HistoryEntry[]
      if (!deepEqual(nr.lifecycle_history.slice(0, ph.length), ph)) add(p, 'lifecycle_history rewritten; history only grows')
      for (const e of nr.lifecycle_history.slice(ph.length)) if (e.at_revision !== next.revision) add(p, `appended history entry must carry at_revision ${next.revision}`)
      const pc = pr.certification_history as Certification[]
      if (!deepEqual(nr.certification_history.slice(0, pc.length), pc)) add(p, 'certification_history rewritten; a new certification needs a NEW certification_id appended')
    }
  }
  for (const nr of next.records) {
    if (prevIds.has(nr.gate_id)) continue
    const p = `records(${nr.gate_id})`
    if (idx(nr.lifecycle_state) > idx(vocab.newRecordMax)) add(p, `a new record cannot appear in ${nr.lifecycle_state}; new records enter at most at ${vocab.newRecordMax}`)
    if (nr.lifecycle_history.some((e) => e.at_revision !== next.revision)) add(p, `a new record's history entries must all carry at_revision ${next.revision}`)
  }
  const nextObs = new Map(next.observations.map((o) => [o.observation_id, o]))
  for (const o of prev.observations) {
    const p = `observations(${o.observation_id})`
    const no = nextObs.get(o.observation_id)
    if (!no) { add(p, 'observation removed; observations are never deleted'); continue }
    const strip = (x: Observation) => ({ ...x, consumers: undefined, invalidated_by: undefined })
    if (!deepEqual(strip(no), strip(o))) add(p, 'observation rewritten')
    if (o.consumers.some((c) => !no.consumers.includes(c))) add(p, 'observation consumers removed')
    invalidatorsMonotonic(o.invalidated_by, no.invalidated_by, p, add, !migration)
  }
  return issues
}

// ---------------------------------------------------------------------------
// 5. Git layer — re-derive SHA-bound claims from the repository.
// ---------------------------------------------------------------------------

function gitOut(cwd: string, args: string[]): string | undefined {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return res.status === 0 ? res.stdout : undefined
}

function treeOf(cwd: string, sha: string): string | undefined {
  return gitOut(cwd, ['rev-parse', '--verify', '-q', `${sha}^{tree}`])?.trim()
}

/**
 * sha256 over the sorted, de-duplicated `git ls-tree -r -z` entries (mode,
 * type, blob, path) of `paths` at `sha`: independent of the ORDER paths are
 * listed in. Undefined if the ref does not resolve or any path is absent — a
 * partial package is never digested.
 */
export function packageDigest(cwd: string, sha: string, paths: string[]): string | undefined {
  if (paths.length === 0) return undefined
  const entries: string[] = []
  for (const p of paths) {
    const out = gitOut(cwd, ['ls-tree', '-r', '-z', '--full-tree', sha, '--', p])
    if (out === undefined) return undefined
    const lines = out.split('\0').filter((l) => l.length > 0)
    if (lines.length === 0) return undefined
    entries.push(...lines)
  }
  const unique = [...new Set(entries)].sort()
  return createHash('sha256').update(unique.join('\n'), 'utf8').digest('hex')
}

export function verifyGit(state: ClosureState, cwd: string, vocab: Vocab): Issue[] {
  const issues: Issue[] = []
  const add = (p: string, message: string) => issues.push({ rule: 'GIT', path: p, message })
  const base = state.integration_base
  const baseTree = treeOf(cwd, base.sha)
  if (!baseTree) add('integration_base', `integration base ${base.sha} does not resolve`)
  else if (baseTree !== base.tree_sha) add('integration_base', `tree ${base.tree_sha} != git ${baseTree}`)

  let ledgerIds = new Set<string>()
  const ledgerAbs = path.join(cwd, RELEASE_GATE_LEDGER_PATH)
  if (existsSync(ledgerAbs)) {
    const ledger = JSON.parse(readFileSync(ledgerAbs, 'utf8')) as { GATES?: { id: string }[] }
    ledgerIds = new Set((ledger.GATES ?? []).map((g) => g.id))
  }

  for (const r of state.records) {
    const p = `records(${r.gate_id})`
    if (ledgerIds.has(r.gate_id)) add(p, `gate_id collides with ${RELEASE_GATE_LEDGER_PATH} gate id; closure-state ids must not shadow canonical ledger gates`)
    if (r.candidate_sha) {
      const t = treeOf(cwd, r.candidate_sha)
      if (!t) add(p, `candidate ${r.candidate_sha} does not resolve`)
      else if (r.tree_sha && t !== r.tree_sha) add(p, `tree_sha ${r.tree_sha} != git ${t}`)
      if (r.integration_status === vocab.integratedStatus || r.integration_status === vocab.notIntegratedStatus) {
        const anc = isAncestor(cwd, r.candidate_sha, base.sha)
        if (anc === undefined) add(p, 'integration ancestry undeterminable')
        else if (anc !== (r.integration_status === vocab.integratedStatus)) {
          add(p, `integration_status ${r.integration_status} contradicts git (candidate ${anc ? 'IS' : 'is NOT'} an ancestor of ${base.sha})`)
        }
      }
      for (const [role, sha] of Object.entries(r.lineage_shas)) {
        if (isAncestor(cwd, r.candidate_sha, sha as string) !== true) add(p, `lineage ${role} ${sha} is not a resolvable descendant of the candidate`)
      }
      if (r.covered_package_digest) {
        const d = packageDigest(cwd, r.candidate_sha, r.covered_paths)
        if (d !== r.covered_package_digest) add(p, `covered_package_digest mismatch at candidate (git ${d ?? 'UNREADABLE'})`)
      }
    }
    for (const e of r.lifecycle_history) {
      if (e.candidate_sha && !treeOf(cwd, e.candidate_sha)) add(p, `history candidate ${e.candidate_sha} does not resolve`)
    }
    for (const c of r.certification_history) {
      if (!treeOf(cwd, c.certified_sha)) add(p, `certified_sha ${c.certified_sha} does not resolve`)
    }
    if (r.authority && pathExistsAtRef(cwd, r.authority.ref, r.authority.path) !== true) {
      add(p, `authority ${r.authority.path} absent at ${r.authority.ref}`)
    }
    if (r.certification?.certified_package_digest) {
      const d = packageDigest(cwd, r.certification.certified_sha, r.covered_paths)
      if (d !== r.certification.certified_package_digest) add(p, `certified_package_digest mismatch at ${r.certification.certified_sha} (git ${d ?? 'UNREADABLE'})`)
    }
    for (const e of r.evidence) {
      if (!e.ref || !e.path) continue
      const ep = `${p}.evidence(${e.fact_id})`
      if (e.field !== undefined) {
        const text = readBlobAtRef(cwd, e.ref, e.path)
        if (text === undefined) { add(ep, `unreadable ${e.path} at ${e.ref}`); continue }
        let doc: unknown
        try { doc = JSON.parse(text) } catch { add(ep, `${e.path} is not JSON`); continue }
        const got = readDotPath(doc, e.field)
        if (!got.found) add(ep, `field ${e.field} absent`)
        else if (e.value !== undefined && !deepEqual(got.value, e.value)) add(ep, `field ${e.field} = ${JSON.stringify(got.value)} != recorded ${JSON.stringify(e.value)}`)
      } else if (typeof e.value === 'string') {
        const text = readBlobAtRef(cwd, e.ref, e.path)
        if (text === undefined || !text.includes(e.value)) add(ep, `verbatim value not found in ${e.path} at ${e.ref}`)
      } else if (pathExistsAtRef(cwd, e.ref, e.path) !== true) {
        add(ep, `${e.path} absent at ${e.ref}`)
      }
    }
  }
  for (const o of state.observations) {
    if (o.result_ref && o.result_path && pathExistsAtRef(cwd, o.result_ref, o.result_path) !== true) {
      add(`observations(${o.observation_id})`, `result ${o.result_path} absent at ${o.result_ref}`)
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// RUN_STATE — location, shape, and resume identity.
// ---------------------------------------------------------------------------

/** True when `dir` or any ancestor holds a `.git` entry (repository or worktree). */
export function isInsideGit(dir: string): boolean {
  let p = path.resolve(dir)
  for (;;) {
    if (existsSync(path.join(p, '.git'))) return true
    const parent = path.dirname(p)
    if (parent === p) return false
    p = parent
  }
}

export interface RunStateRoot {
  root?: string
  rejected: string[]
}

/** %TEMP%\uellix-runs if outside git, else %LOCALAPPDATA%\uellix-runs if outside git, else none (STOP). */
export function resolveRunStateRoot(env: Record<string, string | undefined>, insideGit: (dir: string) => boolean = isInsideGit): RunStateRoot {
  const candidates = [env.TEMP, env.LOCALAPPDATA].filter((d): d is string => !!d).map((d) => path.join(d, 'uellix-runs'))
  const rejected: string[] = []
  for (const c of candidates) {
    if (!insideGit(c)) return { root: c, rejected }
    rejected.push(c)
  }
  return { root: undefined, rejected }
}

export interface RunStateIdentity {
  lane: string
  role: string
  branch: string
  base: string
  candidate?: string | null
}

export interface RunStateResumeCheck {
  verdict: 'RESUME' | 'DRIFT'
  mismatches: string[]
}

interface RunStateShape {
  lane: string
  role: string
  branch: string
  base: string
  candidate: string | null
  own_commits: string[]
  last_verified_head: string
}

/** Resume binds lane, role, branch, base, candidate and last_verified_head — HEAD alone is never sufficient. */
export function checkRunStateResume(rs: RunStateShape, measured: { head: string; branch: string }, expected: RunStateIdentity): RunStateResumeCheck {
  const mismatches: string[] = []
  if (rs.lane !== expected.lane) mismatches.push(`lane ${rs.lane} != expected ${expected.lane}`)
  if (rs.role !== expected.role) mismatches.push(`role ${rs.role} != expected ${expected.role}`)
  if (rs.branch !== expected.branch) mismatches.push(`branch ${rs.branch} != expected ${expected.branch}`)
  if (measured.branch !== expected.branch) mismatches.push(`checked-out branch ${measured.branch} != expected ${expected.branch}`)
  if (rs.base !== expected.base) mismatches.push(`base ${rs.base} != expected ${expected.base}`)
  if (expected.candidate !== undefined && rs.candidate !== expected.candidate) mismatches.push(`candidate ${String(rs.candidate)} != expected ${String(expected.candidate)}`)
  if (rs.candidate !== null && !rs.own_commits.includes(rs.candidate)) mismatches.push(`candidate ${rs.candidate} is not one of this lane's own commits`)
  const lastOwn = rs.own_commits.length > 0 ? rs.own_commits[rs.own_commits.length - 1] : undefined
  if (measured.head !== rs.last_verified_head && measured.head !== lastOwn) {
    mismatches.push(`HEAD ${measured.head} is neither last_verified_head ${rs.last_verified_head} nor the last own commit`)
  }
  return { verdict: mismatches.length === 0 ? 'RESUME' : 'DRIFT', mismatches }
}

export function validateRunState(runState: unknown, schema: Schema, fileDir?: string): Issue[] {
  const issues = [...validateSchema(schema, runState), ...scanSecrets(runState)]
  if (fileDir && isInsideGit(fileDir)) {
    issues.push({ rule: 'RUN_STATE_LOCATION', path: fileDir, message: 'RUN_STATE lives inside a git repository/worktree; use `run-state-root` to pick a verified non-git location' })
  }
  return issues
}

// ---------------------------------------------------------------------------
// Composition + CLI.
// ---------------------------------------------------------------------------

export function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export interface ValidateOptions {
  now: string
  previous?: unknown
  genesis?: boolean
  gitCwd?: string
}

/** Vocabulary, then structural; semantic/transition/git only on a structurally valid state. */
export function validateClosureState(state: unknown, schema: Schema, opts: ValidateOptions): Issue[] {
  // A schema that contradicts itself is reported before anything is judged by it.
  let vocab: Vocab
  try { vocab = loadVocabulary(schema) } catch (e) { return [{ rule: 'SCHEMA_CONSISTENCY', path: CLOSURE_STATE_SCHEMA_PATH, message: (e as Error).message }] }
  const structural = validateSchema(schema, state)
  if (structural.length > 0) return structural
  const s = state as ClosureState
  const issues = validateSemantics(s, vocab, { now: opts.now, genesis: opts.genesis })
  if (opts.previous !== undefined) issues.push(...validateTransition(opts.previous, s, vocab))
  if (opts.gitCwd) issues.push(...verifyGit(s, opts.gitCwd, vocab))
  return issues
}

export interface CiResult {
  mode: 'UNCHANGED' | 'CHANGED_WITH_PREVIOUS' | 'CHANGED_GENESIS'
  mergeBase: string
  issues: Issue[]
}

/** CI: previous projection from the merge-base; full checks whenever the projection changed. */
export function runCi(cwd: string, baseRef: string, now: string): CiResult {
  const schema = loadJson(path.join(cwd, CLOSURE_STATE_SCHEMA_PATH)) as Schema
  const mergeBase = gitOut(cwd, ['merge-base', 'HEAD', baseRef])?.trim()
  if (!mergeBase) return { mode: 'UNCHANGED', mergeBase: '', issues: [{ rule: 'CI', path: '--base', message: `merge-base of HEAD and ${baseRef} unreadable` }] }
  const currentText = readFileSync(path.join(cwd, CLOSURE_STATE_PATH), 'utf8')
  const current = JSON.parse(currentText) as ClosureState
  const previousText = readBlobAtRef(cwd, mergeBase, CLOSURE_STATE_PATH)
  if (previousText !== undefined && deepEqual(JSON.parse(previousText), current)) {
    return { mode: 'UNCHANGED', mergeBase, issues: validateClosureState(current, schema, { now: current.as_of }) }
  }
  if (previousText === undefined) {
    return { mode: 'CHANGED_GENESIS', mergeBase, issues: validateClosureState(current, schema, { now, genesis: true, gitCwd: cwd }) }
  }
  return { mode: 'CHANGED_WITH_PREVIOUS', mergeBase, issues: validateClosureState(current, schema, { now, previous: JSON.parse(previousText), gitCwd: cwd }) }
}

function takeValues(argv: string[], flag: string): string[] {
  const out: string[] = []
  argv.forEach((a, i) => { if (a === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]) })
  return out
}

function report(label: string, issues: Issue[], json: boolean, extra: Record<string, unknown> = {}): number {
  const verdict = issues.length === 0 ? 'PASS' : 'FAIL'
  if (json) process.stdout.write(JSON.stringify({ tool: 'ops:closure-state', command: label, verdict, ...extra, issues }, null, 2) + '\n')
  else {
    for (const i of issues) process.stdout.write(`[${i.rule}] ${i.path}: ${i.message}\n`)
    for (const [k, v] of Object.entries(extra)) process.stdout.write(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`)
    process.stdout.write(`${label}: ${verdict} (${issues.length} issue(s))\n`)
  }
  return verdict === 'PASS' ? 0 : 1
}

export function main(argvIn: string[], cwd: string, env: Record<string, string | undefined> = process.env): number {
  const argv = argvIn[0] === '--' ? argvIn.slice(1) : argvIn
  const [command, ...rest] = argv
  const json = rest.includes('--json')
  try {
    if (command === 'validate') {
      const statePath = path.resolve(cwd, takeValues(rest, '--state')[0] ?? CLOSURE_STATE_PATH)
      const schema = loadJson(path.resolve(cwd, CLOSURE_STATE_SCHEMA_PATH)) as Schema
      const previousPath = takeValues(rest, '--previous')[0]
      const previousRef = takeValues(rest, '--previous-ref')[0]
      let previous: unknown
      if (previousPath) previous = loadJson(path.resolve(cwd, previousPath))
      else if (previousRef) {
        const text = readBlobAtRef(cwd, previousRef, CLOSURE_STATE_PATH)
        if (text === undefined) { process.stderr.write(`no ${CLOSURE_STATE_PATH} at ${previousRef}\n`); return 1 }
        previous = JSON.parse(text)
      }
      const now = takeValues(rest, '--now')[0] ?? new Date().toISOString()
      const issues = validateClosureState(loadJson(statePath), schema, {
        now,
        previous,
        genesis: rest.includes('--genesis'),
        gitCwd: rest.includes('--verify-git') ? cwd : undefined,
      })
      return report('validate', issues, json, { state: path.relative(cwd, statePath).replace(/\\/g, '/'), now, previous: previousPath ?? previousRef ?? null, genesis: rest.includes('--genesis'), git: rest.includes('--verify-git') })
    }
    if (command === 'ci') {
      const base = takeValues(rest, '--base')[0]
      if (!base) { process.stderr.write('ci requires --base <ref>\n'); return 2 }
      const res = runCi(cwd, base, new Date().toISOString())
      return report('ci', res.issues, json, { mode: res.mode, merge_base: res.mergeBase })
    }
    if (command === 'digest') {
      const ref = takeValues(rest, '--ref')[0]
      const paths = takeValues(rest, '--path')
      if (!ref || paths.length === 0) { process.stderr.write('digest requires --ref and at least one --path\n'); return 2 }
      const d = packageDigest(cwd, ref, paths)
      if (!d) { process.stderr.write('digest: ref or path unreadable\n'); return 1 }
      process.stdout.write(`${d}\n`)
      return 0
    }
    if (command === 'run-state-root') {
      const res = resolveRunStateRoot(env)
      if (!res.root) { process.stderr.write(`STOP: no non-git RUN_STATE location (rejected: ${res.rejected.join(', ') || 'none available'})\n`); return 1 }
      const lane = takeValues(rest, '--lane')[0]
      process.stdout.write(`${lane ? path.join(res.root, lane) : res.root}\n`)
      return 0
    }
    if (command === 'run-state') {
      const file = takeValues(rest, '--file')[0]
      if (!file) { process.stderr.write('run-state requires --file\n'); return 2 }
      const schema = loadJson(path.resolve(cwd, RUN_STATE_SCHEMA_PATH)) as Schema
      const abs = path.resolve(cwd, file)
      const rs = loadJson(abs)
      const issues = validateRunState(rs, schema, path.dirname(abs))
      const repo = takeValues(rest, '--repo')[0]
      let resume: RunStateResumeCheck | undefined
      if (repo) {
        const [lane, role, branch, base] = ['--lane', '--role', '--branch', '--base'].map((f) => takeValues(rest, f)[0])
        if (!lane || !role || !branch || !base) { process.stderr.write('run-state --repo requires --lane, --role, --branch and --base (the expected identity; never inferred)\n'); return 2 }
        const candidate = takeValues(rest, '--candidate')[0]
        const repoAbs = path.resolve(cwd, repo)
        const head = gitOut(repoAbs, ['rev-parse', 'HEAD'])?.trim()
        const measuredBranch = gitOut(repoAbs, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim()
        if (!head || !measuredBranch) issues.push({ rule: 'RUN_STATE', path: '--repo', message: 'HEAD/branch unreadable' })
        else if (issues.length === 0) {
          resume = checkRunStateResume(rs as RunStateShape, { head, branch: measuredBranch }, { lane, role, branch, base, candidate })
          for (const m of resume.mismatches) issues.push({ rule: 'RUN_STATE_DRIFT', path: 'identity', message: `${m} — STOP, never reconcile silently` })
        }
      }
      return report('run-state', issues, json, resume ? { resume: resume.verdict } : {})
    }
    process.stderr.write('usage: ops:closure-state -- validate|ci|digest|run-state|run-state-root [options] (see scripts/ops/closure-state.ts header)\n')
    return 2
  } catch (err) {
    process.stderr.write(`ops:closure-state: ${(err as Error).message}\n`)
    return 1
  }
}

// argv is checked rather than `import.meta.url`, matching scripts/ods-program-state.ts.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ops/closure-state.ts')
if (invokedDirectly) process.exitCode = main(process.argv.slice(2), process.cwd())
