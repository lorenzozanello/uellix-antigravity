// @vitest-environment node
//
// tests/release/staging-recovery-cert-adjudication.test.ts
// STAGING RECOVERY — certification ADJUDICATION contract and revocation by
// package_digest (Recovery amendment v1.0.4, owner record v1.0.2).
//
// Authority:
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.4.json
//   docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.2.json
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.4.json
//
// WHAT THIS FILE IS. A reference interpreter of SECTION_E3: the V2 closure
// derivation, store integrity, record validation W1..W11 / R1 / R2,
// write-once history over the FULL git DAG, canonical-store freshness,
// disposition status (CERTIFIED / REVOKED / CONTRADICTED / ...), currency and
// the consumer rule. Revocation, contradiction, integrity, history and
// freshness are exercised on REAL git repositories built in a private
// temporary directory. Every enum, token list, prefix, path pattern and
// declared layer is read from the amendment.
//
// WHAT THIS FILE IS NOT. It writes no adjudication or occurrence into this
// repository. Fixture records live only in the temporary fixture repositories
// and carry fixture lane ids. No database, provider or hosted act.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const GIT_TIMEOUT = 180_000

const PATHS = {
  v104: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.4.json',
  manifest104: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.4.json',
  owner102: 'docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.2.json',
  self: 'tests/release/staging-recovery-cert-adjudication.test.ts',
  battery: 'tests/release/staging-recovery-cert-adjudication.mutation-battery.mjs',
  v103: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.3.json',
  v102: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.2.json',
  v101: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json',
  v100: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_v1.0.0.json',
} as const
const BASE_COMMIT = 'a9ddc4d2c217921b015d0895ad008659afa4d418'

const readBytes = (rel: string): Buffer => readFileSync(path.join(ROOT, rel))
const readJson = <T>(rel: string): T => JSON.parse(readBytes(rel).toString('utf8')) as T
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
/** Bytes git stores: docs/** is LF-pinned; other text round-trips through core.autocrlf. */
const storedBytes = (rel: string): Buffer =>
  rel.startsWith('docs/') ? readBytes(rel) : Buffer.from(readBytes(rel).toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
const gitBlobSha = (bytes: Buffer): string =>
  createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes])).digest('hex')
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]))
  }
  return v
}
const canonical = (v: unknown): string => JSON.stringify(sortDeep(v))
const canonicalPretty = (v: unknown): string => `${JSON.stringify(sortDeep(v), null, 2)}\n`
const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/* ========================================================================== */
/* Shapes                                                                     */
/* ========================================================================== */

type Role = 'COVERED' | 'TOOLCHAIN' | 'IMPORTED' | 'RUNTIME_INPUT' | 'GOVERNING'
interface Entry { role: Role; path: string; blob: string }
interface Member { path: string; blob: string }
interface Identity {
  candidate_sha: string
  tree_sha: string
  digest_algorithm: string
  entries: Entry[]
  package_digest: string
  governing_families: string[]
  governing_family_members_at_candidate: Member[]
}
interface KnownSubject extends Identity { id: string; subject_kind: string; adjudication_directory: string }
interface Declared { path: string; blob: string | null; reason: string }
interface Anchor { path: string; section: string }
interface Contract {
  meaning: string
  subject_kinds: { kinds: Record<string, { covered_path_prefixes: string[]; toolchain_roots: string[] }> }
  subject_identity_derivation: { import_resolution_suffixes: string[] }
  verdict: {
    verdict_classes: string[]
    positive_classes: string[]
    non_positive_classes: string[]
    required_qualifier_tokens: string[]
    prefix_token_vocabulary: string[]
    version_token_pattern: string
  }
  provenance: { recert_scope: { values: string[] } }
  path_and_identity: { adjudication_root: string; adjudication_path: string; kind_path_codes: Record<string, string> }
  canonical_store: { CANONICAL_ADJUDICATION_REF: string }
  currency: { declared_non_invalidating_governing_layers: Record<string, Declared[] | string> }
  consumer_rule: { consumer_results: string[] }
  record_schema: {
    top_level_keys_exact: string[]
    nested_keys_exact: Record<string, string[]>
    entry_roles: string[]
    authority_class: string
    section: string
  }
  validation_order: string[]
  stop_codes: string[]
}
interface Locus { locus: string; class: string; consumer?: string; reason?: string; file?: string }
interface V104 {
  SECTION_E3_ADJUDICATION_CONTRACT: Contract
  SECTION_E4_CONSUMER_REGISTRY: { loci: Locus[]; loci_older_layers: Locus[] }
  SECTION_E5_KNOWN_SUBJECTS_V2: { subjects: KnownSubject[] }
  SECTION_E6_PRECEDENCE_ANCHORS: { anchors: Record<string, Anchor[]>; c10_semantic_identifiers: Record<string, string[] | string> }
  SECTION_E7_MATERIALIZATION_WRITE_SET: { retired_occurrence_root: string }
  SECTION_E10_EVENT_A_PRESERVATION: { CURRENT_EVENT_A_REACHABLE: string; EVENT_A_POLICY: string }
  SECTION_E11_SUPERSEDED_LOCI: { chain: string; topic: string; locus: string }[]
  SECTION_E15_WRITE_SET: string[]
  SECTION_E16_PRESERVATION: { AUTHORIZED_OPERATIONS_DELTA: { added: unknown[]; removed: unknown[]; modified: unknown[] } }
}
interface Adjudication {
  adjudication_contract: { path: string; section: string; blob: string }
  subject_kind: string
  subject: Identity
  verdict: { verdict_class: string; verdict_literal: string; blocking_findings_count: number; nonblocking_findings_reported_count: number }
  blocking_findings: { id: string; summary: string }[]
  nonblocking_findings: { id: string; summary: string; status: string }[]
  closes_predecessor_findings: string[]
  provenance: {
    candidate_author: { lane_id: string; executor: string }
    independent_adjudicator: {
      lane_id: string
      executor: string
      examined_candidate_sha: string
      examined_tree_sha: string
      adjudication_date: string
      scope: string
      scope_basis: string[]
      report_reference: string
    }
    materializer: { lane_id: string; executor: string; materialization_date: string }
    identity_facts_basis: string
    verdict_and_findings_basis: string
    materializer_reproduced_adjudication_evidence: boolean
    independence_basis: string
  }
  chain: { predecessor: null | { path: string; adjudication_digest: string } }
  authority_class: string
  authorizes: unknown[]
  meaning: string
}

const AUTH = readJson<V104>(PATHS.v104)
const C = (a: V104 = AUTH): Contract => a.SECTION_E3_ADJUDICATION_CONTRACT
const WRITE_SET = AUTH.SECTION_E15_WRITE_SET.map((w) => w.split(' ')[0])
const KS = (id: string): KnownSubject => {
  const s = AUTH.SECTION_E5_KNOWN_SUBJECTS_V2.subjects.find((x) => x.id === id)
  if (!s) throw new Error(`known subject ${id} absent`)
  return s
}
const KS_A = KS('KS-A')
const KS_B = KS('KS-B')
const CENSUS = 'READONLY_CENSUS_AUTHORITY_RECERT'
const OFFLINE = 'OFFLINE_RECOVERY_IMPLEMENTATION_RECERT'

/* ========================================================================== */
/* Git and tree views                                                         */
/* ========================================================================== */

const git = (args: string[], cwd = ROOT, input?: string): Buffer =>
  execFileSync('git', args, { cwd, maxBuffer: 1 << 29, input, stdio: ['pipe', 'pipe', 'ignore'] })
const gitText = (args: string[], cwd = ROOT): string => git(args, cwd).toString('utf8').trim()
function hasCommit(sha: string): boolean {
  try {
    return gitText(['cat-file', '-t', sha]) === 'commit'
  } catch {
    return false
  }
}

interface View { list(): string[]; blob(p: string): string | null; texts(ps: string[]): Map<string, string | null> }

function readBlobs(oids: string[], cwd = ROOT): Map<string, string> {
  const out = new Map<string, string>()
  const unique = [...new Set(oids)]
  if (unique.length === 0) return out
  const buf = git(['cat-file', '--batch'], cwd, `${unique.join('\n')}\n`)
  let at = 0
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at)
    const [oid, , size] = buf.subarray(at, nl).toString('utf8').split(' ')
    const n = Number(size)
    out.set(oid, buf.subarray(nl + 1, nl + 1 + n).toString('utf8'))
    at = nl + 1 + n + 1
  }
  return out
}

function commitView(sha: string, cwd = ROOT): View {
  const blobs = new Map<string, string>()
  for (const line of git(['ls-tree', '-r', sha], cwd).toString('utf8').split('\n')) {
    if (!line) continue
    const [meta, p] = line.split('\t')
    const [, type, oid] = meta.split(' ')
    if (type === 'blob') blobs.set(p, oid)
  }
  const list = [...blobs.keys()]
  return {
    list: () => list,
    blob: (p) => blobs.get(p) ?? null,
    texts: (ps) => {
      const got = readBlobs(ps.map((p) => blobs.get(p)).filter((o): o is string => o !== undefined), cwd)
      return new Map(ps.map((p) => [p, blobs.has(p) ? (got.get(blobs.get(p) as string) ?? null) : null]))
    },
  }
}

function patchedView(base: View, patch: Record<string, { blob: string; text?: string } | null>): View {
  const list = [...new Set([...base.list(), ...Object.keys(patch)])].filter((p) => patch[p] !== null)
  return {
    list: () => list,
    blob: (p) => (p in patch ? (patch[p]?.blob ?? null) : base.blob(p)),
    texts: (ps) => {
      const rest = base.texts(ps.filter((p) => !(p in patch)))
      return new Map(ps.map((p) => [p, p in patch ? (patch[p] ? (patch[p]?.text ?? '') : null) : (rest.get(p) ?? null)]))
    },
  }
}

/** The tree that introduces v1.0.4: a9ddc4d2 plus this write set. Fixed forever. */
let introducingCache: View | null = null
function introducingView(): View {
  if (introducingCache) return introducingCache
  if (!hasCommit(BASE_COMMIT)) throw new Error(`base ${BASE_COMMIT} absent; it is an ancestor of this lineage`)
  introducingCache = patchedView(
    commitView(BASE_COMMIT),
    Object.fromEntries(WRITE_SET.map((p) => [p, { blob: gitBlobSha(storedBytes(p)), text: storedBytes(p).toString('utf8') }])),
  )
  return introducingCache
}

/* ========================================================================== */
/* RCO_CLOSURE_DIGEST_V2                                                      */
/* ========================================================================== */

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm
const LITERAL_RE = /['"`]((?:\.{1,2}\/)?[A-Za-z0-9_@-][A-Za-z0-9_.@-]*(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]+)['"`]/g
const SETUP_RE = /setupFiles\s*:\s*\[([^\]]*)\]/g
const REF_RE = /docs\/ops\/[A-Za-z0-9_./-]+\.json/g
const CODE_RE = /\.(ts|tsx|js|mjs|cjs)$/
const ROLE_ORDER: Role[] = ['COVERED', 'TOOLCHAIN', 'IMPORTED', 'RUNTIME_INPUT', 'GOVERNING']
const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
const family = (p: string): string => {
  const i = p.search(/_v\d/)
  return i < 0 ? p : p.slice(0, i + 1)
}
const digestOf = (entries: Entry[]): string => sha256(entries.map((e) => `${e.role}\t${e.path}\t${e.blob}\n`).join(''))

function coveredAt(contract: Contract, kind: string, view: View): string[] {
  const prefixes = contract.subject_kinds.kinds[kind]?.covered_path_prefixes ?? []
  return view.list().filter((p) => prefixes.some((x) => p.startsWith(x))).sort(byteOrder)
}

function deriveV2(contract: Contract, kind: string, candidate: string, tree: string, view: View): Identity | string {
  const k = contract.subject_kinds.kinds[kind]
  if (!k) return 'unknown kind'
  const covered = coveredAt(contract, kind, view)
  if (covered.length === 0) return 'empty COVERED'
  const present = new Set(view.list())
  const role = new Map<string, Role>()
  covered.forEach((p) => role.set(p, 'COVERED'))
  const text = new Map<string, string>()
  const load = (ps: string[]): void => {
    for (const [p, t] of view.texts(ps.filter((x) => !text.has(x)))) text.set(p, t ?? '')
  }
  const suffixes = contract.subject_identity_derivation.import_resolution_suffixes
  const close = (seeds: string[], label: Role): string | null => {
    let frontier = seeds.filter((p) => CODE_RE.test(p))
    while (frontier.length > 0) {
      load(frontier)
      const next: string[] = []
      for (const f of frontier) {
        for (const m of (text.get(f) ?? '').matchAll(IMPORT_RE)) {
          const s = m[1]
          let base: string
          if (s.startsWith('@/')) base = s.slice(2)
          else if (s.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(f), s))
          else continue
          const hit = suffixes.map((x) => base + x).find((c) => present.has(c))
          if (!hit) return `unresolved import ${s} in ${f}`
          if (!role.has(hit)) {
            role.set(hit, label)
            if (CODE_RE.test(hit)) next.push(hit)
          }
        }
      }
      frontier = next
    }
    return null
  }
  const e1 = close(covered, 'IMPORTED')
  if (e1) return e1
  const toolchain: string[] = []
  for (const t of k.toolchain_roots) {
    if (!present.has(t)) return `toolchain root missing ${t}`
    if (!role.has(t)) {
      role.set(t, 'TOOLCHAIN')
      toolchain.push(t)
    }
  }
  const codeRoots = k.toolchain_roots.filter((p) => CODE_RE.test(p))
  load(codeRoots)
  for (const t of codeRoots) {
    for (const m of (text.get(t) ?? '').matchAll(SETUP_RE)) {
      for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
        const r = path.posix.normalize(path.posix.join(path.posix.dirname(t), s[1]))
        if (!present.has(r)) return `setup file missing ${r}`
        if (!role.has(r)) {
          role.set(r, 'TOOLCHAIN')
          toolchain.push(r)
        }
      }
    }
  }
  const e2 = close(toolchain, 'TOOLCHAIN')
  if (e2) return e2
  const coveredCode = covered.filter((p) => CODE_RE.test(p))
  load(coveredCode)
  for (const f of coveredCode) {
    for (const m of stripComments(text.get(f) ?? '').matchAll(LITERAL_RE)) {
      const s = m[1]
      const r = s.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(f), s)) : s
      if (!present.has(r) || role.has(r) || /^docs\/ops\/.*\.json$/.test(r)) continue
      role.set(r, 'RUNTIME_INPUT')
    }
  }
  const scan = [...role].filter(([, r]) => r !== 'RUNTIME_INPUT').map(([p]) => p)
  load(scan)
  const refs = new Set<string>()
  for (const p of scan) for (const m of (text.get(p) ?? '').matchAll(REF_RE)) refs.add(m[0])
  for (const g of [...refs].sort(byteOrder)) {
    if (role.has(g)) continue
    if (!present.has(g)) return `dangling ${g}`
    role.set(g, 'GOVERNING')
  }
  const entries: Entry[] = []
  for (const r of ROLE_ORDER) {
    for (const p of [...role].filter(([, x]) => x === r).map(([q]) => q).sort(byteOrder)) {
      const blob = view.blob(p)
      if (blob === null) return `no blob ${p}`
      entries.push({ role: r, path: p, blob })
    }
  }
  const families = [...new Set(entries.filter((e) => e.role === 'GOVERNING').map((e) => family(e.path)))].sort(byteOrder)
  return {
    candidate_sha: candidate,
    tree_sha: tree,
    digest_algorithm: 'RCO_CLOSURE_DIGEST_V2',
    entries,
    package_digest: digestOf(entries),
    governing_families: families,
    governing_family_members_at_candidate: view
      .list()
      .filter((p) => families.some((f) => p.startsWith(f)))
      .sort(byteOrder)
      .map((p) => ({ path: p, blob: view.blob(p) as string })),
  }
}

/* ========================================================================== */
/* Record validation                                                          */
/* ========================================================================== */

