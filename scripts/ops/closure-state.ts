// scripts/ops/closure-state.ts — CV1 closure-state + RUN_STATE validator.
//
//   pnpm ops:closure-state -- validate [--state <path>] [--now <iso>] [--previous <path>] [--verify-git] [--json]
//   pnpm ops:closure-state -- digest --ref <sha> --path <p> [--path <p> ...]
//   pnpm ops:closure-state -- run-state --file <path> [--repo <dir>] [--json]
//
// docs/ops/ods/CV1_CLOSURE_STATE.json is OPERATIONAL DERIVED STATE, not
// authority: each record points at evidence (git refs, repo paths, JSON
// fields, recorded provider observations, owner decisions, independent
// certifications). This tool never decides a closure; it refuses states
// whose claims are not supported by what they point at.
//
// Three layers, each fail-closed:
//   1. structural — the JSON Schema subset in
//      docs/ops/ods/CV1_CLOSURE_STATE_SCHEMA_v1.0.0.json (vocabularies live
//      ONLY there; nothing here re-lists an enum);
//   2. semantic — the x-semantic-rules of that schema, hermetic (no git,
//      injected `now`), so CI can run them on fixtures and the baseline;
//   3. git (--verify-git) — re-derives every SHA-bound claim from the local
//      repository: trees, ancestry/integration, package digests, and the
//      verbatim value of every repository-backed evidence pointer.
// Anything unreadable is a failure, never a silent pass.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { readBlobAtRef, readDotPath, isAncestor, pathExistsAtRef } from '../ods-program-state'

export const CLOSURE_STATE_PATH = 'docs/ops/ods/CV1_CLOSURE_STATE.json'
export const CLOSURE_STATE_SCHEMA_PATH = 'docs/ops/ods/CV1_CLOSURE_STATE_SCHEMA_v1.0.0.json'
export const RUN_STATE_SCHEMA_PATH = 'docs/ops/ods/ODS_RUN_STATE_SCHEMA_v1.0.0.json'
export const RELEASE_GATE_LEDGER_PATH = 'docs/ops/release/RELEASE_GATE_LEDGER_v1.0.0.json'

export interface Issue {
  rule: string
  path: string
  message: string
}

