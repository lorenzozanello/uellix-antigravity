// @vitest-environment node
//
// tests/release/staging-recovery-integration-successor.test.ts
// STAGING RECOVERY — integration successor v1.0.3 and the Recovery
// certification-occurrence contract (SECTION_D9).
//
// Authority:
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.3.json
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.3.json
//
// WHAT THIS FILE IS. A reference interpreter of the occurrence contract: the
// subject-identity derivation (RCO_CLOSURE_DIGEST_V1, with the IMPORTED
// closure), write-time validation V1..V11, read-time validation (V1..V10, R1,
// R2) and the currency rule. Every enum, prefix, token list, stop code, path
// pattern and declared layer is READ from the amendment; §10 mutates the
// amendment and watches verdicts move, and proves every check is load-bearing
// (kill matrix with a real-survivor self-test). It also checks the
// cross-lineage precedence allocation, the Event A disclosure and pending
// policy, and byte-identity of history.
//
// TWO VIEWS. Statements about the tree that INTRODUCES v1.0.3 are evaluated
// against a fixed view (merge commit be6bdf18 plus this write set), so the
// next authorized acts -- a materialized occurrence, the #220 merge, a later
// amendment -- do not turn them RED. LIVE guards (§8) evaluate the working
// tree: every occurrence present must be valid at read time, and KS-B must be
// absent or CURRENT.
//
// WHAT THIS FILE IS NOT. It creates no occurrence file. Every occurrence built
// here is an in-memory FIXTURE with fixture lane ids; neither KS-A nor KS-B is
// claimed to exist. It performs no database connection, provider call or
// hosted act. Git is read (ls-tree / ls-files / cat-file / log) and never written.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const GIT_TIMEOUT = 120_000

const PATHS = {
  v103: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.3.json',
  manifest103: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.3.json',
  v102: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.2.json',
  v100: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_v1.0.0.json',
  ownerV101: 'docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.1.json',
  censusV100: 'docs/ops/release/STAGING_QUIESCE_READONLY_CENSUS_AUTHORITY_v1.0.0.json',
  censusV101: 'docs/ops/release/STAGING_QUIESCE_READONLY_CENSUS_AUTHORITY_ERRATA_v1.0.1.json',
  self: 'tests/release/staging-recovery-integration-successor.test.ts',
} as const
const INTEGRATION_MERGE = 'be6bdf1844f9d55264f9d14939196b4b677c7afc'

const readBytes = (rel: string): Buffer => readFileSync(path.join(ROOT, rel))
const readJson = <T>(rel: string): T => JSON.parse(readBytes(rel).toString('utf8')) as T
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
/**
 * The bytes git stores for a working-tree file. docs/** is pinned to LF by
 * .gitattributes; other text files round-trip through core.autocrlf, so a
 * Windows checkout holds CRLF while the blob holds LF.
 */
const storedBytes = (rel: string): Buffer =>
  rel.startsWith('docs/') ? readBytes(rel) : Buffer.from(readBytes(rel).toString('utf8').replace(/\r\n/g, '\n'), 'utf8')

/** git's blob id: sha1 over "blob <len>\0<bytes>". */
function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex')
}

/* ========================================================================== */
/* Shapes read from the amendment (only the parts this file consumes)         */
/* ========================================================================== */

type Role = 'COVERED' | 'IMPORTED' | 'GOVERNING'
interface Entry { role: Role; path: string; blob: string }
interface Member { path: string; blob: string }
interface SubjectIdentity {
  candidate_sha: string
  tree_sha: string
  digest_algorithm: string
  entries: Entry[]
  package_digest: string
  governing_families: string[]
  governing_family_members_at_candidate: Member[]
}
interface KnownSubject extends SubjectIdentity {
  id: string
  subject_kind: string
  occurrence_path: string
  package_id: string
}
interface DeclaredLayer { path: string; blob: string | null; reason: string }
interface Contract {
  meaning: string
  subject_kinds: { kinds: Record<string, { covered_path_prefixes: string[] }> }
  subject_identity_derivation: { import_resolution_suffixes: string[] }
  verdict: {
    verdict_classes: string[]
    positive_classes: string[]
    required_qualifier_tokens: string[]
    prefix_token_vocabulary: string[]
    version_token_pattern: string
    forbidden_prefix_tokens: string[]
  }
  provenance: { recert_scope: { values: string[] } }
  path_and_identity: { occurrence_root: string; occurrence_path: string; package_id: string }
  currency: { declared_non_invalidating_governing_layers: Record<string, DeclaredLayer[] | string> }
  occurrence_schema: {
    top_level_keys_exact: string[]
    nested_keys_exact: Record<string, string[]>
    entry_roles: string[]
    authority_class: string
  }
  validation_order: string[]
  stop_codes: string[]
  currency_results: string[]
}
interface Option { label: string; selected: boolean; authorized_by_this_artifact: boolean }
interface V103 {
  SECTION_D1_LINEAGE_INTEGRATION: {
    integrated_quiesce_and_census_package: { path: string; blob: string }[]
    recovery_package_carried: { path: string; blob: string }[]
    merge: { commit: string; pr220_merged: boolean }
  }
  SECTION_D2_CROSS_LINEAGE_PRECEDENCE: {
    internal_precedence: Record<string, { order_highest_first: string[] }>
    topic_allocation: Record<string, string>
    v1_0_2_C10_item_topics: { items_in_order: { item_prefix: string; topic: string }[] }
  }
  SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY: {
    CURRENT_EVENT_A_REACHABLE: string
    FIRST_RUNTIME_BLOCKER: { id: string }
    FIRST_STRUCTURAL_BLOCKER: { id: string }
    STRUCTURAL_BLOCKERS_BEHIND_G_N3: { id: string }[]
    EVENT_A_POLICY: {
      status: string
      selected_option: string | null
      decided_by: string | null
      options_surfaced_not_ratified: Option[]
      bounded_write_loss_for_event_A: { authorized: boolean }
    }
  }
  SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT: Contract
  SECTION_D10_KNOWN_SUBJECTS: { subjects: KnownSubject[] }
  SECTION_D11_MATERIALIZATION_WRITE_SET: { first_authorized_paths_after_recert_of_this_artifact: string[] }
  SECTION_D14_PRESERVATION: { AUTHORIZED_OPERATIONS_DELTA: { added: unknown[]; removed: unknown[]; modified: unknown[] } }
  SECTION_D16_SUPERSEDED_LOCI: { chain: string; topic: string; locus: string }[]
  SECTION_D18_WRITE_SET: string[]
}
interface Occurrence {
  occurrence_contract: { path: string; section: string; blob: string }
  package_id: string
  subject_kind: string
  subject: SubjectIdentity
  verdict: {
    verdict_class: string
    verdict_literal: string
    blocking_findings_count: number
    blocking_findings: unknown[]
    nonblocking_findings_reported_count: number
  }
  nonblocking_findings: { id: string; summary: string; status: string }[]
  closes_predecessor_findings: string[]
  provenance: {
    candidate_author: { lane_id: string; executor: string }
    independent_recertifier: {
      lane_id: string
      executor: string
      examined_candidate_sha: string
      examined_tree_sha: string
      recert_date: string
      scope: string
      report_reference: string
    }
    materializer: { lane_id: string; executor: string; materialization_date: string }
    identity_facts_basis: string
    verdict_and_findings_basis: string
    materializer_reproduced_recert_evidence: boolean
  }
  chain: { predecessor: null | { path: string; candidate_sha: string; package_digest: string } }
  authority_class: string
  authorizes: unknown[]
  meaning: string
}

const AUTH = readJson<V103>(PATHS.v103)
const WRITE_SET = AUTH.SECTION_D18_WRITE_SET.map((w) => w.split(' ')[0])
const C = (auth: V103 = AUTH): Contract => auth.SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT
const KS = (id: string): KnownSubject => {
  const s = AUTH.SECTION_D10_KNOWN_SUBJECTS.subjects.find((x) => x.id === id)
  if (!s) throw new Error(`known subject ${id} absent`)
  return s
}
const KS_A = KS('KS-A')
const KS_B = KS('KS-B')

/* ========================================================================== */
/* Tree views                                                                 */
/* ========================================================================== */

interface View {
  list(): string[]
  blob(p: string): string | null
  /** Batch text read; a missing path maps to null. */
  texts(ps: string[]): Map<string, string | null>
}

const git = (args: string[], input?: string): Buffer =>
  execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 29, input, stdio: ['pipe', 'pipe', 'ignore'] })
const gitText = (...args: string[]): string => git(args).toString('utf8').trim()

function hasCommit(sha: string): boolean {
  try {
    return gitText('cat-file', '-t', sha) === 'commit'
  } catch {
    return false
  }
}

/** One `git cat-file --batch` call for many blob ids. */
function readBlobs(oids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const unique = [...new Set(oids)]
  if (unique.length === 0) return out
  const buf = git(['cat-file', '--batch'], `${unique.join('\n')}\n`)
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

function commitView(sha: string): View {
  const blobs = new Map<string, string>()
  for (const line of git(['ls-tree', '-r', sha]).toString('utf8').split('\n')) {
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
      const got = readBlobs(ps.map((p) => blobs.get(p)).filter((o): o is string => o !== undefined))
      return new Map(ps.map((p) => [p, blobs.has(p) ? (got.get(blobs.get(p) as string) ?? null) : null]))
    },
  }
}

/** The working tree: tracked plus untracked-not-ignored files, hashed as git would store them. */
function worktreeView(): View {
  const list = gitText('ls-files', '--cached', '--others', '--exclude-standard')
    .split('\n')
    .filter((p) => p && existsSync(path.join(ROOT, p)))
  const set = new Set(list)
  return {
    list: () => list,
    blob: (p) => (set.has(p) ? gitBlobSha(storedBytes(p)) : null),
    texts: (ps) => new Map(ps.map((p) => [p, set.has(p) ? storedBytes(p).toString('utf8') : null])),
  }
}

/** A view with some paths replaced, added (with optional text) or removed (null). */
function patchedView(base: View, patch: Record<string, { blob: string; text?: string } | null>): View {
  const list = [...new Set([...base.list(), ...Object.keys(patch)])].filter((p) => patch[p] !== null)
  return {
    list: () => list,
    blob: (p) => (p in patch ? (patch[p]?.blob ?? null) : base.blob(p)),
    texts: (ps) => {
      const rest = base.texts(ps.filter((p) => !(p in patch)))
      return new Map(ps.map((p) => [p, p in patch ? (patch[p]?.text ?? (patch[p] ? '' : null)) : (rest.get(p) ?? null)]))
    },
  }
}

/** The tree that introduces v1.0.3: the integration merge plus this write set. Fixed forever. */
let successorCache: View | null = null
function successorView(): View {
  if (successorCache) return successorCache
  if (!hasCommit(INTEGRATION_MERGE)) throw new Error(`integration merge ${INTEGRATION_MERGE} is not present; it is an ancestor of this lineage`)
  successorCache = patchedView(
    commitView(INTEGRATION_MERGE),
    Object.fromEntries(WRITE_SET.map((p) => [p, { blob: gitBlobSha(storedBytes(p)), text: storedBytes(p).toString('utf8') }])),
  )
  return successorCache
}

/* ========================================================================== */
/* RCO_CLOSURE_DIGEST_V1 (SECTION_D9.subject_identity_derivation)             */
/* ========================================================================== */

const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const digestOf = (entries: Entry[]): string =>
  createHash('sha256')
    .update(entries.map((e) => `${e.role}\t${e.path}\t${e.blob}\n`).join(''), 'utf8')
    .digest('hex')
function family(p: string): string {
  const i = p.search(/_v\d/)
  return i < 0 ? p : p.slice(0, i + 1)
}
const REF_RE = /docs\/ops\/[A-Za-z0-9_./-]+\.json/g
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm
const CODE_RE = /\.(ts|tsx|js|mjs)$/

function coveredAt(contract: Contract, kind: string, view: View): string[] {
  const prefixes = contract.subject_kinds.kinds[kind]?.covered_path_prefixes ?? []
  return view.list().filter((p) => prefixes.some((x) => p.startsWith(x))).sort(byteOrder)
}