const adjudicationDigest = (r: unknown): string => sha256(canonical(r))
const kindCode = (contract: Contract, kind: string): string => contract.path_and_identity.kind_path_codes[kind] ?? '?'
const adjudicationPathFor = (contract: Contract, r: Adjudication): string =>
  contract.path_and_identity.adjudication_path
    .replace('<KIND_CODE>', kindCode(contract, r.subject_kind))
    .replace('<package_digest>', r.subject?.package_digest ?? '')
    .replace('<adjudication_digest>', adjudicationDigest(r))
const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== ''
const LANE_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/
const identityKey = (lane: string): string => lane.split('-').join('')
const keysExact = (o: unknown, keys: string[]): boolean =>
  o !== null && typeof o === 'object' && !Array.isArray(o) && sameList(Object.keys(o).sort(byteOrder), [...keys].sort(byteOrder))
const byRole = (s: Identity, ...roles: Role[]): Entry[] => s.entries.filter((e) => roles.includes(e.role))
const pathsOf = (es: { path: string }[]): string[] => es.map((e) => e.path)
const blobsEqual = (a: { path: string; blob: string }[], b: { path: string; blob: string }[]): boolean =>
  a.length === b.length && a.every((e, i) => e.path === b[i].path && e.blob === b[i].blob)
const NON_GOVERNING: Role[] = ['COVERED', 'TOOLCHAIN', 'IMPORTED', 'RUNTIME_INPUT']

/** Strict parse used for POSITIVE records: returns the class or null. */
function parseStrict(v: Contract['verdict'], literal: unknown): string | null {
  if (typeof literal !== 'string' || !/^[A-Z0-9_]+$/.test(literal)) return null
  const tokens = literal.split('_')
  const version = new RegExp(v.version_token_pattern)
  for (const c of [...v.verdict_classes].sort((a, b) => b.split('_').length - a.split('_').length)) {
    const ct = c.split('_')
    if (tokens.length > ct.length && tokens.slice(-ct.length).join('_') === c) {
      const prefix = tokens.slice(0, -ct.length)
      if (!v.required_qualifier_tokens.includes(prefix[prefix.length - 1])) return null
      return prefix.every((t) => v.prefix_token_vocabulary.includes(t) || version.test(t)) ? c : null
    }
  }
  return null
}
/** SECTION_E3.verdict.literal_rule. */
function literalOk(v: Contract['verdict'], cls: string, literal: unknown): boolean {
  if (!v.verdict_classes.includes(cls)) return false
  if (v.positive_classes.includes(cls)) return parseStrict(v, literal) === cls
  if (typeof literal !== 'string' || !/^[A-Z0-9_]+$/.test(literal)) return false
  const tokens = literal.split('_')
  return !v.positive_classes.some((p) => tokens.slice(-p.split('_').length).join('_') === p)
}

interface Stored { path: string; record: Adjudication }
interface Ctx {
  mode: 'write' | 'read'
  contract: Contract
  knownSubjects: KnownSubject[]
  contractPath: string
  contractBlob: string
  recordPath: string
  derived: Identity | string
  target: string | null
  existing: Stored[]
  historyViolations: string[]
}

function shapeOk(r: Adjudication, c: Ctx): boolean {
  const s = c.contract.record_schema
  const n = s.nested_keys_exact
  const p = r.provenance as unknown as Record<string, unknown>
  return (
    keysExact(r, s.top_level_keys_exact) &&
    keysExact(r.adjudication_contract, n.adjudication_contract) &&
    keysExact(r.subject, n.subject) &&
    Array.isArray(r.subject.entries) &&
    r.subject.entries.every((e) => keysExact(e, n['subject.entries[]']) && s.entry_roles.includes(e.role)) &&
    Array.isArray(r.subject.governing_family_members_at_candidate) &&
    r.subject.governing_family_members_at_candidate.every((m) => keysExact(m, n['subject.governing_family_members_at_candidate[]'])) &&
    keysExact(r.verdict, n.verdict) &&
    Array.isArray(r.blocking_findings) &&
    r.blocking_findings.every((f) => keysExact(f, n['blocking_findings[]'])) &&
    Array.isArray(r.nonblocking_findings) &&
    r.nonblocking_findings.every((f) => keysExact(f, n['nonblocking_findings[]'])) &&
    keysExact(p, n.provenance) &&
    keysExact(p.candidate_author, n['provenance.candidate_author']) &&
    keysExact(p.independent_adjudicator, n['provenance.independent_adjudicator']) &&
    keysExact(p.materializer, n['provenance.materializer']) &&
    keysExact(r.chain, n.chain) &&
    (r.chain.predecessor === null || keysExact(r.chain.predecessor, n['chain.predecessor (when not null)']))
  )
}

/** Chain integrity of all stored records of one kind. Returns null or a reason. */
function chainIntegrity(records: Stored[]): string | null {
  if (records.length === 0) return null
  const byPath = new Map(records.map((s) => [s.path, s]))
  const roots = records.filter((s) => s.record.chain.predecessor === null)
  if (roots.length !== 1) return `roots=${roots.length}`
  const successors = new Map<string, Stored[]>()
  for (const s of records) {
    const p = s.record.chain.predecessor
    if (p === null) continue
    const pred = byPath.get(p.path)
    if (!pred) return `missing predecessor ${p.path}`
    if (adjudicationDigest(pred.record) !== p.adjudication_digest) return `predecessor digest mismatch ${p.path}`
    successors.set(p.path, [...(successors.get(p.path) ?? []), s])
  }
  let cur: Stored | undefined = roots[0]
  const seen = new Set<string>()
  while (cur) {
    if (seen.has(cur.path)) return 'cycle'
    seen.add(cur.path)
    const next: Stored[] = successors.get(cur.path) ?? []
    if (next.length > 1) return `fork at ${cur.path}`
    cur = next[0]
  }
  return seen.size === records.length ? null : 'orphan records'
}

/** Records of one kind in chain order (root first). Assumes chainIntegrity passed. */
function chainOrder(records: Stored[]): Stored[] {
  const root = records.find((s) => s.record.chain.predecessor === null)
  const next = new Map(records.filter((s) => s.record.chain.predecessor).map((s) => [s.record.chain.predecessor?.path as string, s]))
  const out: Stored[] = []
  for (let cur = root; cur; cur = next.get(cur.path)) out.push(cur)
  return out
}

type Check = (r: Adjudication, c: Ctx) => string | null
interface CheckDef { id: string; when: 'both' | 'write' | 'read'; check: Check }

/** SECTION_E3.validation_order, in order. */
const CHECKS: CheckDef[] = [
  { id: 'W1_KIND', when: 'both', check: (r, c) => (typeof r.subject_kind === 'string' && c.contract.subject_kinds.kinds[r.subject_kind] ? null : 'STOP_UNKNOWN_SUBJECT_KIND') },
  { id: 'W2_SHAPE', when: 'both', check: (r, c) => (shapeOk(r, c) ? null : 'STOP_ADJUDICATION_SHAPE') },
  { id: 'W3_CONTRACT', when: 'both', check: (r, c) =>
    r.adjudication_contract.path === c.contractPath && r.adjudication_contract.section === c.contract.record_schema.section && r.adjudication_contract.blob === c.contractBlob
      ? null
      : 'STOP_ADJUDICATION_CONTRACT_MISMATCH' },
  { id: 'W4_NOT_AUTHORITY', when: 'both', check: (r, c) =>
    r.authority_class === c.contract.record_schema.authority_class && Array.isArray(r.authorizes) && r.authorizes.length === 0 && r.meaning === c.contract.meaning
      ? null
      : 'STOP_ADJUDICATION_CLAIMS_AUTHORITY' },
  { id: 'W5_SHA_FORMAT', when: 'both', check: (r) => (/^[0-9a-f]{40}$/.test(r.subject.candidate_sha) ? null : 'STOP_CANDIDATE_SHA_MALFORMED') },
  { id: 'W5_PATH_IDENTITY', when: 'both', check: (r, c) => (c.recordPath === adjudicationPathFor(c.contract, r) ? null : 'STOP_ADJUDICATION_PATH_IDENTITY_MISMATCH') },
  { id: 'W6_KIND_SUBJECT', when: 'both', check: (r, c) => {
    const prefixes = c.contract.subject_kinds.kinds[r.subject_kind]?.covered_path_prefixes ?? []
    const cov = byRole(r.subject, 'COVERED')
    return cov.length > 0 && cov.every((e) => prefixes.some((x) => e.path.startsWith(x))) ? null : 'STOP_SUBJECT_KIND_MISMATCH'
  } },
  { id: 'W7_TARGET', when: 'both', check: (r, c) => {
    if (c.target === null) return null
    const t = c.knownSubjects.find((k) => k.id === c.target)
    if (!t || t.subject_kind !== r.subject_kind) return 'STOP_SUBJECT_KIND_MISMATCH'
    if (r.subject.candidate_sha !== t.candidate_sha) return 'STOP_CANDIDATE_SHA_MISMATCH'
    if (r.subject.tree_sha !== t.tree_sha) return 'STOP_TREE_SHA_MISMATCH'
    if (!blobsEqual(byRole(r.subject, ...NON_GOVERNING), byRole(t, ...NON_GOVERNING))) return 'STOP_COVERED_SET_MISMATCH'
    if (!blobsEqual(byRole(r.subject, 'GOVERNING'), byRole(t, 'GOVERNING'))) return 'STOP_GOVERNING_PIN_MISMATCH'
    if (!sameList(r.subject.governing_families, t.governing_families)) return 'STOP_GOVERNING_PIN_MISMATCH'
    if (!blobsEqual(r.subject.governing_family_members_at_candidate, t.governing_family_members_at_candidate)) return 'STOP_GOVERNING_PIN_MISMATCH'
    if (r.subject.package_digest !== t.package_digest) return 'STOP_PACKAGE_DIGEST_MISMATCH'
    return null
  } },
  { id: 'W7_DERIVED', when: 'both', check: (r, c) => {
    const d = c.derived
    if (typeof d === 'string' || d.candidate_sha !== r.subject.candidate_sha || d.tree_sha === d.candidate_sha) return 'STOP_CANDIDATE_SHA_MISMATCH'
    if (d.tree_sha !== r.subject.tree_sha) return 'STOP_TREE_SHA_MISMATCH'
    const tag = (e: Entry): string => `${e.role}:${e.path}`
    if (!sameList(r.subject.entries.filter((e) => e.role !== 'GOVERNING').map(tag), d.entries.filter((e) => e.role !== 'GOVERNING').map(tag))) return 'STOP_COVERED_SET_MISMATCH'
    if (!blobsEqual(byRole(r.subject, ...NON_GOVERNING), byRole(d, ...NON_GOVERNING))) return 'STOP_COVERED_SET_MISMATCH'
    if (!blobsEqual(byRole(r.subject, 'GOVERNING'), byRole(d, 'GOVERNING'))) return 'STOP_GOVERNING_PIN_MISMATCH'
    if (!sameList(r.subject.governing_families, d.governing_families)) return 'STOP_GOVERNING_PIN_MISMATCH'
    if (!blobsEqual(r.subject.governing_family_members_at_candidate, d.governing_family_members_at_candidate)) return 'STOP_GOVERNING_PIN_MISMATCH'
    return null
  } },
  { id: 'W7_DIGEST', when: 'both', check: (r, c) =>
    r.subject.digest_algorithm === 'RCO_CLOSURE_DIGEST_V2' &&
    r.subject.package_digest === digestOf(r.subject.entries) &&
    typeof c.derived !== 'string' && r.subject.package_digest === c.derived.package_digest
      ? null
      : 'STOP_PACKAGE_DIGEST_MISMATCH' },
  { id: 'W8_LITERAL', when: 'both', check: (r, c) => (literalOk(c.contract.verdict, r.verdict.verdict_class, r.verdict.verdict_literal) ? null : 'STOP_VERDICT_LITERAL_MISMATCH') },
  { id: 'W8_CLASS_CONSISTENCY', when: 'both', check: (r) => {
    const v = r.verdict
    const b = r.blocking_findings
    const nb = v.nonblocking_findings_reported_count
    const ids = b.map((x) => x.id)
    const listOk = v.blocking_findings_count === b.length && b.every((x) => isStr(x.id) && isStr(x.summary)) && new Set(ids).size === ids.length
    const ok =
      v.verdict_class === 'PASS' ? v.blocking_findings_count === 0 && b.length === 0 && nb === 0
      : v.verdict_class === 'PASS_WITH_NONBLOCKING_FINDINGS' ? v.blocking_findings_count === 0 && b.length === 0 && nb >= 1
      : v.verdict_class === 'FAIL' ? listOk && b.length >= 1
      : listOk
    return ok ? null : 'STOP_VERDICT_CLASS_INCONSISTENT'
  } },
  { id: 'W9_COMPLETE', when: 'both', check: (r) => {
    const f = r.nonblocking_findings
    const ids = f.map((x) => x.id)
    return f.length === r.verdict.nonblocking_findings_reported_count && f.every((x) => isStr(x.id) && isStr(x.summary)) && new Set(ids).size === ids.length
      ? null
      : 'STOP_NONBLOCKING_FINDINGS_INCOMPLETE'
  } },
  { id: 'W9_OPEN', when: 'both', check: (r) => (r.nonblocking_findings.every((x) => x.status === 'OPEN') ? null : 'STOP_FINDING_NOT_OPEN') },
  { id: 'W10_LANE_GRAMMAR', when: 'both', check: (r) => {
    const lanes = [r.provenance.candidate_author.lane_id, r.provenance.independent_adjudicator.lane_id, r.provenance.materializer.lane_id]
    return lanes.every((l) => typeof l === 'string' && LANE_RE.test(l)) ? null : 'STOP_PROVENANCE_IDENTITY_MALFORMED'
  } },
  { id: 'W10_INDEPENDENT', when: 'both', check: (r) => {
    const keys = [r.provenance.candidate_author.lane_id, r.provenance.independent_adjudicator.lane_id, r.provenance.materializer.lane_id].map(identityKey)
    return new Set(keys).size === 3 ? null : 'STOP_PROVENANCE_NOT_INDEPENDENT'
  } },
  { id: 'W10_SUBJECT_BINDING', when: 'both', check: (r) =>
    r.provenance.independent_adjudicator.examined_candidate_sha === r.subject.candidate_sha && r.provenance.independent_adjudicator.examined_tree_sha === r.subject.tree_sha
      ? null
      : 'STOP_RECERT_SUBJECT_MISMATCH' },
  { id: 'W10_SCOPE', when: 'both', check: (r, c) => {
    const a = r.provenance.independent_adjudicator
    const basisOk = Array.isArray(a.scope_basis) && a.scope_basis.every(isStr) && (a.scope === 'FULL_SUBJECT' ? a.scope_basis.length === 0 : a.scope_basis.length > 0)
    return c.contract.provenance.recert_scope.values.includes(a.scope) && basisOk && isStr(a.report_reference) ? null : 'STOP_RECERT_SCOPE_UNDECLARED'
  } },
  { id: 'W10_BASIS', when: 'both', check: (r) =>
    r.provenance.materializer_reproduced_adjudication_evidence === false &&
    r.provenance.identity_facts_basis === 'MATERIALIZER_REDERIVED' &&
    r.provenance.verdict_and_findings_basis === 'ADJUDICATOR_REPORTED_SECOND_HAND' &&
    r.provenance.independence_basis === 'PROCESS_GOVERNED'
      ? null
      : 'STOP_MATERIALIZER_REPRODUCTION_CLAIM' },
  { id: 'W11_PATH_FREE', when: 'write', check: (_r, c) => (c.existing.some((e) => e.path === c.recordPath) ? 'STOP_ADJUDICATION_PATH_EXISTS' : null) },
  { id: 'W11_CHAIN', when: 'write', check: (r, c) => {
    const same = c.existing.filter((e) => e.record.subject_kind === r.subject_kind)
    const p = r.chain.predecessor
    if (same.length === 0) return p === null ? null : 'STOP_CHAIN_PREDECESSOR_MISMATCH'
    if (chainIntegrity(same) !== null || p === null) return 'STOP_CHAIN_PREDECESSOR_MISMATCH'
    const ordered = chainOrder(same)
    const tip = ordered[ordered.length - 1]
    return p.path === tip.path && p.adjudication_digest === adjudicationDigest(tip.record) ? null : 'STOP_CHAIN_PREDECESSOR_MISMATCH'
  } },
  { id: 'W11_CLOSURE', when: 'write', check: (r, c) => {
    const closes = r.closes_predecessor_findings
    if (!Array.isArray(closes)) return 'STOP_FINDING_CLOSURE_INVALID'
    if (r.chain.predecessor === null) return closes.length === 0 ? null : 'STOP_FINDING_CLOSURE_INVALID'
    const pred = c.existing.find((e) => e.path === r.chain.predecessor?.path)
    const ids = new Set(pred?.record.nonblocking_findings.map((x) => x.id) ?? [])
    return new Set(closes).size === closes.length && closes.every((id) => ids.has(id)) ? null : 'STOP_FINDING_CLOSURE_INVALID'
  } },
  { id: 'R1_HISTORY', when: 'read', check: (_r, c) => (c.historyViolations.length === 0 ? null : 'STOP_ADJUDICATION_HISTORY_VIOLATED') },
  { id: 'R2_CHAIN', when: 'read', check: (r, c) => (chainIntegrity(c.existing.filter((e) => e.record.subject_kind === r.subject_kind)) === null ? null : 'STOP_CHAIN_INTEGRITY_VIOLATED') },
]