// ---------------------------------------------------------------------------
// 1. Structural layer — a deliberately small JSON Schema subset.
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function typeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === 'number' && actual === 'integer')
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
    if (!types.some((t) => typeMatches(t, actual))) {
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
// 2. Semantic layer — hermetic rules (x-semantic-rules of the schema).
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

export interface Invalidator {
  predicate_id: string
  kind: string
  fired: boolean
  fired_at?: string | null
  description: string
}

export interface Certification {
  certification_id: string
  kind: string
  verdict: string
  scope: string
  certified_sha: string
  certified_authority_version: string | null
  certified_package_digest: string | null
  evidence_fact_id: string
}

export interface ClosureRecord {
  gate_id: string
  milestone: string
  lifecycle_state: string
  implementation_status: string
  integration_status: string
  candidate_sha: string | null
  tree_sha: string | null
  lineage_shas: { materialization?: string; evidence_head?: string }
  authority: { path: string; ref: string } | null
  authority_version: string | null
  certification: Certification | null
  certification_status: string
  certification_inherits_from: { certification_id: string; from_sha: string; rationale: string } | null
  covered_paths: string[]
  covered_package_digest: string | null
  evidence: EvidenceItem[]
  evidence_freshness: string
  evidence_expires_at: string | null
  observed_at: string | null
  invalidated_by: Invalidator[]
  dependencies: string[]
  blocking_findings: { finding_id: string; status: string; summary: string; evidence_fact_id?: string }[]
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

/** Lifecycle order, read from the schema so the ladder has one source. */
export function lifecycleLadder(schema: Schema): string[] {
  const defs = schema.$defs as Record<string, Schema>
  return defs.lifecycle_state.enum as string[]
}

const CERTIFIED = new Set(['CERTIFIED_PASS', 'CERTIFIED_PASS_WITH_NONBLOCKING_FINDINGS'])

// Credential / connection-string shapes. Checked on parsed string values,
// so JSON escaping cannot hide a match.
const SECRET_PATTERNS: [string, RegExp][] = [
  ['connection-uri-with-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./],
  ['supabase-key', /\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['assigned-credential', /\b(password|passwd|pwd|api[_-]?key|secret|token)\s*[=:]\s*["']?[A-Za-z0-9_\-+/]{12,}/i],
]

export function scanSecrets(value: unknown, at = '$'): Issue[] {
  const issues: Issue[] = []
  const walk = (v: unknown, p: string) => {
    if (typeof v === 'string') {
      for (const [name, re] of SECRET_PATTERNS) {
        if (re.test(v)) issues.push({ rule: 'NO_SECRET_MATERIAL', path: p, message: `string matches ${name} shape` })
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`)
  }
  walk(value, at)
  return issues
}

function ms(iso: string): number {
  return Date.parse(iso)
}

export function validateSemantics(state: ClosureState, schema: Schema, now: string): Issue[] {
  const issues: Issue[] = []
  const add = (rule: string, p: string, message: string) => issues.push({ rule, path: p, message })
  const ladder = lifecycleLadder(schema)
  const idx = (s: string) => ladder.indexOf(s)
  const AUTHORED = idx('AUTHORED')
  const CERT = idx('CERTIFIED')
  const MATERIALIZED = idx('MATERIALIZED')
  const ARMED = idx('ARMED')
  const EXECUTED = idx('EXECUTED')
  const EVIDENCED = idx('EVIDENCED')
  const nowMs = ms(now)
  if (Number.isNaN(nowMs)) return [{ rule: 'INPUT', path: 'now', message: `unparseable now '${now}'` }]

  // REFERENCES — ids and cross-links.
  const byId = new Map<string, ClosureRecord>()
  state.records.forEach((r, i) => {
    if (byId.has(r.gate_id)) add('REFERENCES', `records[${i}].gate_id`, `duplicate gate_id ${r.gate_id}`)
    byId.set(r.gate_id, r)
  })
  const obsById = new Map<string, Observation>()
  const readKeys = new Map<string, string>()
  state.observations.forEach((o, i) => {
    const p = `observations[${i}]`
    if (obsById.has(o.observation_id)) add('REFERENCES', p, `duplicate observation_id ${o.observation_id}`)
    obsById.set(o.observation_id, o)
    const key = [o.provider, o.surface, o.projection, o.observed_at].join('\u0000')
    const prior = readKeys.get(key)
    if (prior) add('REFERENCES', p, `observation duplicates the same provider read as ${prior}; record it once with several consumers`)
    readKeys.set(key, o.observation_id)
    for (const c of o.consumers) if (!byId.has(c)) add('REFERENCES', `${p}.consumers`, `unknown consumer ${c}`)
    if (o.freshness_class === 'TTL' && !o.expires_at) add('FRESHNESS', p, 'TTL observation requires expires_at')
    if (o.freshness_class !== 'TTL' && o.expires_at) add('FRESHNESS', p, 'expires_at is only meaningful for TTL freshness')
  })
  const citedBy = new Map<string, Set<string>>()

  state.records.forEach((r, i) => {
    const p = `records[${i}](${r.gate_id})`
    const li = idx(r.lifecycle_state)
    const factIds = new Set<string>()

    // Evidence item well-formedness.
    r.evidence.forEach((e, j) => {
      const ep = `${p}.evidence[${j}]`
      if (factIds.has(e.fact_id)) add('REFERENCES', ep, `duplicate fact_id ${e.fact_id}`)
      factIds.add(e.fact_id)
      if (e.class === 'REPOSITORY_FACT' && (!e.ref || !e.path)) add('EVIDENCE_CLASS', ep, 'REPOSITORY_FACT requires ref and path')
      if (e.class === 'PROVIDER_OBSERVATION') {
        if (!e.observation_id) add('EVIDENCE_CLASS', ep, 'PROVIDER_OBSERVATION requires observation_id')
        else if (!obsById.has(e.observation_id)) add('REFERENCES', ep, `unknown observation ${e.observation_id}`)
      }
      if (e.observation_id) {
        const set = citedBy.get(e.observation_id) ?? new Set<string>()
        set.add(r.gate_id)
        citedBy.set(e.observation_id, set)
      }
      if (e.class === 'INFERENCE' && !(e.derived_from && e.derived_from.length > 0)) add('EVIDENCE_CLASS', ep, 'INFERENCE requires derived_from')
      if ((e.class === 'HUMAN_DECISION' || e.class === 'INDEPENDENT_CERTIFICATION') && !e.source && !(e.ref && e.path)) {
        add('EVIDENCE_CLASS', ep, `${e.class} requires source or ref+path`)
      }
      if (e.field !== undefined && (!e.ref || !e.path)) add('EVIDENCE_CLASS', ep, 'field requires ref and path')
      if (e.scope === 'INTEGRATED' && r.integration_status !== 'INTEGRATED') {
        add('CERTIFICATION_SCOPE', ep, `evidence scoped INTEGRATED on a record whose integration_status is ${r.integration_status}; branch-local facts must not be presented as integrated`)
      }
    })
    for (const d of r.dependencies) {
      if (d === r.gate_id) add('REFERENCES', `${p}.dependencies`, 'self-dependency')
      else if (!byId.has(d)) add('REFERENCES', `${p}.dependencies`, `unknown dependency ${d}`)
    }
    for (const f of r.blocking_findings) {
      if (f.evidence_fact_id && !factIds.has(f.evidence_fact_id)) add('REFERENCES', `${p}.blocking_findings`, `unknown evidence_fact_id ${f.evidence_fact_id}`)
    }

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

    // Invalidators and freshness, including consumed observations.
    const consumed = r.evidence.map((e) => (e.observation_id ? obsById.get(e.observation_id) : undefined)).filter((o): o is Observation => !!o)
    const fired = [...r.invalidated_by, ...consumed.flatMap((o) => o.invalidated_by)].filter((v) => v.fired)
    const expired: string[] = []
    if (r.evidence_freshness === 'TTL') {
      if (!r.evidence_expires_at) add('FRESHNESS', p, 'TTL freshness requires evidence_expires_at')
      else if (ms(r.evidence_expires_at) <= nowMs) expired.push(`record evidence expired at ${r.evidence_expires_at}`)
    } else if (r.evidence_expires_at) add('FRESHNESS', p, 'evidence_expires_at is only meaningful for TTL freshness')
    for (const o of consumed) {
      if (o.freshness_class === 'TTL' && o.expires_at && ms(o.expires_at) <= nowMs) expired.push(`${o.observation_id} expired at ${o.expires_at}`)
    }

    // LIFECYCLE_CERTIFICATION / self-certification.
    const certified = CERTIFIED.has(r.certification_status)
    if (li >= CERT && !certified) {
      add('LIFECYCLE_CERTIFICATION', p, `${r.lifecycle_state} requires a CERTIFIED_PASS* status, found ${r.certification_status}`)
    }
    const cert = r.certification
    if (certified) {
      if (!cert) add('LIFECYCLE_CERTIFICATION', p, `${r.certification_status} without a certification object`)
      else {
        if (cert.kind !== 'INDEPENDENT') add('LIFECYCLE_CERTIFICATION', p, 'a SELF certification cannot back a CERTIFIED status')
        const ev = r.evidence.find((e) => e.fact_id === cert.evidence_fact_id)
        if (!ev || ev.class !== 'INDEPENDENT_CERTIFICATION') {
          add('LIFECYCLE_CERTIFICATION', p, `certification evidence ${cert.evidence_fact_id} must be an INDEPENDENT_CERTIFICATION item`)
        }
        // CERTIFICATION_BINDING — inherited only while no predicate fired.
        if (cert.certified_authority_version !== r.authority_version) {
          add('CERTIFICATION_BINDING', p, `AUTHORITY_CHANGED: certified at authority ${cert.certified_authority_version}, record now at ${r.authority_version}`)
        }
        if (cert.certified_package_digest && r.covered_package_digest && cert.certified_package_digest !== r.covered_package_digest) {
          add('CERTIFICATION_BINDING', p, 'COVERED_PATH_CHANGED: covered_package_digest differs from the certified package')
        }
        if (r.candidate_sha && cert.certified_sha !== r.candidate_sha) {
          const inh = r.certification_inherits_from
          if (!inh || inh.certification_id !== cert.certification_id || inh.from_sha !== cert.certified_sha) {
            add('CERTIFICATION_BINDING', p, `BINDING_CHANGED: certified ${cert.certified_sha} but candidate is ${r.candidate_sha} and no matching certification_inherits_from`)
          } else if (!cert.certified_package_digest || !r.covered_package_digest) {
            add('CERTIFICATION_BINDING', p, 'inheritance across SHAs requires both certified and current package digests')
          }
        }
      }
    }
    if (cert && cert.scope === 'INTEGRATION' && r.integration_status !== 'INTEGRATED') {
      add('CERTIFICATION_SCOPE', p, `branch-local certification presented as INTEGRATION (integration_status ${r.integration_status})`)
    }

    // FIRED_INVALIDATOR.
    if (fired.length > 0) {
      const names = fired.map((f) => `${f.predicate_id}(${f.kind})`).join(', ')
      if (certified) add('FIRED_INVALIDATOR', p, `fired invalidator ${names} but certification_status is still ${r.certification_status}`)
      if (r.execution_allowed) add('FIRED_INVALIDATOR', p, `fired invalidator ${names} but execution_allowed=true`)
    }

    // FRESHNESS.
    if (expired.length > 0 && (r.execution_allowed || li >= ARMED)) {
      add('FRESHNESS', p, `expired evidence (${expired.join('; ')}) cannot support ${r.execution_allowed ? 'execution_allowed=true' : r.lifecycle_state}`)
    }

    // IMPLEMENTED_VS_INTEGRATED — independent dimensions.
    if (li >= MATERIALIZED && !['IMPLEMENTED', 'NOT_APPLICABLE'].includes(r.implementation_status)) {
      add('IMPLEMENTED_VS_INTEGRATED', p, `${r.lifecycle_state} with implementation_status ${r.implementation_status}; integration_status ${r.integration_status} is a separate dimension — NOT_INTEGRATED is not NOT_IMPLEMENTED`)
    }
    if (r.integration_status === 'INTEGRATED' && r.implementation_status === 'NOT_IMPLEMENTED') {
      add('IMPLEMENTED_VS_INTEGRATED', p, 'INTEGRATED yet NOT_IMPLEMENTED is contradictory')
    }

    // EXECUTED_EVIDENCE.
    if (li >= EXECUTED) {
      if (!r.observed_at) add('EXECUTED_EVIDENCE', p, `${r.lifecycle_state} requires observed_at`)
      if (!r.evidence.some((e) => e.class === 'REPOSITORY_FACT' || e.class === 'PROVIDER_OBSERVATION')) {
        add('EXECUTED_EVIDENCE', p, `${r.lifecycle_state} requires REPOSITORY_FACT or PROVIDER_OBSERVATION evidence; INFERENCE alone never suffices`)
      }
    }

    // EXECUTION_ALLOWED.
    const open = r.blocking_findings.filter((f) => f.status === 'OPEN')
    if (r.execution_allowed) {
      if (r.lifecycle_state !== 'ARMED') add('EXECUTION_ALLOWED', p, `execution_allowed=true requires lifecycle ARMED, found ${r.lifecycle_state}`)
      if (open.length > 0) add('EXECUTION_ALLOWED', p, `execution_allowed=true with unresolved blocking finding(s) ${open.map((f) => f.finding_id).join(', ')}`)
    }

    // CLOSED_REQUIRES.
    if (r.lifecycle_state === 'CLOSED') {
      for (const d of r.dependencies) {
        const dep = byId.get(d)
        if (dep && dep.lifecycle_state !== 'CLOSED') add('CLOSED_REQUIRES', p, `dependency ${d} is ${dep.lifecycle_state}, not CLOSED`)
      }
      if (open.length > 0) add('CLOSED_REQUIRES', p, `CLOSED with unresolved blocking finding(s) ${open.map((f) => f.finding_id).join(', ')}`)
      if (!r.evidence.some((e) => e.class === 'HUMAN_DECISION')) add('CLOSED_REQUIRES', p, 'CLOSED requires a HUMAN_DECISION evidence item')
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
// Transition between two revisions of the state.
// ---------------------------------------------------------------------------

export function validateTransition(prev: ClosureState, next: ClosureState, schema: Schema): Issue[] {
  const issues: Issue[] = []
  const ladder = lifecycleLadder(schema)
  if (next.revision !== prev.revision + 1) {
    issues.push({ rule: 'TRANSITION', path: 'revision', message: `revision must advance by exactly 1 (${prev.revision} -> ${next.revision})` })
  }
  if (ms(next.as_of) < ms(prev.as_of)) issues.push({ rule: 'TRANSITION', path: 'as_of', message: 'as_of moved backwards' })
  const nextById = new Map(next.records.map((r) => [r.gate_id, r]))
  for (const pr of prev.records) {
    const nr = nextById.get(pr.gate_id)
    if (!nr) {
      issues.push({ rule: 'TRANSITION', path: `records(${pr.gate_id})`, message: 'record removed; records are superseded, never deleted' })
      continue
    }
    const delta = ladder.indexOf(nr.lifecycle_state) - ladder.indexOf(pr.lifecycle_state)
    if (delta > 1) {
      issues.push({ rule: 'TRANSITION', path: `records(${pr.gate_id})`, message: `invalid lifecycle transition ${pr.lifecycle_state} -> ${nr.lifecycle_state} skips ${delta - 1} state(s)` })
    }
    if (delta < 0 && !nr.invalidated_by.some((v) => v.fired)) {
      issues.push({ rule: 'TRANSITION', path: `records(${pr.gate_id})`, message: `regression ${pr.lifecycle_state} -> ${nr.lifecycle_state} requires a fired invalidator` })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// 3. Git layer — re-derive SHA-bound claims from the repository.
// ---------------------------------------------------------------------------

function gitOut(cwd: string, args: string[]): string | undefined {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return res.status === 0 ? res.stdout : undefined
}

function treeOf(cwd: string, sha: string): string | undefined {
  return gitOut(cwd, ['rev-parse', '--verify', '-q', `${sha}^{tree}`])?.trim()
}

/**
 * sha256 over the sorted `git ls-tree -r -z` entries (mode, type, blob, path)
 * of `paths` at `sha`. Undefined if the ref does not resolve or any path is
 * absent — a partial package is never digested.
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

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function verifyGit(state: ClosureState, cwd: string): Issue[] {
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
      if (r.integration_status === 'INTEGRATED' || r.integration_status === 'NOT_INTEGRATED') {
        const anc = isAncestor(cwd, r.candidate_sha, base.sha)
        if (anc === undefined) add(p, 'integration ancestry undeterminable')
        else if (anc !== (r.integration_status === 'INTEGRATED')) {
          add(p, `integration_status ${r.integration_status} contradicts git (candidate ${anc ? 'IS' : 'is NOT'} an ancestor of ${base.sha})`)
        }
      }
      for (const [role, sha] of Object.entries(r.lineage_shas)) {
        const anc = isAncestor(cwd, r.candidate_sha, sha as string)
        if (anc !== true) add(p, `lineage ${role} ${sha} is not a resolvable descendant of the candidate`)
      }
      if (r.covered_package_digest) {
        const d = packageDigest(cwd, r.candidate_sha, r.covered_paths)
        if (d !== r.covered_package_digest) add(p, `covered_package_digest mismatch at candidate (git ${d ?? 'UNREADABLE'})`)
      }
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
// RUN_STATE.
// ---------------------------------------------------------------------------

export interface RunStateResumeCheck {
  head: string
  verdict: 'RESUME' | 'DRIFT'
  detail: string
}

export function checkRunStateResume(runState: { last_verified_head: string; own_commits?: string[] }, head: string): RunStateResumeCheck {
  const own = runState.own_commits ?? []
  if (head === runState.last_verified_head) return { head, verdict: 'RESUME', detail: 'HEAD == last_verified_head' }
  if (own.length > 0 && head === own[own.length - 1]) return { head, verdict: 'RESUME', detail: 'HEAD == last own commit' }
  return { head, verdict: 'DRIFT', detail: `HEAD ${head} is neither last_verified_head ${runState.last_verified_head} nor the last own commit — STOP, never reconcile silently` }
}

export function validateRunState(runState: unknown, schema: Schema): Issue[] {
  return [...validateSchema(schema, runState), ...scanSecrets(runState)]
}

// ---------------------------------------------------------------------------
// Composition + CLI.
// ---------------------------------------------------------------------------

export function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export interface ValidateOptions {
  now: string
  previous?: ClosureState
  gitCwd?: string
}

/** Structural first; semantic/transition/git only on a structurally valid state (their inputs are then typed). */
export function validateClosureState(state: unknown, schema: Schema, opts: ValidateOptions): Issue[] {
  const structural = validateSchema(schema, state)
  if (structural.length > 0) return structural
  const s = state as ClosureState
  const issues = validateSemantics(s, schema, opts.now)
  if (opts.previous) issues.push(...validateTransition(opts.previous, s, schema))
  if (opts.gitCwd) issues.push(...verifyGit(s, opts.gitCwd))
  return issues
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

export function main(argvIn: string[], cwd: string): number {
  const argv = argvIn[0] === '--' ? argvIn.slice(1) : argvIn
  const [command, ...rest] = argv
  const json = rest.includes('--json')
  try {
    if (command === 'validate') {
      const statePath = path.resolve(cwd, takeValues(rest, '--state')[0] ?? CLOSURE_STATE_PATH)
      const schema = loadJson(path.resolve(cwd, CLOSURE_STATE_SCHEMA_PATH)) as Schema
      const previousPath = takeValues(rest, '--previous')[0]
      const now = takeValues(rest, '--now')[0] ?? new Date().toISOString()
      const issues = validateClosureState(loadJson(statePath), schema, {
        now,
        previous: previousPath ? (loadJson(path.resolve(cwd, previousPath)) as ClosureState) : undefined,
        gitCwd: rest.includes('--verify-git') ? cwd : undefined,
      })
      return report('validate', issues, json, { state: path.relative(cwd, statePath).replace(/\\/g, '/'), now, git: rest.includes('--verify-git') })
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
    if (command === 'run-state') {
      const file = takeValues(rest, '--file')[0]
      if (!file) { process.stderr.write('run-state requires --file\n'); return 2 }
      const schema = loadJson(path.resolve(cwd, RUN_STATE_SCHEMA_PATH)) as Schema
      const rs = loadJson(path.resolve(cwd, file))
      const issues = validateRunState(rs, schema)
      const repo = takeValues(rest, '--repo')[0]
      let resume: RunStateResumeCheck | undefined
      if (repo && issues.length === 0) {
        const head = gitOut(path.resolve(cwd, repo), ['rev-parse', 'HEAD'])?.trim()
        if (!head) issues.push({ rule: 'RUN_STATE', path: '--repo', message: 'HEAD unreadable' })
        else {
          resume = checkRunStateResume(rs as { last_verified_head: string; own_commits?: string[] }, head)
          if (resume.verdict === 'DRIFT') issues.push({ rule: 'RUN_STATE_DRIFT', path: 'last_verified_head', message: resume.detail })
        }
      }
      return report('run-state', issues, json, resume ? { resume: resume.verdict, head: resume.head } : {})
    }
    process.stderr.write('usage: ops:closure-state -- validate|digest|run-state [options] (see scripts/ops/closure-state.ts header)\n')
    return 2
  } catch (err) {
    process.stderr.write(`ops:closure-state: ${(err as Error).message}\n`)
    return 1
  }
}

// argv is checked rather than `import.meta.url`, matching scripts/ods-program-state.ts.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ops/closure-state.ts')
if (invokedDirectly) process.exitCode = main(process.argv.slice(2), process.cwd())