/** Returns the identity, or a string naming why the derivation failed. */
function deriveIdentity(contract: Contract, kind: string, candidate: string, tree: string, view: View): SubjectIdentity | string {
  if (!contract.subject_kinds.kinds[kind]) return 'unknown kind'
  const covered = coveredAt(contract, kind, view)
  if (covered.length === 0) return 'empty COVERED'
  const present = new Set(view.list())
  const suffixes = contract.subject_identity_derivation.import_resolution_suffixes
  const text = new Map<string, string | null>()
  const load = (ps: string[]): void => {
    const need = ps.filter((p) => !text.has(p))
    for (const [p, t] of view.texts(need)) text.set(p, t)
  }
  // S3 IMPORTED, breadth-first with one batch read per level.
  const seen = new Set(covered)
  const imported: string[] = []
  let frontier = covered.filter((p) => CODE_RE.test(p))
  while (frontier.length > 0) {
    load(frontier)
    const next: string[] = []
    for (const f of frontier) {
      for (const m of (text.get(f) ?? '').matchAll(IMPORT_RE)) {
        const spec = m[1]
        let base: string
        if (spec.startsWith('@/')) base = spec.slice(2)
        else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec))
        else continue
        const hit = suffixes.map((x) => base + x).find((c) => present.has(c))
        if (!hit) return `unresolved import ${spec} in ${f}`
        if (!seen.has(hit)) {
          seen.add(hit)
          imported.push(hit)
          if (CODE_RE.test(hit)) next.push(hit)
        }
      }
    }
    frontier = next
  }
  imported.sort(byteOrder)
  // S4 GOVERNING.
  load([...covered, ...imported])
  const refs = new Set<string>()
  for (const p of [...covered, ...imported]) for (const m of (text.get(p) ?? '').matchAll(REF_RE)) refs.add(m[0])
  const governing = [...refs].filter((p) => !seen.has(p)).sort(byteOrder)
  const entries: Entry[] = []
  for (const [role, list] of [['COVERED', covered], ['IMPORTED', imported], ['GOVERNING', governing]] as const) {
    for (const p of list) {
      const blob = view.blob(p)
      if (blob === null) return `dangling ${p}`
      entries.push({ role, path: p, blob })
    }
  }
  const families = [...new Set(governing.map(family))].sort(byteOrder)
  return {
    candidate_sha: candidate,
    tree_sha: tree,
    digest_algorithm: 'RCO_CLOSURE_DIGEST_V1',
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
/* Validation: write time (V1..V11) and read time (V1..V10, R1, R2)           */
/* ========================================================================== */

interface Ctx {
  mode: 'write' | 'read'
  contract: Contract
  knownSubjects: KnownSubject[]
  contractPath: string
  /** write: the contract blob at the materializer's head. read: the contract blob at the consumer head. */
  contractBlob: string
  occurrencePath: string
  /** SUBJECT_IDENTITY re-derived at the record's candidate; a string when it cannot be derived. */
  derived: SubjectIdentity | string
  /** The known subject a materializer lane is recording, if any (SECTION_D10). */
  target: string | null
  existing: { path: string; record: Occurrence }[]
  /** read only: the occurrence bytes equal those of the commit that added it. */
  unchangedSinceWrite: boolean
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toUpperCase() : '')
const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== ''
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const entriesOf = (s: SubjectIdentity, ...roles: Role[]): Entry[] => s.entries.filter((e) => roles.includes(e.role))
const pathsOf = (es: { path: string }[]): string[] => es.map((e) => e.path)
const blobsEqual = (a: { path: string; blob: string }[], b: { path: string; blob: string }[]): boolean =>
  a.length === b.length && a.every((e, i) => e.path === b[i].path && e.blob === b[i].blob)
const keysExact = (o: unknown, keys: string[]): boolean =>
  o !== null && typeof o === 'object' && !Array.isArray(o) && sameList(Object.keys(o).sort(byteOrder), [...keys].sort(byteOrder))

function parseVerdictLiteral(v: Contract['verdict'], literal: unknown): string | null {
  if (typeof literal !== 'string' || !/^[A-Z0-9_]+$/.test(literal)) return null
  const tokens = literal.split('_')
  const byLength = [...v.verdict_classes].sort((a, b) => b.split('_').length - a.split('_').length)
  for (const c of byLength) {
    const ct = c.split('_')
    if (tokens.length > ct.length && tokens.slice(-ct.length).join('_') === c) {
      const prefix = tokens.slice(0, -ct.length)
      if (!v.required_qualifier_tokens.includes(prefix[prefix.length - 1])) return null
      const version = new RegExp(v.version_token_pattern)
      if (!prefix.every((t) => v.prefix_token_vocabulary.includes(t) || version.test(t))) return null
      return prefix.some((t) => v.forbidden_prefix_tokens.includes(t)) ? null : c
    }
  }
  return null
}

const occurrencePathFor = (contract: Contract, kind: string, sha: string): string =>
  contract.path_and_identity.occurrence_path.replace('<SUBJECT_KIND>', kind).replace('<candidate_sha>', sha)
const packageIdFor = (contract: Contract, kind: string, sha: string): string =>
  contract.path_and_identity.package_id.replace('<SUBJECT_KIND>', kind).replace('<candidate_sha>', sha)

function chainTips(existing: { path: string; record: Occurrence }[]): { path: string; record: Occurrence }[] {
  const named = new Set(existing.map((e) => e.record.chain?.predecessor?.path).filter(Boolean))
  return existing.filter((e) => !named.has(e.path))
}

function shapeOk(r: Occurrence, c: Ctx): boolean {
  const s = c.contract.occurrence_schema
  const n = s.nested_keys_exact
  const p = r.provenance as unknown as Record<string, unknown>
  return (
    keysExact(r, s.top_level_keys_exact) &&
    keysExact(r.occurrence_contract, n.occurrence_contract) &&
    keysExact(r.subject, n.subject) &&
    Array.isArray(r.subject.entries) &&
    r.subject.entries.every((e) => keysExact(e, n['subject.entries[]']) && s.entry_roles.includes(e.role)) &&
    Array.isArray(r.subject.governing_family_members_at_candidate) &&
    r.subject.governing_family_members_at_candidate.every((m) => keysExact(m, n['subject.governing_family_members_at_candidate[]'])) &&
    keysExact(r.verdict, n.verdict) &&
    Array.isArray(r.nonblocking_findings) &&
    r.nonblocking_findings.every((f) => keysExact(f, n['nonblocking_findings[]'])) &&
    keysExact(p, n.provenance) &&
    keysExact(p.candidate_author, n['provenance.candidate_author']) &&
    keysExact(p.independent_recertifier, n['provenance.independent_recertifier']) &&
    keysExact(p.materializer, n['provenance.materializer']) &&
    keysExact(r.chain, n.chain) &&
    (r.chain.predecessor === null || keysExact(r.chain.predecessor, n['chain.predecessor (when not null)']))
  )
}

type Check = (r: Occurrence, c: Ctx) => string | null
interface CheckDef { id: string; when: 'both' | 'write' | 'read'; check: Check }

/** SECTION_D9.validation_order, in order. */
const CHECKS: CheckDef[] = [
  { id: 'V1_KIND', when: 'both', check: (r, c) => (typeof r.subject_kind === 'string' && c.contract.subject_kinds.kinds[r.subject_kind] ? null : 'STOP_UNKNOWN_SUBJECT_KIND') },
  { id: 'V2_SHAPE', when: 'both', check: (r, c) => (shapeOk(r, c) ? null : 'STOP_OCCURRENCE_SHAPE') },
  { id: 'V3_CONTRACT', when: 'both', check: (r, c) =>
    r.occurrence_contract.path === c.contractPath &&
    r.occurrence_contract.section === 'SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT' &&
    r.occurrence_contract.blob === c.contractBlob
      ? null
      : 'STOP_OCCURRENCE_CONTRACT_MISMATCH' },
  { id: 'V4_NOT_AUTHORITY', when: 'both', check: (r, c) =>
    r.authority_class === c.contract.occurrence_schema.authority_class &&
    Array.isArray(r.authorizes) && r.authorizes.length === 0 && r.meaning === c.contract.meaning
      ? null
      : 'STOP_OCCURRENCE_CLAIMS_AUTHORITY' },
  { id: 'V5_SHA_FORMAT', when: 'both', check: (r) => (/^[0-9a-f]{40}$/.test(r.subject.candidate_sha) ? null : 'STOP_CANDIDATE_SHA_MALFORMED') },
  { id: 'V5_PATH_IDENTITY', when: 'both', check: (r, c) =>
    r.package_id === packageIdFor(c.contract, r.subject_kind, r.subject.candidate_sha) &&
    c.occurrencePath === occurrencePathFor(c.contract, r.subject_kind, r.subject.candidate_sha)
      ? null
      : 'STOP_OCCURRENCE_PATH_IDENTITY_MISMATCH' },
  { id: 'V6_KIND_SUBJECT', when: 'both', check: (r, c) => {
    const prefixes = c.contract.subject_kinds.kinds[r.subject_kind]?.covered_path_prefixes ?? []
    const cov = entriesOf(r.subject, 'COVERED')
    return cov.length > 0 && cov.every((e) => prefixes.some((x) => e.path.startsWith(x))) ? null : 'STOP_SUBJECT_KIND_MISMATCH'
  } },
  { id: 'V7_TARGET', when: 'both', check: (r, c) => {
    if (c.target === null) return null
    const t = c.knownSubjects.find((k) => k.id === c.target)
    if (!t || t.subject_kind !== r.subject_kind) return 'STOP_SUBJECT_KIND_MISMATCH'
    if (r.subject.candidate_sha !== t.candidate_sha) return 'STOP_CANDIDATE_SHA_MISMATCH'
    if (r.subject.tree_sha !== t.tree_sha) return 'STOP_TREE_SHA_MISMATCH'
    if (!blobsEqual(entriesOf(r.subject, 'COVERED', 'IMPORTED'), entriesOf(t, 'COVERED', 'IMPORTED'))) return 'STOP_COVERED_SET_MISMATCH'
    if (!blobsEqual(entriesOf(r.subject, 'GOVERNING'), entriesOf(t, 'GOVERNING'))) return 'STOP_GOVERNING_PIN_MISMATCH'
    if (r.subject.package_digest !== t.package_digest) return 'STOP_PACKAGE_DIGEST_MISMATCH'
    return null
  } },
  { id: 'V7_DERIVED', when: 'both', check: (r, c) => {
    const d = c.derived
    if (typeof d === 'string' || d.candidate_sha !== r.subject.candidate_sha || d.tree_sha === d.candidate_sha) return 'STOP_CANDIDATE_SHA_MISMATCH'
    if (d.tree_sha !== r.subject.tree_sha) return 'STOP_TREE_SHA_MISMATCH'
    if (!sameList(pathsOf(entriesOf(r.subject, 'COVERED', 'IMPORTED')), pathsOf(entriesOf(d, 'COVERED', 'IMPORTED')))) return 'STOP_COVERED_SET_MISMATCH'
    if (!blobsEqual(entriesOf(r.subject, 'COVERED', 'IMPORTED'), entriesOf(d, 'COVERED', 'IMPORTED'))) return 'STOP_COVERED_SET_MISMATCH'
    if (!sameList(r.subject.entries.map((e) => e.role), d.entries.map((e) => e.role))) return 'STOP_COVERED_SET_MISMATCH'
    if (!blobsEqual(entriesOf(r.subject, 'GOVERNING'), entriesOf(d, 'GOVERNING'))) return 'STOP_GOVERNING_PIN_MISMATCH'
    if (!sameList(r.subject.governing_families, d.governing_families)) return 'STOP_GOVERNING_PIN_MISMATCH'
    if (!blobsEqual(r.subject.governing_family_members_at_candidate, d.governing_family_members_at_candidate)) return 'STOP_GOVERNING_PIN_MISMATCH'
    return null
  } },
  { id: 'V7_DIGEST', when: 'both', check: (r, c) =>
    r.subject.digest_algorithm === 'RCO_CLOSURE_DIGEST_V1' &&
    r.subject.package_digest === digestOf(r.subject.entries) &&
    typeof c.derived !== 'string' && r.subject.package_digest === c.derived.package_digest
      ? null
      : 'STOP_PACKAGE_DIGEST_MISMATCH' },
  { id: 'V8_PROMOTABLE', when: 'both', check: (r, c) => (c.contract.verdict.positive_classes.includes(r.verdict.verdict_class) ? null : 'STOP_VERDICT_NOT_PROMOTABLE') },
  { id: 'V8_LITERAL', when: 'both', check: (r, c) =>
    parseVerdictLiteral(c.contract.verdict, r.verdict.verdict_literal) === r.verdict.verdict_class ? null : 'STOP_VERDICT_LITERAL_MISMATCH' },
  { id: 'V8_BLOCKING', when: 'both', check: (r) =>
    r.verdict.blocking_findings_count === 0 && Array.isArray(r.verdict.blocking_findings) && r.verdict.blocking_findings.length === 0
      ? null
      : 'STOP_BLOCKING_FINDINGS_PRESENT' },
  { id: 'V9_COMPLETE', when: 'both', check: (r) => {
    const f = r.nonblocking_findings
    const ids = f.map((x) => x.id)
    const ok =
      f.length === r.verdict.nonblocking_findings_reported_count &&
      f.every((x) => isStr(x.id) && isStr(x.summary)) &&
      new Set(ids).size === ids.length &&
      (r.verdict.verdict_class === 'PASS' ? f.length === 0 : f.length >= 1)
    return ok ? null : 'STOP_NONBLOCKING_FINDINGS_INCOMPLETE'
  } },
  { id: 'V9_OPEN', when: 'both', check: (r) => (r.nonblocking_findings.every((x) => x.status === 'OPEN') ? null : 'STOP_FINDING_NOT_OPEN') },
  { id: 'V10_INDEPENDENT', when: 'both', check: (r) => {
    const lanes = [r.provenance.candidate_author.lane_id, r.provenance.independent_recertifier.lane_id, r.provenance.materializer.lane_id].map(norm)
    return lanes.every((l) => l !== '') && new Set(lanes).size === 3 ? null : 'STOP_PROVENANCE_NOT_INDEPENDENT'
  } },
  { id: 'V10_RECERT_BINDING', when: 'both', check: (r) =>
    r.provenance.independent_recertifier.examined_candidate_sha === r.subject.candidate_sha &&
    r.provenance.independent_recertifier.examined_tree_sha === r.subject.tree_sha
      ? null
      : 'STOP_RECERT_SUBJECT_MISMATCH' },
  { id: 'V10_SCOPE', when: 'both', check: (r, c) =>
    c.contract.provenance.recert_scope.values.includes(r.provenance.independent_recertifier.scope) &&
    isStr(r.provenance.independent_recertifier.report_reference)
      ? null
      : 'STOP_RECERT_SCOPE_UNDECLARED' },
  { id: 'V10_BASIS', when: 'both', check: (r) =>
    r.provenance.materializer_reproduced_recert_evidence === false &&
    r.provenance.identity_facts_basis === 'MATERIALIZER_REDERIVED' &&
    r.provenance.verdict_and_findings_basis === 'RECERTIFIER_REPORTED_SECOND_HAND'
      ? null
      : 'STOP_MATERIALIZER_REPRODUCTION_CLAIM' },
  { id: 'V11_PATH_FREE', when: 'write', check: (_r, c) => (c.existing.some((e) => e.path === c.occurrencePath) ? 'STOP_OCCURRENCE_PATH_EXISTS' : null) },
  { id: 'V11_CHAIN', when: 'write', check: (r, c) => {
    const same = c.existing.filter((e) => e.record.subject_kind === r.subject_kind)
    const p = r.chain.predecessor
    if (same.length === 0) return p === null ? null : 'STOP_CHAIN_PREDECESSOR_MISMATCH'
    const tips = chainTips(same)
    if (tips.length !== 1 || p === null) return 'STOP_CHAIN_PREDECESSOR_MISMATCH'
    const tip = tips[0]
    const ok =
      p.path === tip.path &&
      p.candidate_sha === tip.record.subject.candidate_sha &&
      p.package_digest === tip.record.subject.package_digest &&
      p.candidate_sha !== r.subject.candidate_sha
    return ok ? null : 'STOP_CHAIN_PREDECESSOR_MISMATCH'
  } },
  { id: 'V11_CLOSURE', when: 'write', check: (r, c) => {
    const closes = r.closes_predecessor_findings
    if (!Array.isArray(closes)) return 'STOP_FINDING_CLOSURE_INVALID'
    if (r.chain.predecessor === null) return closes.length === 0 ? null : 'STOP_FINDING_CLOSURE_INVALID'
    const pred = c.existing.find((e) => e.path === r.chain.predecessor?.path)
    const ids = new Set(pred?.record.nonblocking_findings.map((x) => x.id) ?? [])
    return new Set(closes).size === closes.length && closes.every((id) => ids.has(id)) ? null : 'STOP_FINDING_CLOSURE_INVALID'
  } },
  { id: 'R1_UNCHANGED', when: 'read', check: (_r, c) => (c.unchangedSinceWrite ? null : 'STOP_OCCURRENCE_EDITED_AFTER_WRITE') },
  { id: 'R2_SINGLE_TIP', when: 'read', check: (r, c) =>
    chainTips(c.existing.filter((e) => e.record.subject_kind === r.subject_kind)).length === 1 ? null : 'STOP_CHAIN_PREDECESSOR_MISMATCH' },
]

function validate(r: Occurrence, c: Ctx, disabled: ReadonlySet<string> = new Set()): string {
  for (const d of CHECKS) {
    if (disabled.has(d.id) || (d.when !== 'both' && d.when !== c.mode)) continue
    try {
      const stop = d.check(r, c)
      if (stop) return stop
    } catch {
      return 'STOP_OCCURRENCE_SHAPE'
    }
  }
  return 'VALID'
}

/* ========================================================================== */
/* Currency (SECTION_D9.currency)                                             */
/* ========================================================================== */

function currency(contract: Contract, r: Occurrence, head: View, readCtx: Ctx): string {
  const valid = validate(r, { ...readCtx, mode: 'read', contract })
  if (valid !== 'VALID') return `INVALID_AT_READ:${valid}`
  if (coveredAt(contract, r.subject_kind, head).length === 0) return 'SUBJECT_NOT_PRESENT'
  const atHead = deriveIdentity(contract, r.subject_kind, r.subject.candidate_sha, r.subject.tree_sha, head)
  const own = entriesOf(r.subject, 'COVERED', 'IMPORTED')
  if (typeof atHead === 'string' || !sameList(pathsOf(entriesOf(atHead, 'COVERED', 'IMPORTED')), pathsOf(own))) return 'STALE_COVERED_SET_CHANGED'
  if (own.some((e) => head.blob(e.path) !== e.blob)) return 'STALE_COVERED_PATH_CHANGED'
  if (entriesOf(r.subject, 'GOVERNING').some((e) => head.blob(e.path) !== e.blob)) return 'STALE_GOVERNING_AUTHORITY_CHANGED'
  const declaredRaw = contract.currency.declared_non_invalidating_governing_layers[r.subject_kind]
  const declared = new Map((Array.isArray(declaredRaw) ? declaredRaw : []).map((d) => [d.path, d.blob]))
  const recorded = new Map(r.subject.governing_family_members_at_candidate.map((m) => [m.path, m.blob]))
  for (const p of head.list().filter((x) => r.subject.governing_families.some((f) => x.startsWith(f)))) {
    const blob = head.blob(p)
    if (recorded.has(p)) {
      if (recorded.get(p) !== blob) return 'STALE_GOVERNING_AUTHORITY_CHANGED'
    } else if (declared.has(p)) {
      const want = declared.get(p)
      if (want === null ? p !== readCtx.contractPath : want !== blob) return 'STALE_GOVERNING_AUTHORITY_CHANGED'
    } else return 'STALE_GOVERNING_LAYER_ADDED'
  }
  for (const p of recorded.keys()) if (head.blob(p) === null) return 'STALE_GOVERNING_AUTHORITY_CHANGED'
  return 'CURRENT'
}

/* ========================================================================== */
/* Fixtures (in-memory only; fixture lane ids; nothing is written)            */
/* ========================================================================== */

const CONTRACT_BLOB = gitBlobSha(readBytes(PATHS.v103))
const identityOf = (ks: KnownSubject): SubjectIdentity => ({
  candidate_sha: ks.candidate_sha,
  tree_sha: ks.tree_sha,
  digest_algorithm: ks.digest_algorithm,
  entries: clone(ks.entries),
  package_digest: ks.package_digest,
  governing_families: [...ks.governing_families],
  governing_family_members_at_candidate: clone(ks.governing_family_members_at_candidate),
})

function fixtureOccurrence(ks: KnownSubject, auth: V103 = AUTH): Occurrence {
  const subject = identityOf(ks)
  return {
    occurrence_contract: { path: PATHS.v103, section: 'SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT', blob: CONTRACT_BLOB },
    package_id: packageIdFor(C(auth), ks.subject_kind, ks.candidate_sha),
    subject_kind: ks.subject_kind,
    subject,
    verdict: {
      verdict_class: 'PASS_WITH_NONBLOCKING_FINDINGS',
      verdict_literal: 'STAGING_RECOVERY_RECERT_PASS_WITH_NONBLOCKING_FINDINGS',
      blocking_findings_count: 0,
      blocking_findings: [],
      nonblocking_findings_reported_count: 2,
    },
    nonblocking_findings: [
      { id: 'FIX-NB-1', summary: 'fixture finding one', status: 'OPEN' },
      { id: 'FIX-NB-2', summary: 'fixture finding two', status: 'OPEN' },
    ],
    closes_predecessor_findings: [],
    provenance: {
      candidate_author: { lane_id: 'FIXTURE-AUTHOR-LANE', executor: 'fixture' },
      independent_recertifier: {
        lane_id: 'FIXTURE-RECERT-LANE',
        executor: 'fixture',
        examined_candidate_sha: subject.candidate_sha,
        examined_tree_sha: subject.tree_sha,
        recert_date: '2026-01-01',
        scope: 'FOCUSED_REMEDIATION',
        report_reference: 'fixture://report',
      },
      materializer: { lane_id: 'FIXTURE-MATERIALIZER-LANE', executor: 'fixture', materialization_date: '2026-01-02' },
      identity_facts_basis: 'MATERIALIZER_REDERIVED',
      verdict_and_findings_basis: 'RECERTIFIER_REPORTED_SECOND_HAND',
      materializer_reproduced_recert_evidence: false,
    },
    chain: { predecessor: null },
    authority_class: C(auth).occurrence_schema.authority_class,
    authorizes: [],
    meaning: C(auth).meaning,
  }
}

function ctxFor(r: Occurrence, over: Partial<Ctx> = {}, auth: V103 = AUTH): Ctx {
  const sha = r.subject?.candidate_sha ?? ''
  const ks = auth.SECTION_D10_KNOWN_SUBJECTS.subjects.find((k) => k.candidate_sha === sha) ?? null
  return {
    mode: 'write',
    contract: C(auth),
    knownSubjects: auth.SECTION_D10_KNOWN_SUBJECTS.subjects,
    contractPath: PATHS.v103,
    contractBlob: CONTRACT_BLOB,
    occurrencePath: occurrencePathFor(C(auth), r.subject_kind, sha),
    derived: ks ? identityOf(ks) : clone(r.subject),
    target: ks?.id ?? null,
    existing: [],
    unchangedSinceWrite: true,
    ...over,
  }
}
/** A consumer's read context for a single stored occurrence. */
const readCtxFor = (r: Occurrence, over: Partial<Ctx> = {}): Ctx =>
  ctxFor(r, { mode: 'read', existing: [{ path: occurrencePathFor(C(), r.subject_kind, r.subject.candidate_sha), record: r }], ...over })

/** Re-key a fixture to another candidate SHA, consistently (path, id, recert binding). */
function rekey(r: Occurrence, sha: string): Occurrence {
  const x = clone(r)
  x.subject.candidate_sha = sha
  x.package_id = packageIdFor(C(), x.subject_kind, sha)
  x.provenance.independent_recertifier.examined_candidate_sha = sha
  return x
}
const FAKE_SHA = 'f'.repeat(40)
const FAKE_SHA_2 = 'e'.repeat(40)
const B_PRESENT = hasCommit(KS_B.candidate_sha)

/* ========================================================================== */
/* §1 subject identity: the known subjects recompute                          */
/* ========================================================================== */

describe('§1 SUBJECT_IDENTITY of the known subjects', () => {
  it('both known subjects record a package_digest that recomputes from their own entries, and derived path/id', () => {
    for (const ks of [KS_A, KS_B]) {
      expect(ks.digest_algorithm).toBe('RCO_CLOSURE_DIGEST_V1')
      expect(digestOf(ks.entries)).toBe(ks.package_digest)
      expect(ks.occurrence_path).toBe(occurrencePathFor(C(), ks.subject_kind, ks.candidate_sha))
      expect(ks.package_id).toBe(packageIdFor(C(), ks.subject_kind, ks.candidate_sha))
    }
    expect([entriesOf(KS_A, 'COVERED'), entriesOf(KS_A, 'IMPORTED'), entriesOf(KS_A, 'GOVERNING')].map((x) => x.length)).toEqual([6, 0, 12])
    expect([entriesOf(KS_B, 'COVERED'), entriesOf(KS_B, 'IMPORTED'), entriesOf(KS_B, 'GOVERNING')].map((x) => x.length)).toEqual([39, 7, 4])
  })

  it('KS-A (census, #209 ab7fb64b) recomputes EXACTLY from git at its candidate commit (an ancestor of this lineage)', () => {
    if (!hasCommit(KS_A.candidate_sha)) throw new Error(`KS-A candidate ${KS_A.candidate_sha} is not present; it is an ancestor of this lineage`)
    expect(gitText('rev-parse', `${KS_A.candidate_sha}^{tree}`)).toBe(KS_A.tree_sha)
    expect(deriveIdentity(C(), KS_A.subject_kind, KS_A.candidate_sha, KS_A.tree_sha, commitView(KS_A.candidate_sha))).toEqual(identityOf(KS_A))
  }, GIT_TIMEOUT)

  it('KS-B candidate availability: required in CI (fetch-depth 0), reported locally', () => {
    if (process.env.CI) expect(B_PRESENT, `KS-B candidate ${KS_B.candidate_sha} must be fetchable in CI`).toBe(true)
  })

  it.runIf(B_PRESENT)('KS-B (offline, #220 8cf94dca) recomputes EXACTLY from git at its candidate commit, imports included', () => {
    expect(gitText('rev-parse', `${KS_B.candidate_sha}^{tree}`)).toBe(KS_B.tree_sha)
    expect(deriveIdentity(C(), KS_B.subject_kind, KS_B.candidate_sha, KS_B.tree_sha, commitView(KS_B.candidate_sha))).toEqual(identityOf(KS_B))
    expect(pathsOf(entriesOf(KS_B, 'IMPORTED'))).toContain('scripts/db-audit-disposable.ts')
  }, GIT_TIMEOUT)

  it('a dangling governing reference, or an unresolvable repository import, fails the derivation', () => {
    const base = successorView()
    const censusFile = pathsOf(entriesOf(KS_A, 'COVERED'))[0]
    const dangling = patchedView(base, { [censusFile]: { blob: '1'.repeat(40), text: 'see docs/ops/release/NO_SUCH_AUTHORITY_v9.9.9.json' } })
    expect(deriveIdentity(C(), KS_A.subject_kind, KS_A.candidate_sha, KS_A.tree_sha, dangling)).toMatch(/^dangling /)
    const withCode = patchedView(base, { 'scripts/recovery/probe.ts': { blob: '2'.repeat(40), text: "import { x } from '../missing-module'" } })
    expect(deriveIdentity(C(), KS_B.subject_kind, KS_B.candidate_sha, KS_B.tree_sha, withCode)).toMatch(/^unresolved import /)
  }, GIT_TIMEOUT)
})

/* ========================================================================== */
/* §2 positive occurrences                                                    */
/* ========================================================================== */

describe('§2 a well-formed occurrence validates, and means only what the contract says', () => {
  it('KS-A and KS-B fixture occurrences are VALID at write time and at read time', () => {
    for (const ks of [KS_A, KS_B]) {
      const r = fixtureOccurrence(ks)
      expect(validate(r, ctxFor(r)), ks.id).toBe('VALID')
      expect(validate(r, readCtxFor(r)), ks.id).toBe('VALID')
    }
  })
  it('a PASS verdict with zero nonblocking findings is VALID', () => {
    const r = fixtureOccurrence(KS_A)
    r.verdict = { ...r.verdict, verdict_class: 'PASS', verdict_literal: 'STAGING_RECOVERY_RECERT_PASS', nonblocking_findings_reported_count: 0 }
    r.nonblocking_findings = []
    expect(validate(r, ctxFor(r))).toBe('VALID')
  })
  it('the two literals reported for KS-A and KS-B, and a minimal RECERT_PASS, parse to their class', () => {
    expect(parseVerdictLiteral(C().verdict, 'RECERT_PASS')).toBe('PASS')
    for (const l of ['CENSUS_V102_RECERT_PASS_WITH_NONBLOCKING_FINDINGS', 'STAGING_RECOVERY_OFFLINE_FOCUSED_RECERT_PASS_WITH_NONBLOCKING_FINDINGS'])
      expect(parseVerdictLiteral(C().verdict, l)).toBe('PASS_WITH_NONBLOCKING_FINDINGS')
  })
  it('an occurrence authorizes nothing: a non-empty authorizes, another class or meaning STOPS', () => {
    for (const mutate of [
      (r: Occurrence) => { r.authorizes = ['HC-2-A'] },
      (r: Occurrence) => { r.authority_class = 'EXECUTION_AUTHORITY' },
      (r: Occurrence) => { r.meaning = `${r.meaning} Execution may proceed.` },
    ]) {
      const r = fixtureOccurrence(KS_A)
      mutate(r)
      expect(validate(r, ctxFor(r))).toBe('STOP_OCCURRENCE_CLAIMS_AUTHORITY')
    }
  })
})

/* ========================================================================== */
/* §3 negative controls (the brief's falsification list)                      */
/* ========================================================================== */

describe('§3 falsification', () => {
  it('wrong subject SHA STOPS (against the known subject, and against the derivation)', () => {
    const r = rekey(fixtureOccurrence(KS_A), FAKE_SHA)
    expect(validate(r, ctxFor(r, { target: 'KS-A' }))).toBe('STOP_CANDIDATE_SHA_MISMATCH')
    expect(validate(r, ctxFor(r, { target: null, derived: 'candidate not readable' }))).toBe('STOP_CANDIDATE_SHA_MISMATCH')
  })

  it('same tree / wrong commit STOPS: commit identity binds, tree equality never substitutes', () => {
    const r = rekey(fixtureOccurrence(KS_A), FAKE_SHA)
    expect(r.subject.tree_sha).toBe(KS_A.tree_sha)
    expect(validate(r, ctxFor(r, { target: 'KS-A' }))).toBe('STOP_CANDIDATE_SHA_MISMATCH')
    r.provenance.independent_recertifier.examined_candidate_sha = KS_A.candidate_sha
    expect(validate(r, ctxFor(r, { target: null, derived: clone(r.subject) }))).toBe('STOP_RECERT_SUBJECT_MISMATCH')
    // A tree id offered as the candidate never derives: a commit never equals its own tree.
    const asTree = rekey(fixtureOccurrence(KS_A), KS_A.tree_sha)
    expect(validate(asTree, ctxFor(asTree, { target: null, derived: clone(asTree.subject) }))).toBe('STOP_CANDIDATE_SHA_MISMATCH')
  })

  it('wrong tree STOPS', () => {
    const r = fixtureOccurrence(KS_A)
    r.subject.tree_sha = '0'.repeat(40)
    r.provenance.independent_recertifier.examined_tree_sha = r.subject.tree_sha
    expect(validate(r, ctxFor(r))).toBe('STOP_TREE_SHA_MISMATCH')
    expect(validate(r, ctxFor(r, { target: null }))).toBe('STOP_TREE_SHA_MISMATCH')
  })

  it('wrong package digest STOPS', () => {
    const r = fixtureOccurrence(KS_A)
    r.subject.package_digest = '0'.repeat(64)
    expect(validate(r, ctxFor(r))).toBe('STOP_PACKAGE_DIGEST_MISMATCH')
    expect(validate(r, ctxFor(r, { target: null }))).toBe('STOP_PACKAGE_DIGEST_MISMATCH')
  })

  it('wrong authority pin STOPS even when the digest is recomputed to match it', () => {
    const r = fixtureOccurrence(KS_B)
    const g = r.subject.entries.find((e) => e.role === 'GOVERNING')
    if (!g) throw new Error('no governing entry')
    g.blob = '1'.repeat(40)
    r.subject.package_digest = digestOf(r.subject.entries)
    expect(validate(r, ctxFor(r))).toBe('STOP_GOVERNING_PIN_MISMATCH')
    expect(validate(r, ctxFor(r, { target: null, derived: identityOf(KS_B) }))).toBe('STOP_GOVERNING_PIN_MISMATCH')
  })

  it('an IMPORTED module omitted or changed STOPS', () => {
    const omitted = fixtureOccurrence(KS_B)
    omitted.subject.entries = omitted.subject.entries.filter((e) => e.role !== 'IMPORTED')
    omitted.subject.package_digest = digestOf(omitted.subject.entries)
    expect(validate(omitted, ctxFor(omitted))).toBe('STOP_COVERED_SET_MISMATCH')
    expect(validate(omitted, ctxFor(omitted, { target: null, derived: identityOf(KS_B) }))).toBe('STOP_COVERED_SET_MISMATCH')
  })

  it('blocking_findings > 0 STOPS, by count or by list', () => {
    const r1 = fixtureOccurrence(KS_A)
    r1.verdict.blocking_findings_count = 1
    expect(validate(r1, ctxFor(r1))).toBe('STOP_BLOCKING_FINDINGS_PRESENT')
    const r2 = fixtureOccurrence(KS_A)
    r2.verdict.blocking_findings = [{ id: 'B-1' }]
    expect(validate(r2, ctxFor(r2))).toBe('STOP_BLOCKING_FINDINGS_PRESENT')
  })

  it('a FAIL, BLOCKED or INSUFFICIENT_EVIDENCE result is never promotable, under any presentation', () => {
    for (const cls of ['FAIL', 'BLOCKED', 'INSUFFICIENT_EVIDENCE']) {
      const r = fixtureOccurrence(KS_A)
      r.verdict = { ...r.verdict, verdict_class: cls, verdict_literal: `CENSUS_RECERT_${cls}`, nonblocking_findings_reported_count: 0 }
      r.nonblocking_findings = []
      expect(validate(r, ctxFor(r))).toBe('STOP_VERDICT_NOT_PROMOTABLE')
    }
    for (const literal of [
      'CENSUS_RECERT_FAIL',
      'CENSUS_RECERT_FAIL_PASS',
      'CENSUS_FAIL_RECERT_PASS_WITH_NONBLOCKING_FINDINGS',
      'CENSUS_RECERT_BLOCKED',
      'CENSUS_RECERT_INSUFFICIENT_EVIDENCE',
      'CENSUS_RECERT_PASS_WITH_PROGRAM_BLOCKERS',
      'CENSUS_RECERT_WITH_BLOCKERS_PASS',
      'CENSUS_BLOCKING_RECERT_PASS',
      'CENSUS_RECERT_FAILED_PASS',
      'CENSUS_RECERT_NOT_PASS',
      'CENSUS_RECERT_NO_PASS',
      'CENSUS_CONDITIONAL_PASS',
      'CENSUS_RECERT_REVOKED_PASS',
      'CENSUS_RECERT_INCOMPLETE_PASS',
      'CENSUS_NOT_RECERT_PASS',
      'CENSUS_DID_NOT_PASS_WITH_NONBLOCKING_FINDINGS',
      'CENSUS_CONDITIONAL_RECERT_PASS',
      'CENSUS_WITHDRAWN_RECERT_PASS',
      'CENSUS_ABORTED_RECERT_PASS',
      'CENSUS_REJECTED_IC_PASS',
      'CENSUS_INVALID_CERT_PASS',
      'CENSUS_NON_RECERT_PASS',
      'CENSUS_UNSUCCESSFUL_REVIEW_PASS',
      'CENSUS_V102_RECERT_V103_PASS',
      'census_recert_pass',
      'PASS',
    ]) {
      const r = fixtureOccurrence(KS_A)
      r.verdict = { ...r.verdict, verdict_class: 'PASS', verdict_literal: literal, nonblocking_findings_reported_count: 0 }
      r.nonblocking_findings = []
      expect(validate(r, ctxFor(r)), literal).toBe('STOP_VERDICT_LITERAL_MISMATCH')
    }
    const r = fixtureOccurrence(KS_A)
    r.verdict.verdict_literal = 'STAGING_RECOVERY_RECERT_PASS'
    expect(validate(r, ctxFor(r))).toBe('STOP_VERDICT_LITERAL_MISMATCH')
  })

  it('a missing nonblocking finding STOPS; so does a PASS_WITH_NONBLOCKING_FINDINGS with none, a PASS with some, a duplicate or non-string id', () => {
    const cases: ((r: Occurrence) => void)[] = [
      (r) => { r.nonblocking_findings.pop() },
      (r) => { r.nonblocking_findings = []; r.verdict.nonblocking_findings_reported_count = 0 },
      (r) => { r.verdict = { ...r.verdict, verdict_class: 'PASS', verdict_literal: 'STAGING_RECOVERY_RECERT_PASS' } },
      (r) => { r.nonblocking_findings[1].id = r.nonblocking_findings[0].id },
      (r) => { (r.nonblocking_findings[0] as unknown as Record<string, unknown>).id = 7 },
    ]
    for (const f of cases) {
      const r = fixtureOccurrence(KS_A)
      f(r)
      expect(validate(r, ctxFor(r))).toBe('STOP_NONBLOCKING_FINDINGS_INCOMPLETE')
    }
  })

  it('a nonblocking finding recorded as anything but OPEN STOPS', () => {
    const r = fixtureOccurrence(KS_A)
    r.nonblocking_findings[0].status = 'CLOSED'
    expect(validate(r, ctxFor(r))).toBe('STOP_FINDING_NOT_OPEN')
  })

  it('materializer == author, recertifier == author, materializer == recertifier, or a non-string lane STOP', () => {
    const cases: ['materializer' | 'independent_recertifier', unknown][] = [
      ['materializer', ' fixture-author-lane '],
      ['independent_recertifier', 'FIXTURE-AUTHOR-LANE'],
      ['materializer', 'fixture-recert-lane'],
      ['materializer', 42],
    ]
    for (const [role, lane] of cases) {
      const r = fixtureOccurrence(KS_A)
      ;(r.provenance[role] as unknown as Record<string, unknown>).lane_id = lane
      expect(validate(r, ctxFor(r)), `${role}=${String(lane)}`).toBe('STOP_PROVENANCE_NOT_INDEPENDENT')
    }
  })

  it('an undeclared recert scope or an empty report reference STOPS', () => {
    const r1 = fixtureOccurrence(KS_A)
    r1.provenance.independent_recertifier.scope = 'WHOLE_PROGRAM'
    expect(validate(r1, ctxFor(r1))).toBe('STOP_RECERT_SCOPE_UNDECLARED')
    const r2 = fixtureOccurrence(KS_A)
    r2.provenance.independent_recertifier.report_reference = ' '
    expect(validate(r2, ctxFor(r2))).toBe('STOP_RECERT_SCOPE_UNDECLARED')
  })

  it('a materializer claiming to have reproduced the recert evidence STOPS', () => {
    const r1 = fixtureOccurrence(KS_A)
    r1.provenance.materializer_reproduced_recert_evidence = true
    expect(validate(r1, ctxFor(r1))).toBe('STOP_MATERIALIZER_REPRODUCTION_CLAIM')
    const r2 = fixtureOccurrence(KS_A)
    r2.provenance.verdict_and_findings_basis = 'MATERIALIZER_REPRODUCED'
    expect(validate(r2, ctxFor(r2))).toBe('STOP_MATERIALIZER_REPRODUCTION_CLAIM')
  })

  it('an event path reused for a new candidate STOPS, and an existing path is never overwritten', () => {
    const a = fixtureOccurrence(KS_A)
    const later = rekey(a, FAKE_SHA)
    const pathA = occurrencePathFor(C(), a.subject_kind, a.subject.candidate_sha)
    expect(validate(later, ctxFor(later, { target: null, derived: clone(later.subject), occurrencePath: pathA }))).toBe('STOP_OCCURRENCE_PATH_IDENTITY_MISMATCH')
    const reusedId = clone(later)
    reusedId.package_id = a.package_id
    expect(validate(reusedId, ctxFor(reusedId, { target: null, derived: clone(later.subject) }))).toBe('STOP_OCCURRENCE_PATH_IDENTITY_MISMATCH')
    expect(validate(a, ctxFor(a, { existing: [{ path: pathA, record: a }] }))).toBe('STOP_OCCURRENCE_PATH_EXISTS')
  })

  it('an unknown subject kind STOPS, including OTHER', () => {
    for (const kind of ['OTHER', 'READONLY_CENSUS_EXECUTION', 'RECOVERY_AUTHORITY_PACKAGE_RECERT', '']) {
      const r = fixtureOccurrence(KS_A)
      r.subject_kind = kind
      expect(validate(r, ctxFor(r)), kind).toBe('STOP_UNKNOWN_SUBJECT_KIND')
    }
  })

  it('a census occurrence bound to the offline subject STOPS, and vice versa', () => {
    const censusOnOffline = fixtureOccurrence(KS_B)
    censusOnOffline.subject_kind = 'READONLY_CENSUS_AUTHORITY_RECERT'
    censusOnOffline.package_id = packageIdFor(C(), censusOnOffline.subject_kind, KS_B.candidate_sha)
    expect(validate(censusOnOffline, ctxFor(censusOnOffline))).toBe('STOP_SUBJECT_KIND_MISMATCH')
    const offlineOnCensus = fixtureOccurrence(KS_A)
    offlineOnCensus.subject_kind = 'OFFLINE_RECOVERY_IMPLEMENTATION_RECERT'
    offlineOnCensus.package_id = packageIdFor(C(), offlineOnCensus.subject_kind, KS_A.candidate_sha)
    expect(validate(offlineOnCensus, ctxFor(offlineOnCensus))).toBe('STOP_SUBJECT_KIND_MISMATCH')
    const r = fixtureOccurrence(KS_A)
    expect(validate(r, ctxFor(r, { target: 'KS-B' }))).toBe('STOP_SUBJECT_KIND_MISMATCH')
  })

  it('shape and contract binding: extra, missing or nested extra key, unknown role, wrong contract blob, malformed SHA STOP', () => {
    const shapes: ((r: Occurrence) => void)[] = [
      (r) => { (r as unknown as Record<string, unknown>).executable = true },
      (r) => { delete (r as Partial<Occurrence>).closes_predecessor_findings },
      (r) => { (r.subject as unknown as Record<string, unknown>).execution_grant = 'HC-3' },
      (r) => { (r.provenance.independent_recertifier as unknown as Record<string, unknown>).reproduced_by_materializer = true },
      (r) => { (r.subject.entries[0] as unknown as Record<string, unknown>).role = 'EXEMPT' },
      (r) => { (r as unknown as Record<string, unknown>).subject = null },
      (r) => { r.chain.predecessor = { path: 'p', candidate_sha: FAKE_SHA, package_digest: 'd', extra: 1 } as unknown as Occurrence['chain']['predecessor'] },
    ]
    for (const f of shapes) {
      const r = fixtureOccurrence(KS_A)
      f(r)
      expect(validate(r, ctxFor(r))).toBe('STOP_OCCURRENCE_SHAPE')
    }
    const wrongBlob = fixtureOccurrence(KS_A)
    wrongBlob.occurrence_contract.blob = gitBlobSha(Buffer.from('another contract'))
    expect(validate(wrongBlob, ctxFor(wrongBlob))).toBe('STOP_OCCURRENCE_CONTRACT_MISMATCH')
    const malformed = rekey(fixtureOccurrence(KS_A), 'ABC')
    expect(validate(malformed, ctxFor(malformed, { target: null }))).toBe('STOP_CANDIDATE_SHA_MALFORMED')
  })
})

/* ========================================================================== */
/* §4 chain                                                                   */
/* ========================================================================== */

describe('§4 chain: repeated certification of the same subject kind', () => {
  const first = fixtureOccurrence(KS_A)
  const firstPath = occurrencePathFor(C(), first.subject_kind, first.subject.candidate_sha)
  const successorOf = (pred: Occurrence, predPath: string, sha: string): Occurrence => {
    const r = rekey(pred, sha)
    r.chain.predecessor = { path: predPath, candidate_sha: pred.subject.candidate_sha, package_digest: pred.subject.package_digest }
    return r
  }
  const ctxLater = (r: Occurrence, existing: Ctx['existing']): Ctx => ctxFor(r, { target: null, derived: clone(r.subject), existing })

  it("a later candidate naming the tip as predecessor is VALID and may close the predecessor's findings", () => {
    const r = successorOf(first, firstPath, FAKE_SHA)
    r.closes_predecessor_findings = ['FIX-NB-1']
    expect(validate(r, ctxLater(r, [{ path: firstPath, record: first }]))).toBe('VALID')
  })
  it('a later candidate that ignores the existing chain (predecessor null) STOPS', () => {
    const r = rekey(first, FAKE_SHA)
    expect(validate(r, ctxLater(r, [{ path: firstPath, record: first }]))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
  })
  it('a predecessor that is not the tip STOPS at write time; a forked chain is INVALID at read time', () => {
    const second = successorOf(first, firstPath, FAKE_SHA)
    const secondPath = occurrencePathFor(C(), second.subject_kind, FAKE_SHA)
    const third = successorOf(first, firstPath, FAKE_SHA_2)
    const thirdPath = occurrencePathFor(C(), third.subject_kind, FAKE_SHA_2)
    expect(validate(third, ctxLater(third, [{ path: firstPath, record: first }, { path: secondPath, record: second }]))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
    // Two materializers raced: both second and third name first. Read time sees two tips.
    const forked = [{ path: firstPath, record: first }, { path: secondPath, record: second }, { path: thirdPath, record: third }]
    expect(validate(first, ctxFor(first, { mode: 'read', existing: forked }))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
  })
  it('a first occurrence that names a predecessor STOPS', () => {
    const r = fixtureOccurrence(KS_A)
    r.chain.predecessor = { path: firstPath, candidate_sha: FAKE_SHA, package_digest: r.subject.package_digest }
    expect(validate(r, ctxFor(r))).toBe('STOP_CHAIN_PREDECESSOR_MISMATCH')
  })
  it('closing a finding the predecessor does not carry, or closing without a predecessor, STOPS', () => {
    const r = successorOf(first, firstPath, FAKE_SHA)
    r.closes_predecessor_findings = ['NOT-A-FINDING']
    expect(validate(r, ctxLater(r, [{ path: firstPath, record: first }]))).toBe('STOP_FINDING_CLOSURE_INVALID')
    const self = fixtureOccurrence(KS_A)
    self.closes_predecessor_findings = ['FIX-NB-1']
    expect(validate(self, ctxFor(self))).toBe('STOP_FINDING_CLOSURE_INVALID')
  })
  it("occurrences of another kind do not form this kind's chain", () => {
    const b = fixtureOccurrence(KS_B)
    const bPath = occurrencePathFor(C(), b.subject_kind, b.subject.candidate_sha)
    const a = fixtureOccurrence(KS_A)
    expect(validate(a, ctxFor(a, { existing: [{ path: bPath, record: b }] }))).toBe('VALID')
  })
  it('at read time an earlier occurrence that is no longer the tip, and its own existing path, are not errors (V11 is write-only)', () => {
    const second = successorOf(first, firstPath, FAKE_SHA)
    const secondPath = occurrencePathFor(C(), second.subject_kind, FAKE_SHA)
    const existing = [{ path: firstPath, record: first }, { path: secondPath, record: second }]
    expect(validate(first, ctxFor(first, { mode: 'read', existing }))).toBe('VALID')
  })
})

/* ========================================================================== */
/* §5 currency / invalidation (against the fixed introducing tree)           */
/* ========================================================================== */

describe('§5 currency: what invalidates an occurrence, and what does not', () => {
  const a = fixtureOccurrence(KS_A)
  const b = fixtureOccurrence(KS_B)
  const cur = (r: Occurrence, v: View, over: Partial<Ctx> = {}): string => currency(C(), r, v, readCtxFor(r, over))

  it('KS-A is CURRENT at the introducing tree: the only new governing-family members are the declared layers', () => {
    expect(cur(a, successorView())).toBe('CURRENT')
  }, GIT_TIMEOUT)
  it('KS-B is SUBJECT_NOT_PRESENT at the introducing tree: PR #220 is not merged', () => {
    expect(cur(b, successorView())).toBe('SUBJECT_NOT_PRESENT')
    expect(AUTH.SECTION_D1_LINEAGE_INTEGRATION.merge.pr220_merged).toBe(false)
  }, GIT_TIMEOUT)
  it('a later commit OUTSIDE the subject does not invalidate it', () => {
    const v = patchedView(successorView(), {
      'docs/ops/release/SOME_UNRELATED_AUTHORITY_v1.0.0.json': { blob: 'a'.repeat(40) },
      'docs/ops/commercial/UNRELATED_NOTES.md': { blob: 'b'.repeat(40) },
    })
    expect(cur(a, v)).toBe('CURRENT')
  }, GIT_TIMEOUT)
  it('a covered-path change makes it STALE', () => {
    const covered = pathsOf(entriesOf(a.subject, 'COVERED'))[2]
    expect(cur(a, patchedView(successorView(), { [covered]: { blob: 'c'.repeat(40), text: '{}' } }))).toBe('STALE_COVERED_PATH_CHANGED')
  }, GIT_TIMEOUT)
  it('a new census layer changes the covered set and makes it STALE; census execution evidence does not', () => {
    const errata = patchedView(successorView(), { 'docs/ops/release/STAGING_QUIESCE_READONLY_CENSUS_AUTHORITY_ERRATA_v1.0.3.json': { blob: 'd'.repeat(40), text: '{}' } })
    expect(cur(a, errata)).toBe('STALE_COVERED_SET_CHANGED')
    const evidence = patchedView(successorView(), { 'docs/ops/release/STAGING_QUIESCE_READONLY_CENSUS_EVIDENCE_2026-10-01.json': { blob: 'd'.repeat(40), text: '{}' } })
    expect(cur(a, evidence)).toBe('CURRENT')
  }, GIT_TIMEOUT)
  it('a governing-authority change, or a changed recorded family member, makes it STALE', () => {
    const g = pathsOf(entriesOf(a.subject, 'GOVERNING'))[0]
    expect(cur(a, patchedView(successorView(), { [g]: { blob: 'e'.repeat(40) } }))).toBe('STALE_GOVERNING_AUTHORITY_CHANGED')
    const nonGoverningMember = a.subject.governing_family_members_at_candidate.find((m) => !pathsOf(entriesOf(a.subject, 'GOVERNING')).includes(m.path))
    if (!nonGoverningMember) throw new Error('expected a non-governing family member')
    expect(cur(a, patchedView(successorView(), { [nonGoverningMember.path]: { blob: 'e'.repeat(40) } }))).toBe('STALE_GOVERNING_AUTHORITY_CHANGED')
  }, GIT_TIMEOUT)
  it('an undeclared new governing layer, or a declared layer edited in place, makes it STALE (fail closed)', () => {
    expect(cur(a, patchedView(successorView(), { 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.4.json': { blob: 'f'.repeat(40) } }))).toBe('STALE_GOVERNING_LAYER_ADDED')
    expect(cur(a, patchedView(successorView(), { [PATHS.ownerV101]: { blob: 'f'.repeat(40) } }))).toBe('STALE_GOVERNING_AUTHORITY_CHANGED')
  }, GIT_TIMEOUT)
  it('an in-place edit of the contract, or of the occurrence file, makes it INVALID_AT_READ', () => {
    expect(cur(a, successorView(), { contractBlob: '9'.repeat(40) })).toBe('INVALID_AT_READ:STOP_OCCURRENCE_CONTRACT_MISMATCH')
    expect(cur(a, successorView(), { unchangedSinceWrite: false })).toBe('INVALID_AT_READ:STOP_OCCURRENCE_EDITED_AFTER_WRITE')
  }, GIT_TIMEOUT)
  it.runIf(B_PRESENT)('KS-B would be CURRENT at a head that merges #220 unchanged; STALE if a recovery test is added or an imported module changes', () => {
    const covered = pathsOf(entriesOf(b.subject, 'COVERED'))
    const texts = commitView(KS_B.candidate_sha).texts(covered)
    const merged = patchedView(successorView(), Object.fromEntries(entriesOf(b.subject, 'COVERED').map((e) => [e.path, { blob: e.blob, text: texts.get(e.path) ?? '' }])))
    expect(cur(b, merged)).toBe('CURRENT')
    expect(cur(b, patchedView(merged, { 'tests/recovery/new-probe.test.ts': { blob: '9'.repeat(40), text: '' } }))).toBe('STALE_COVERED_SET_CHANGED')
    expect(cur(b, patchedView(merged, { 'scripts/db-audit-disposable.ts': { blob: '8'.repeat(40), text: successorView().texts(['scripts/db-audit-disposable.ts']).get('scripts/db-audit-disposable.ts') ?? '' } }))).toBe('STALE_COVERED_PATH_CHANGED')
  }, GIT_TIMEOUT)
})

/* ========================================================================== */
/* §6 contract invariants                                                     */
/* ========================================================================== */

describe('§6 contract invariants', () => {
  it('the subject-kind enum is exactly the two known subjects, with no OTHER; prefixes are disjoint', () => {
    expect(Object.keys(C().subject_kinds.kinds).sort()).toEqual(['OFFLINE_RECOVERY_IMPLEMENTATION_RECERT', 'READONLY_CENSUS_AUTHORITY_RECERT'])
    const [x, y] = Object.values(C().subject_kinds.kinds).map((k) => k.covered_path_prefixes)
    expect(x.some((p) => y.some((q) => p.startsWith(q) || q.startsWith(p)))).toBe(false)
  })
  it('positive classes are exactly PASS and PASS_WITH_NONBLOCKING_FINDINGS', () => {
    expect([...C().verdict.positive_classes].sort()).toEqual(['PASS', 'PASS_WITH_NONBLOCKING_FINDINGS'])
    expect(C().verdict.verdict_classes).toEqual(['PASS', 'PASS_WITH_NONBLOCKING_FINDINGS', 'FAIL', 'BLOCKED', 'INSUFFICIENT_EVIDENCE'])
  })
  it('the stop codes of validation_order, stop_codes and this interpreter are the same set', () => {
    const fromOrder = new Set(C().validation_order.join(' ').match(/STOP_[A-Z_]+/g) ?? [])
    const declared = new Set(C().stop_codes)
    expect([...fromOrder].sort()).toEqual([...declared].sort())
    const src = readBytes(PATHS.self).toString('utf8')
    const block = src.slice(src.indexOf('const CHECKS'), src.indexOf('function validate('))
    const emitted = new Set([...block.matchAll(/'(STOP_[A-Z_]+)'/g)].map((m) => m[1]))
    expect([...emitted].sort()).toEqual([...declared].sort())
  })
  it('declared_non_invalidating layers are EXACTLY the governing-family members added since each known candidate, with their blobs', () => {
    const v = successorView()
    for (const ks of [KS_A, KS_B]) {
      const recorded = new Set(pathsOf(ks.governing_family_members_at_candidate))
      const added = v.list().filter((p) => ks.governing_families.some((f) => p.startsWith(f)) && !recorded.has(p)).sort(byteOrder)
      const declared = C().currency.declared_non_invalidating_governing_layers[ks.subject_kind] as DeclaredLayer[]
      expect(pathsOf(declared).sort(byteOrder), ks.id).toEqual(added)
      for (const d of declared) expect(d.blob, d.path).toBe(d.path === PATHS.v103 ? null : v.blob(d.path))
    }
  }, GIT_TIMEOUT)
  it('the first authorized materialization paths are exactly the two known occurrence paths, absent from the introducing tree', () => {
    expect(AUTH.SECTION_D11_MATERIALIZATION_WRITE_SET.first_authorized_paths_after_recert_of_this_artifact).toEqual([KS_A.occurrence_path, KS_B.occurrence_path])
    const root = C().path_and_identity.occurrence_root
    expect(successorView().list().filter((p) => p.startsWith(root))).toEqual([])
  }, GIT_TIMEOUT)
})

/* ========================================================================== */
/* §7 cross-lineage precedence                                                */
/* ========================================================================== */

const DOMAINS = ['RECOVERY', 'CENSUS', 'QUIESCE']
const CENSUS_RULE_ID = /^(G-N\d|G-U\d|A-\d)$/

function resolvePrecedence(auth: V103, topic: string): string {
  const d = auth.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation[topic]
  return d !== undefined && DOMAINS.includes(d) && auth.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.internal_precedence[d] ? d : 'STOP'
}

function precedenceViolations(auth: V103): string[] {
  const v: string[] = []
  const d2 = auth.SECTION_D2_CROSS_LINEAGE_PRECEDENCE
  if (Object.keys(d2.internal_precedence).sort().join() !== [...DOMAINS].sort().join()) v.push('domains')
  for (const [topic, dom] of Object.entries(d2.topic_allocation)) if (!DOMAINS.includes(dom)) v.push(`unallocated:${topic}`)
  for (const [dom, p] of Object.entries(d2.internal_precedence))
    for (const f of p.order_highest_first) if (!existsSync(path.join(ROOT, f))) v.push(`missing:${dom}:${f}`)
  if (d2.topic_allocation.CENSUS_CLASSIFICATION_PROCEDURE_G_N_A_G_U !== 'CENSUS') v.push('census-rules-not-census')
  if (d2.topic_allocation.CENSUS_EXECUTION_GATE_CERTIFICATION_AND_HCC_1 !== 'CENSUS') v.push('census-gate-not-census')
  if (d2.topic_allocation.QUIESCE_WRITER_INVENTORY_W_1_TO_W_16 !== 'QUIESCE') v.push('quiesce-inventory-not-quiesce')
  if (d2.topic_allocation.OD_Q5_AND_ANY_OWNER_READJUDICATION_OF_OD_3 !== 'RECOVERY') v.push('od3-not-recovery')
  for (const { topic } of d2.v1_0_2_C10_item_topics.items_in_order) if (resolvePrecedence(auth, topic) === 'STOP') v.push(`c10-item-unallocated:${topic}`)
  for (const s of auth.SECTION_D16_SUPERSEDED_LOCI) {
    if (!DOMAINS.includes(s.chain)) v.push(`locus-chain:${s.locus}`)
    if (resolvePrecedence(auth, s.topic) !== 'RECOVERY') v.push(`supersedes-non-recovery-topic:${s.topic}`)
  }
  // No census classification rule is restated anywhere in this amendment: an
  // object carrying such an id may hold nothing but the id and a statement.
  const walk = (x: unknown, at: string): void => {
    if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${at}[${i}]`))
    else if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>
      if (typeof o.id === 'string' && CENSUS_RULE_ID.test(o.id) && Object.keys(o).some((k) => k !== 'id' && k !== 'statement')) v.push(`redefines:${o.id}@${at}`)
      for (const [k, y] of Object.entries(o)) walk(y, `${at}.${k}`)
    }
  }
  walk(auth, '$')
  return v
}

describe('§7 cross-lineage precedence', () => {
  it('the real allocation has no violation, and every topic resolves to one domain', () => {
    expect(precedenceViolations(AUTH)).toEqual([])
    for (const t of Object.keys(AUTH.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation)) expect(resolvePrecedence(AUTH, t)).not.toBe('STOP')
  })
  it('every v1.0.2 SECTION_C10 disposition item maps, in order, to an allocated topic', () => {
    const v102 = readJson<{ SECTION_C10_OD_3_SUPERSESSION_AND_QUIESCE_CHAIN_DISPOSITION: { QUIESCE_CHAIN_DISPOSITION: { items: { item: string }[] } } }>(PATHS.v102)
    const items = v102.SECTION_C10_OD_3_SUPERSESSION_AND_QUIESCE_CHAIN_DISPOSITION.QUIESCE_CHAIN_DISPOSITION.items
    const mapped = AUTH.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.v1_0_2_C10_item_topics.items_in_order
    expect(mapped).toHaveLength(items.length)
    items.forEach((it, i) => expect(it.item.startsWith(mapped[i].item_prefix), it.item).toBe(true))
  })
  it('no topic key is written twice in the raw artifact (JSON.parse would silently keep the last)', () => {
    const raw = readBytes(PATHS.v103).toString('utf8')
    const block = raw.slice(raw.indexOf('"topic_allocation": {'), raw.indexOf('"v1_0_2_C10_item_topics"'))
    const keys = [...block.matchAll(/^\s+"([A-Z0-9_]+)":/gm)].map((m) => m[1])
    expect(keys.length).toBe(new Set(keys).size)
    expect(keys.length).toBe(Object.keys(AUTH.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation).length)
  })
  it('a topic nobody owns STOPS', () => {
    expect(resolvePrecedence(AUTH, 'SOME_UNALLOCATED_TOPIC')).toBe('STOP')
    const m = clone(AUTH)
    delete m.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation.STAGE_A_AND_S8_BLOCKING_STATUS
    expect(precedenceViolations(m)).toContain('c10-item-unallocated:STAGE_A_AND_S8_BLOCKING_STATUS')
  })
  it('precedence contradiction: the Recovery chain claiming the census rules or the census gate is RED', () => {
    const m = clone(AUTH)
    m.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation.CENSUS_CLASSIFICATION_PROCEDURE_G_N_A_G_U = 'RECOVERY'
    m.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation.CENSUS_EXECUTION_GATE_CERTIFICATION_AND_HCC_1 = 'RECOVERY'
    expect(precedenceViolations(m)).toEqual(expect.arrayContaining(['census-rules-not-census', 'census-gate-not-census']))
  })
  it('precedence contradiction: superseding a locus on a CENSUS topic is RED', () => {
    const m = clone(AUTH)
    m.SECTION_D16_SUPERSEDED_LOCI.push({ chain: 'CENSUS', topic: 'CENSUS_CLASSIFICATION_PROCEDURE_G_N_A_G_U', locus: 'census errata v1.0.1 SECTION_B7 G-N3' })
    expect(precedenceViolations(m)).toContain('supersedes-non-recovery-topic:CENSUS_CLASSIFICATION_PROCEDURE_G_N_A_G_U')
  })
  it('precedence contradiction: a topic allocated to an unknown or shared domain is RED', () => {
    const m = clone(AUTH)
    m.SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation.CENSUS_CF_1_DISPOSITION = 'RECOVERY+CENSUS'
    expect(precedenceViolations(m)).toEqual(expect.arrayContaining(['unallocated:CENSUS_CF_1_DISPOSITION', 'supersedes-non-recovery-topic:CENSUS_CF_1_DISPOSITION']))
  })
  it('silently weakening G-N3: any restated G-N/A/G-U rule, under any key name, is RED', () => {
    for (const extra of [{ condition: 'Auth healthy AND live sessions measured' }, { narrowed_trigger: 'occupancy only' }]) {
      const m = clone(AUTH) as unknown as Record<string, Record<string, unknown>>
      m.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY.G_N3_NARROWED = { id: 'G-N3', ...extra }
      expect(precedenceViolations(m as unknown as V103).some((x) => x.startsWith('redefines:G-N3'))).toBe(true)
    }
  })
  it('G-N3 in force is the census errata v1.0.1 condition, fired on Auth ACTIVE_HEALTHY alone', () => {
    const e = readJson<{ SECTION_B7_GN3_TOKEN_REFRESH_CORRECTION: { the_correction: { id: string; condition_v1_0_1: string } } }>(PATHS.censusV101)
    const c = e.SECTION_B7_GN3_TOKEN_REFRESH_CORRECTION.the_correction
    expect(c.id).toBe('G-N3')
    expect(c.condition_v1_0_1).toMatch(/ACTIVE_HEALTHY/)
    expect(c.condition_v1_0_1).not.toMatch(/sign-in|external_email_enabled/)
  })
})

/* ========================================================================== */
/* §8 LIVE guards on the working tree                                         */
/* ========================================================================== */

/** R1: null when never committed; otherwise the blob of the FIRST add, or 'DELETED_IN_HISTORY'. */
function introducingBlob(rel: string): string | null {
  if (gitText('log', '--diff-filter=D', '--format=%H', '--', rel) !== '') return 'DELETED_IN_HISTORY'
  const adds = gitText('log', '--diff-filter=A', '--format=%H', '--reverse', '--', rel).split('\n').filter(Boolean)
  return adds.length > 0 ? gitText('rev-parse', `${adds[0]}:${rel}`) : null
}

describe('§8 live guards: whatever later lanes add must stay valid', () => {
  it('every occurrence file present is at a derived path, valid at read time, unchanged since written, one tip per kind', () => {
    const wt = worktreeView()
    const root = C().path_and_identity.occurrence_root
    const files = wt.list().filter((p) => p.startsWith(root))
    const texts = wt.texts(files)
    const stored = files.map((p) => ({ path: p, record: JSON.parse(texts.get(p) ?? 'null') as Occurrence }))
    const headContractBlob = wt.blob(PATHS.v103) as string
    for (const { path: p, record } of stored) {
      expect(p, 'path').toBe(occurrencePathFor(C(), record.subject_kind, record.subject?.candidate_sha))
      const known = AUTH.SECTION_D10_KNOWN_SUBJECTS.subjects.find((k) => k.candidate_sha === record.subject.candidate_sha) ?? null
      const derived = known
        ? identityOf(known)
        : hasCommit(record.subject.candidate_sha)
          ? deriveIdentity(C(), record.subject_kind, record.subject.candidate_sha, gitText('rev-parse', `${record.subject.candidate_sha}^{tree}`), commitView(record.subject.candidate_sha))
          : 'candidate not readable'
      const added = introducingBlob(p)
      const ctx = ctxFor(record, {
        mode: 'read',
        occurrencePath: p,
        contractBlob: headContractBlob,
        derived,
        target: known?.id ?? null,
        existing: stored,
        unchangedSinceWrite: added === null || added === wt.blob(p),
      })
      expect(validate(record, ctx), p).toBe('VALID')
    }
  }, GIT_TIMEOUT)
  it('a KS-B occurrence evaluated at the working tree is never INVALID_AT_READ (STALE is legitimate; CURRENT at the merged head is the merge lane\'s own check)', () => {
    const wt = worktreeView()
    const b = fixtureOccurrence(KS_B)
    const result = currency(C(), b, wt, readCtxFor(b, { contractBlob: wt.blob(PATHS.v103) as string }))
    expect(C().currency_results).toContain(result)
    expect(result.startsWith('INVALID_AT_READ')).toBe(false)
  }, GIT_TIMEOUT)
})

/* ========================================================================== */
/* §9 Event A: reachability disclosed, policy pending                         */
/* ========================================================================== */

function eventAPolicyViolations(auth: V103): string[] {
  const v: string[] = []
  const p = auth.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY.EVENT_A_POLICY
  if (p.status !== 'PENDING') v.push('status')
  if (p.selected_option !== null) v.push('selected_option')
  if (p.decided_by !== null) v.push('decided_by')
  for (const o of p.options_surfaced_not_ratified) {
    if (o.selected !== false) v.push(`selected:${o.label}`)
    if (o.authorized_by_this_artifact !== false) v.push(`authorized:${o.label}`)
  }
  if (p.bounded_write_loss_for_event_A.authorized !== false) v.push('bounded_write_loss')
  return v
}

describe('§9 Event A', () => {
  const d8 = AUTH.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY
  it('the policy is PENDING, no option is selected, no bounded write loss is authorized', () => {
    expect(eventAPolicyViolations(AUTH)).toEqual([])
    expect(d8.EVENT_A_POLICY.options_surfaced_not_ratified.map((o) => o.label)).toEqual(['OPTION_A', 'OPTION_B', 'OPTION_C'])
  })
  it('an Event A policy silently selected is RED, in every form', () => {
    const forms: ((m: V103) => void)[] = [
      (m) => { m.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY.EVENT_A_POLICY.selected_option = 'OPTION_A' },
      (m) => { m.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY.EVENT_A_POLICY.status = 'DECIDED' },
      (m) => { m.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY.EVENT_A_POLICY.decided_by = 'writer' },
      (m) => { m.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY.EVENT_A_POLICY.options_surfaced_not_ratified[1].selected = true },
      (m) => { m.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY.EVENT_A_POLICY.options_surfaced_not_ratified[2].authorized_by_this_artifact = true },
      (m) => { m.SECTION_D8_EVENT_A_REACHABILITY_AND_POLICY.EVENT_A_POLICY.bounded_write_loss_for_event_A.authorized = true },
    ]
    for (const f of forms) {
      const m = clone(AUTH)
      f(m)
      expect(eventAPolicyViolations(m).length).toBeGreaterThan(0)
    }
  })
  it('CURRENT_EVENT_A_REACHABLE = NO; the first runtime blocker is the first Event A fact of the v1.0.2 registry', () => {
    expect(d8.CURRENT_EVENT_A_REACHABLE).toBe('NO')
    const v102 = readJson<{ SECTION_C4_EVENT_CLASS_REGISTRY: { classes: Record<string, { posture: string; required_facts: { id: string }[] }> } }>(PATHS.v102)
    const ea = v102.SECTION_C4_EVENT_CLASS_REGISTRY.classes.EVENT_A_INITIAL_CORPUS
    expect(d8.FIRST_RUNTIME_BLOCKER.id).toBe(ea.required_facts[0].id)
    expect(ea.posture).toBe('C3_EMPTY_WINDOW_BY_CONSTRUCTION')
  })
  it('the first structural blocker is G-N3, with G-N4 and DEP-C1 behind it, in census trigger order', () => {
    expect(d8.FIRST_STRUCTURAL_BLOCKER.id).toBe('G-N3')
    expect(d8.STRUCTURAL_BLOCKERS_BEHIND_G_N3.map((b) => b.id).slice(0, 2)).toEqual(['G-N4', 'DEP-C1'])
    const census = readJson<{ SECTION_G_C3_AVAILABILITY_DECISION_PROCEDURE: { C3_NOT_AVAILABLE: { triggers_any_one_of_which_suffices: { id: string }[] } } }>(PATHS.censusV100)
    expect(census.SECTION_G_C3_AVAILABILITY_DECISION_PROCEDURE.C3_NOT_AVAILABLE.triggers_any_one_of_which_suffices.map((t) => t.id)).toEqual([
      'G-N1', 'G-N2', 'G-N3', 'G-N4', 'G-N5', 'G-N6', 'G-N7',
    ])
  })
  it('the owner record v1.0.1 still carries the occupancy-worded condition verbatim', () => {
    expect(readJson<{ owner_decision_verbatim: string[] }>(PATHS.ownerV101).owner_decision_verbatim[7]).toBe('- governed census proves no client/writer is active;')
  })
})

/* ========================================================================== */
/* §10 history byte-identical; operations; write set                          */
/* ========================================================================== */

describe('§10 append-only history and write set', () => {
  const d1 = AUTH.SECTION_D1_LINEAGE_INTEGRATION
  const historical = [...d1.integrated_quiesce_and_census_package, ...d1.recovery_package_carried]

  it('every integrated and carried artifact recomputes to its pinned git blob id', () => {
    for (const h of historical) expect(gitBlobSha(storedBytes(h.path)), h.path).toBe(h.blob)
  })
  it('historical-artifact mutation: a single appended byte in any of them is RED', () => {
    for (const h of historical) expect(gitBlobSha(Buffer.concat([storedBytes(h.path), Buffer.from(' ')])), h.path).not.toBe(h.blob)
  })
  it('no Recovery, quiesce or census historical file of the introducing tree is missing from the pinned lists', () => {
    const present = successorView()
      .list()
      .filter((p) => /^docs\/ops\/(release\/STAGING_(RECOVERY_EXECUTION|QUIESCE)_|owner-ratifications\/STAGING_RECOVERY_OWNER_)/.test(p))
      .filter((p) => !WRITE_SET.includes(p))
      .sort(byteOrder)
    expect(present).toEqual(historical.map((h) => h.path).filter((p) => p.startsWith('docs/')).sort(byteOrder))
  }, GIT_TIMEOUT)
  it('the write set is exactly the three added paths, they exist, and the recorded integration merge is be6bdf18', () => {
    expect(WRITE_SET).toEqual([PATHS.v103, PATHS.manifest103, PATHS.self])
    for (const p of WRITE_SET) expect(existsSync(path.join(ROOT, p)), p).toBe(true)
    expect(d1.merge.commit).toBe(INTEGRATION_MERGE)
  })
  it('no operation is added: the delta is empty and v1.0.0 AUTHORIZED_OPERATIONS is AO-1..AO-9', () => {
    const d = AUTH.SECTION_D14_PRESERVATION.AUTHORIZED_OPERATIONS_DELTA
    expect([d.added, d.removed, d.modified]).toEqual([[], [], []])
    const v100 = readJson<{ AUTHORIZED_OPERATIONS: { operations: { id: string }[] } }>(PATHS.v100)
    expect(v100.AUTHORIZED_OPERATIONS.operations.map((o) => o.id)).toEqual(['AO-1', 'AO-2', 'AO-3', 'AO-4', 'AO-5', 'AO-6', 'AO-7', 'AO-8', 'AO-9'])
  })
})

/* ========================================================================== */
/* §11 mutation controls: the interpreter is driven by the artifact, and      */
/*     every validation check is load-bearing                                 */
/* ========================================================================== */

interface NegCase { name: string; expected: string; run: (disabled: ReadonlySet<string>) => string }

function negativeCases(): NegCase[] {
  const A = occurrencePathFor(C(), KS_A.subject_kind, KS_A.candidate_sha)
  const mk = (name: string, expected: string, build: () => { r: Occurrence; c: Ctx }): NegCase => ({
    name,
    expected,
    run: (disabled) => {
      const { r, c } = build()
      return validate(r, c, disabled)
    },
  })
  const withR = (ks: KnownSubject, f: (r: Occurrence) => void, over: (r: Occurrence) => Partial<Ctx> = () => ({})) => () => {
    const r = fixtureOccurrence(ks)
    f(r)
    return { r, c: ctxFor(r, over(r)) }
  }
  const govPin = (r: Occurrence): void => {
    const g = r.subject.entries.find((e) => e.role === 'GOVERNING')
    if (g) g.blob = '1'.repeat(40)
    r.subject.package_digest = digestOf(r.subject.entries)
  }
  const covBlob = (r: Occurrence): void => {
    r.subject.entries[0].blob = '2'.repeat(40)
    r.subject.package_digest = digestOf(r.subject.entries)
  }
  const badTree = (r: Occurrence): void => {
    r.subject.tree_sha = '0'.repeat(40)
    r.provenance.independent_recertifier.examined_tree_sha = r.subject.tree_sha
  }
  const later = (): Occurrence => rekey(fixtureOccurrence(KS_A), FAKE_SHA)
  return [
    mk('unknown kind', 'STOP_UNKNOWN_SUBJECT_KIND', withR(KS_A, (r) => { r.subject_kind = 'OTHER' })),
    mk('extra key', 'STOP_OCCURRENCE_SHAPE', withR(KS_A, (r) => { (r as unknown as Record<string, unknown>).x = 1 })),
    mk('contract blob', 'STOP_OCCURRENCE_CONTRACT_MISMATCH', withR(KS_A, (r) => { r.occurrence_contract.blob = '0'.repeat(40) })),
    mk('authorizes', 'STOP_OCCURRENCE_CLAIMS_AUTHORITY', withR(KS_A, (r) => { r.authorizes = ['HC-3'] })),
    mk('malformed sha', 'STOP_CANDIDATE_SHA_MALFORMED', () => {
      const r = rekey(fixtureOccurrence(KS_A), 'XYZ')
      return { r, c: ctxFor(r, { target: null, derived: clone(r.subject) }) }
    }),
    mk('path reuse', 'STOP_OCCURRENCE_PATH_IDENTITY_MISMATCH', () => {
      const r = later()
      return { r, c: ctxFor(r, { target: null, derived: clone(r.subject), occurrencePath: A }) }
    }),
    mk('census on offline', 'STOP_SUBJECT_KIND_MISMATCH', withR(KS_B, (r) => {
      r.subject_kind = 'READONLY_CENSUS_AUTHORITY_RECERT'
      r.package_id = packageIdFor(C(), r.subject_kind, r.subject.candidate_sha)
    }, () => ({ target: null }))),
    mk('wrong sha vs target', 'STOP_CANDIDATE_SHA_MISMATCH', () => {
      const r = later()
      return { r, c: ctxFor(r, { target: 'KS-A', derived: clone(r.subject) }) }
    }),
    mk('wrong sha vs derivation', 'STOP_CANDIDATE_SHA_MISMATCH', () => {
      const r = later()
      return { r, c: ctxFor(r, { target: null, derived: 'candidate not readable' }) }
    }),
    mk('wrong tree vs target', 'STOP_TREE_SHA_MISMATCH', withR(KS_A, badTree, (r) => ({ derived: clone(r.subject) }))),
    mk('wrong tree vs derivation', 'STOP_TREE_SHA_MISMATCH', withR(KS_A, badTree, () => ({ target: null }))),
    mk('governing pin vs target', 'STOP_GOVERNING_PIN_MISMATCH', withR(KS_B, govPin, (r) => ({ derived: clone(r.subject) }))),
    mk('governing pin vs derivation', 'STOP_GOVERNING_PIN_MISMATCH', withR(KS_B, govPin, () => ({ target: null }))),
    mk('covered blob vs derivation', 'STOP_COVERED_SET_MISMATCH', withR(KS_A, covBlob, () => ({ target: null }))),
    mk('covered blob vs target', 'STOP_COVERED_SET_MISMATCH', withR(KS_A, covBlob, (r) => ({ derived: clone(r.subject) }))),
    mk('digest', 'STOP_PACKAGE_DIGEST_MISMATCH', withR(KS_A, (r) => { r.subject.package_digest = '0'.repeat(64) }, () => ({ target: null }))),
    mk('digest vs target', 'STOP_PACKAGE_DIGEST_MISMATCH', withR(KS_A, (r) => { r.subject.package_digest = '0'.repeat(64) }, (r) => ({ derived: clone(r.subject) }))),
    mk('FAIL', 'STOP_VERDICT_NOT_PROMOTABLE', withR(KS_A, (r) => {
      r.verdict = { ...r.verdict, verdict_class: 'FAIL', verdict_literal: 'CENSUS_RECERT_FAIL', nonblocking_findings_reported_count: 0 }
      r.nonblocking_findings = []
    })),
    mk('FAIL as PASS', 'STOP_VERDICT_LITERAL_MISMATCH', withR(KS_A, (r) => {
      r.verdict = { ...r.verdict, verdict_class: 'PASS', verdict_literal: 'CENSUS_RECERT_FAIL', nonblocking_findings_reported_count: 0 }
      r.nonblocking_findings = []
    })),
    mk('blocking', 'STOP_BLOCKING_FINDINGS_PRESENT', withR(KS_A, (r) => { r.verdict.blocking_findings_count = 2 })),
    mk('missing NB', 'STOP_NONBLOCKING_FINDINGS_INCOMPLETE', withR(KS_A, (r) => { r.nonblocking_findings.pop() })),
    mk('NB closed', 'STOP_FINDING_NOT_OPEN', withR(KS_A, (r) => { r.nonblocking_findings[0].status = 'CLOSED' })),
    mk('materializer is author', 'STOP_PROVENANCE_NOT_INDEPENDENT', withR(KS_A, (r) => { r.provenance.materializer.lane_id = 'FIXTURE-AUTHOR-LANE' })),
    mk('recert of another commit', 'STOP_RECERT_SUBJECT_MISMATCH', withR(KS_A, (r) => { r.provenance.independent_recertifier.examined_candidate_sha = FAKE_SHA })),
    mk('scope undeclared', 'STOP_RECERT_SCOPE_UNDECLARED', withR(KS_A, (r) => { r.provenance.independent_recertifier.scope = 'ANY' })),
    mk('reproduction claim', 'STOP_MATERIALIZER_REPRODUCTION_CLAIM', withR(KS_A, (r) => { r.provenance.materializer_reproduced_recert_evidence = true })),
    mk('path exists', 'STOP_OCCURRENCE_PATH_EXISTS', withR(KS_A, () => undefined, (r) => ({ existing: [{ path: A, record: clone(r) }] }))),
    mk('chain ignored', 'STOP_CHAIN_PREDECESSOR_MISMATCH', () => {
      const first = fixtureOccurrence(KS_A)
      const r = rekey(first, FAKE_SHA)
      return { r, c: ctxFor(r, { target: null, derived: clone(r.subject), existing: [{ path: A, record: first }] }) }
    }),
    mk('closure without predecessor', 'STOP_FINDING_CLOSURE_INVALID', withR(KS_A, (r) => { r.closes_predecessor_findings = ['FIX-NB-1'] })),
    mk('edited after write', 'STOP_OCCURRENCE_EDITED_AFTER_WRITE', () => {
      const r = fixtureOccurrence(KS_A)
      return { r, c: readCtxFor(r, { unchangedSinceWrite: false }) }
    }),
    mk('forked chain at read', 'STOP_CHAIN_PREDECESSOR_MISMATCH', () => {
      const first = fixtureOccurrence(KS_A)
      const pred = { path: A, candidate_sha: first.subject.candidate_sha, package_digest: first.subject.package_digest }
      const s1 = rekey(first, FAKE_SHA)
      s1.chain.predecessor = pred
      const s2 = rekey(first, FAKE_SHA_2)
      s2.chain.predecessor = pred
      const existing = [
        { path: A, record: first },
        { path: occurrencePathFor(C(), first.subject_kind, FAKE_SHA), record: s1 },
        { path: occurrencePathFor(C(), first.subject_kind, FAKE_SHA_2), record: s2 },
      ]
      return { r: first, c: ctxFor(first, { mode: 'read', existing }) }
    }),
  ]
}

describe('§11 mutation controls', () => {
  it('every negative case STOPS with its expected code when no check is disabled', () => {
    for (const n of negativeCases()) expect(n.run(new Set()), n.name).toBe(n.expected)
  })

  it('kill matrix: disabling ANY single validation check lets at least one negative case through', () => {
    const cases = negativeCases()
    const survivors = CHECKS.map((d) => d.id).filter((id) => !cases.some((n) => n.run(new Set([id])) !== n.expected))
    expect(survivors).toEqual([])
  })

  it('self-test: a check that guards nothing is reported as a SURVIVOR (the matrix can fail)', () => {
    CHECKS.push({ id: 'V_NOOP_SELF_TEST', when: 'both', check: () => null })
    try {
      const cases = negativeCases()
      expect(cases.some((n) => n.run(new Set(['V_NOOP_SELF_TEST'])) !== n.expected)).toBe(false)
    } finally {
      CHECKS.pop()
    }
  })

  it('driven by the artifact: adding FAIL to positive_classes in the contract makes a FAIL occurrence pass V8_PROMOTABLE', () => {
    const m = clone(AUTH)
    m.SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT.verdict.positive_classes.push('FAIL')
    const r = fixtureOccurrence(KS_A, m)
    r.verdict = { ...r.verdict, verdict_class: 'FAIL', verdict_literal: 'CENSUS_RECERT_FAIL', nonblocking_findings_reported_count: 0 }
    r.nonblocking_findings = []
    expect(validate(r, ctxFor(r))).toBe('STOP_VERDICT_NOT_PROMOTABLE')
    expect(validate(r, ctxFor(r, {}, m))).not.toBe('STOP_VERDICT_NOT_PROMOTABLE')
  })

  it('driven by the artifact: adding a kind OTHER to the enum makes an OTHER occurrence pass V1', () => {
    const m = clone(AUTH)
    m.SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT.subject_kinds.kinds.OTHER = { covered_path_prefixes: ['docs/'] }
    const r = fixtureOccurrence(KS_A, m)
    r.subject_kind = 'OTHER'
    expect(validate(r, ctxFor(r))).toBe('STOP_UNKNOWN_SUBJECT_KIND')
    expect(validate(r, ctxFor(r, {}, m))).not.toBe('STOP_UNKNOWN_SUBJECT_KIND')
  })

  it('driven by the artifact: dropping NOT from forbidden_prefix_tokens and admitting it to the vocabulary and qualifiers lets CENSUS_RECERT_NOT_PASS through', () => {
    const m = clone(AUTH)
    const v = m.SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT.verdict
    v.forbidden_prefix_tokens = v.forbidden_prefix_tokens.filter((t) => t !== 'NOT')
    v.required_qualifier_tokens.push('NOT')
    v.prefix_token_vocabulary.push('NOT')
    expect(parseVerdictLiteral(C().verdict, 'CENSUS_RECERT_NOT_PASS')).toBeNull()
    expect(parseVerdictLiteral(v, 'CENSUS_RECERT_NOT_PASS')).toBe('PASS')
  })

  it('driven by the artifact: removing a declared non-invalidating layer turns KS-A from CURRENT to STALE', () => {
    const m = clone(AUTH)
    const list = m.SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT.currency.declared_non_invalidating_governing_layers.READONLY_CENSUS_AUTHORITY_RECERT as DeclaredLayer[]
    list.splice(list.findIndex((d) => d.path === PATHS.ownerV101), 1)
    const r = fixtureOccurrence(KS_A)
    expect(currency(C(), r, successorView(), readCtxFor(r))).toBe('CURRENT')
    expect(currency(C(m), r, successorView(), readCtxFor(r))).toBe('STALE_GOVERNING_LAYER_ADDED')
  }, GIT_TIMEOUT)

  it('driven by the artifact: widening a covered prefix changes the derived identity', () => {
    const m = clone(AUTH)
    m.SECTION_D9_CERTIFICATION_OCCURRENCE_CONTRACT.subject_kinds.kinds.READONLY_CENSUS_AUTHORITY_RECERT.covered_path_prefixes = ['docs/ops/release/STAGING_QUIESCE_']
    const d = deriveIdentity(C(m), KS_A.subject_kind, KS_A.candidate_sha, KS_A.tree_sha, successorView())
    expect(typeof d === 'string' ? d : d.package_digest).not.toBe(KS_A.package_digest)
  }, GIT_TIMEOUT)
})