function validate(r: Adjudication, c: Ctx, disabled: ReadonlySet<string> = new Set()): string {
  for (const d of CHECKS) {
    if (disabled.has(d.id) || (d.when !== 'both' && d.when !== c.mode)) continue
    try {
      const stop = d.check(r, c)
      if (stop) return stop
    } catch {
      return 'STOP_ADJUDICATION_SHAPE'
    }
  }
  return 'VALID'
}

/* ========================================================================== */
/* Store integrity and write-once history (SECTION_E3)                        */
/* ========================================================================== */

interface RawEntry { path: string; mode: string; oid: string; bytes: string }

/** SECTION_E3.store_integrity over EVERY entry under the root. Returns violations. */
function storeIntegrity(contract: Contract, raw: RawEntry[]): string[] {
  const v: string[] = []
  const root = contract.path_and_identity.adjudication_root
  const codes = contract.path_and_identity.kind_path_codes
  const shape = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([A-Z]+)/([0-9a-f]{64})/([0-9a-f]{64})\\.json$`)
  for (const e of raw) {
    if (e.mode !== '100644') { v.push(`mode ${e.mode} ${e.path}`); continue }
    const m = shape.exec(e.path)
    if (!m) { v.push(`path shape ${e.path}`); continue }
    let rec: Adjudication
    try {
      rec = JSON.parse(e.bytes) as Adjudication
    } catch {
      v.push(`not json ${e.path}`)
      continue
    }
    if (canonicalPretty(rec) !== e.bytes) { v.push(`not canonical bytes ${e.path}`); continue }
    const kind = typeof rec?.subject_kind === 'string' ? rec.subject_kind : ''
    if (!(kind in codes) || codes[kind] !== m[1]) { v.push(`kind/directory ${e.path}`); continue }
    if (rec.subject?.package_digest !== m[2]) { v.push(`digest directory ${e.path}`); continue }
    if (adjudicationDigest(rec) !== m[3]) v.push(`content digest ${e.path}`)
  }
  return v
}

const HISTORY_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: path.join(tmpdir(), 'uellix-rca-no-grafts-file') }
function isShallow(cwd: string): boolean {
  return gitText(['rev-parse', '--is-shallow-repository'], cwd) !== 'false'
}
/** Violations of write_once_history for the whole root, given the paths present at H. */
function historyViolations(cwd: string, root: string, presentAtHead: string[]): string[] {
  const out = execFileSync(
    'git',
    ['--no-replace-objects', '-c', 'log.showRoot=true', 'log', '--full-history', '--no-renames', '--cc', '--format=%x01%H %P', '--name-status', '--', root],
    { cwd, env: HISTORY_ENV, maxBuffer: 1 << 29, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const adds = new Map<string, number>()
  const v: string[] = []
  let parents = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('\x01')) {
      parents = line.slice(1).trim().split(' ').length - 1
      continue
    }
    if (!line.trim()) continue
    const [status, p] = line.split('\t')
    if (parents > 1) v.push(`merge-entry ${status} ${p}`)
    else if (status === 'A') adds.set(p, (adds.get(p) ?? 0) + 1)
    else v.push(`${status} ${p}`)
  }
  for (const [p, n] of adds) if (n !== 1) v.push(`adds=${n} ${p}`)
  for (const p of presentAtHead) if (!adds.has(p)) v.push(`adds=0 ${p}`)
  return v
}

/* ========================================================================== */
/* Disposition status, currency and the consumer rule                         */
/* ========================================================================== */

function dispositionStatus(contract: Contract, ordered: Stored[], digest: string): { status: string; stop: string | null; positives: Adjudication[] } {
  const d = ordered.map((s) => s.record).filter((r) => r.subject.package_digest === digest)
  const pos = (r: Adjudication): boolean => contract.verdict.positive_classes.includes(r.verdict.verdict_class)
  if (d.length === 0) return { status: 'NOT_ADJUDICATED', stop: 'STOP_NOT_CERTIFIED', positives: [] }
  const positives = d.filter(pos)
  if (positives.length === 0) return { status: 'NEGATIVELY_ADJUDICATED', stop: 'STOP_NOT_CERTIFIED', positives }
  const firstNeg = d.findIndex((r) => !pos(r))
  if (firstNeg < 0) return { status: 'CERTIFIED', stop: null, positives }
  if (d.slice(firstNeg + 1).some(pos)) return { status: 'CONTRADICTED', stop: 'STOP_CONTRADICTORY_CERTIFICATION', positives }
  return { status: 'REVOKED', stop: 'STOP_CERTIFICATION_REVOKED', positives }
}

function familyRule(contract: Contract, kind: string, latest: Adjudication, head: View, contractPath: string): string {
  const raw = contract.currency.declared_non_invalidating_governing_layers[kind]
  const declared = new Map((Array.isArray(raw) ? raw : []).map((d) => [d.path, d.blob]))
  const recorded = new Map(latest.subject.governing_family_members_at_candidate.map((m) => [m.path, m.blob]))
  for (const p of head.list().filter((x) => latest.subject.governing_families.some((f) => x.startsWith(f)))) {
    const blob = head.blob(p)
    if (recorded.has(p)) {
      if (recorded.get(p) !== blob) return 'STALE_GOVERNING_AUTHORITY_CHANGED'
    } else if (declared.has(p)) {
      const want = declared.get(p)
      if (want === null ? p !== contractPath : want !== blob) return 'STALE_GOVERNING_AUTHORITY_CHANGED'
    } else return 'STALE_GOVERNING_LAYER_ADDED'
  }
  for (const p of recorded.keys()) if (head.blob(p) === null) return 'STALE_GOVERNING_AUTHORITY_CHANGED'
  return 'CURRENT'
}

interface Store { raw: RawEntry[]; records: Stored[]; history: string[]; shallow: boolean; occurrenceRootFiles: string[] }
interface ConsumerInput {
  contract: Contract
  kind: string
  head: View
  store: Store
  /** blobs of the entries under the root at the freshly fetched canonical tip */
  canonical: Map<string, string>
  /** the fetched canonical tip is an ancestor of H */
  canonicalIsAncestor: boolean
  contractPath: string
  contractBlob: string
  derivedFor: (r: Adjudication) => Identity | string
  targetFor: (r: Adjudication) => string | null
}
interface ConsumerResult { result: string; status?: string; package_digest?: string; scopes?: string[]; scope_basis?: string[][] }

/** SECTION_E3.consumer_rule, steps (0)..(9). */
function consume(i: ConsumerInput): ConsumerResult {
  if (i.store.shallow) return { result: 'STOP_ADJUDICATION_HISTORY_UNVERIFIABLE' }
  if (i.store.occurrenceRootFiles.length > 0) return { result: 'STOP_RETIRED_OCCURRENCE_ROOT_USED' }
  if (storeIntegrity(i.contract, i.store.raw).length > 0) return { result: 'STOP_ADJUDICATION_STORE_INVALID' }
  if (i.store.history.length > 0) return { result: 'STOP_ADJUDICATION_HISTORY_VIOLATED' }
  const mine = i.store.records.filter((s) => s.record.subject_kind === i.kind)
  if (chainIntegrity(mine) !== null) return { result: 'STOP_CHAIN_INTEGRITY_VIOLATED' }
  for (const s of i.store.records) {
    const ctx: Ctx = {
      mode: 'read',
      contract: i.contract,
      knownSubjects: AUTH.SECTION_E5_KNOWN_SUBJECTS_V2.subjects,
      contractPath: i.contractPath,
      contractBlob: i.contractBlob,
      recordPath: s.path,
      derived: i.derivedFor(s.record),
      target: i.targetFor(s.record),
      existing: i.store.records,
      historyViolations: i.store.history,
    }
    if (validate(s.record, ctx) !== 'VALID') return { result: 'STOP_ADJUDICATION_INVALID_AT_READ' }
  }
  if (!i.canonicalIsAncestor) return { result: 'STOP_ADJUDICATION_STORE_STALE' }
  const atHead = new Map(i.store.raw.map((e) => [e.path, e.oid]))
  for (const [p, b] of i.canonical) if (atHead.get(p) !== b) return { result: 'STOP_ADJUDICATION_STORE_STALE' }
  const closure = deriveV2(i.contract, i.kind, '0'.repeat(40), '1'.repeat(40), i.head)
  if (typeof closure === 'string') return { result: closure === 'empty COVERED' ? 'STOP_SUBJECT_NOT_PRESENT' : 'STOP_NOT_CURRENT' }
  const disp = dispositionStatus(i.contract, chainOrder(mine), closure.package_digest)
  if (disp.stop) return { result: disp.stop, status: disp.status, package_digest: closure.package_digest }
  const latest = disp.positives[disp.positives.length - 1]
  if (familyRule(i.contract, i.kind, latest, i.head, i.contractPath) !== 'CURRENT') return { result: 'STOP_NOT_CURRENT', status: disp.status }
  return {
    result: 'USABLE',
    status: 'CERTIFIED',
    package_digest: closure.package_digest,
    scopes: disp.positives.map((r) => r.provenance.independent_adjudicator.scope),
    scope_basis: disp.positives.map((r) => r.provenance.independent_adjudicator.scope_basis),
  }
}

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const CONTRACT_BLOB = gitBlobSha(readBytes(PATHS.v104))
const identityOf = (ks: KnownSubject): Identity => ({
  candidate_sha: ks.candidate_sha,
  tree_sha: ks.tree_sha,
  digest_algorithm: ks.digest_algorithm,
  entries: clone(ks.entries),
  package_digest: ks.package_digest,
  governing_families: [...ks.governing_families],
  governing_family_members_at_candidate: clone(ks.governing_family_members_at_candidate),
})
const LITERAL: Record<string, string> = {
  PASS: 'CENSUS_RECERT_PASS',
  PASS_WITH_NONBLOCKING_FINDINGS: 'CENSUS_RECERT_PASS_WITH_NONBLOCKING_FINDINGS',
  FAIL: 'CENSUS_ERRATA_V103_RECERT_FAIL',
  BLOCKED: 'CENSUS_RECERT_PASS_WITH_PROGRAM_BLOCKERS',
  INSUFFICIENT_EVIDENCE: 'CENSUS_RECERT_INSUFFICIENT_EVIDENCE',
}

function fixture(ks: KnownSubject, cls = 'PASS_WITH_NONBLOCKING_FINDINGS', over: { candidate?: string; adjudicator?: string } = {}): Adjudication {
  const subject = identityOf(ks)
  if (over.candidate) subject.candidate_sha = over.candidate
  const positive = cls === 'PASS' || cls === 'PASS_WITH_NONBLOCKING_FINDINGS'
  const nb = cls === 'PASS' ? [] : [{ id: 'FIX-NB-1', summary: 'fixture nonblocking finding', status: 'OPEN' }]
  const blocking = positive ? [] : cls === 'FAIL' ? [{ id: 'FIX-B-1', summary: 'fixture blocking finding' }] : []
  return {
    adjudication_contract: { path: PATHS.v104, section: C().record_schema.section, blob: CONTRACT_BLOB },
    subject_kind: ks.subject_kind,
    subject,
    verdict: { verdict_class: cls, verdict_literal: LITERAL[cls], blocking_findings_count: blocking.length, nonblocking_findings_reported_count: nb.length },
    blocking_findings: blocking,
    nonblocking_findings: nb,
    closes_predecessor_findings: [],
    provenance: {
      candidate_author: { lane_id: 'FIXTURE-AUTHOR-LANE', executor: 'fixture' },
      independent_adjudicator: {
        lane_id: over.adjudicator ?? 'FIXTURE-ADJUDICATOR-LANE',
        executor: 'fixture',
        examined_candidate_sha: subject.candidate_sha,
        examined_tree_sha: subject.tree_sha,
        adjudication_date: '2026-01-01',
        scope: 'FOCUSED_REMEDIATION',
        scope_basis: ['fixture://prior-round'],
        report_reference: 'fixture://report',
      },
      materializer: { lane_id: 'FIXTURE-MATERIALIZER-LANE', executor: 'fixture', materialization_date: '2026-01-02' },
      identity_facts_basis: 'MATERIALIZER_REDERIVED',
      verdict_and_findings_basis: 'ADJUDICATOR_REPORTED_SECOND_HAND',
      materializer_reproduced_adjudication_evidence: false,
      independence_basis: 'PROCESS_GOVERNED',
    },
    chain: { predecessor: null },
    authority_class: C().record_schema.authority_class,
    authorizes: [],
    meaning: C().meaning,
  }
}
function linkAfter(r: Adjudication, pred: Stored | null): Adjudication {
  r.chain.predecessor = pred ? { path: pred.path, adjudication_digest: adjudicationDigest(pred.record) } : null
  return r
}
const store = (r: Adjudication): Stored => ({ path: adjudicationPathFor(C(), r), record: r })
const knownFor = (r: Adjudication): KnownSubject | undefined => AUTH.SECTION_E5_KNOWN_SUBJECTS_V2.subjects.find((k) => k.candidate_sha === r.subject.candidate_sha)
/** Fixture re-derivation: a known candidate's recorded identity; any other fixture candidate is taken as recorded (fixture only). */
const derivedDefault = (r: Adjudication): Identity => {
  const k = knownFor(r)
  return k ? identityOf(k) : clone(r.subject)
}
function ctxFor(r: Adjudication, over: Partial<Ctx> = {}): Ctx {
  return {
    mode: 'write',
    contract: C(),
    knownSubjects: AUTH.SECTION_E5_KNOWN_SUBJECTS_V2.subjects,
    contractPath: PATHS.v104,
    contractBlob: CONTRACT_BLOB,
    recordPath: adjudicationPathFor(C(), r),
    derived: derivedDefault(r),
    target: knownFor(r)?.id ?? null,
    existing: [],
    historyViolations: [],
    ...over,
  }
}
const SIBLING = 'b'.repeat(40)
const SIBLING_2 = 'c'.repeat(40)

/* ---------- real git fixture repositories (private temp dir) ---------- */

const TMP = mkdtempSync(path.join(tmpdir(), 'uellix-rca-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
let repoSeq = 0
class FixtureRepo {
  readonly dir: string
  constructor(dir?: string) {
    this.dir = dir ?? path.join(TMP, `r${repoSeq++}`)
    if (dir) return
    mkdirSync(this.dir, { recursive: true })
    this.g(['init', '-q', '-b', 'main', '.'])
    this.write('README.fixture', 'fixture\n')
    this.commit('base')
  }
  g(args: string[]): string {
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: this.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(this.dir) },
    }).trim()
  }
  /** untrimmed stdout (exact blob bytes) */
  gRaw(args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(this.dir) } })
  }
  write(rel: string, content: string): void {
    const abs = path.join(this.dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  put(s: Stored): void {
    this.write(s.path, canonicalPretty(s.record))
  }
  commit(msg: string): void {
    this.g(['add', '-A'])
    this.g(['commit', '-q', '--allow-empty', '-m', msg])
  }
  /** Entries under the root at a ref, with mode and bytes. */
  rawAt(ref: string): RawEntry[] {
    const root = C().path_and_identity.adjudication_root
    return this.g(['ls-tree', '-r', ref, '--', root])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta, p] = line.split('\t')
        const [mode, type, oid] = meta.split(' ')
        return { path: p, mode, oid, bytes: type === 'blob' ? this.gRaw(['cat-file', 'blob', oid]) : '' }
      })
  }
  storeAtHead(): Store {
    const root = C().path_and_identity.adjudication_root
    const occ = AUTH.SECTION_E7_MATERIALIZATION_WRITE_SET.retired_occurrence_root
    const raw = this.rawAt('HEAD')
    const records: Stored[] = []
    for (const e of raw) {
      try {
        records.push({ path: e.path, record: JSON.parse(e.bytes) as Adjudication })
      } catch {
        /* an unparsable entry is caught by storeIntegrity */
      }
    }
    const files = this.g(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean)
    return {
      raw,
      records,
      history: historyViolations(this.dir, root, raw.map((e) => e.path)),
      shallow: isShallow(this.dir),
      occurrenceRootFiles: files.filter((p) => p.startsWith(occ)),
    }
  }
  isAncestor(a: string, b: string): boolean {
    try {
      this.g(['merge-base', '--is-ancestor', a, b])
      return true
    } catch {
      return false
    }
  }
  /** blobs under the root at a ref (the canonical store tip) */
  canonicalAt(ref: string): Map<string, string> {
    return new Map(this.rawAt(ref).map((e) => [e.path, e.oid]))
  }
}

function consumeCensus(st: Store, head: View = introducingView(), derivedFor = derivedDefault, canonical: Map<string, string> = new Map(), canonicalIsAncestor = true): ConsumerResult {
  return consume({
    contract: C(),
    kind: CENSUS,
    head,
    store: st,
    canonical,
    canonicalIsAncestor,
    contractPath: PATHS.v104,
    contractBlob: CONTRACT_BLOB,
    derivedFor,
    targetFor: (r) => knownFor(r)?.id ?? null,
  })
}
function repoWith(records: Stored[]): FixtureRepo {
  const repo = new FixtureRepo()
  for (const s of records) {
    repo.put(s)
    repo.commit(`adjudicate ${s.record.verdict.verdict_class}`)
  }
  return repo
}
function chainOf(specs: { cls: string; candidate?: string; ks?: KnownSubject; adjudicator?: string }[]): Stored[] {
  const out: Stored[] = []
  for (const sp of specs) {
    const r = linkAfter(fixture(sp.ks ?? KS_A, sp.cls, { candidate: sp.candidate, adjudicator: sp.adjudicator }), out[out.length - 1] ?? null)
    out.push(store(r))
  }
  return out
}
const B_PRESENT = hasCommit(KS_B.candidate_sha)

/* ========================================================================== */
/* §1 owner record v1.0.2                                                     */
/* ========================================================================== */

describe('§1 owner decision RECOVERY_CERT_REVOCATION_BINDING', () => {
  const owner = readJson<{ owner_decision_verbatim: string[]; structured_decision: Record<string, unknown>; companion_authority_amendment: string }>(PATHS.owner102)
  it('the verbatim decision and its structured form agree', () => {
    const v = owner.owner_decision_verbatim
    expect(v[0]).toBe('RECOVERY_CERT_REVOCATION_BINDING = PACKAGE_DIGEST')
    expect(v).toContain('SIGNED = YES')
    expect(v).toContain('EVENT_A_POLICY = PENDING')
    for (const cls of ['FAIL', 'BLOCKED', 'INSUFFICIENT_EVIDENCE']) expect(v).toContain(cls)
    const s = owner.structured_decision
    expect(s.RECOVERY_CERT_REVOCATION_BINDING).toBe('PACKAGE_DIGEST')
    expect(s.SIGNED).toBe('YES')
    expect(s.EVENT_A_POLICY).toBe('PENDING')
    expect(s.NON_POSITIVE_CLASSES_AT_LEAST).toEqual(['FAIL', 'BLOCKED', 'INSUFFICIENT_EVIDENCE'])
    expect(owner.companion_authority_amendment).toBe(PATHS.v104)
  })
  it('positive and non-positive classes partition the closed vocabulary', () => {
    const v = C().verdict
    expect([...v.positive_classes, ...v.non_positive_classes].sort()).toEqual([...v.verdict_classes].sort())
    expect(v.positive_classes.filter((c) => v.non_positive_classes.includes(c))).toEqual([])
    for (const c of owner.structured_decision.NON_POSITIVE_CLASSES_AT_LEAST as string[]) expect(v.non_positive_classes).toContain(c)
  })
  it('the owner record blob pinned in the declared layers is the actual blob', () => {
    const d = (C().currency.declared_non_invalidating_governing_layers[CENSUS] as Declared[]).find((x) => x.path === PATHS.owner102)
    expect(d?.blob).toBe(gitBlobSha(readBytes(PATHS.owner102)))
  })
})

/* ========================================================================== */
/* §2 closure V2                                                              */
/* ========================================================================== */

describe('§2 RCO_CLOSURE_DIGEST_V2', () => {
  it('both known subjects recompute their digest from their entries; roles are ordered and counted', () => {
    for (const ks of [KS_A, KS_B]) expect(digestOf(ks.entries)).toBe(ks.package_digest)
    const count = (ks: KnownSubject): number[] => ROLE_ORDER.map((r) => byRole(ks, r).length)
    expect(count(KS_A)).toEqual([6, 0, 0, 0, 12])
    expect(count(KS_B)).toEqual([39, 9, 7, 1, 4])
    expect(pathsOf(byRole(KS_B, 'RUNTIME_INPUT'))).toEqual(['db/baseline/stella_g2_post_restore.sql'])
    expect(pathsOf(byRole(KS_B, 'TOOLCHAIN'))).toContain('.gitattributes')
  })
  it('KS-A under V2 keeps its v1.0.3 package_digest (docs-only kind)', () => {
    const v103 = readJson<{ SECTION_D10_KNOWN_SUBJECTS: { subjects: { id: string; package_digest: string }[] } }>(PATHS.v103)
    expect(KS_A.package_digest).toBe(v103.SECTION_D10_KNOWN_SUBJECTS.subjects.find((s) => s.id === 'KS-A')?.package_digest)
  })
  it('KS-A recomputes EXACTLY from git at ab7fb64b', () => {
    if (!hasCommit(KS_A.candidate_sha)) throw new Error('KS-A candidate absent; it is an ancestor of this lineage')
    expect(deriveV2(C(), CENSUS, KS_A.candidate_sha, KS_A.tree_sha, commitView(KS_A.candidate_sha))).toEqual(identityOf(KS_A))
  }, GIT_TIMEOUT)
  it('KS-B candidate availability: required in CI (fetch-depth 0)', () => {
    if (process.env.CI) expect(B_PRESENT, `KS-B candidate ${KS_B.candidate_sha} must be fetchable in CI`).toBe(true)
  })
  it.runIf(B_PRESENT)('KS-B recomputes EXACTLY from git at 8cf94dca, with toolchain, imports and the runtime corpus', () => {
    expect(deriveV2(C(), OFFLINE, KS_B.candidate_sha, KS_B.tree_sha, commitView(KS_B.candidate_sha))).toEqual(identityOf(KS_B))
  }, GIT_TIMEOUT)
  it('the closure is minimal: no documentation, no unrelated application module', () => {
    const all = KS_B.entries.map((e) => e.path)
    expect(all.filter((p) => p.endsWith('.md'))).toEqual([])
    expect(all.filter((p) => /^(app|components|lib)\//.test(p))).toEqual([])
  })
  it.runIf(B_PRESENT)('a runtime literal inside a comment is not an input; a live one is', () => {
    const base = commitView(KS_B.candidate_sha)
    const f = 'scripts/recovery/tool-pin.ts'
    const t = base.texts([f]).get(f) ?? ''
    const commented = patchedView(base, { [f]: { blob: '1'.repeat(40), text: `${t}\n// see 'db/baseline/stella_g2_schema.sql'\n/* and 'db/baseline/stella_g2_schema.sql' */\n` } })
    const live = patchedView(base, { [f]: { blob: '1'.repeat(40), text: `${t}\nexport const X = 'README.md'.length + 'db/baseline/stella_g2_schema.sql'.length\n` } })
    const dc = deriveV2(C(), OFFLINE, KS_B.candidate_sha, KS_B.tree_sha, commented)
    const dl = deriveV2(C(), OFFLINE, KS_B.candidate_sha, KS_B.tree_sha, live)
    if (typeof dc === 'string' || typeof dl === 'string') throw new Error('derivation failed')
    expect(pathsOf(byRole(dc, 'RUNTIME_INPUT'))).toEqual(['db/baseline/stella_g2_post_restore.sql'])
    expect(pathsOf(byRole(dl, 'RUNTIME_INPUT'))).toEqual(['db/baseline/stella_g2_post_restore.sql', 'db/baseline/stella_g2_schema.sql'])
  }, GIT_TIMEOUT)
  it('a dangling reference, an unresolvable import, a missing toolchain root or setup file fails the derivation', () => {
    const v = introducingView()
    const cen = pathsOf(byRole(KS_A, 'COVERED'))[0]
    expect(deriveV2(C(), CENSUS, KS_A.candidate_sha, KS_A.tree_sha, patchedView(v, { [cen]: { blob: '1'.repeat(40), text: 'docs/ops/release/NO_SUCH_v9.9.9.json' } }))).toMatch(/^dangling/)
    const withCode = patchedView(v, { 'scripts/recovery/x.ts': { blob: '2'.repeat(40), text: "import y from './missing'" } })
    expect(deriveV2(C(), OFFLINE, KS_B.candidate_sha, KS_B.tree_sha, withCode)).toMatch(/^unresolved import/)
    const base = patchedView(v, { 'scripts/recovery/x.ts': { blob: '2'.repeat(40), text: '' } })
    expect(deriveV2(C(), OFFLINE, KS_B.candidate_sha, KS_B.tree_sha, patchedView(base, { 'pnpm-lock.yaml': null }))).toMatch(/^toolchain root missing/)
    expect(deriveV2(C(), OFFLINE, KS_B.candidate_sha, KS_B.tree_sha, patchedView(base, { '.gitattributes': null }))).toMatch(/^toolchain root missing/)
    const badSetup = patchedView(base, { 'vitest.config.ts': { blob: '3'.repeat(40), text: 'setupFiles: ["./nope.ts"]' } })
    expect(deriveV2(C(), OFFLINE, KS_B.candidate_sha, KS_B.tree_sha, badSetup)).toMatch(/^setup file missing/)
  }, GIT_TIMEOUT)
})

/* ========================================================================== */
/* §3 record validation                                                       */
/* ========================================================================== */

describe('§3 adjudication records of every class', () => {
  it('a record of EVERY verdict class validates as a record (non-positive results are representable)', () => {
    for (const cls of C().verdict.verdict_classes) {
      const r = fixture(KS_A, cls)
      expect(validate(r, ctxFor(r)), cls).toBe('VALID')
    }
    const b = fixture(KS_B, 'FAIL')
    expect(validate(b, ctxFor(b))).toBe('VALID')
  })
  it('the path is content-addressed and short: any edit breaks the path identity', () => {
    const r = fixture(KS_A)
    const p = adjudicationPathFor(C(), r)
    expect(p).toMatch(new RegExp(`^${C().path_and_identity.adjudication_root}CENSUS/${KS_A.package_digest}/[0-9a-f]{64}\\.json$`))
    for (const ks of [KS_A, KS_B]) expect(adjudicationPathFor(C(), fixture(ks)).length, ks.id).toBeLessThanOrEqual(170)
    expect(Object.keys(C().path_and_identity.kind_path_codes).sort()).toEqual(Object.keys(C().subject_kinds.kinds).sort())
    const edited = clone(r)
    edited.provenance.independent_adjudicator.report_reference = 'fixture://other'
    expect(validate(edited, ctxFor(edited, { recordPath: p }))).toBe('STOP_ADJUDICATION_PATH_IDENTITY_MISMATCH')
  })
  it('non-positive literals are opaque evidence; positive literals are strict; a positive literal on a non-positive record STOPS', () => {
    const ok: [string, string][] = [
      ['FAIL', 'CENSUS_ERRATA_V103_RECERT_FAIL'], ['FAIL', 'STAGING_RECOVERY_OFFLINE_PRIMITIVES_FOCUSED_RECERT_FAIL'], ['FAIL', 'X_RECERT_R2_FAIL'],
      ['FAIL', 'X_RECERT_FAILED'], ['FAIL', 'X_RECERT_FAIL_WITH_BLOCKING_FINDINGS'], ['BLOCKED', 'X_RECERT_PASS_WITH_PROGRAM_BLOCKERS'], ['INSUFFICIENT_EVIDENCE', 'IC_INSUFFICIENT_EVIDENCE'],
    ]
    for (const [cls, lit] of ok) {
      const r = fixture(KS_A, cls)
      r.verdict.verdict_literal = lit
      expect(validate(r, ctxFor(r)), lit).toBe('VALID')
    }
    const bad: [string, string][] = [
      ['PASS', 'CENSUS_RECERT_FAIL'], ['FAIL', 'CENSUS_RECERT_PASS'], ['BLOCKED', 'CENSUS_RECERT_PASS_WITH_NONBLOCKING_FINDINGS'], ['PASS', 'CENSUS_REVIEW_PASS'],
      ['PASS', 'CENSUS_RECERT_NOT_PASS'], ['PASS', 'PASS'], ['PASS', 'CENSUS_WITHDRAWN_RECERT_PASS'], ['PASS', 'CENSUS_RECERT_V1X_PASS'], ['PASS', 'CENSUS_PASS'],
      ['FAIL', 'census_recert_fail'], ['FAIL', ''], ['UNKNOWN_CLASS', 'CENSUS_RECERT_UNKNOWN_CLASS'],
      ['INSUFFICIENT_EVIDENCE', 'CENSUS_PRIMITIVES_RECERT_PASS'], ['FAIL', 'OFFLINE_PRIMITIVES_RECERT_PASS_WITH_NONBLOCKING_FINDINGS'], ['BLOCKED', 'PASS'],
    ]
    for (const [cls, lit] of bad) {
      const r = fixture(KS_A, cls === 'UNKNOWN_CLASS' ? 'PASS' : cls)
      r.verdict.verdict_class = cls
      r.verdict.verdict_literal = lit
      expect(validate(r, ctxFor(r)), `${cls} ${lit}`).toBe('STOP_VERDICT_LITERAL_MISMATCH')
    }
  })
  it('class consistency: FAIL without blocking, PASS with blocking or nonblocking, counts that disagree STOP', () => {
    const cases: [string, (r: Adjudication) => void][] = [
      ['FAIL', (r) => { r.blocking_findings = []; r.verdict.blocking_findings_count = 0 }],
      ['PASS', (r) => { r.blocking_findings = [{ id: 'B', summary: 's' }]; r.verdict.blocking_findings_count = 1 }],
      ['PASS', (r) => { r.verdict.blocking_findings_count = 1 }],
      ['PASS', (r) => { r.nonblocking_findings = [{ id: 'N', summary: 's', status: 'OPEN' }]; r.verdict.nonblocking_findings_reported_count = 1 }],
      ['BLOCKED', (r) => { r.verdict.blocking_findings_count = 2 }],
      ['PASS_WITH_NONBLOCKING_FINDINGS', (r) => { r.nonblocking_findings = []; r.verdict.nonblocking_findings_reported_count = 0 }],
      ['FAIL', (r) => { r.blocking_findings.push({ ...r.blocking_findings[0] }); r.verdict.blocking_findings_count = 2 }],
    ]
    for (const [cls, f] of cases) {
      const r = fixture(KS_A, cls)
      f(r)
      expect(validate(r, ctxFor(r)), cls).toBe('STOP_VERDICT_CLASS_INCONSISTENT')
    }
  })
  it('findings: a duplicate nonblocking id, a missing one, or a non-OPEN one STOPS', () => {
    const dup = fixture(KS_A, 'PASS_WITH_NONBLOCKING_FINDINGS')
    dup.nonblocking_findings.push({ ...dup.nonblocking_findings[0] })
    dup.verdict.nonblocking_findings_reported_count = 2
    expect(validate(dup, ctxFor(dup))).toBe('STOP_NONBLOCKING_FINDINGS_INCOMPLETE')
    const missing = fixture(KS_A, 'PASS_WITH_NONBLOCKING_FINDINGS')
    missing.verdict.nonblocking_findings_reported_count = 2
    expect(validate(missing, ctxFor(missing))).toBe('STOP_NONBLOCKING_FINDINGS_INCOMPLETE')
    const closed = fixture(KS_A, 'PASS_WITH_NONBLOCKING_FINDINGS')
    closed.nonblocking_findings[0].status = 'CLOSED'
    expect(validate(closed, ctxFor(closed))).toBe('STOP_FINDING_NOT_OPEN')
  })
  it('identity: wrong SHA, same tree / wrong commit, wrong tree, digest, pin, families, members, runtime set, kind STOP', () => {
    const sha = fixture(KS_A, 'PASS', { candidate: SIBLING })
    expect(validate(sha, ctxFor(sha, { target: 'KS-A' }))).toBe('STOP_CANDIDATE_SHA_MISMATCH')
    const sameTree = fixture(KS_A, 'PASS', { candidate: SIBLING })
    sameTree.provenance.independent_adjudicator.examined_candidate_sha = KS_A.candidate_sha
    expect(validate(sameTree, ctxFor(sameTree))).toBe('STOP_RECERT_SUBJECT_MISMATCH')
    const examinedTree = fixture(KS_A, 'PASS')
    examinedTree.provenance.independent_adjudicator.examined_tree_sha = '0'.repeat(40)
    expect(validate(examinedTree, ctxFor(examinedTree))).toBe('STOP_RECERT_SUBJECT_MISMATCH')
    const tree = fixture(KS_A)
    tree.subject.tree_sha = '0'.repeat(40)
    tree.provenance.independent_adjudicator.examined_tree_sha = tree.subject.tree_sha
    expect(validate(tree, ctxFor(tree))).toBe('STOP_TREE_SHA_MISMATCH')
    const dig = fixture(KS_A)
    dig.subject.package_digest = '0'.repeat(64)
    expect(validate(dig, ctxFor(dig, { target: null }))).toBe('STOP_PACKAGE_DIGEST_MISMATCH')
    const pin = fixture(KS_B)
    const g = pin.subject.entries.find((e) => e.role === 'GOVERNING')
    if (g) g.blob = '1'.repeat(40)
    pin.subject.package_digest = digestOf(pin.subject.entries)
    expect(validate(pin, ctxFor(pin))).toBe('STOP_GOVERNING_PIN_MISMATCH')
    for (const target of ['KS-A', null]) {
      const fam = fixture(KS_A)
      fam.subject.governing_families = fam.subject.governing_families.slice(1)
      const famDerived = target === null ? identityOf(KS_A) : clone(fam.subject)
      expect(validate(fam, ctxFor(fam, { target, derived: famDerived })), `families ${target}`).toBe('STOP_GOVERNING_PIN_MISMATCH')
      const mem = fixture(KS_A)
      mem.subject.governing_family_members_at_candidate[0].blob = '5'.repeat(40)
      const memDerived = target === null ? identityOf(KS_A) : clone(mem.subject)
      expect(validate(mem, ctxFor(mem, { target, derived: memDerived })), `members ${target}`).toBe('STOP_GOVERNING_PIN_MISMATCH')
    }
    const runtime = fixture(KS_B)
    runtime.subject.entries = runtime.subject.entries.filter((e) => e.role !== 'RUNTIME_INPUT')
    runtime.subject.package_digest = digestOf(runtime.subject.entries)
    expect(validate(runtime, ctxFor(runtime, { target: null, derived: identityOf(KS_B) }))).toBe('STOP_COVERED_SET_MISMATCH')
    const kind = fixture(KS_B)
    kind.subject_kind = CENSUS
    expect(validate(kind, ctxFor(kind))).toBe('STOP_SUBJECT_KIND_MISMATCH')
    const other = fixture(KS_A)
    other.subject_kind = 'OTHER'
    expect(validate(other, ctxFor(other))).toBe('STOP_UNKNOWN_SUBJECT_KIND')
  })
  it('an adjudication authorizes nothing, has the fixed class and meaning, and names this contract, section and blob', () => {
    const cases: [string, (r: Adjudication) => void][] = [
      ['STOP_ADJUDICATION_CLAIMS_AUTHORITY', (r) => { r.authorizes = ['HC-2-A'] }],
      ['STOP_ADJUDICATION_CLAIMS_AUTHORITY', (r) => { r.authority_class = 'EXECUTION_AUTHORITY' }],
      ['STOP_ADJUDICATION_CLAIMS_AUTHORITY', (r) => { r.meaning = `${r.meaning} Execution may proceed.` }],
      ['STOP_ADJUDICATION_CONTRACT_MISMATCH', (r) => { r.adjudication_contract.blob = '0'.repeat(40) }],
      ['STOP_ADJUDICATION_CONTRACT_MISMATCH', (r) => { r.adjudication_contract.section = 'SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT' }],
      ['STOP_ADJUDICATION_CONTRACT_MISMATCH', (r) => { r.adjudication_contract.path = PATHS.v103 }],
    ]
    for (const [code, f] of cases) {
      const r = fixture(KS_A)
      f(r)
      expect(validate(r, ctxFor(r)), code).toBe(code)
    }
  })
  it('scope and bases: a non-FULL scope needs a basis; FULL_SUBJECT must have none; report reference and bases are fixed', () => {
    const cases: [string, (r: Adjudication) => void][] = [
      ['STOP_RECERT_SCOPE_UNDECLARED', (r) => { r.provenance.independent_adjudicator.scope_basis = [] }],
      ['STOP_RECERT_SCOPE_UNDECLARED', (r) => { r.provenance.independent_adjudicator.scope = 'FULL_SUBJECT' }],
      ['STOP_RECERT_SCOPE_UNDECLARED', (r) => { r.provenance.independent_adjudicator.report_reference = ' ' }],
      ['STOP_RECERT_SCOPE_UNDECLARED', (r) => { r.provenance.independent_adjudicator.scope = 'WHOLE_PROGRAM' }],
      ['STOP_MATERIALIZER_REPRODUCTION_CLAIM', (r) => { r.provenance.identity_facts_basis = 'ADJUDICATOR_REPORTED' }],
      ['STOP_MATERIALIZER_REPRODUCTION_CLAIM', (r) => { r.provenance.verdict_and_findings_basis = 'MATERIALIZER_REPRODUCED' }],
      ['STOP_MATERIALIZER_REPRODUCTION_CLAIM', (r) => { r.provenance.independence_basis = 'CRYPTOGRAPHIC' }],
      ['STOP_MATERIALIZER_REPRODUCTION_CLAIM', (r) => { r.provenance.materializer_reproduced_adjudication_evidence = true }],
    ]
    for (const [code, f] of cases) {
      const r = fixture(KS_A)
      f(r)
      expect(validate(r, ctxFor(r)), code).toBe(code)
    }
    const full = fixture(KS_A)
    full.provenance.independent_adjudicator.scope = 'FULL_SUBJECT'
    full.provenance.independent_adjudicator.scope_basis = []
    expect(validate(full, ctxFor(full))).toBe('VALID')
  })
})

/* ========================================================================== */
/* §4 provenance identity                                                     */
/* ========================================================================== */

describe('§4 provenance: cosmetic variants cannot fake three actors', () => {
  it('Unicode, lower-case, whitespace, zero-width, full-width and non-hyphen separators are MALFORMED', () => {
    for (const lane of ['FIXTURE-AUTHOR-LANЕ', 'fixture-author-lane', ' FIXTURE-AUTHOR-LANE', 'FIXTURE\u200B-AUTHOR-LANE', 'ＦＩＸＴＵＲＥ-AUTHOR', 'FIXTURE_AUTHOR_LANE', 'FIXTURE--AUTHOR', '-FIXTURE', '']) {
      const r = fixture(KS_A)
      r.provenance.materializer.lane_id = lane
      expect(validate(r, ctxFor(r)), JSON.stringify(lane)).toBe('STOP_PROVENANCE_IDENTITY_MALFORMED')
    }
  })
  it('separator variants of one lane are one identity', () => {
    for (const lane of ['FIXTURE-AUTHOR-LANE', 'FIXTUREAUTHORLANE', 'FIXTURE-AUTHORLANE', 'FIX-TURE-AUTHOR-LANE']) {
      const r = fixture(KS_A)
      r.provenance.materializer.lane_id = lane
      expect(validate(r, ctxFor(r)), lane).toBe('STOP_PROVENANCE_NOT_INDEPENDENT')
    }
    const adj = fixture(KS_A)
    adj.provenance.independent_adjudicator.lane_id = 'FIXTURE-MATERIALIZER-LANE'
    expect(validate(adj, ctxFor(adj))).toBe('STOP_PROVENANCE_NOT_INDEPENDENT')
  })
})

/* ========================================================================== */
/* §5 write-once history on real git DAGs                                     */
/* ========================================================================== */

describe('§5 write-once history over the FULL git DAG', () => {
  const ROOT_ADJ = C().path_and_identity.adjudication_root
  const p = (n: string): string => `${ROOT_ADJ}CENSUS/${KS_A.package_digest}/${n}.json`
  const hv = (r: FixtureRepo): string[] => historyViolations(r.dir, ROOT_ADJ, r.rawAt('HEAD').map((e) => e.path))

  it('a single add, a root-commit add, and a side-branch add merged normally are clean', () => {
    const r = new FixtureRepo()
    r.write(p('a'), '{}\n')
    r.commit('add a')
    expect(hv(r)).toEqual([])
    r.g(['checkout', '-q', '-b', 'side'])
    r.write(p('b'), '{"b":1}\n')
    r.commit('add b on side')
    r.g(['checkout', '-q', 'main'])
    r.write('other.txt', 'x\n')
    r.commit('unrelated')
    r.g(['merge', '-q', '--no-ff', 'side', '-m', 'merge side'])
    expect(hv(r)).toEqual([])
    const rootAdd = new FixtureRepo(path.join(TMP, `root${repoSeq++}`))
    mkdirSync(rootAdd.dir, { recursive: true })
    rootAdd.g(['init', '-q', '-b', 'main', '.'])
    rootAdd.write(p('r'), '{}\n')
    rootAdd.commit('root commit adds')
    expect(hv(rootAdd)).toEqual([])
    rootAdd.g(['config', 'log.showRoot', 'false'])
    expect(hv(rootAdd), 'a local log.showRoot=false cannot hide a root add').toEqual([])
  }, GIT_TIMEOUT)

  it('an add/add merge path replacement is a violation, although simplified history sees one add', () => {
    const r = new FixtureRepo()
    r.g(['checkout', '-q', '-b', 'forger'])
    r.write(p('x'), '{"verdict":"PASS"}\n')
    r.commit('forged add')
    r.g(['checkout', '-q', 'main'])
    r.write(p('x'), '{"verdict":"PASS_WITH_NONBLOCKING_FINDINGS"}\n')
    r.commit('original add')
    r.g(['merge', '-q', '-X', 'theirs', 'forger', '-m', 'merge forger'])
    expect(r.g(['log', '--diff-filter=A', '--format=%s', '--', p('x')]).split('\n')).toHaveLength(1)
    expect(hv(r)).toContain(`adds=2 ${p('x')}`)
  }, GIT_TIMEOUT)

  it('modify, delete, delete-and-re-add, rename and evil merge are violations', () => {
    const mod = new FixtureRepo()
    mod.write(p('m'), '{}\n')
    mod.commit('add')
    mod.write(p('m'), '{"x":1}\n')
    mod.commit('modify')
    expect(hv(mod)).toContain(`M ${p('m')}`)

    const del = new FixtureRepo()
    del.write(p('d'), '{}\n')
    del.commit('add')
    del.g(['rm', '-q', p('d')])
    del.commit('delete')
    expect(hv(del)).toContain(`D ${p('d')}`)

    const readd = new FixtureRepo()
    readd.write(p('r'), '{}\n')
    readd.commit('add')
    readd.g(['rm', '-q', p('r')])
    readd.commit('delete')
    readd.write(p('r'), '{}\n')
    readd.commit('re-add')
    expect(hv(readd)).toEqual(expect.arrayContaining([`D ${p('r')}`, `adds=2 ${p('r')}`]))

    const ren = new FixtureRepo()
    ren.write(p('old'), '{"same":true}\n')
    ren.commit('add')
    ren.g(['mv', p('old'), p('new')])
    ren.commit('rename')
    expect(hv(ren)).toContain(`D ${p('old')}`)

    const evil = new FixtureRepo()
    evil.write(p('e'), '{"v":1}\n')
    evil.commit('add')
    evil.g(['checkout', '-q', '-b', 's'])
    evil.write('s.txt', 's\n')
    evil.commit('side')
    evil.g(['checkout', '-q', 'main'])
    evil.write('m.txt', 'm\n')
    evil.commit('main')
    evil.g(['merge', '-q', '--no-commit', 's'])
    evil.write(p('e'), '{"v":2}\n')
    evil.g(['add', p('e')])
    evil.g(['commit', '-q', '-m', 'evil merge'])
    expect(hv(evil).some((x) => x.startsWith('merge-entry') && x.endsWith(p('e')))).toBe(true)
  }, GIT_TIMEOUT)

  it('a replace-graft that hides a delete and re-add is defeated (--no-replace-objects)', () => {
    const r = new FixtureRepo()
    r.write(p('g'), '{"v":1}\n')
    r.commit('add')
    const added = r.g(['rev-parse', 'HEAD'])
    r.g(['rm', '-q', p('g')])
    r.commit('delete')
    r.write(p('g'), '{"v":1}\n')
    r.commit('re-add identical')
    r.g(['replace', '--graft', 'HEAD', added])
    expect(r.g(['log', '--format=%s']).split('\n')).not.toContain('delete')
    expect(hv(r)).toEqual(expect.arrayContaining([`D ${p('g')}`]))
  }, GIT_TIMEOUT)

  it('an info/grafts file that hides a delete and re-add is defeated (GIT_GRAFT_FILE)', () => {
    const r = new FixtureRepo()
    r.write(p('h'), '{"v":1}\n')
    r.commit('add')
    const added = r.g(['rev-parse', 'HEAD'])
    r.g(['rm', '-q', p('h')])
    r.commit('delete')
    r.write(p('h'), '{"v":1}\n')
    r.commit('re-add identical')
    writeFileSync(path.join(r.dir, '.git', 'info', 'grafts'), `${r.g(['rev-parse', 'HEAD'])} ${added}\n`)
    expect(r.g(['log', '--format=%s'])).not.toContain('delete')
    expect(hv(r)).toEqual(expect.arrayContaining([`D ${p('h')}`]))
  }, GIT_TIMEOUT)

  it('a path present with zero adds (hidden history) is a violation; a shallow clone is UNVERIFIABLE', () => {
    expect(historyViolations(new FixtureRepo().dir, ROOT_ADJ, [p('ghost')])).toContain(`adds=0 ${p('ghost')}`)
    const src = repoWith(chainOf([{ cls: 'FAIL' }, { cls: 'PASS', candidate: SIBLING }]))
    const cloneDir = path.join(TMP, `shallow${repoSeq++}`)
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${src.dir.split(path.sep).join('/')}`, cloneDir], { stdio: 'ignore' })
    const shallow = new FixtureRepo(cloneDir).storeAtHead()
    expect(shallow.shallow).toBe(true)
    expect(consumeCensus(shallow).result).toBe('STOP_ADJUDICATION_HISTORY_UNVERIFIABLE')
  }, GIT_TIMEOUT)
})

/* ========================================================================== */
/* §6 revocation, contradiction, store integrity, freshness                   */
/* ========================================================================== */

describe('§6 revocation by package_digest, contradiction, integrity and freshness', () => {
  it('PASS alone at a head whose closure equals the certified digest is USABLE, and reports scope', () => {
    const res = consumeCensus(repoWith(chainOf([{ cls: 'PASS_WITH_NONBLOCKING_FINDINGS' }])).storeAtHead())
    expect(res).toMatchObject({ result: 'USABLE', status: 'CERTIFIED', package_digest: KS_A.package_digest, scopes: ['FOCUSED_REMEDIATION'], scope_basis: [['fixture://prior-round']] })
  }, GIT_TIMEOUT)

  it('PASS -> later FAIL on the same package_digest: REVOKED', () => {
    expect(consumeCensus(repoWith(chainOf([{ cls: 'PASS' }, { cls: 'FAIL', adjudicator: 'SECOND-ADJUDICATOR-LANE' }])).storeAtHead())).toMatchObject({ result: 'STOP_CERTIFICATION_REVOKED', status: 'REVOKED' })
  }, GIT_TIMEOUT)

  it('PASS on SHA A -> FAIL / BLOCKED / INSUFFICIENT_EVIDENCE on sibling SHA B with the same package_digest: REVOKED', () => {
    for (const cls of ['FAIL', 'BLOCKED', 'INSUFFICIENT_EVIDENCE']) {
      expect(consumeCensus(repoWith(chainOf([{ cls: 'PASS' }, { cls, candidate: SIBLING }])).storeAtHead()).result, cls).toBe('STOP_CERTIFICATION_REVOKED')
    }
  }, GIT_TIMEOUT)

  it('PASS, contradictory FAIL, later PASS on the same digest: STOP_CONTRADICTORY_CERTIFICATION (no latest-wins)', () => {
    expect(consumeCensus(repoWith(chainOf([{ cls: 'PASS' }, { cls: 'FAIL', candidate: SIBLING }, { cls: 'PASS', candidate: SIBLING_2 }])).storeAtHead())).toMatchObject({ result: 'STOP_CONTRADICTORY_CERTIFICATION', status: 'CONTRADICTED' })
    expect(consumeCensus(repoWith(chainOf([{ cls: 'FAIL' }, { cls: 'PASS', candidate: SIBLING }])).storeAtHead()).result).toBe('STOP_CONTRADICTORY_CERTIFICATION')
  }, GIT_TIMEOUT)

  it('only non-positive adjudications, or none: NOT certified', () => {
    expect(consumeCensus(repoWith(chainOf([{ cls: 'FAIL' }])).storeAtHead())).toMatchObject({ result: 'STOP_NOT_CERTIFIED', status: 'NEGATIVELY_ADJUDICATED' })
    expect(consumeCensus(repoWith([]).storeAtHead())).toMatchObject({ result: 'STOP_NOT_CERTIFIED', status: 'NOT_ADJUDICATED' })
  }, GIT_TIMEOUT)

  it('a FAIL on a DIFFERENT package_digest does not revoke this closure', () => {
    const other = fixture(KS_A, 'FAIL', { candidate: SIBLING })
    other.subject.entries[0].blob = '9'.repeat(40)
    other.subject.package_digest = digestOf(other.subject.entries)
    const first = store(linkAfter(fixture(KS_A, 'PASS'), null))
    const second = store(linkAfter(other, first))
    expect(consumeCensus(repoWith([first, second]).storeAtHead()).result).toBe('USABLE')
  }, GIT_TIMEOUT)

  it('a FAIL whose subject_kind is mistyped or foreign, or any unattributable entry, makes the store INVALID for every kind', () => {
    const [pass] = chainOf([{ cls: 'PASS' }])
    const forge = (mutate: (r: Adjudication) => void): FixtureRepo => {
      const fail = linkAfter(fixture(KS_A, 'FAIL', { candidate: SIBLING }), pass)
      mutate(fail)
      const repo = repoWith([pass])
      const pth = `${C().path_and_identity.adjudication_root}CENSUS/${KS_A.package_digest}/${adjudicationDigest(fail)}.json`
      repo.write(pth, canonicalPretty(fail))
      repo.commit('add a foreign-kind FAIL under the CENSUS directory')
      return repo
    }
    expect(consumeCensus(forge((r) => { r.subject_kind = `${CENSUS}_` }).storeAtHead()).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
    expect(consumeCensus(forge((r) => { r.subject_kind = OFFLINE }).storeAtHead()).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
    const junk = repoWith([pass])
    junk.write(`${C().path_and_identity.adjudication_root}CENSUS/${KS_A.package_digest}/${'e'.repeat(64)}.json`, 'not json\n')
    junk.commit('junk entry')
    expect(consumeCensus(junk.storeAtHead()).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
    const stray = repoWith([pass])
    stray.write(`${C().path_and_identity.adjudication_root}notes.txt`, 'x\n')
    stray.commit('stray file')
    expect(consumeCensus(stray.storeAtHead()).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
    const gitlink = repoWith([pass])
    gitlink.g(['update-index', '--add', '--cacheinfo', `160000,${gitlink.g(['rev-parse', 'HEAD'])},${C().path_and_identity.adjudication_root}CENSUS/sub`])
    gitlink.g(['commit', '-q', '-m', 'gitlink entry'])
    expect(consumeCensus(gitlink.storeAtHead()).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
  }, GIT_TIMEOUT)

  it('non-canonical bytes (duplicate or reordered keys) make the store INVALID', () => {
    const [pass] = chainOf([{ cls: 'PASS' }])
    const pretty = canonicalPretty(pass.record)
    const dup = pretty.replace('"verdict_class": "PASS"', '"verdict_class": "FAIL",\n    "verdict_class": "PASS"')
    expect(JSON.parse(dup).verdict.verdict_class).toBe('PASS')
    const repo = new FixtureRepo()
    repo.write(pass.path, dup)
    repo.commit('duplicate keys')
    expect(consumeCensus(repo.storeAtHead()).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
    const reordered = new FixtureRepo()
    reordered.write(pass.path, `${JSON.stringify(pass.record, null, 2)}\n`)
    reordered.commit('insertion-order keys')
    expect(consumeCensus(reordered.storeAtHead()).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
  }, GIT_TIMEOUT)

  it('an invalid record of ANOTHER kind (valid store, clean history) also STOPS this kind', () => {
    const censusPass = store(linkAfter(fixture(KS_A, 'PASS'), null))
    const offlineBad = fixture(KS_B, 'PASS')
    offlineBad.adjudication_contract.blob = '0'.repeat(40)
    const st = repoWith([censusPass, store(offlineBad)]).storeAtHead()
    expect(storeIntegrity(C(), st.raw)).toEqual([])
    expect(st.history).toEqual([])
    expect(consumeCensus(st).result).toBe('STOP_ADJUDICATION_INVALID_AT_READ')
  }, GIT_TIMEOUT)

  it('a valid record stored with a non-regular mode (executable) makes the store INVALID', () => {
    const [pass] = chainOf([{ cls: 'PASS' }])
    const repo = new FixtureRepo()
    repo.put(pass)
    repo.g(['add', '-A'])
    repo.g(['update-index', '--chmod=+x', pass.path])
    repo.g(['commit', '-q', '-m', 'executable record'])
    const st = repo.storeAtHead()
    expect(st.raw[0].mode).toBe('100755')
    expect(consumeCensus(st).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
  }, GIT_TIMEOUT)

  it('a stored record that fails read-time validation (clean history, intact chain, canonical bytes) makes the kind unusable', () => {
    const other = fixture(KS_A, 'PASS')
    other.adjudication_contract.blob = '0'.repeat(40)
    const st = repoWith([store(other)]).storeAtHead()
    expect(st.history).toEqual([])
    expect(storeIntegrity(C(), st.raw)).toEqual([])
    expect(consumeCensus(st).result).toBe('STOP_ADJUDICATION_INVALID_AT_READ')
  }, GIT_TIMEOUT)

  it('a FAIL merged into the canonical ref after a consumer branched: the stale head STOPS', () => {
    const chain = chainOf([{ cls: 'PASS' }, { cls: 'FAIL', candidate: SIBLING }])
    const repo = repoWith([chain[0]])
    repo.g(['branch', 'consumer-lane'])
    repo.put(chain[1])
    repo.commit('canonical ref receives the FAIL')
    const canonical = repo.canonicalAt('main')
    repo.g(['checkout', '-q', 'consumer-lane'])
    expect(consumeCensus(repo.storeAtHead()).result, 'without the freshness rule the stale head looks usable').toBe('USABLE')
    const tip = repo.g(['rev-parse', 'main'])
    expect(consumeCensus(repo.storeAtHead(), introducingView(), derivedDefault, canonical, repo.isAncestor(tip, 'HEAD')).result).toBe('STOP_ADJUDICATION_STORE_STALE')
    repo.g(['merge', '-q', 'main'])
    expect(consumeCensus(repo.storeAtHead(), introducingView(), derivedDefault, canonical, repo.isAncestor(tip, 'HEAD')).result).toBe('STOP_CERTIFICATION_REVOKED')
  }, GIT_TIMEOUT)

  it('a FAIL added and then deleted on the canonical ref: an older head that still contains the tip is STALE (ancestry)', () => {
    const chain = chainOf([{ cls: 'PASS' }, { cls: 'FAIL', candidate: SIBLING }])
    const repo = repoWith([chain[0]])
    repo.g(['branch', 'consumer-lane'])
    repo.put(chain[1])
    repo.commit('canonical ref receives the FAIL')
    repo.g(['rm', '-q', chain[1].path])
    repo.commit('canonical ref deletes the FAIL')
    const canonical = repo.canonicalAt('main')
    const tip = repo.g(['rev-parse', 'main'])
    repo.g(['checkout', '-q', 'consumer-lane'])
    expect(consumeCensus(repo.storeAtHead(), introducingView(), derivedDefault, canonical).result, 'containment alone is satisfied').toBe('USABLE')
    expect(consumeCensus(repo.storeAtHead(), introducingView(), derivedDefault, canonical, repo.isAncestor(tip, 'HEAD')).result).toBe('STOP_ADJUDICATION_STORE_STALE')
    repo.g(['merge', '-q', 'main'])
    expect(consumeCensus(repo.storeAtHead(), introducingView(), derivedDefault, canonical, repo.isAncestor(tip, 'HEAD')).result).toBe('STOP_ADJUDICATION_HISTORY_VIOLATED')
  }, GIT_TIMEOUT)

  it('leading or trailing whitespace around canonical bytes makes the store INVALID (exact blob bytes are read)', () => {
    const [pass] = chainOf([{ cls: 'PASS' }])
    const repo = new FixtureRepo()
    repo.write(pass.path, `\n\n${canonicalPretty(pass.record)}\n\n`)
    repo.commit('padded record')
    expect(consumeCensus(repo.storeAtHead()).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
  }, GIT_TIMEOUT)

  it('a deleted predecessor (truncation) STOPS; a chain restart after deletion STOPS', () => {
    const chain = chainOf([{ cls: 'PASS' }, { cls: 'PASS', candidate: SIBLING }])
    const repo = repoWith(chain)
    repo.g(['rm', '-q', chain[0].path])
    repo.commit('delete predecessor')
    expect(consumeCensus(repo.storeAtHead()).result).toBe('STOP_ADJUDICATION_HISTORY_VIOLATED')
    const restart = repoWith(chainOf([{ cls: 'FAIL' }]))
    const [only] = restart.storeAtHead().records
    restart.g(['rm', '-q', only.path])
    restart.commit('delete the negative adjudication')
    restart.put(chainOf([{ cls: 'PASS', candidate: SIBLING }])[0])
    restart.commit('restart the chain with a PASS')
    expect(consumeCensus(restart.storeAtHead()).result).toBe('STOP_ADJUDICATION_HISTORY_VIOLATED')
  }, GIT_TIMEOUT)

  it('a wrong predecessor digest STOPS at write time and makes the kind unusable at read time', () => {
    const [first] = chainOf([{ cls: 'PASS' }])
    const bad = fixture(KS_A, 'PASS', { candidate: SIBLING })
    bad.chain.predecessor = { path: first.path, adjudication_digest: '0'.repeat(64) }
    expect(validate(bad, ctxFor(bad, { existing: [first] }))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
    expect(consumeCensus(repoWith([first, store(bad)]).storeAtHead()).result).toBe('STOP_CHAIN_INTEGRITY_VIOLATED')
  }, GIT_TIMEOUT)

  it('an add/add merge replacing a stored adjudication STOPS the consumer', () => {
    const [first] = chainOf([{ cls: 'PASS_WITH_NONBLOCKING_FINDINGS' }])
    const repo = new FixtureRepo()
    repo.g(['checkout', '-q', '-b', 'forger'])
    repo.write(first.path, '{"forged":true}\n')
    repo.commit('forged add at the same path')
    repo.g(['checkout', '-q', 'main'])
    repo.put(first)
    repo.commit('genuine add')
    repo.g(['merge', '-q', '-X', 'ours', 'forger', '-m', 'merge keeps genuine bytes'])
    expect(consumeCensus(repo.storeAtHead()).result).toBe('STOP_ADJUDICATION_HISTORY_VIOLATED')
  }, GIT_TIMEOUT)

  it('a file under the retired occurrence root STOPS every consumer', () => {
    const repo = repoWith(chainOf([{ cls: 'PASS' }]))
    repo.write(`${AUTH.SECTION_E7_MATERIALIZATION_WRITE_SET.retired_occurrence_root}${CENSUS}/${KS_A.candidate_sha}.json`, '{}\n')
    repo.commit('write under the retired root')
    expect(consumeCensus(repo.storeAtHead()).result).toBe('STOP_RETIRED_OCCURRENCE_ROOT_USED')
  }, GIT_TIMEOUT)

  it('currency: covered change, declared layer edit, undeclared amendment, changed or deleted recorded family member', () => {
    const st = repoWith(chainOf([{ cls: 'PASS' }])).storeAtHead()
    const v = introducingView()
    const cen = pathsOf(byRole(KS_A, 'COVERED'))[1]
    expect(consumeCensus(st, patchedView(v, { [cen]: { blob: '7'.repeat(40), text: v.texts([cen]).get(cen) ?? '' } }))).toMatchObject({ result: 'STOP_NOT_CERTIFIED', status: 'NOT_ADJUDICATED' })
    expect(consumeCensus(st, patchedView(v, { [PATHS.owner102]: { blob: '7'.repeat(40), text: '' } })).result).toBe('STOP_NOT_CURRENT')
    expect(consumeCensus(st, patchedView(v, { 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.5.json': { blob: '7'.repeat(40), text: '' } })).result).toBe('STOP_NOT_CURRENT')
    const gov = new Set(pathsOf(byRole(KS_A, 'GOVERNING')))
    const nonGov = KS_A.governing_family_members_at_candidate.find((m) => !gov.has(m.path))
    if (!nonGov) throw new Error('expected a non-governing family member')
    expect(consumeCensus(st, patchedView(v, { [nonGov.path]: { blob: '7'.repeat(40), text: '' } })).result).toBe('STOP_NOT_CURRENT')
    expect(consumeCensus(st, patchedView(v, { [nonGov.path]: null })).result).toBe('STOP_NOT_CURRENT')
  }, GIT_TIMEOUT)

  it('currency is judged against the LATEST positive adjudication for the closure', () => {
    const stale = fixture(KS_A, 'PASS')
    stale.subject.governing_family_members_at_candidate = stale.subject.governing_family_members_at_candidate.slice(1)
    const first = store(linkAfter(stale, null))
    const latest = store(linkAfter(fixture(KS_A, 'PASS', { candidate: SIBLING }), first))
    const derivedFor = (r: Adjudication): Identity => (r === first.record || adjudicationDigest(r) === adjudicationDigest(first.record) ? clone(r.subject) : derivedDefault(r))
    const targetFree = (st: Store): ConsumerResult =>
      consume({ contract: C(), kind: CENSUS, head: introducingView(), store: st, canonical: new Map(), canonicalIsAncestor: true, contractPath: PATHS.v104, contractBlob: CONTRACT_BLOB, derivedFor, targetFor: () => null })
    expect(targetFree(repoWith([first]).storeAtHead()).result).toBe('STOP_NOT_CURRENT')
    expect(targetFree(repoWith([first, latest]).storeAtHead()).result).toBe('USABLE')
  }, GIT_TIMEOUT)

  it.runIf(B_PRESENT)('offline: runtime corpus, lockfile or .gitattributes change at a merged head makes KS-B unusable', () => {
    const base = commitView(KS_B.candidate_sha)
    const texts = base.texts(pathsOf(byRole(KS_B, 'COVERED')))
    const merged = patchedView(introducingView(), Object.fromEntries(byRole(KS_B, 'COVERED').map((e) => [e.path, { blob: e.blob, text: texts.get(e.path) ?? '' }])))
    const repo = repoWith([store(linkAfter(fixture(KS_B, 'PASS'), null))])
    const run = (head: View): ConsumerResult =>
      consume({ contract: C(), kind: OFFLINE, head, store: repo.storeAtHead(), canonical: new Map(), canonicalIsAncestor: true, contractPath: PATHS.v104, contractBlob: CONTRACT_BLOB, derivedFor: derivedDefault, targetFor: (r) => knownFor(r)?.id ?? null })
    expect(run(merged).result).toBe('USABLE')
    for (const p of ['db/baseline/stella_g2_post_restore.sql', 'pnpm-lock.yaml', '.gitattributes']) expect(run(patchedView(merged, { [p]: { blob: '6'.repeat(40) } })).result, p).toBe('STOP_NOT_CERTIFIED')
    expect(run(introducingView()).result).toBe('STOP_SUBJECT_NOT_PRESENT')
  }, GIT_TIMEOUT)
})

/* ========================================================================== */
/* §7 consumer registry                                                       */
/* ========================================================================== */

function discover(doc: unknown, test: (s: string) => boolean): string[] {
  const out: string[] = []
  const walk = (v: unknown, p: string): void => {
    if (typeof v === 'string') { if (test(v)) out.push(p) }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`))
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`)
  }
  walk(doc, '$')
  return out
}
const RULE_1 = (s: string): boolean => /occurrence|\bKS-[AB]\b/i.test(s) && /\bCURRENT\b|\bvalid\b|\bcurrency\b/.test(s)
const RULE_2 = (s: string): boolean => /\bcertif(ied|ication)\b/i.test(s) && /\b(census|offline|HX-[0-9]|authority)\b/i.test(s)

describe('§7 consumer registry is mechanically complete', () => {
  const classes = ['CONSUMER', 'SUPERSEDED_RULE', 'NON_CONSUMER', 'PACKAGE_CONSUMER']
  const classified = (l: Locus): void => {
    expect(classes).toContain(l.class)
    if (l.class === 'CONSUMER' || l.class === 'PACKAGE_CONSUMER') expect(l.consumer, l.locus).toBeTruthy()
    else expect(l.reason, l.locus).toBeTruthy()
  }
  it('rule 1: the registry equals the loci discovered in v1.0.3, each classified', () => {
    expect(AUTH.SECTION_E4_CONSUMER_REGISTRY.loci.map((l) => l.locus).sort()).toEqual(discover(readJson<unknown>(PATHS.v103), RULE_1).sort())
    AUTH.SECTION_E4_CONSUMER_REGISTRY.loci.forEach(classified)
  })
  it('rule 2: the older-layer registry equals the bare "certified" loci of v1.0.0, v1.0.1 and v1.0.2, each classified', () => {
    const found = [PATHS.v100, PATHS.v101, PATHS.v102].flatMap((f) => discover(readJson<unknown>(f), RULE_2).map((l) => `${f} ${l}`)).sort()
    expect(AUTH.SECTION_E4_CONSUMER_REGISTRY.loci_older_layers.map((l) => `${l.file} ${l.locus}`).sort()).toEqual(found)
    AUTH.SECTION_E4_CONSUMER_REGISTRY.loci_older_layers.forEach(classified)
  })
  it('EA-F1, HX-2, HX-5A, M-2, M-3 are CONSUMERS; HX-1 and PS-2 are PACKAGE_CONSUMERS', () => {
    const all = [...AUTH.SECTION_E4_CONSUMER_REGISTRY.loci, ...AUTH.SECTION_E4_CONSUMER_REGISTRY.loci_older_layers]
    const consumers = all.filter((l) => l.class === 'CONSUMER').map((l) => l.consumer ?? '')
    for (const c of ['EA-F1', 'HX-2', 'HX-5A', 'M-2', 'M-3']) expect(consumers.some((x) => x.startsWith(c)), c).toBe(true)
    const pkg = all.filter((l) => l.class === 'PACKAGE_CONSUMER').map((l) => l.consumer ?? '')
    expect(pkg).toEqual(expect.arrayContaining(['HX-1', 'PS-2 (authority package merged and certified)']))
  })
  it('a new CURRENT-reliant or bare-certified locus would be discovered (the discovery can fail)', () => {
    expect(discover({ EXTRA: { gate: 'requires a CURRENT occurrence' } }, RULE_1)).toEqual(['$.EXTRA.gate'])
    expect(discover({ EXTRA: { gate: 'the census authority must be certified' } }, RULE_2)).toEqual(['$.EXTRA.gate'])
  })
})

/* ========================================================================== */
/* §8 precedence anchors over ALL topics and C10 semantics                    */
/* ========================================================================== */

const domainOfPath = (p: string): string | null =>
  /\/STAGING_QUIESCE_READONLY_CENSUS_/.test(p) ? 'CENSUS'
  : /\/STAGING_QUIESCE_MECHANISM_/.test(p) ? 'QUIESCE'
  : /\/STAGING_RECOVERY_|\/owner-ratifications\/STAGING_RECOVERY_OWNER_/.test(p) ? 'RECOVERY'
  : null

interface V103Precedence { SECTION_D2_CROSS_LINEAGE_PRECEDENCE: { topic_allocation: Record<string, string>; v1_0_2_C10_item_topics: { items_in_order: { item_prefix: string; topic: string }[] } } }

function anchorViolations(allocation: Record<string, string>, anchors: Record<string, Anchor[]>): string[] {
  const v: string[] = []
  const topics = Object.keys(allocation)
  if (topics.length === 0) v.push('no topics')
  if (Object.keys(anchors).sort().join() !== [...topics].sort().join()) v.push('anchor set differs from topic set')
  for (const t of topics) {
    const list = anchors[t]
    if (!Array.isArray(list) || list.length === 0) { v.push(`empty:${t}`); continue }
    for (const a of list) {
      if (domainOfPath(a.path) !== allocation[t]) v.push(`domain:${t}`)
      if (!existsSync(path.join(ROOT, a.path)) || !(a.section in readJson<Record<string, unknown>>(a.path))) v.push(`section:${t}`)
    }
  }
  return v
}

const tokenIn = (text: string, id: string): boolean => new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`).test(text)
function c10Violations(items: { item: string }[], mapping: { item_prefix: string; topic: string }[], ids: Record<string, string[] | string>): string[] {
  const v: string[] = []
  if (items.length !== mapping.length) v.push('length')
  const topicIds = Object.entries(ids).filter((e): e is [string, string[]] => Array.isArray(e[1]))
  items.forEach((it, i) => {
    const m = mapping[i]
    if (!m || !it.item.startsWith(m.item_prefix)) v.push(`prefix:${i}`)
    const own = topicIds.find(([t]) => t === m?.topic)?.[1] ?? []
    if (!own.some((id) => tokenIn(it.item, id))) v.push(`own:${i}`)
    for (const [t, list] of topicIds) if (t !== m?.topic && list.some((id) => tokenIn(it.item, id))) v.push(`foreign:${i}:${t}`)
  })
  return v
}

describe('§8 precedence anchors (every topic) and C10 semantics', () => {
  const alloc = readJson<V103Precedence>(PATHS.v103).SECTION_D2_CROSS_LINEAGE_PRECEDENCE
  const anchors = AUTH.SECTION_E6_PRECEDENCE_ANCHORS.anchors
  const v102Items = (): { item: string }[] =>
    readJson<{ SECTION_C10_OD_3_SUPERSESSION_AND_QUIESCE_CHAIN_DISPOSITION: { QUIESCE_CHAIN_DISPOSITION: { items: { item: string }[] } } }>(PATHS.v102).SECTION_C10_OD_3_SUPERSESSION_AND_QUIESCE_CHAIN_DISPOSITION.QUIESCE_CHAIN_DISPOSITION.items
  it('every topic is anchored to existing sections of files of its allocated domain', () => {
    expect(anchorViolations(alloc.topic_allocation, anchors)).toEqual([])
    expect(Object.keys(alloc.topic_allocation)).toHaveLength(28)
  })
  it('reallocating ANY topic to another domain is RED (all topics, not four)', () => {
    const red: string[] = []
    for (const t of Object.keys(alloc.topic_allocation)) {
      for (const d of ['RECOVERY', 'CENSUS', 'QUIESCE'].filter((x) => x !== alloc.topic_allocation[t])) {
        if (anchorViolations({ ...alloc.topic_allocation, [t]: d }, anchors).length > 0) red.push(`${t}->${d}`)
      }
    }
    expect(red).toHaveLength(Object.keys(alloc.topic_allocation).length * 2)
  })
  it('an anchor moved to a file of another chain, to a missing section, or an empty anchor list is RED', () => {
    expect(anchorViolations(alloc.topic_allocation, { ...anchors, CENSUS_CLASSIFICATION_PROCEDURE_G_N_A_G_U: [{ path: PATHS.v103, section: 'SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY' }] })).toContain('domain:CENSUS_CLASSIFICATION_PROCEDURE_G_N_A_G_U')
    expect(anchorViolations(alloc.topic_allocation, { ...anchors, QUIESCE_WRITER_INVENTORY_W_1_TO_W_16: [{ path: anchors.QUIESCE_WRITER_INVENTORY_W_1_TO_W_16[0].path, section: 'SECTION_Z_ABSENT' }] })).toContain('section:QUIESCE_WRITER_INVENTORY_W_1_TO_W_16')
    expect(anchorViolations(alloc.topic_allocation, { ...anchors, CENSUS_NON_AUTHORIZATIONS: [] })).toContain('empty:CENSUS_NON_AUTHORIZATIONS')
    const mixed = [...anchors.CENSUS_DEP_C1_OD_C1_OD_C2_OD_C3, { path: PATHS.v102, section: 'SECTION_C4_EVENT_CLASS_REGISTRY' }]
    expect(anchorViolations(alloc.topic_allocation, { ...anchors, CENSUS_DEP_C1_OD_C1_OD_C2_OD_C3: mixed })).toContain('domain:CENSUS_DEP_C1_OD_C1_OD_C2_OD_C3')
  })
  it('the v1.0.3 C10 mapping is semantically consistent with the item content', () => {
    expect(c10Violations(v102Items(), alloc.v1_0_2_C10_item_topics.items_in_order, AUTH.SECTION_E6_PRECEDENCE_ANCHORS.c10_semantic_identifiers)).toEqual([])
  })
  it('each C10 rule is independently load-bearing: missing own identifier, foreign identifier, wrong prefix, wrong length', () => {
    const ids = { T1: ['AAA'], T2: ['BBB'] }
    expect(c10Violations([{ item: 'AAA one' }], [{ item_prefix: 'AAA', topic: 'T1' }], ids)).toEqual([])
    expect(c10Violations([{ item: 'AAA one' }], [{ item_prefix: 'AAA', topic: 'T2' }], ids)).toEqual(['own:0', 'foreign:0:T1'])
    expect(c10Violations([{ item: 'CCC one' }], [{ item_prefix: 'CCC', topic: 'T1' }], ids)).toEqual(['own:0'])
    expect(c10Violations([{ item: 'AAA and BBB' }], [{ item_prefix: 'AAA', topic: 'T1' }], ids)).toEqual(['foreign:0:T2'])
    expect(c10Violations([{ item: 'AAA one' }], [{ item_prefix: 'ZZZ', topic: 'T1' }], ids)).toEqual(['prefix:0'])
    expect(c10Violations([{ item: 'AAA one' }], [], ids)).toContain('length')
    expect(tokenIn('xS8y', 'S8')).toBe(false)
    expect(tokenIn('(S8)', 'S8')).toBe(true)
  })
  it('a swapped or mis-mapped C10 item is RED by content (every pair of differently-mapped items)', () => {
    const items = v102Items()
    const map = alloc.v1_0_2_C10_item_topics.items_in_order
    const ids = AUTH.SECTION_E6_PRECEDENCE_ANCHORS.c10_semantic_identifiers
    let pairs = 0
    for (let i = 0; i < map.length; i++) {
      for (let j = i + 1; j < map.length; j++) {
        if (map[i].topic === map[j].topic) continue
        const swapped = clone(map)
        ;[swapped[i].topic, swapped[j].topic] = [swapped[j].topic, swapped[i].topic]
        expect(c10Violations(items, swapped, ids).length, `${i}<->${j}`).toBeGreaterThan(0)
        pairs++
      }
    }
    expect(pairs).toBeGreaterThan(40)
  })
})

/* ========================================================================== */
/* §9 closed predecessor semantics                                            */
/* ========================================================================== */

describe('§9 closed predecessor semantics', () => {
  const [first] = chainOf([{ cls: 'PASS' }])
  const next = (): Adjudication => linkAfter(fixture(KS_A, 'PASS', { candidate: SIBLING }), first)
  it('the correct predecessor is VALID; a first record with no existing chain has predecessor null', () => {
    const r = next()
    expect(validate(r, ctxFor(r, { existing: [first] }))).toBe('VALID')
    expect(validate(first.record, ctxFor(first.record))).toBe('VALID')
  })
  it('an extra key, a missing key, a wrong path, a wrong digest, or a null predecessor over an existing chain STOP', () => {
    const extra = next()
    ;(extra.chain.predecessor as unknown as Record<string, unknown>).candidate_sha = KS_A.candidate_sha
    expect(validate(extra, ctxFor(extra, { existing: [first] }))).toBe('STOP_ADJUDICATION_SHAPE')
    const missing = next()
    delete (missing.chain.predecessor as unknown as Record<string, unknown>).adjudication_digest
    expect(validate(missing, ctxFor(missing, { existing: [first] }))).toBe('STOP_ADJUDICATION_SHAPE')
    const wrongPath = next()
    if (wrongPath.chain.predecessor) wrongPath.chain.predecessor.path = `${first.path}.x`
    expect(validate(wrongPath, ctxFor(wrongPath, { existing: [first] }))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
    const wrongDigest = next()
    if (wrongDigest.chain.predecessor) wrongDigest.chain.predecessor.adjudication_digest = 'f'.repeat(64)
    expect(validate(wrongDigest, ctxFor(wrongDigest, { existing: [first] }))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
    const nullPred = linkAfter(fixture(KS_A, 'PASS', { candidate: SIBLING }), null)
    expect(validate(nullPred, ctxFor(nullPred, { existing: [first] }))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
  })
  it('a non-tip predecessor STOPS at write; a fork, two roots, an orphan or a missing predecessor fail integrity', () => {
    const second = store(next())
    const fork = linkAfter(fixture(KS_A, 'PASS', { candidate: SIBLING_2 }), first)
    expect(validate(fork, ctxFor(fork, { existing: [first, second] }))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
    expect(chainIntegrity([first, second, store(fork)])).toMatch(/^fork/)
    expect(chainIntegrity([first, store(linkAfter(fixture(KS_A, 'FAIL', { candidate: SIBLING_2 }), null))])).toBe('roots=2')
    expect(chainIntegrity([second])).toBe('roots=0')
    expect(chainIntegrity([first, store(linkAfter(fixture(KS_A, 'PASS', { candidate: SIBLING_2 }), second))])).toMatch(/^missing predecessor/)
  })
  it('closing a finding requires naming the predecessor that carries it, once', () => {
    const r = next()
    r.closes_predecessor_findings = ['NOT-THERE']
    expect(validate(r, ctxFor(r, { existing: [first] }))).toBe('STOP_FINDING_CLOSURE_INVALID')
    const withNb = store(linkAfter(fixture(KS_A, 'PASS_WITH_NONBLOCKING_FINDINGS'), null))
    const closer = linkAfter(fixture(KS_A, 'PASS', { candidate: SIBLING }), withNb)
    closer.closes_predecessor_findings = ['FIX-NB-1']
    expect(validate(closer, ctxFor(closer, { existing: [withNb] }))).toBe('VALID')
    const twice = linkAfter(fixture(KS_A, 'PASS', { candidate: SIBLING }), withNb)
    twice.closes_predecessor_findings = ['FIX-NB-1', 'FIX-NB-1']
    expect(validate(twice, ctxFor(twice, { existing: [withNb] }))).toBe('STOP_FINDING_CLOSURE_INVALID')
  })
})

/* ========================================================================== */
/* §10 preservation, write set, stop-code closure                             */
/* ========================================================================== */

describe('§10 preservation and write set', () => {
  it('v1.0.3, its manifest and its test are byte-identical to their committed blobs', () => {
    const pins: Record<string, string> = {
      [PATHS.v103]: 'c20cc4f123bce9659e09a6e3fb0878a7de2752b0',
      'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.3.json': '9647d0f400c6f6dc4144e48f08391d3a8affd43d',
      'tests/release/staging-recovery-integration-successor.test.ts': '0418070e665c778b6d3147b199c7e3514401fd18',
    }
    for (const [p, b] of Object.entries(pins)) expect(gitBlobSha(storedBytes(p)), p).toBe(b)
  })
  it('the write set is exactly five added paths; the introducing tree holds no adjudication, no occurrence and no PR #220 code', () => {
    expect(WRITE_SET).toEqual([PATHS.v104, PATHS.manifest104, PATHS.owner102, PATHS.self, PATHS.battery])
    for (const p of WRITE_SET) expect(existsSync(path.join(ROOT, p)), p).toBe(true)
    const v = introducingView().list()
    expect(v.filter((p) => p.startsWith(C().path_and_identity.adjudication_root))).toEqual([])
    expect(v.filter((p) => p.startsWith(AUTH.SECTION_E7_MATERIALIZATION_WRITE_SET.retired_occurrence_root))).toEqual([])
    expect(v.filter((p) => p.startsWith('scripts/recovery/'))).toEqual([])
  }, GIT_TIMEOUT)
  it('declared layers are exactly the governing-family members added since each known candidate, with their blobs', () => {
    const v = introducingView()
    for (const ks of [KS_A, KS_B]) {
      const recorded = new Set(pathsOf(ks.governing_family_members_at_candidate))
      const added = v.list().filter((p) => ks.governing_families.some((f) => p.startsWith(f)) && !recorded.has(p)).sort(byteOrder)
      const declared = C().currency.declared_non_invalidating_governing_layers[ks.subject_kind] as Declared[]
      expect(pathsOf(declared).sort(byteOrder), ks.id).toEqual(added)
      for (const d of declared) expect(d.blob, d.path).toBe(d.path === PATHS.v104 ? null : v.blob(d.path))
    }
  }, GIT_TIMEOUT)
  it('Event A is untouched: NOT reachable, policy PENDING in v1.0.3 and v1.0.4', () => {
    expect(AUTH.SECTION_E10_EVENT_A_PRESERVATION).toMatchObject({ CURRENT_EVENT_A_REACHABLE: 'NO', EVENT_A_POLICY: 'PENDING' })
    const d8 = readJson<{ SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY: { EVENT_A_POLICY: { status: string; selected_option: null } } }>(PATHS.v103).SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY
    expect(d8.EVENT_A_POLICY.status).toBe('PENDING')
    expect(d8.EVENT_A_POLICY.selected_option).toBeNull()
  })
  it('no operation added; superseded loci are RECOVERY topics only; the canonical store ref is named', () => {
    const d = AUTH.SECTION_E16_PRESERVATION.AUTHORIZED_OPERATIONS_DELTA
    expect([d.added, d.removed, d.modified]).toEqual([[], [], []])
    const alloc = readJson<V103Precedence>(PATHS.v103).SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation
    for (const s of AUTH.SECTION_E11_SUPERSEDED_LOCI) expect(alloc[s.topic], s.locus).toBe('RECOVERY')
    const ao = readJson<{ AUTHORIZED_OPERATIONS: { operations: { id: string }[] } }>(PATHS.v100).AUTHORIZED_OPERATIONS.operations.map((o) => o.id)
    expect(ao).toEqual(['AO-1', 'AO-2', 'AO-3', 'AO-4', 'AO-5', 'AO-6', 'AO-7', 'AO-8', 'AO-9'])
    expect(C().canonical_store.CANONICAL_ADJUDICATION_REF).toBe('refs/heads/codex/cv1-recovery-integration-successor-r1')
  })
  it('the stop codes of validation_order, stop_codes and this interpreter are the same set; consumer results are declared', () => {
    const fromOrder = new Set(C().validation_order.join(' ').match(/STOP_[A-Z_]+/g) ?? [])
    expect([...fromOrder].sort()).toEqual([...C().stop_codes].sort())
    const src = readBytes(PATHS.self).toString('utf8')
    const block = src.slice(src.indexOf('const CHECKS'), src.indexOf('function validate('))
    const emitted = new Set([...block.matchAll(/'(STOP_[A-Z_]+)'/g)].map((m) => m[1]))
    expect([...emitted].sort()).toEqual([...C().stop_codes].sort())
    const consumerBlock = src.slice(src.indexOf('function consume('), src.indexOf('/* Fixtures'))
    const consumerCodes = new Set([...consumerBlock.matchAll(/'(STOP_[A-Z_]+|USABLE)'/g)].map((m) => m[1]))
    const dispBlock = src.slice(src.indexOf('function dispositionStatus('), src.indexOf('function familyRule('))
    for (const m of dispBlock.matchAll(/'(STOP_[A-Z_]+)'/g)) consumerCodes.add(m[1])
    expect([...consumerCodes].sort()).toEqual([...C().consumer_rule.consumer_results].sort())
  })
})

/* ========================================================================== */
/* §11 kill matrix over the validation checks                                 */
/* ========================================================================== */

interface NegCase { name: string; expected: string; run: (disabled: ReadonlySet<string>) => string }

function negativeCases(): NegCase[] {
  const mk = (name: string, expected: string, build: () => { r: Adjudication; c: Ctx }): NegCase => ({ name, expected, run: (d) => { const { r, c } = build(); return validate(r, c, d) } })
  const with_ = (ks: KnownSubject, cls: string, f: (r: Adjudication) => void, over: (r: Adjudication) => Partial<Ctx> = () => ({})) => () => {
    const r = fixture(ks, cls)
    f(r)
    return { r, c: ctxFor(r, { recordPath: adjudicationPathFor(C(), r), ...over(r) }) }
  }
  const [first] = chainOf([{ cls: 'PASS' }])
  const sib = (): Adjudication => fixture(KS_A, 'PASS', { candidate: SIBLING })
  const pin = (r: Adjudication): void => {
    const g = r.subject.entries.find((e) => e.role === 'GOVERNING')
    if (g) g.blob = '1'.repeat(40)
    r.subject.package_digest = digestOf(r.subject.entries)
  }
  const cov = (r: Adjudication): void => {
    r.subject.entries[0].blob = '2'.repeat(40)
    r.subject.package_digest = digestOf(r.subject.entries)
  }
  const tree = (r: Adjudication): void => {
    r.subject.tree_sha = '0'.repeat(40)
    r.provenance.independent_adjudicator.examined_tree_sha = r.subject.tree_sha
  }
  return [
    mk('kind', 'STOP_UNKNOWN_SUBJECT_KIND', with_(KS_A, 'PASS', (r) => { r.subject_kind = 'OTHER' })),
    mk('shape', 'STOP_ADJUDICATION_SHAPE', with_(KS_A, 'PASS', (r) => { (r as unknown as Record<string, unknown>).x = 1 })),
    mk('contract', 'STOP_ADJUDICATION_CONTRACT_MISMATCH', with_(KS_A, 'PASS', (r) => { r.adjudication_contract.blob = '0'.repeat(40) })),
    mk('authority', 'STOP_ADJUDICATION_CLAIMS_AUTHORITY', with_(KS_A, 'PASS', (r) => { r.authorizes = ['HC-3'] })),
    mk('sha format', 'STOP_CANDIDATE_SHA_MALFORMED', () => {
      const r = fixture(KS_A, 'PASS', { candidate: 'XYZ' })
      return { r, c: ctxFor(r, { target: null, derived: clone(r.subject) }) }
    }),
    mk('path identity', 'STOP_ADJUDICATION_PATH_IDENTITY_MISMATCH', with_(KS_A, 'PASS', () => undefined, () => ({ recordPath: 'x.json' }))),
    mk('kind subject', 'STOP_SUBJECT_KIND_MISMATCH', with_(KS_B, 'PASS', (r) => { r.subject_kind = CENSUS }, () => ({ target: null }))),
    mk('target sha', 'STOP_CANDIDATE_SHA_MISMATCH', () => {
      const r = sib()
      return { r, c: ctxFor(r, { target: 'KS-A', derived: clone(r.subject) }) }
    }),
    mk('derived sha', 'STOP_CANDIDATE_SHA_MISMATCH', () => {
      const r = sib()
      return { r, c: ctxFor(r, { target: null, derived: 'unreadable' }) }
    }),
    mk('target tree', 'STOP_TREE_SHA_MISMATCH', with_(KS_A, 'PASS', tree, (r) => ({ derived: clone(r.subject) }))),
    mk('derived tree', 'STOP_TREE_SHA_MISMATCH', with_(KS_A, 'PASS', tree, () => ({ target: null }))),
    mk('target covered', 'STOP_COVERED_SET_MISMATCH', with_(KS_A, 'PASS', cov, (r) => ({ derived: clone(r.subject) }))),
    mk('derived covered', 'STOP_COVERED_SET_MISMATCH', with_(KS_A, 'PASS', cov, () => ({ target: null }))),
    mk('target pin', 'STOP_GOVERNING_PIN_MISMATCH', with_(KS_B, 'PASS', pin, (r) => ({ derived: clone(r.subject) }))),
    mk('derived pin', 'STOP_GOVERNING_PIN_MISMATCH', with_(KS_B, 'PASS', pin, () => ({ target: null }))),
    mk('target digest', 'STOP_PACKAGE_DIGEST_MISMATCH', with_(KS_A, 'PASS', (r) => { r.subject.package_digest = '0'.repeat(64) }, (r) => ({ derived: clone(r.subject) }))),
    mk('derived digest', 'STOP_PACKAGE_DIGEST_MISMATCH', with_(KS_A, 'PASS', (r) => { r.subject.package_digest = '0'.repeat(64) }, () => ({ target: null }))),
    mk('literal', 'STOP_VERDICT_LITERAL_MISMATCH', with_(KS_A, 'PASS', (r) => { r.verdict.verdict_literal = 'CENSUS_RECERT_FAIL' })),
    mk('class', 'STOP_VERDICT_CLASS_INCONSISTENT', with_(KS_A, 'FAIL', (r) => { r.blocking_findings = []; r.verdict.blocking_findings_count = 0 })),
    mk('nb complete', 'STOP_NONBLOCKING_FINDINGS_INCOMPLETE', with_(KS_A, 'FAIL', (r) => { r.nonblocking_findings = [] })),
    mk('nb open', 'STOP_FINDING_NOT_OPEN', with_(KS_A, 'PASS_WITH_NONBLOCKING_FINDINGS', (r) => { r.nonblocking_findings[0].status = 'CLOSED' })),
    mk('lane grammar', 'STOP_PROVENANCE_IDENTITY_MALFORMED', with_(KS_A, 'PASS', (r) => { r.provenance.materializer.lane_id = 'FIXTURE-AUTHOR-LANЕ' })),
    mk('independence', 'STOP_PROVENANCE_NOT_INDEPENDENT', with_(KS_A, 'PASS', (r) => { r.provenance.materializer.lane_id = 'FIXTUREAUTHORLANE' })),
    mk('subject binding', 'STOP_RECERT_SUBJECT_MISMATCH', with_(KS_A, 'PASS', (r) => { r.provenance.independent_adjudicator.examined_candidate_sha = SIBLING })),
    mk('scope', 'STOP_RECERT_SCOPE_UNDECLARED', with_(KS_A, 'PASS', (r) => { r.provenance.independent_adjudicator.scope_basis = [] })),
    mk('basis', 'STOP_MATERIALIZER_REPRODUCTION_CLAIM', with_(KS_A, 'PASS', (r) => { r.provenance.independence_basis = 'CRYPTOGRAPHIC' })),
    mk('path exists', 'STOP_ADJUDICATION_PATH_EXISTS', () => ({ r: first.record, c: ctxFor(first.record, { existing: [first] }) })),
    mk('chain', 'STOP_CHAIN_PREDECESSOR_MISMATCH', () => {
      const r = sib()
      return { r, c: ctxFor(r, { existing: [first] }) }
    }),
    mk('closure', 'STOP_FINDING_CLOSURE_INVALID', with_(KS_A, 'PASS', (r) => { r.closes_predecessor_findings = ['X'] })),
    mk('history', 'STOP_ADJUDICATION_HISTORY_VIOLATED', () => ({ r: first.record, c: ctxFor(first.record, { mode: 'read', existing: [first], historyViolations: ['D x'] }) })),
    mk('integrity', 'STOP_CHAIN_INTEGRITY_VIOLATED', () => {
      const orphan = store(linkAfter(fixture(KS_A, 'PASS', { candidate: SIBLING }), null))
      return { r: first.record, c: ctxFor(first.record, { mode: 'read', existing: [first, orphan] }) }
    }),
  ]
}

describe('§11 kill matrix', () => {
  it('every negative case STOPS with its expected code', () => {
    for (const n of negativeCases()) expect(n.run(new Set()), n.name).toBe(n.expected)
  })
  it('disabling ANY single check lets at least one negative case through', () => {
    const cases = negativeCases()
    expect(CHECKS.map((d) => d.id).filter((id) => !cases.some((n) => n.run(new Set([id])) !== n.expected))).toEqual([])
  })
  it('self-test: a check that guards nothing survives', () => {
    CHECKS.push({ id: 'NOOP', when: 'both', check: () => null })
    try {
      expect(negativeCases().some((n) => n.run(new Set(['NOOP'])) !== n.expected)).toBe(false)
    } finally {
      CHECKS.pop()
    }
  })
  it('driven by the artifact: adding FAIL to positive_classes lets a revoked closure become CERTIFIED', () => {
    const m = clone(AUTH)
    m.SECTION_E3_ADJUDICATION_CONTRACT.verdict.positive_classes.push('FAIL')
    const order = chainOf([{ cls: 'PASS' }, { cls: 'FAIL', candidate: SIBLING }])
    expect(dispositionStatus(C(), order, KS_A.package_digest).status).toBe('REVOKED')
    expect(dispositionStatus(C(m), order, KS_A.package_digest).status).toBe('CERTIFIED')
  })
})
