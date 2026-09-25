// @vitest-environment node
//
// tests/release/staging-recovery-cert-store-durability.test.ts
// STAGING RECOVERY — certification STORE DURABILITY: write-once RECERT_ATTEMPT
// reservations, ever-added store integrity, controlled git reads and a
// provider-enforced canonical ref (Recovery amendment v1.0.5, owner v1.0.3).
//
// Authority:
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.5.json
//   docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.3.json
//   docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.5.json
//
// WHAT THIS FILE IS. A reference interpreter of SECTION_F3: the V3 closure
// derivation, the controlled git read environment, store integrity, record
// validation (adjudications W1..W13, attempts A1..A10), ever-added history over
// the FULL git DAG, canonical-store monotonicity and the provider-protection
// evaluator, attempt states and the consumer rule. Every git-rewrite attack,
// every history shape and every attempt scenario runs on REAL git repositories
// built in a private temporary directory. Every enum, token list, prefix, path
// pattern, grammar, flag and declared layer is read from (or checked equal to)
// the amendment.
//
// WHAT THIS FILE IS NOT. It writes no attempt, adjudication or occurrence into
// this repository, reads no provider (provider facts are the recorded
// 2026-09-24 measurement or explicit fixtures) and mutates no branch
// protection. No database or hosted act.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const ROOT = process.cwd()
/** Real git repositories and a full fsck per store read: well above the 5 s default. */
vi.setConfig({ testTimeout: 120_000 })

const PATHS = {
  v105: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.5.json',
  manifest105: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.5.json',
  owner103: 'docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.3.json',
  self: 'tests/release/staging-recovery-cert-store-durability.test.ts',
  battery: 'tests/release/staging-recovery-cert-store-durability.mutation-battery.mjs',
  v104: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.4.json',
  v103: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.3.json',
  v102: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.2.json',
  v101: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json',
  v100: 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_v1.0.0.json',
} as const
const BASE_COMMIT = 'c057ff71415f0545e95003321c88ea224f6c26f8'
/** Every file of the Recovery chain that must stay byte-identical to its blob at the base. */
const IMMUTABLE = [
  PATHS.v100, PATHS.v101, PATHS.v102, PATHS.v103, PATHS.v104,
  'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_v1.0.0.json',
  'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.1.json',
  'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.2.json',
  'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.3.json',
  'docs/ops/release/STAGING_RECOVERY_EXECUTION_TEST_MANIFEST_AMENDMENT_v1.0.4.json',
  'docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.0.json',
  'docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.1.json',
  'docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_v1.0.2.json',
  'tests/release/staging-recovery-event-class-authority.test.ts',
  'tests/release/staging-recovery-integration-successor.test.ts',
  'tests/release/staging-recovery-cert-adjudication.test.ts',
  'tests/release/staging-recovery-cert-adjudication.mutation-battery.mjs',
]

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
interface KindDef { covered_path_prefixes: string[]; toolchain_roots: string[]; absent_reference_policy: string }
interface Schema { top_level_keys_exact: string[]; nested_keys_exact: Record<string, string[]>; record_type: string; authority_class: string }
interface Measured { classic_protection: string; rules_for_branch: string; repository_rulesets: string; provider_tip: string; activity: { activity_type: string; before: string; after: string }[]; evaluation: string }
interface Contract {
  meaning: string
  attempt_meaning: string
  record_types: Record<string, string>
  subject_kinds: { kinds: Record<string, KindDef> }
  subject_identity_derivation: { algorithm: string; grammars: Record<string, string>; import_resolution_suffixes: string[] }
  verdict: {
    verdict_classes: string[]
    positive_classes: string[]
    non_positive_classes: string[]
    required_qualifier_tokens: string[]
    prefix_token_vocabulary: string[]
    version_token_pattern: string
  }
  provenance: { recert_scope: { values: string[] } }
  path_and_identity: { adjudication_root: string; adjudication_path: string; attempt_path: string; kind_path_codes: Record<string, string> }
  git_read_environment: { environment: { per_command_flags: string[] } }
  canonical_store: {
    CANONICAL_ADJUDICATION_REF: string
    STORE_GENESIS: { commit: string }
    provider_protection: { measured_2026_09_24: Measured }
  }
  attempt_contract: { validation_order: string[] }
  state: { stops: Record<string, string> }
  currency: { declared_non_invalidating_governing_layers: Record<string, Declared[] | string> }
  consumer_rule: { consumer_results: string[] }
  record_schema: { section: string; entry_roles: string[]; ADJUDICATION: Schema; RECERT_ATTEMPT: Schema & { states: string[]; disposition_statuses: string[] } }
  validation_order: string[]
  stop_codes: string[]
}
interface RegistryEntry { file: string; locus: string; class: string; consumer?: string; reason?: string; discovered_by: string[] }
interface SectionRule { file: string; locus_prefix: string; class: string; reason: string }
interface V105 {
  SECTION_F2_OWNER_DECISION_BINDING: { owner_record: string; owner_record_blob: string }
  SECTION_F3_CERTIFICATION_STORE_CONTRACT: Contract
  SECTION_F4_CONSUMER_REGISTRY: { registry: RegistryEntry[]; section_rules: SectionRule[]; discovery_rule_3: { pattern: string }; counts: Record<string, number> }
  SECTION_F5_KNOWN_SUBJECTS_V3: { subjects: KnownSubject[] }
  SECTION_F6_PRECEDENCE_ANCHORS: { anchors: Record<string, Anchor[]>; recovery_topic_count: number }
  SECTION_F7_MATERIALIZATION_AND_RESERVATION_WRITE_SET: { retired_occurrence_root: string }
  SECTION_F8_PR220_DISPOSITION: { merge_prerequisites_conjunctive: string[] }
  SECTION_F9_CONSUMERS_RESTATED: Record<string, string>
  SECTION_F10_EVENT_A_PRESERVATION: { CURRENT_EVENT_A_REACHABLE: string; EVENT_A_POLICY: string }
  SECTION_F11_SUPERSEDED_LOCI: { chain: string; topic: string; locus: string }[]
  SECTION_F15_WRITE_SET: string[]
  SECTION_F16_PRESERVATION: { AUTHORIZED_OPERATIONS_DELTA: { added: unknown[]; removed: unknown[]; modified: unknown[] } }
  SECTION_F18_PROVIDER_BOUNDARY_REPORT: { ref: string; required_change: { ruleset_json: ProviderRuleset & { rules: { type: string }[] } }; mutation_by_this_lane: string }
  final_state: string
}

const AUTH = readJson<V105>(PATHS.v105)
const C = (a: V105 = AUTH): Contract => a.SECTION_F3_CERTIFICATION_STORE_CONTRACT
const WRITE_SET = AUTH.SECTION_F15_WRITE_SET.map((w) => w.split(' ')[0])
const KS = (id: string): KnownSubject => {
  const s = AUTH.SECTION_F5_KNOWN_SUBJECTS_V3.subjects.find((x) => x.id === id)
  if (!s) throw new Error(`known subject ${id} absent`)
  return s
}
const KS_A = KS('KS-A')
const KS_B = KS('KS-B')
const CENSUS = 'READONLY_CENSUS_AUTHORITY_RECERT'
const OFFLINE = 'OFFLINE_RECOVERY_IMPLEMENTATION_RECERT'
const PACKAGE = 'RECOVERY_AUTHORITY_PACKAGE_RECERT'
const CANONICAL_REF = C().canonical_store.CANONICAL_ADJUDICATION_REF

/* ========================================================================== */
/* Controlled git read environment (SECTION_F3.git_read_environment)          */
/* ========================================================================== */

const PRIVATE = mkdtempSync(path.join(tmpdir(), 'uellix-rcs-'))
afterAll(() => rmSync(PRIVATE, { recursive: true, force: true }))
const GRAFT_DIR = mkdtempSync(path.join(PRIVATE, 'g'))
const GRAFT_FILE = path.join(GRAFT_DIR, 'absent')
const HOME_DIR = mkdtempSync(path.join(PRIVATE, 'h'))
const EMPTY_GLOBAL = path.join(HOME_DIR, 'empty.gitconfig')
writeFileSync(EMPTY_GLOBAL, '')

/** The pinned -c pairs, parsed from the artifact's per_command_flags. */
const PINNED: [string, string][] = C()
  .git_read_environment.environment.per_command_flags.filter((f) => f.startsWith('-c '))
  .map((f) => {
    const [k, v] = f.slice(3).split('=')
    return [k, v]
  })
const CONTROLLED_FLAGS = ['--no-replace-objects', ...PINNED.flatMap(([k, v]) => ['-c', `${k}=${v}`])]

/** Built from nothing: only what the platform needs to start git is copied from the parent. */
function controlledEnv(parent: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) {
    const key = Object.keys(parent).find((k) => k.toUpperCase() === name.toUpperCase())
    const value = key === undefined ? undefined : parent[key]
    if (value !== undefined) env[name] = value
  }
  return {
    ...env,
    HOME: HOME_DIR,
    USERPROFILE: HOME_DIR,
    XDG_CONFIG_HOME: HOME_DIR,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: GRAFT_FILE,
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  }
}
type Runner = (cwd: string, args: string[], input?: string) => Buffer
/** The controlled runner. `parent` lets a test hand it a hostile parent environment. */
const makeControlled = (parent: Record<string, string | undefined> = process.env): Runner => (cwd, args, input) => {
  if (existsSync(GRAFT_FILE)) throw new Error('graft path present')
  return execFileSync('git', [...CONTROLLED_FLAGS, ...args], { cwd, env: controlledEnv(parent) as unknown as NodeJS.ProcessEnv, maxBuffer: 1 << 29, input, stdio: ['pipe', 'pipe', 'ignore'] })
}
const cgit: Runner = makeControlled()
/** A NAIVE runner (inherits everything, pins nothing): what the attacks defeat. */
const naive: Runner = (cwd, args, input) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) }, maxBuffer: 1 << 29, input, stdio: ['pipe', 'pipe', 'ignore'] })
const text = (b: Buffer): string => b.toString('utf8').trim()

/** SECTION_F3.git_read_environment.self_check. Returns violations. */
function environmentViolations(cwd: string, run: Runner = cgit): string[] {
  const v: string[] = []
  if (existsSync(GRAFT_FILE)) v.push('graft path present')
  const effective = new Map<string, string>()
  for (const line of run(cwd, ['config', '--list', '--show-scope']).toString('utf8').split('\n')) {
    if (!line) continue
    const [scope, kv] = line.split('\t')
    if (scope === 'system' || scope === 'global') v.push(`scope ${scope}`)
    const eq = kv.indexOf('=')
    effective.set(kv.slice(0, eq).toLowerCase(), kv.slice(eq + 1))
  }
  for (const [k, val] of PINNED) if (effective.get(k.toLowerCase()) !== val) v.push(`pin ${k}=${effective.get(k.toLowerCase())}`)
  for (const k of effective.keys()) if (k.startsWith('fsck.')) v.push(`fsck config ${k}`)
  if (text(run(cwd, ['rev-parse', '--show-object-format'])) !== 'sha1') v.push('object format')
  return v
}

/** SECTION_F3.git_read_environment.object_integrity: every object re-hashed. Returns violations. */
function objectIntegrityViolations(cwd: string, run: Runner = cgit): string[] {
  try {
    run(cwd, ['fsck', '--full', '--no-dangling', '--no-progress'])
    return []
  } catch (e) {
    return [`fsck exit ${(e as { status?: number }).status ?? '?'}`]
  }
}

function hasCommit(sha: string, cwd = ROOT): boolean {
  try {
    return text(cgit(cwd, ['cat-file', '-t', sha])) === 'commit'
  } catch {
    return false
  }
}
function isAncestorIn(cwd: string, a: string, b: string, run: Runner = cgit): boolean {
  try {
    run(cwd, ['merge-base', '--is-ancestor', a, b])
    return true
  } catch {
    return false
  }
}
function isShallow(cwd: string, run: Runner = cgit): boolean {
  return text(run(cwd, ['rev-parse', '--is-shallow-repository'])) !== 'false'
}

/* ========================================================================== */
/* Tree views                                                                 */
/* ========================================================================== */

interface View { list(): string[]; blob(p: string): string | null; texts(ps: string[]): Map<string, string | null> }
interface TreeEntry { path: string; mode: string; type: string; oid: string }

function lsTree(cwd: string, ref: string, pathspec: string[] = [], run: Runner = cgit): TreeEntry[] {
  return run(cwd, ['ls-tree', '-r', '-z', '--full-tree', ref, '--', ...pathspec])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const tab = rec.indexOf('\t')
      const [mode, type, oid] = rec.slice(0, tab).split(' ')
      return { path: rec.slice(tab + 1), mode, type, oid }
    })
}
function readBlobs(oids: string[], cwd = ROOT, run: Runner = cgit): Map<string, string> {
  const out = new Map<string, string>()
  const unique = [...new Set(oids)]
  if (unique.length === 0) return out
  const buf = run(cwd, ['cat-file', '--batch'], `${unique.join('\n')}\n`)
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
  const blobs = new Map(lsTree(cwd, sha).filter((e) => e.type === 'blob').map((e) => [e.path, e.oid]))
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
/** The tree that introduces v1.0.5: the base plus this write set. Fixed forever. */
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
/* RCO_CLOSURE_DIGEST_V3 (grammars equal to SECTION_F3 grammars, checked)      */
/* ========================================================================== */

const IMPORT_RE = /^[ \t]*(?:import|export)\b[^'"`;]*?\bfrom[ \t]*['"]([^'"\n]+)['"]|^[ \t]*import[ \t]*['"]([^'"\n]+)['"]|\b(?:require|import)[ \t]*\([ \t]*['"]([^'"\n]+)['"][ \t]*\)/gm
const LITERAL_RE = /['"`]((?:(?:\.{1,2}\/)+[A-Za-z0-9_@-][A-Za-z0-9_.@-]*(?:\/[A-Za-z0-9_.@-]+)*|[A-Za-z0-9_@-][A-Za-z0-9_.@-]*(?:\/[A-Za-z0-9_.@-]+)+)\.[A-Za-z0-9]+)['"`]/g
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT_RE = /(^|[^:\\])\/\/.*$/gm
const SETUP_RE = /setupFiles\s*:\s*\[([^\]]*)\]/g
const REF_RE = /docs\/ops\/[A-Za-z0-9_./-]+\.json/g
const CODE_RE = /\.(ts|tsx|js|mjs|cjs)$/
const GRAMMARS: Record<string, RegExp> = {
  import_specifier: IMPORT_RE,
  runtime_literal: LITERAL_RE,
  block_comment: BLOCK_COMMENT_RE,
  line_comment: LINE_COMMENT_RE,
  setup_files: SETUP_RE,
  governing_reference: REF_RE,
  code_file: CODE_RE,
}
const ROLE_ORDER: Role[] = ['COVERED', 'TOOLCHAIN', 'IMPORTED', 'RUNTIME_INPUT', 'GOVERNING']
const stripComments = (t: string): string => t.replace(BLOCK_COMMENT_RE, '').replace(LINE_COMMENT_RE, '$1')
const family = (p: string): string => {
  const i = p.search(/_v\d/)
  return i < 0 ? p : p.slice(0, i + 1)
}
const digestOf = (entries: Entry[]): string => sha256(entries.map((e) => `${e.role}\t${e.path}\t${e.blob}\n`).join(''))

function coveredAt(contract: Contract, kind: string, view: View): string[] {
  const prefixes = contract.subject_kinds.kinds[kind]?.covered_path_prefixes ?? []
  return view.list().filter((p) => prefixes.some((x) => p.startsWith(x))).sort(byteOrder)
}

interface Derived extends Identity { excluded_absent_references: string[] }
function deriveV3(contract: Contract, kind: string, candidate: string, tree: string, view: View): Derived | string {
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
          const s = m[1] ?? m[2] ?? m[3]
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
  const excluded: string[] = []
  for (const g of [...refs].sort(byteOrder)) {
    if (role.has(g)) continue
    if (!present.has(g)) {
      if (k.absent_reference_policy === 'EXCLUDE') {
        excluded.push(g)
        continue
      }
      return `dangling ${g}`
    }
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
    digest_algorithm: contract.subject_identity_derivation.algorithm,
    entries,
    package_digest: digestOf(entries),
    governing_families: families,
    governing_family_members_at_candidate: view
      .list()
      .filter((p) => families.some((f) => p.startsWith(f)))
      .sort(byteOrder)
      .map((p) => ({ path: p, blob: view.blob(p) as string })),
    excluded_absent_references: excluded,
  }
}

/* ========================================================================== */
/* Records                                                                    */
/* ========================================================================== */

interface ContractRef { path: string; section: string; blob: string }
interface Pred { path: string; record_digest: string }
interface Adjudication {
  record_type: string
  contract: ContractRef
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
  resolves_attempt: { path: string; record_digest: string; attempt_id: string }
  chain: { predecessor: Pred | null }
  authority_class: string
  authorizes: unknown[]
  meaning: string
}
interface AttemptSubject { candidate_sha: string; tree_sha: string; package_digest: string; digest_algorithm: string }
interface Attempt {
  record_type: string
  contract: ContractRef
  attempt_id: string
  subject_kind: string
  subject: AttemptSubject
  prior_state: { state: string; disposition_status: string }
  canonical_store: { ref: string; tip_observed_at_reservation: string }
  reservation: { reserved_by: { lane_id: string; executor: string }; adjudicator_lane_id: string; reservation_date: string }
  chain: { predecessor: Pred | null }
  authority_class: string
  authorizes: unknown[]
  meaning: string
}
type Rec = Adjudication | Attempt
interface Stored { path: string; record: Rec }
const isAttempt = (r: Rec): r is Attempt => r.record_type === 'RECERT_ATTEMPT'
const isAdjudication = (r: Rec): r is Adjudication => r.record_type === 'ADJUDICATION'

const recordDigest = (r: unknown): string => sha256(canonical(r))
const kindCode = (contract: Contract, kind: string): string => contract.path_and_identity.kind_path_codes[kind] ?? '?'
const recordPathFor = (contract: Contract, r: Rec): string =>
  (isAttempt(r) ? contract.path_and_identity.attempt_path : contract.path_and_identity.adjudication_path)
    .replace('<KIND_CODE>', kindCode(contract, r.subject_kind))
    .replace('<package_digest>', r.subject?.package_digest ?? '')
    .replace('<record_digest>', recordDigest(r))
const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== ''
const LANE_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/
const identityKey = (lane: string): string => lane.split('-').join('')
const keysExact = (o: unknown, keys: string[]): boolean =>
  o !== null && typeof o === 'object' && !Array.isArray(o) && sameList(Object.keys(o).sort(byteOrder), [...keys].sort(byteOrder))
const byRole = (s: Identity, ...roles: Role[]): Entry[] => s.entries.filter((e) => roles.includes(e.role))
const blobsEqual = (a: { path: string; blob: string }[], b: { path: string; blob: string }[]): boolean =>
  a.length === b.length && a.every((e, i) => e.path === b[i].path && e.blob === b[i].blob)
const NON_GOVERNING: Role[] = ['COVERED', 'TOOLCHAIN', 'IMPORTED', 'RUNTIME_INPUT']
const HEX40 = /^[0-9a-f]{40}$/

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
function literalOk(v: Contract['verdict'], cls: string, literal: unknown): boolean {
  if (!v.verdict_classes.includes(cls)) return false
  if (v.positive_classes.includes(cls)) return parseStrict(v, literal) === cls
  if (typeof literal !== 'string' || !/^[A-Z0-9_]+$/.test(literal)) return false
  const tokens = literal.split('_')
  return !v.positive_classes.some((p) => tokens.slice(-p.split('_').length).join('_') === p)
}

/* ---------- chain ---------- */

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
    if (recordDigest(pred.record) !== p.record_digest) return `predecessor digest mismatch ${p.path}`
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
function chainOrder(records: Stored[]): Stored[] {
  const root = records.find((s) => s.record.chain.predecessor === null)
  const next = new Map(records.filter((s) => s.record.chain.predecessor).map((s) => [s.record.chain.predecessor?.path as string, s]))
  const out: Stored[] = []
  for (let cur = root; cur; cur = next.get(cur.path)) out.push(cur)
  return out
}
const tipRef = (ordered: Stored[]): Pred | null => {
  const tip = ordered[ordered.length - 1]
  return tip ? { path: tip.path, record_digest: recordDigest(tip.record) } : null
}

/* ---------- disposition and state (SECTION_F3.state) ---------- */

function dispositionStatus(contract: Contract, adjudications: Adjudication[]): { status: string; positives: Adjudication[] } {
  const pos = (r: Adjudication): boolean => contract.verdict.positive_classes.includes(r.verdict.verdict_class)
  if (adjudications.length === 0) return { status: 'NOT_ADJUDICATED', positives: [] }
  const positives = adjudications.filter(pos)
  if (positives.length === 0) return { status: 'NEGATIVELY_ADJUDICATED', positives }
  const firstNeg = adjudications.findIndex((r) => !pos(r))
  if (firstNeg < 0) return { status: 'CERTIFIED', positives }
  if (adjudications.slice(firstNeg + 1).some(pos)) return { status: 'CONTRADICTED', positives }
  return { status: 'REVOKED', positives }
}
interface StateResult { state: string; disposition: string; stop: string | null; positives: Adjudication[] }
/** state(K, P) over the records of one kind in chain order. */
function stateOf(contract: Contract, ordered: Stored[], digest: string): StateResult {
  const mine = ordered.filter((s) => s.record.subject?.package_digest === digest)
  const adjudications = mine.map((s) => s.record).filter(isAdjudication)
  const attempts = mine.filter((s) => isAttempt(s.record))
  const d = dispositionStatus(contract, adjudications)
  const resolved = new Set(adjudications.map((a) => a.resolves_attempt?.path))
  const out = (state: string, stop: string | null): StateResult => ({ state, disposition: d.status, stop, positives: d.positives })
  if (d.status === 'CONTRADICTED') return out('CONTRADICTED', 'STOP_CONTRADICTORY_CERTIFICATION')
  if (d.status === 'REVOKED') return out('RESOLVED_NON_POSITIVE', 'STOP_CERTIFICATION_REVOKED')
  if (d.status === 'NEGATIVELY_ADJUDICATED') return out('RESOLVED_NON_POSITIVE', 'STOP_NOT_CERTIFIED')
  if (attempts.some((a) => !resolved.has(a.path))) return out('OPEN_ATTEMPT', 'STOP_RECERT_ATTEMPT_OPEN')
  if (attempts.length === 0) return out('NO_ATTEMPT', 'STOP_NOT_CERTIFIED')
  return out('RESOLVED_PASS', null)
}

/* ---------- validation ---------- */

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

function adjudicationShapeOk(r: Adjudication, c: Ctx): boolean {
  const s = c.contract.record_schema.ADJUDICATION
  const n = s.nested_keys_exact
  const p = r.provenance as unknown as Record<string, unknown>
  return (
    r.record_type === s.record_type &&
    keysExact(r, s.top_level_keys_exact) &&
    keysExact(r.contract, n.contract) &&
    keysExact(r.subject, n.subject) &&
    Array.isArray(r.subject.entries) &&
    r.subject.entries.every((e) => keysExact(e, n['subject.entries[]']) && c.contract.record_schema.entry_roles.includes(e.role)) &&
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
    keysExact(r.resolves_attempt, n.resolves_attempt) &&
    keysExact(r.chain, n.chain) &&
    (r.chain.predecessor === null || keysExact(r.chain.predecessor, n['chain.predecessor (when not null)']))
  )
}
function attemptShapeOk(r: Attempt, c: Ctx): boolean {
  const s = c.contract.record_schema.RECERT_ATTEMPT
  const n = s.nested_keys_exact
  return (
    r.record_type === s.record_type &&
    keysExact(r, s.top_level_keys_exact) &&
    keysExact(r.contract, n.contract) &&
    keysExact(r.subject, n.subject) &&
    keysExact(r.prior_state, n.prior_state) &&
    keysExact(r.canonical_store, n.canonical_store) &&
    keysExact(r.reservation, n.reservation) &&
    keysExact(r.reservation.reserved_by, n['reservation.reserved_by']) &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.reservation.reservation_date) &&
    keysExact(r.chain, n.chain) &&
    (r.chain.predecessor === null || keysExact(r.chain.predecessor, n['chain.predecessor (when not null)']))
  )
}

const kindRecords = (c: Ctx, kind: string): Stored[] => c.existing.filter((e) => e.record.subject_kind === kind)
/** The kind's records strictly BEFORE the record at recordPath in chain order (write time: all of them). */
function chainPrefix(c: Ctx, kind: string): Stored[] | null {
  const same = kindRecords(c, kind)
  if (chainIntegrity(same) !== null) return null
  const ordered = chainOrder(same)
  const at = ordered.findIndex((s) => s.path === c.recordPath)
  return c.mode === 'write' ? ordered : at < 0 ? null : ordered.slice(0, at)
}
const writeChainCheck = (r: Rec, c: Ctx): string | null => {
  const same = kindRecords(c, r.subject_kind)
  const p = r.chain.predecessor
  if (same.length === 0) return p === null ? null : 'STOP_CHAIN_PREDECESSOR_MISMATCH'
  if (chainIntegrity(same) !== null || p === null) return 'STOP_CHAIN_PREDECESSOR_MISMATCH'
  const tip = tipRef(chainOrder(same)) as Pred
  return p.path === tip.path && p.record_digest === tip.record_digest ? null : 'STOP_CHAIN_PREDECESSOR_MISMATCH'
}

type Check<T> = (r: T, c: Ctx) => string | null
interface CheckDef<T> { id: string; when: 'both' | 'write' | 'read'; check: Check<T> }

/** SECTION_F3.validation_order (ADJUDICATION), in order. */
const ADJUDICATION_CHECKS: CheckDef<Adjudication>[] = [
  { id: 'W1_KIND', when: 'both', check: (r, c) => (typeof r.subject_kind === 'string' && c.contract.subject_kinds.kinds[r.subject_kind] ? null : 'STOP_UNKNOWN_SUBJECT_KIND') },
  { id: 'W2_SHAPE', when: 'both', check: (r, c) => (adjudicationShapeOk(r, c) ? null : 'STOP_ADJUDICATION_SHAPE') },
  { id: 'W3_CONTRACT', when: 'both', check: (r, c) =>
    r.contract.path === c.contractPath && r.contract.section === c.contract.record_schema.section && r.contract.blob === c.contractBlob ? null : 'STOP_ADJUDICATION_CONTRACT_MISMATCH' },
  { id: 'W4_NOT_AUTHORITY', when: 'both', check: (r, c) =>
    r.authority_class === c.contract.record_schema.ADJUDICATION.authority_class && Array.isArray(r.authorizes) && r.authorizes.length === 0 && r.meaning === c.contract.meaning
      ? null
      : 'STOP_ADJUDICATION_CLAIMS_AUTHORITY' },
  { id: 'W5_SHA_FORMAT', when: 'both', check: (r) => (HEX40.test(r.subject.candidate_sha) ? null : 'STOP_CANDIDATE_SHA_MALFORMED') },
  { id: 'W5_PATH_IDENTITY', when: 'both', check: (r, c) => (c.recordPath === recordPathFor(c.contract, r) ? null : 'STOP_ADJUDICATION_PATH_IDENTITY_MISMATCH') },
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
    r.subject.digest_algorithm === c.contract.subject_identity_derivation.algorithm &&
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
  { id: 'W11_CHAIN', when: 'write', check: (r, c) => writeChainCheck(r, c) },
  { id: 'W11_CLOSURE', when: 'write', check: (r, c) => {
    const closes = r.closes_predecessor_findings
    if (!Array.isArray(closes)) return 'STOP_FINDING_CLOSURE_INVALID'
    const prior = chainOrder(kindRecords(c, r.subject_kind)).map((s) => s.record).filter(isAdjudication)
    const last = prior[prior.length - 1]
    if (!last) return closes.length === 0 ? null : 'STOP_FINDING_CLOSURE_INVALID'
    const ids = new Set(last.nonblocking_findings.map((x) => x.id))
    return new Set(closes).size === closes.length && closes.every((id) => ids.has(id)) ? null : 'STOP_FINDING_CLOSURE_INVALID'
  } },
  { id: 'R1_HISTORY', when: 'read', check: (_r, c) => (c.historyViolations.length === 0 ? null : 'STOP_ADJUDICATION_HISTORY_VIOLATED') },
  { id: 'R2_CHAIN', when: 'read', check: (r, c) => (chainIntegrity(kindRecords(c, r.subject_kind)) === null ? null : 'STOP_CHAIN_INTEGRITY_VIOLATED') },
  { id: 'W12_RESOLVES', when: 'both', check: (r, c) => {
    const ra = r.resolves_attempt
    const prefix = chainPrefix(c, r.subject_kind)
    const att = prefix?.find((s) => s.path === ra.path)
    if (!att || !isAttempt(att.record)) return 'STOP_RECERT_ATTEMPT_RESOLUTION_INVALID'
    const a = att.record
    return recordDigest(a) === ra.record_digest &&
      a.attempt_id === ra.attempt_id &&
      a.subject_kind === r.subject_kind &&
      a.subject.candidate_sha === r.subject.candidate_sha &&
      a.subject.tree_sha === r.subject.tree_sha &&
      a.subject.package_digest === r.subject.package_digest &&
      identityKey(a.reservation.adjudicator_lane_id) === identityKey(r.provenance.independent_adjudicator.lane_id) &&
      a.reservation.reservation_date <= r.provenance.independent_adjudicator.adjudication_date
      ? null
      : 'STOP_RECERT_ATTEMPT_RESOLUTION_INVALID'
  } },
  { id: 'W13_SINGLE_RESOLUTION', when: 'both', check: (r, c) =>
    c.existing.some((s) => s.path !== c.recordPath && isAdjudication(s.record) && s.record.resolves_attempt?.path === r.resolves_attempt.path)
      ? 'STOP_RECERT_ATTEMPT_DOUBLY_RESOLVED'
      : null },
]

/** SECTION_F3.attempt_contract.validation_order, in order. */
const ATTEMPT_CHECKS: CheckDef<Attempt>[] = [
  { id: 'A1_KIND', when: 'both', check: (r, c) => (typeof r.subject_kind === 'string' && c.contract.subject_kinds.kinds[r.subject_kind] ? null : 'STOP_UNKNOWN_SUBJECT_KIND') },
  { id: 'A2_SHAPE', when: 'both', check: (r, c) => (attemptShapeOk(r, c) ? null : 'STOP_RECERT_ATTEMPT_SHAPE') },
  { id: 'A3_CONTRACT', when: 'both', check: (r, c) =>
    r.contract.path === c.contractPath && r.contract.section === c.contract.record_schema.section && r.contract.blob === c.contractBlob ? null : 'STOP_ADJUDICATION_CONTRACT_MISMATCH' },
  { id: 'A4_NOT_AUTHORITY', when: 'both', check: (r, c) =>
    r.authority_class === c.contract.record_schema.RECERT_ATTEMPT.authority_class && Array.isArray(r.authorizes) && r.authorizes.length === 0 && r.meaning === c.contract.attempt_meaning
      ? null
      : 'STOP_ADJUDICATION_CLAIMS_AUTHORITY' },
  { id: 'A5_SHA_FORMAT', when: 'both', check: (r) => (HEX40.test(r.subject.candidate_sha) ? null : 'STOP_CANDIDATE_SHA_MALFORMED') },
  { id: 'A5_PATH_IDENTITY', when: 'both', check: (r, c) => (c.recordPath === recordPathFor(c.contract, r) ? null : 'STOP_ADJUDICATION_PATH_IDENTITY_MISMATCH') },
  { id: 'A5_PATH_FREE', when: 'write', check: (_r, c) => (c.existing.some((e) => e.path === c.recordPath) ? 'STOP_ADJUDICATION_PATH_EXISTS' : null) },
  { id: 'A6_SUBJECT', when: 'both', check: (r, c) => {
    const d = c.derived
    const t = c.target === null ? null : (c.knownSubjects.find((k) => k.id === c.target) ?? null)
    if (c.target !== null && (!t || t.subject_kind !== r.subject_kind)) return 'STOP_SUBJECT_KIND_MISMATCH'
    for (const ref of [d, t] as (Identity | string | null)[]) {
      if (ref === null) continue
      if (typeof ref === 'string' || ref.candidate_sha !== r.subject.candidate_sha || ref.tree_sha === ref.candidate_sha) return 'STOP_CANDIDATE_SHA_MISMATCH'
      if (ref.tree_sha !== r.subject.tree_sha) return 'STOP_TREE_SHA_MISMATCH'
      if (ref.package_digest !== r.subject.package_digest || r.subject.digest_algorithm !== c.contract.subject_identity_derivation.algorithm) return 'STOP_PACKAGE_DIGEST_MISMATCH'
    }
    return null
  } },
  { id: 'A7_IDS', when: 'both', check: (r) =>
    [r.attempt_id, r.reservation.reserved_by.lane_id, r.reservation.adjudicator_lane_id].every((l) => typeof l === 'string' && LANE_RE.test(l)) ? null : 'STOP_PROVENANCE_IDENTITY_MALFORMED' },
  { id: 'A7_UNIQUE', when: 'both', check: (r, c) =>
    c.existing.some((s) => s.path !== c.recordPath && isAttempt(s.record) && identityKey(s.record.attempt_id) === identityKey(r.attempt_id)) ? 'STOP_RECERT_ATTEMPT_ID_DUPLICATE' : null },
  { id: 'A8_CANONICAL', when: 'both', check: (r) =>
    r.canonical_store.ref === CANONICAL_REF && HEX40.test(r.canonical_store.tip_observed_at_reservation) ? null : 'STOP_CANONICAL_STORE_REF_MISMATCH' },
  { id: 'R1_HISTORY', when: 'read', check: (_r, c) => (c.historyViolations.length === 0 ? null : 'STOP_ADJUDICATION_HISTORY_VIOLATED') },
  { id: 'R2_CHAIN', when: 'read', check: (r, c) => (chainIntegrity(kindRecords(c, r.subject_kind)) === null ? null : 'STOP_CHAIN_INTEGRITY_VIOLATED') },
  { id: 'A9_PRIOR_STATE', when: 'both', check: (r, c) => {
    const prefix = chainPrefix(c, r.subject_kind)
    if (prefix === null) return 'STOP_RECERT_ATTEMPT_PRIOR_STATE_MISMATCH'
    const s = stateOf(c.contract, prefix, r.subject.package_digest)
    return r.prior_state.state === s.state && r.prior_state.disposition_status === s.disposition ? null : 'STOP_RECERT_ATTEMPT_PRIOR_STATE_MISMATCH'
  } },
  { id: 'A9_NOT_ALREADY_OPEN', when: 'both', check: (r) => (r.prior_state.state === 'OPEN_ATTEMPT' ? 'STOP_RECERT_ATTEMPT_ALREADY_OPEN' : null) },
  { id: 'A10_CHAIN', when: 'write', check: (r, c) => writeChainCheck(r, c) },
]

function validate(r: Rec, c: Ctx, disabled: ReadonlySet<string> = new Set()): string {
  const run = <T>(checks: CheckDef<T>[], rec: T, shapeStop: string): string => {
    for (const d of checks) {
      if (disabled.has(d.id) || (d.when !== 'both' && d.when !== c.mode)) continue
      try {
        const stop = d.check(rec, c)
        if (stop) return stop
      } catch {
        return shapeStop
      }
    }
    return 'VALID'
  }
  if (isAttempt(r)) return run(ATTEMPT_CHECKS, r, 'STOP_RECERT_ATTEMPT_SHAPE')
  if (isAdjudication(r)) return run(ADJUDICATION_CHECKS, r, 'STOP_ADJUDICATION_SHAPE')
  return 'STOP_ADJUDICATION_SHAPE'
}

/* ========================================================================== */
/* Store integrity and ever-added history                                     */
/* ========================================================================== */

interface RawEntry { path: string; mode: string; oid: string; bytes: string }

function storeIntegrity(contract: Contract, raw: RawEntry[]): string[] {
  const v: string[] = []
  const root = contract.path_and_identity.adjudication_root
  const codes = contract.path_and_identity.kind_path_codes
  const shape = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([A-Z]+)/([0-9a-f]{64})/(a-)?([0-9a-f]{64})\\.json$`)
  for (const e of raw) {
    if (e.mode !== '100644') { v.push(`mode ${e.mode} ${e.path}`); continue }
    const m = shape.exec(e.path)
    if (!m) { v.push(`path shape ${e.path}`); continue }
    let rec: Rec
    try {
      rec = JSON.parse(e.bytes) as Rec
    } catch {
      v.push(`not json ${e.path}`)
      continue
    }
    if (canonicalPretty(rec) !== e.bytes) { v.push(`not canonical bytes ${e.path}`); continue }
    if (rec?.record_type !== (m[3] ? 'RECERT_ATTEMPT' : 'ADJUDICATION')) { v.push(`record type/file form ${e.path}`); continue }
    const kind = typeof rec?.subject_kind === 'string' ? rec.subject_kind : ''
    if (!(kind in codes) || codes[kind] !== m[1]) { v.push(`kind/directory ${e.path}`); continue }
    if (rec.subject?.package_digest !== m[2]) { v.push(`digest directory ${e.path}`); continue }
    if (recordDigest(rec) !== m[4]) v.push(`content digest ${e.path}`)
  }
  return v
}

/** SECTION_F3.ever_added_history for the whole root at H. */
function everAddedViolations(cwd: string, root: string, atHead: Map<string, string>, run: Runner = cgit, ref = 'HEAD'): string[] {
  const out = run(cwd, ['log', '-z', '--full-history', '--no-renames', '--cc', '--raw', '--no-abbrev', '--format=%x01%H %P', ref, '--', `:(top,literal)${root}`]).toString('utf8')
  const v: string[] = []
  const adds = new Map<string, { n: number; oid: string; mode: string }>()
  for (const chunk of out.split('\x01')) {
    if (!chunk) continue
    const nul = chunk.indexOf('\0')
    const header = nul < 0 ? chunk : chunk.slice(0, nul)
    const parents = header.trim().split(' ').length - 1
    const tokens = nul < 0 ? [] : chunk.slice(nul + 1).split('\0')
    for (let i = 0; i < tokens.length; i++) {
      const meta = tokens[i].replace(/^\n+/, '')
      if (!meta) continue
      if (!meta.startsWith(':')) { v.push(`unparsed ${meta}`); continue }
      const p = tokens[++i] ?? ''
      if (meta.startsWith('::') || parents > 1) { v.push(`merge-entry ${p}`); continue }
      const [, dstMode, , dstOid, status] = meta.slice(1).split(' ')
      if (status === 'A') adds.set(p, { n: (adds.get(p)?.n ?? 0) + 1, oid: dstOid, mode: dstMode })
      else v.push(`${status} ${p}`)
    }
  }
  for (const [p, e] of adds) {
    if (e.n !== 1) v.push(`adds=${e.n} ${p}`)
    if (e.mode !== '100644') v.push(`add mode ${e.mode} ${p}`)
    const h = atHead.get(p)
    if (h === undefined) v.push(`ever-added absent at H ${p}`)
    else if (h !== e.oid) v.push(`introducing blob changed ${p}`)
  }
  for (const p of atHead.keys()) if (!adds.has(p)) v.push(`adds=0 ${p}`)
  return v
}

/* ========================================================================== */
/* Provider protection (SECTION_F3.canonical_store.provider_protection)       */
/* ========================================================================== */

interface ProviderRuleset { enforcement: string; target: string; bypass_actors: unknown[]; conditions: { ref_name: { include: string[]; exclude: string[] } } }
interface Provider {
  ref: string
  tip: string
  classic: { allow_force_pushes: { enabled: boolean }; allow_deletions: { enabled: boolean }; enforce_admins: { enabled: boolean } } | null
  rules: { type: string; ruleset_id: number }[]
  rulesets: Record<number, ProviderRuleset>
  activity: { activity_type: string }[]
}
function protectionPass(p: Provider, ref: string): boolean {
  const ids = [...new Set(p.rules.filter((r) => r.type === 'non_fast_forward').map((r) => r.ruleset_id))].filter((id) =>
    p.rules.some((r) => r.type === 'deletion' && r.ruleset_id === id),
  )
  const ruleset = ids.some((id) => {
    const s = p.rulesets[id]
    return (
      s !== undefined &&
      s.enforcement === 'active' &&
      s.target === 'branch' &&
      Array.isArray(s.bypass_actors) &&
      s.bypass_actors.length === 0 &&
      (s.conditions?.ref_name?.include ?? []).some((x) => x === ref || x === '~ALL')
    )
  })
  const c = p.classic
  const classic = c !== null && c.allow_force_pushes?.enabled === false && c.allow_deletions?.enabled === false && c.enforce_admins?.enabled === true
  return ruleset || classic
}
const rewriteWitnessed = (p: Provider): boolean =>
  p.activity.some((a) => a.activity_type === 'force_push' || a.activity_type === 'branch_deletion') || p.activity.filter((a) => a.activity_type === 'branch_creation').length > 1

const MEASURED = C().canonical_store.provider_protection.measured_2026_09_24
/** The recorded 2026-09-24 provider state (404 / [] / []), as evaluator input. */
const measuredProvider = (): Provider => ({
  ref: CANONICAL_REF,
  tip: MEASURED.provider_tip,
  classic: null,
  rules: [],
  rulesets: {},
  activity: MEASURED.activity.map((a) => ({ activity_type: a.activity_type })),
})
/** A protected provider fixture (the SECTION_F18 required change applied). */
const protectedProvider = (tip: string): Provider => {
  const rs = AUTH.SECTION_F18_PROVIDER_BOUNDARY_REPORT.required_change.ruleset_json
  return {
    ref: CANONICAL_REF,
    tip,
    classic: null,
    rules: rs.rules.map((r) => ({ type: r.type, ruleset_id: 7 })),
    rulesets: { 7: { enforcement: rs.enforcement, target: rs.target, bypass_actors: [...rs.bypass_actors], conditions: clone(rs.conditions) } },
    activity: [{ activity_type: 'push' }],
  }
}

/* ========================================================================== */
/* Currency and the consumer rule                                             */
/* ========================================================================== */

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

interface Store {
  raw: RawEntry[]
  records: Stored[]
  history: string[]
  shallow: boolean
  occurrenceRootFiles: string[]
  envViolations: string[]
  objectIntegrity: string[]
  /** entries under the root at the provider tip: path -> blob */
  tipRaw: Map<string, string>
}
interface ConsumerInput {
  contract: Contract
  kind: string
  head: View
  headSha: string
  store: Store
  provider: Provider
  genesis: string
  isAncestor: (a: string, b: string) => boolean
  contractPath: string
  contractBlob: string
  derivedFor: (r: Rec) => Identity | string
  targetFor: (r: Rec) => string | null
}
interface ConsumerResult { result: string; state?: string; disposition?: string; package_digest?: string; scopes?: string[] }

/** SECTION_F3.consumer_rule, steps (0)..(12). */
function consume(i: ConsumerInput): ConsumerResult {
  if (!protectionPass(i.provider, CANONICAL_REF)) return { result: 'STOP_PROVIDER_PROTECTION_REQUIRED' }
  if (rewriteWitnessed(i.provider)) return { result: 'STOP_CANONICAL_STORE_REWRITTEN' }
  if (i.store.envViolations.length > 0) return { result: 'STOP_GIT_READ_ENVIRONMENT_UNCONTROLLED' }
  if (i.store.objectIntegrity.length > 0) return { result: 'STOP_GIT_OBJECT_STORE_CORRUPT' }
  if (i.store.shallow) return { result: 'STOP_ADJUDICATION_HISTORY_UNVERIFIABLE' }
  if (i.provider.ref !== CANONICAL_REF) return { result: 'STOP_CANONICAL_STORE_REF_MISMATCH' }
  if (!i.isAncestor(i.genesis, i.provider.tip)) return { result: 'STOP_CANONICAL_STORE_NOT_MONOTONIC' }
  if (!i.isAncestor(i.provider.tip, i.headSha)) return { result: 'STOP_ADJUDICATION_STORE_STALE' }
  if (i.store.occurrenceRootFiles.length > 0) return { result: 'STOP_RETIRED_OCCURRENCE_ROOT_USED' }
  if (storeIntegrity(i.contract, i.store.raw).length > 0) return { result: 'STOP_ADJUDICATION_STORE_INVALID' }
  if (i.store.history.length > 0) return { result: 'STOP_ADJUDICATION_HISTORY_VIOLATED' }
  const mine = i.store.records.filter((s) => s.record.subject_kind === i.kind)
  if (chainIntegrity(mine) !== null) return { result: 'STOP_CHAIN_INTEGRITY_VIOLATED' }
  for (const s of i.store.records) {
    const ctx: Ctx = {
      mode: 'read',
      contract: i.contract,
      knownSubjects: AUTH.SECTION_F5_KNOWN_SUBJECTS_V3.subjects,
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
  for (const s of i.store.records) {
    if (isAttempt(s.record) && !i.isAncestor(s.record.canonical_store.tip_observed_at_reservation, i.provider.tip)) return { result: 'STOP_CANONICAL_STORE_NOT_MONOTONIC' }
  }
  const atHead = new Map(i.store.raw.map((e) => [e.path, e.oid]))
  for (const [p, b] of i.store.tipRaw) if (atHead.get(p) !== b) return { result: 'STOP_ADJUDICATION_STORE_STALE' }
  const closure = deriveV3(i.contract, i.kind, '0'.repeat(40), '1'.repeat(40), i.head)
  if (typeof closure === 'string') return { result: closure === 'empty COVERED' ? 'STOP_SUBJECT_NOT_PRESENT' : 'STOP_NOT_CURRENT' }
  const st = stateOf(i.contract, chainOrder(mine), closure.package_digest)
  if (st.stop) return { result: st.stop, state: st.state, disposition: st.disposition, package_digest: closure.package_digest }
  const latest = st.positives[st.positives.length - 1]
  if (familyRule(i.contract, i.kind, latest, i.head, i.contractPath) !== 'CURRENT') return { result: 'STOP_NOT_CURRENT', state: st.state }
  return {
    result: 'USABLE',
    state: st.state,
    disposition: st.disposition,
    package_digest: closure.package_digest,
    scopes: st.positives.map((r) => r.provenance.independent_adjudicator.scope),
  }
}

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const CONTRACT_BLOB = gitBlobSha(readBytes(PATHS.v105))
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
const contractRef = (): ContractRef => ({ path: PATHS.v105, section: C().record_schema.section, blob: CONTRACT_BLOB })
let attemptSeq = 0

interface AttemptOver { candidate?: string; adjudicator?: string; attemptId?: string; tip?: string; prior?: { state: string; disposition_status: string }; digest?: string }
/** A RECERT_ATTEMPT reserved at the tip of `prefix` (records of any kind, chain-ordered per kind). */
function attemptFor(ks: KnownSubject, prefix: Stored[], over: AttemptOver = {}): Attempt {
  const same = chainOrder(prefix.filter((s) => s.record.subject_kind === ks.subject_kind))
  const subject: AttemptSubject = { candidate_sha: over.candidate ?? ks.candidate_sha, tree_sha: ks.tree_sha, package_digest: over.digest ?? ks.package_digest, digest_algorithm: ks.digest_algorithm }
  const st = stateOf(C(), same, subject.package_digest)
  return {
    record_type: 'RECERT_ATTEMPT',
    contract: contractRef(),
    attempt_id: over.attemptId ?? `FIXTURE-ATTEMPT-${++attemptSeq}`,
    subject_kind: ks.subject_kind,
    subject,
    prior_state: over.prior ?? { state: st.state, disposition_status: st.disposition },
    canonical_store: { ref: CANONICAL_REF, tip_observed_at_reservation: over.tip ?? 'd'.repeat(40) },
    reservation: { reserved_by: { lane_id: 'FIXTURE-RESERVATION-LANE', executor: 'fixture' }, adjudicator_lane_id: over.adjudicator ?? 'FIXTURE-ADJUDICATOR-LANE', reservation_date: '2026-01-01' },
    chain: { predecessor: tipRef(same) },
    authority_class: C().record_schema.RECERT_ATTEMPT.authority_class,
    authorizes: [],
    meaning: C().attempt_meaning,
  }
}
/** An ADJUDICATION of class `cls` resolving attempt `att`, at the tip of `prefix`. */
function adjudicationFor(ks: KnownSubject, cls: string, att: Stored, prefix: Stored[]): Adjudication {
  const a = att.record as Attempt
  const subject = identityOf(ks)
  subject.candidate_sha = a.subject.candidate_sha
  subject.package_digest = a.subject.package_digest
  const same = chainOrder(prefix.filter((s) => s.record.subject_kind === ks.subject_kind))
  const positive = cls === 'PASS' || cls === 'PASS_WITH_NONBLOCKING_FINDINGS'
  const nb = cls === 'PASS' ? [] : [{ id: 'FIX-NB-1', summary: 'fixture nonblocking finding', status: 'OPEN' }]
  const blocking = positive ? [] : cls === 'FAIL' ? [{ id: 'FIX-B-1', summary: 'fixture blocking finding' }] : []
  return {
    record_type: 'ADJUDICATION',
    contract: contractRef(),
    subject_kind: ks.subject_kind,
    subject,
    verdict: { verdict_class: cls, verdict_literal: LITERAL[cls], blocking_findings_count: blocking.length, nonblocking_findings_reported_count: nb.length },
    blocking_findings: blocking,
    nonblocking_findings: nb,
    closes_predecessor_findings: [],
    provenance: {
      candidate_author: { lane_id: 'FIXTURE-AUTHOR-LANE', executor: 'fixture' },
      independent_adjudicator: {
        lane_id: a.reservation.adjudicator_lane_id,
        executor: 'fixture',
        examined_candidate_sha: subject.candidate_sha,
        examined_tree_sha: subject.tree_sha,
        adjudication_date: '2026-01-02',
        scope: 'FOCUSED_REMEDIATION',
        scope_basis: ['fixture://prior-round'],
        report_reference: 'fixture://report',
      },
      materializer: { lane_id: 'FIXTURE-MATERIALIZER-LANE', executor: 'fixture', materialization_date: '2026-01-03' },
      identity_facts_basis: 'MATERIALIZER_REDERIVED',
      verdict_and_findings_basis: 'ADJUDICATOR_REPORTED_SECOND_HAND',
      materializer_reproduced_adjudication_evidence: false,
      independence_basis: 'PROCESS_GOVERNED',
    },
    resolves_attempt: { path: att.path, record_digest: recordDigest(a), attempt_id: a.attempt_id },
    chain: { predecessor: tipRef(same) },
    authority_class: C().record_schema.ADJUDICATION.authority_class,
    authorizes: [],
    meaning: C().meaning,
  }
}
const stored = (r: Rec): Stored => ({ path: recordPathFor(C(), r), record: r })
const knownFor = (r: Rec): KnownSubject | undefined =>
  AUTH.SECTION_F5_KNOWN_SUBJECTS_V3.subjects.find((k) => k.candidate_sha === r.subject.candidate_sha && k.subject_kind === r.subject_kind)
/** Fixture re-derivation: a known candidate's recorded identity; any other fixture candidate is taken as recorded. */
const derivedDefault = (r: Rec): Identity => {
  const k = knownFor(r)
  if (k) return identityOf(k)
  return isAttempt(r) ? { ...r.subject, entries: [], governing_families: [], governing_family_members_at_candidate: [] } : clone(r.subject)
}
function ctxFor(r: Rec, over: Partial<Ctx> = {}): Ctx {
  return {
    mode: 'write',
    contract: C(),
    knownSubjects: AUTH.SECTION_F5_KNOWN_SUBJECTS_V3.subjects,
    contractPath: PATHS.v105,
    contractBlob: CONTRACT_BLOB,
    recordPath: recordPathFor(C(), r),
    derived: derivedDefault(r),
    target: knownFor(r)?.id ?? null,
    existing: [],
    historyViolations: [],
    ...over,
  }
}
const SIBLING = 'b'.repeat(40)

/* ---------- real git fixture repositories (private temp dir) ---------- */

let repoSeq = 0
class FixtureRepo {
  readonly dir: string
  readonly genesis: string
  constructor(dir?: string) {
    this.dir = dir ?? path.join(PRIVATE, `r${repoSeq++}`)
    if (dir) {
      this.genesis = text(cgit(this.dir, ['rev-list', '--max-parents=0', 'HEAD']))
      return
    }
    mkdirSync(this.dir, { recursive: true })
    this.g(['init', '-q', '-b', 'main', '.'])
    // Unique content: two repositories created within one second with identical content
    // and identity would share one base commit id and make "foreign" commits vacuous.
    this.write('README.fixture', `fixture ${path.basename(this.dir)} ${process.pid} ${Date.now()}\n`)
    this.commit('base')
    this.genesis = this.head()
  }
  /** Fixture WRITES (setup only): plain git with fixture identity. */
  g(args: string[]): string {
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: this.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(this.dir) },
    }).trim()
  }
  write(rel: string, content: string): void {
    const abs = path.join(this.dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  put(s: Stored): void {
    this.write(s.path, canonicalPretty(s.record))
  }
  commit(msg: string): string {
    this.g(['add', '-A'])
    this.g(['commit', '-q', '--allow-empty', '-m', msg])
    return this.head()
  }
  head(): string {
    return this.g(['rev-parse', 'HEAD'])
  }
  /** Entries under the root at a ref, with mode and EXACT blob bytes (controlled reads). */
  rawAt(ref: string, run: Runner = cgit): RawEntry[] {
    const entries = lsTree(this.dir, ref, [C().path_and_identity.adjudication_root], run)
    const bytes = readBlobs(entries.filter((e) => e.type === 'blob').map((e) => e.oid), this.dir, run)
    return entries.map((e) => ({ path: e.path, mode: e.mode, oid: e.oid, bytes: e.type === 'blob' ? (bytes.get(e.oid) ?? '') : '' }))
  }
  storeAt(ref = 'HEAD', tip = ref, run: Runner = cgit): Store {
    const root = C().path_and_identity.adjudication_root
    const occ = AUTH.SECTION_F7_MATERIALIZATION_AND_RESERVATION_WRITE_SET.retired_occurrence_root
    const raw = this.rawAt(ref, run)
    const records: Stored[] = []
    for (const e of raw) {
      try {
        records.push({ path: e.path, record: JSON.parse(e.bytes) as Rec })
      } catch {
        /* caught by storeIntegrity */
      }
    }
    return {
      raw,
      records,
      history: everAddedViolations(this.dir, root, new Map(raw.map((e) => [e.path, e.oid])), run, ref),
      shallow: isShallow(this.dir, run),
      occurrenceRootFiles: lsTree(this.dir, ref, [occ], run).map((e) => e.path),
      envViolations: environmentViolations(this.dir, run),
      objectIntegrity: objectIntegrityViolations(this.dir, run),
      tipRaw: new Map(lsTree(this.dir, tip, [root], run).map((e) => [e.path, e.oid])),
    }
  }
  isAncestor(a: string, b: string): boolean {
    return isAncestorIn(this.dir, a, b)
  }
}

/** A chain of records written one commit each; attempts observe the fixture tip at reservation. */
class Scenario {
  readonly repo = new FixtureRepo()
  readonly recs: Stored[] = []
  attempt(ks: KnownSubject = KS_A, over: AttemptOver = {}): Stored {
    const s = stored(attemptFor(ks, this.recs, { tip: this.repo.head(), ...over }))
    this.repo.put(s)
    this.repo.commit(`reserve ${s.record.subject_kind}`)
    this.recs.push(s)
    return s
  }
  adjudicate(cls: string, att: Stored, ks: KnownSubject = KS_A, edit?: (r: Adjudication) => void): Stored {
    const r = adjudicationFor(ks, cls, att, this.recs)
    edit?.(r)
    const s = stored(r)
    this.repo.put(s)
    this.repo.commit(`adjudicate ${cls}`)
    this.recs.push(s)
    return s
  }
  consume(kind = CENSUS, over: Partial<ConsumerInput> = {}): ConsumerResult {
    const head = this.repo.head()
    return consume({
      contract: C(),
      kind,
      head: introducingView(),
      headSha: head,
      store: this.repo.storeAt('HEAD', head),
      provider: protectedProvider(head),
      genesis: this.repo.genesis,
      isAncestor: (a, b) => this.repo.isAncestor(a, b),
      contractPath: PATHS.v105,
      contractBlob: CONTRACT_BLOB,
      derivedFor: derivedDefault,
      targetFor: (r) => knownFor(r)?.id ?? null,
      ...over,
    })
  }
}
const B_PRESENT = hasCommit(KS_B.candidate_sha)

/* ========================================================================== */
/* §1 owner record v1.0.3                                                     */
/* ========================================================================== */

describe('§1 owner decisions RECERT_ATTEMPT_RESERVATION and CANONICAL_CERT_STORE_FORCE_PUSH_POLICY', () => {
  const owner = readJson<{ owner_decision_verbatim: Record<string, string[]>; structured_decision: Record<string, unknown>; companion_authority_amendment: string }>(PATHS.owner103)
  it('verbatim and structured forms agree; both are SIGNED; Event A stays PENDING', () => {
    const a = owner.owner_decision_verbatim.RECERT_ATTEMPT_RESERVATION.join('\n')
    const s = owner.owner_decision_verbatim.CANONICAL_CERT_STORE_FORCE_PUSH_POLICY.join('\n')
    expect(a).toContain('RECERT_ATTEMPT_RESERVATION_REQUIRED = YES')
    expect(a).toContain('OPEN attempt => STOP_RECERT_ATTEMPT_OPEN.')
    expect(s).toContain('PROVIDER_ENFORCED_NO_FORCE_PUSH_REQUIRED')
    expect(s).toContain('Do NOT mutate branch protection in this lane.')
    expect(owner.structured_decision.RECERT_ATTEMPT_RESERVATION_REQUIRED).toBe('YES')
    expect(owner.structured_decision.CANONICAL_CERT_STORE_FORCE_PUSH_POLICY).toBe('PROVIDER_ENFORCED_NO_FORCE_PUSH_REQUIRED')
    expect(owner.structured_decision.BRANCH_PROTECTION_MUTATION_IN_THIS_LANE).toBe('FORBIDDEN')
    expect(owner.structured_decision.EVENT_A_POLICY).toBe('PENDING')
    expect(owner.companion_authority_amendment).toBe(PATHS.v105)
  })
  it('every binding field the owner names is a key of the attempt schema', () => {
    const schema = C().record_schema.RECERT_ATTEMPT
    const flat = [...schema.top_level_keys_exact, ...Object.entries(schema.nested_keys_exact).flatMap(([k, ks]) => ks.map((x) => `${k}.${x}`))]
    for (const f of ['attempt_id', 'subject_kind', 'subject.package_digest', 'subject.candidate_sha', 'subject.tree_sha', 'prior_state.state', 'canonical_store.ref', 'canonical_store.tip_observed_at_reservation']) {
      expect(flat).toContain(f)
    }
  })
  it('the owner record blob pinned in SECTION_F2 and the declared layers is the actual blob', () => {
    const blob = gitBlobSha(readBytes(PATHS.owner103))
    expect(AUTH.SECTION_F2_OWNER_DECISION_BINDING.owner_record).toBe(PATHS.owner103)
    expect(AUTH.SECTION_F2_OWNER_DECISION_BINDING.owner_record_blob).toBe(blob)
    for (const kind of [CENSUS, OFFLINE]) {
      const layers = C().currency.declared_non_invalidating_governing_layers[kind] as Declared[]
      expect(layers.find((d) => d.path === PATHS.owner103)?.blob).toBe(blob)
      expect(layers.find((d) => d.path === PATHS.v104)?.blob).toBe(gitBlobSha(readBytes(PATHS.v104)))
    }
  })
})

/* ========================================================================== */
/* §2 RCO_CLOSURE_DIGEST_V3                                                   */
/* ========================================================================== */

describe('§2 RCO_CLOSURE_DIGEST_V3 and the package kind', () => {
  it('the grammars this interpreter executes are exactly the normative grammars of SECTION_F3', () => {
    const g = C().subject_identity_derivation.grammars
    expect(Object.keys(g).sort()).toEqual(Object.keys(GRAMMARS).sort())
    for (const [k, re] of Object.entries(GRAMMARS)) expect(re.source, k).toBe(g[k])
  })
  it('KS-A recomputes EXACTLY from git at its candidate, with its v1.0.4 digest', () => {
    const v104 = readJson<{ SECTION_E5_KNOWN_SUBJECTS_V2: { subjects: KnownSubject[] } }>(PATHS.v104).SECTION_E5_KNOWN_SUBJECTS_V2.subjects
    const d = deriveV3(C(), CENSUS, KS_A.candidate_sha, KS_A.tree_sha, commitView(KS_A.candidate_sha)) as Derived
    expect(d.package_digest).toBe(KS_A.package_digest)
    expect(d.entries).toEqual(KS_A.entries)
    expect(d.governing_family_members_at_candidate).toEqual(KS_A.governing_family_members_at_candidate)
    expect(KS_A.package_digest).toBe(v104.find((k) => k.id === 'KS-A')?.package_digest)
    expect(KS_B.package_digest).toBe(v104.find((k) => k.id === 'KS-B')?.package_digest)
    expect(KS_B.entries).toEqual(v104.find((k) => k.id === 'KS-B')?.entries)
  })
  it('KS-B recomputes from git at its candidate when the candidate is fetched (required in CI: fetch-depth 0)', () => {
    if (!B_PRESENT) {
      expect(process.env.CI).toBeFalsy()
      return
    }
    const d = deriveV3(C(), OFFLINE, KS_B.candidate_sha, KS_B.tree_sha, commitView(KS_B.candidate_sha)) as Derived
    expect(d.package_digest).toBe(KS_B.package_digest)
    expect(d.entries).toEqual(KS_B.entries)
  })
  it('the package kind derives at the introducing tree: it covers this artifact, its owner record and this test, and excludes only absent references', () => {
    const d = deriveV3(C(), PACKAGE, '0'.repeat(40), '1'.repeat(40), introducingView())
    expect(typeof d).not.toBe('string')
    const id = d as Derived
    const covered = id.entries.filter((e) => e.role === 'COVERED').map((e) => e.path)
    for (const p of [PATHS.v105, PATHS.owner103, PATHS.self, PATHS.battery, PATHS.manifest105, PATHS.v100]) expect(covered).toContain(p)
    expect(covered.some((p) => p.startsWith(C().path_and_identity.adjudication_root))).toBe(false)
    for (const x of id.excluded_absent_references) expect(introducingView().blob(x)).toBeNull()
    expect(id.entries.filter((e) => e.role === 'TOOLCHAIN').map((e) => e.path)).toContain('pnpm-lock.yaml')
  })
  it('the import grammar reads statements, not import-shaped strings inside code', () => {
    const v = patchedView(introducingView(), {
      'scripts/recovery/x.ts': { blob: '2'.repeat(40), text: 'const s = "import y from \'./missing\'"\nexport const k = 1\n' },
    })
    expect(typeof deriveV3(C(), OFFLINE, '0'.repeat(40), '1'.repeat(40), v)).not.toBe('string')
    const stmt = patchedView(introducingView(), { 'scripts/recovery/x.ts': { blob: '2'.repeat(40), text: "import y from './missing'\n" } })
    expect(deriveV3(C(), OFFLINE, '0'.repeat(40), '1'.repeat(40), stmt)).toMatch(/^unresolved import/)
    const multi = patchedView(introducingView(), { 'scripts/recovery/x.ts': { blob: '2'.repeat(40), text: "import {\n  a,\n  b,\n} from './missing'\n" } })
    expect(deriveV3(C(), OFFLINE, '0'.repeat(40), '1'.repeat(40), multi)).toMatch(/^unresolved import/)
    const call = patchedView(introducingView(), { 'scripts/recovery/x.ts': { blob: '2'.repeat(40), text: 'const m = ' + 'req' + "uire('./missing')\n" } })
    expect(deriveV3(C(), OFFLINE, '0'.repeat(40), '1'.repeat(40), call)).toMatch(/^unresolved import/)
  })
  it('a runtime literal with several "../" segments is collected (RNB-LIT)', () => {
    const v = patchedView(introducingView(), {
      'scripts/recovery/deep/x.ts': { blob: '3'.repeat(40), text: "const f = '../../../db/baseline/stella_g2_schema.sql'\n" },
    })
    const d = deriveV3(C(), OFFLINE, '0'.repeat(40), '1'.repeat(40), v) as Derived
    expect(d.entries.find((e) => e.path === 'db/baseline/stella_g2_schema.sql')?.role).toBe('RUNTIME_INPUT')
    expect(LITERAL_RE.source).toContain('(?:\\.{1,2}\\/)+')
  })
  it('absent references STOP for CENSUS and OFFLINE and are excluded for PACKAGE', () => {
    const ref = 'docs/ops/release/' + 'ABSENT_AUTHORITY_v9.9.9.json'
    const off = patchedView(introducingView(), { 'scripts/recovery/x.ts': { blob: '4'.repeat(40), text: `// ${ref}\n` } })
    expect(deriveV3(C(), OFFLINE, '0'.repeat(40), '1'.repeat(40), off)).toBe(`dangling ${ref}`)
    const pkg = patchedView(introducingView(), { 'tests/release/staging-recovery-x.test.ts': { blob: '4'.repeat(40), text: `// ${ref}\n` } })
    expect((deriveV3(C(), PACKAGE, '0'.repeat(40), '1'.repeat(40), pkg) as Derived).excluded_absent_references).toContain(ref)
    expect(C().subject_kinds.kinds[CENSUS].absent_reference_policy).toBe('STOP')
    expect(C().subject_kinds.kinds[OFFLINE].absent_reference_policy).toBe('STOP')
    expect(C().subject_kinds.kinds[PACKAGE].absent_reference_policy).toBe('EXCLUDE')
  })
  it('an unresolvable import, a missing toolchain root or setup file fails the derivation', () => {
    const noRoot = patchedView(introducingView(), { 'tsconfig.json': null })
    expect(deriveV3(C(), PACKAGE, '0'.repeat(40), '1'.repeat(40), noRoot)).toBe('toolchain root missing tsconfig.json')
    const noSetup = patchedView(introducingView(), { 'vitest.setup.ts': null })
    expect(deriveV3(C(), PACKAGE, '0'.repeat(40), '1'.repeat(40), noSetup)).toBe('setup file missing vitest.setup.ts')
    expect(deriveV3(C(), OFFLINE, '0'.repeat(40), '1'.repeat(40), introducingView())).toBe('empty COVERED')
  })
})

/* ========================================================================== */
/* §3 controlled git read environment                                         */
/* ========================================================================== */

describe('§3 every git-rewrite mechanism is neutralized by the controlled reads (R3-2)', () => {
  const logOf = (repo: FixtureRepo, run: Runner): string[] => text(run(repo.dir, ['log', '--format=%s', 'HEAD'])).split('\n')
  const pathsAt = (repo: FixtureRepo, run: Runner): string[] => lsTree(repo.dir, 'HEAD', [], run).map((e) => e.path)
  /** base -> add r/fail.json -> delete it and add r/pass.json */
  function failThenPass(): { repo: FixtureRepo; fail: string; head: string } {
    const repo = new FixtureRepo()
    repo.write('docs/ops/release/rca/f.json', '{}\n')
    const fail = repo.commit('fail')
    repo.g(['rm', '-q', 'docs/ops/release/rca/f.json'])
    repo.write('docs/ops/release/rca/p.json', '{}\n')
    return { repo, fail, head: repo.commit('pass') }
  }
  it('the per-command flags pin every key the reads depend on; the environment is built from nothing', () => {
    expect(CONTROLLED_FLAGS[0]).toBe('--no-replace-objects')
    expect(PINNED.map(([k]) => k)).toEqual(expect.arrayContaining(['core.commitGraph', 'core.useReplaceRefs', 'log.showRoot', 'diff.renames', 'diff.relative', 'log.follow']))
    const env = controlledEnv({ PATH: 'p', Git_Dir: 'x', GIT_CONFIG_PARAMETERS: "'log.showroot'='false'", GIT_NAMESPACE: 'n' })
    expect(Object.keys(env).filter((k) => /^git_/i.test(k)).sort()).toEqual(
      ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_GRAFT_FILE', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_OPTIONAL_LOCKS', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT'].sort(),
    )
    expect(env.GIT_GRAFT_FILE.startsWith(PRIVATE)).toBe(true)
    expect(existsSync(env.GIT_GRAFT_FILE)).toBe(false)
  })
  it('replace refs rewrite log AND ls-tree in a naive read; the controlled read sees the real objects', () => {
    const { repo, fail, head } = failThenPass()
    const fake = repo.g(['commit-tree', `${fail}^{tree}`, '-p', fail, '-m', 'pass'])
    repo.g(['replace', head, fake])
    expect(pathsAt(repo, naive)).toContain('docs/ops/release/rca/f.json')
    expect(pathsAt(repo, cgit)).not.toContain('docs/ops/release/rca/f.json')
    expect(pathsAt(repo, cgit)).toContain('docs/ops/release/rca/p.json')
    const hidden = new FixtureRepo()
    hidden.write('docs/ops/release/rca/x.json', '{}\n')
    const added = hidden.commit('add')
    hidden.g(['rm', '-q', 'docs/ops/release/rca/x.json'])
    hidden.commit('delete')
    hidden.write('docs/ops/release/rca/x.json', '{}\n')
    const readd = hidden.commit('re-add')
    const graft = hidden.g(['commit-tree', `${readd}^{tree}`, '-p', added, '-m', 're-add'])
    hidden.g(['replace', readd, graft])
    const at = new Map([['docs/ops/release/rca/x.json', lsTree(hidden.dir, 'HEAD', [], cgit).find((e) => e.path.endsWith('x.json'))?.oid as string]])
    expect(everAddedViolations(hidden.dir, 'docs/ops/release/rca/', at, naive)).not.toContain('D docs/ops/release/rca/x.json')
    expect(everAddedViolations(hidden.dir, 'docs/ops/release/rca/', at, cgit)).toContain('D docs/ops/release/rca/x.json')
  })
  it('an info/grafts file hides parents in a naive read; the controlled read ignores it', () => {
    const { repo, head } = failThenPass()
    writeFileSync(path.join(repo.dir, '.git', 'info', 'grafts'), `${head}\n`)
    expect(logOf(repo, naive)).toEqual(['pass'])
    expect(logOf(repo, cgit)).toEqual(['pass', 'fail', 'base'])
  })
  it('a forged commit-graph hides a delete from a naive read; core.commitGraph=false restores it', () => {
    const repo = new FixtureRepo()
    repo.write('docs/ops/release/rca/x.json', '{}\n')
    const added = repo.commit('add')
    repo.g(['rm', '-q', 'docs/ops/release/rca/x.json'])
    repo.commit('delete')
    repo.write('docs/ops/release/rca/x.json', '{}\n')
    const head = repo.commit('re-add')
    repo.g(['commit-graph', 'write', '--reachable'])
    const cgPath = path.join(repo.dir, '.git', 'objects', 'info', 'commit-graph')
    const buf = readFileSync(cgPath)
    const chunks: Record<string, number> = {}
    for (let i = 0; i <= buf[6]; i++) chunks[buf.subarray(8 + i * 12, 12 + i * 12).toString('latin1')] = Number(buf.readBigUInt64BE(12 + i * 12))
    const oids = [...Array((chunks.CDAT - chunks.OIDL) / 20)].map((_, i) => buf.subarray(chunks.OIDL + i * 20, chunks.OIDL + i * 20 + 20).toString('hex'))
    buf.writeUInt32BE(oids.indexOf(added), chunks.CDAT + oids.indexOf(head) * 36 + 20)
    chmodSync(cgPath, 0o644)
    writeFileSync(cgPath, buf)
    expect(logOf(repo, naive)).toEqual(['re-add', 'add', 'base'])
    expect(logOf(repo, cgit)).toEqual(['re-add', 'delete', 'add', 'base'])
    const at = new Map([['docs/ops/release/rca/x.json', lsTree(repo.dir, 'HEAD', [], cgit).find((e) => e.path.endsWith('x.json'))?.oid as string]])
    expect(everAddedViolations(repo.dir, 'docs/ops/release/rca/', at, cgit)).toContain('D docs/ops/release/rca/x.json')
  })
  it('a repository log.showRoot=false hides the root add in a naive read; the pin restores it', () => {
    const repo = new FixtureRepo()
    repo.g(['config', 'log.showRoot', 'false'])
    const names = (run: Runner): string => run(repo.dir, ['log', '--format=%x01', '--name-only', '--', 'README.fixture']).toString('utf8')
    expect(names(naive)).not.toContain('README.fixture')
    expect(names(cgit)).toContain('README.fixture')
  })
  it('an alias cannot shadow a built-in; repository and included configuration cannot override a pin', () => {
    const repo = new FixtureRepo()
    repo.g(['config', 'alias.log', 'log --oneline -1'])
    repo.g(['config', 'alias.ls-tree', 'ls-tree HEAD~0'])
    repo.write('docs/ops/release/rca/x.json', '{}\n')
    repo.commit('add')
    expect(logOf(repo, naive)).toEqual(['add', 'base'])
    const inc = path.join(repo.dir, 'hostile.gitconfig')
    writeFileSync(inc, '[log]\n\tshowRoot = false\n[diff]\n\trenames = true\n\trelative = true\n[core]\n\tuseReplaceRefs = true\n\tcommitGraph = true\n')
    repo.g(['config', 'include.path', inc])
    expect(environmentViolations(repo.dir, cgit)).toEqual([])
    expect(environmentViolations(repo.dir, naive).length).toBeGreaterThan(0)
  })
  it('an inherited hostile environment does not reach the controlled reads', () => {
    const repo = new FixtureRepo()
    const other = new FixtureRepo()
    const hostile: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_PARAMETERS: "'log.showroot'='false' 'core.commitgraph'='true'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'log.showRoot',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_DIR: path.join(other.dir, '.git'),
      GIT_NAMESPACE: 'hostile',
    }
    expect(other.head()).not.toBe(repo.head())
    const run = makeControlled(hostile)
    expect(environmentViolations(repo.dir, run)).toEqual([])
    expect(text(run(repo.dir, ['rev-parse', 'HEAD']))).toBe(repo.head())
    const leaky: Runner = (cwd, args) => execFileSync('git', [...CONTROLLED_FLAGS, ...args], { cwd, env: hostile, stdio: ['pipe', 'pipe', 'ignore'] })
    expect(text(leaky(repo.dir, ['rev-parse', 'HEAD']))).toBe(other.head())
  })
  it('the self-check reports an unpinned or uncontrolled runner, a global or system scope, a non-sha1 repository and a present graft path', () => {
    const repo = new FixtureRepo()
    expect(environmentViolations(repo.dir)).toEqual([])
    expect(environmentViolations(repo.dir, naive).some((v) => v.startsWith('pin '))).toBe(true)
    const hostileGlobal = path.join(PRIVATE, `global${repoSeq++}.gitconfig`)
    writeFileSync(hostileGlobal, '[user]\n\tname = hostile\n')
    const withGlobal: Runner = (cwd, args, input) =>
      execFileSync('git', [...CONTROLLED_FLAGS, ...args], { cwd, env: { ...controlledEnv(), GIT_CONFIG_GLOBAL: hostileGlobal } as unknown as NodeJS.ProcessEnv, input, stdio: ['pipe', 'pipe', 'ignore'] })
    expect(environmentViolations(repo.dir, withGlobal)).toEqual(['scope global'])
    const sha256Dir = path.join(PRIVATE, `s256${repoSeq++}`)
    mkdirSync(sha256Dir)
    execFileSync('git', ['init', '-q', '--object-format=sha256', '.'], { cwd: sha256Dir, stdio: 'ignore' })
    expect(environmentViolations(sha256Dir)).toEqual(['object format'])
    writeFileSync(GRAFT_FILE, '')
    try {
      expect(() => environmentViolations(repo.dir)).toThrow()
    } finally {
      rmSync(GRAFT_FILE, { force: true })
    }
  })
  it('a loose object rewritten under its own id hides a side-branch FAIL from every ordinary read; fsck detects it (review B1)', () => {
    const repo = new FixtureRepo()
    repo.g(['checkout', '-q', '-b', 'side'])
    repo.write('docs/ops/release/rca/fail.json', '{}\n')
    const side = repo.commit('side FAIL')
    repo.g(['checkout', '-q', 'main'])
    repo.write('docs/ops/release/rca/pass.json', '{"p":1}\n')
    repo.commit('PASS')
    repo.g(['merge', '-q', '-s', 'ours', '--no-edit', 'side'])
    const merge = repo.head()
    const at = new Map(lsTree(repo.dir, 'HEAD', ['docs/ops/release/rca/']).map((e) => [e.path, e.oid]))
    expect(everAddedViolations(repo.dir, 'docs/ops/release/rca/', at)).toContain('ever-added absent at H docs/ops/release/rca/fail.json')
    expect(objectIntegrityViolations(repo.dir)).toEqual([])
    const body = repo.g(['cat-file', 'commit', merge]) + '\n'
    const lines = body.split('\n')
    const firstParent = lines.findIndex((l) => l.startsWith('parent '))
    const forged = lines.filter((l, i) => !(l.startsWith('parent ') && i !== firstParent)).join('\n')
    const obj = path.join(repo.dir, '.git', 'objects', merge.slice(0, 2), merge.slice(2))
    chmodSync(obj, 0o644)
    writeFileSync(obj, deflateSync(Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(forged)}\0`), Buffer.from(forged)])))
    expect(repo.head()).toBe(merge)
    expect(everAddedViolations(repo.dir, 'docs/ops/release/rca/', at)).toEqual([])
    expect(isAncestorIn(repo.dir, side, merge)).toBe(false)
    expect(objectIntegrityViolations(repo.dir)).toEqual(['fsck exit 3'])
    repo.g(['config', 'fsck.skipList', path.join(PRIVATE, 'no-such-skiplist')])
    expect(environmentViolations(repo.dir)).toContain('fsck config fsck.skiplist')
  })
  it('a shallow clone is detected', () => {
    const src = failThenPass().repo
    const dst = path.join(PRIVATE, `shallow${repoSeq++}`)
    execFileSync('git', ['clone', '-q', '--depth', '1', `file:///${src.dir.replace(/\\/g, '/')}`, dst], { stdio: 'ignore' })
    expect(isShallow(dst)).toBe(true)
    expect(isShallow(src.dir)).toBe(false)
  })
})

/* ========================================================================== */
/* §4 ever-added history on real DAGs (R3-1)                                  */
/* ========================================================================== */

describe('§4 ever-added store integrity over the FULL git DAG (R3-1)', () => {
  const ROOT_DIR = 'docs/ops/release/rca/'
  const fileA = `${ROOT_DIR}CENSUS/${'a'.repeat(64)}/${'1'.repeat(64)}.json`
  const fileB = `${ROOT_DIR}CENSUS/${'a'.repeat(64)}/${'2'.repeat(64)}.json`
  const violations = (repo: FixtureRepo): string[] => {
    const raw = lsTree(repo.dir, 'HEAD', [ROOT_DIR])
    return everAddedViolations(repo.dir, ROOT_DIR, new Map(raw.map((e) => [e.path, e.oid])))
  }
  it('a single add, a root-commit add and a side-branch add merged normally are clean', () => {
    const plain = new FixtureRepo()
    plain.write(fileA, '{"a":1}\n')
    plain.commit('add')
    expect(violations(plain)).toEqual([])
    const rootDir = path.join(PRIVATE, `root${repoSeq++}`)
    mkdirSync(path.join(rootDir, path.dirname(fileA)), { recursive: true })
    writeFileSync(path.join(rootDir, fileA), '{"a":1}\n')
    const fx = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false']
    for (const a of [['init', '-q', '-b', 'main', '.'], ['add', '-A'], [...fx, 'commit', '-q', '-m', 'root add']]) execFileSync('git', a, { cwd: rootDir, stdio: 'ignore' })
    const root = new FixtureRepo(rootDir)
    expect(lsTree(root.dir, 'HEAD').map((e) => e.path)).toEqual([fileA])
    expect(violations(root)).toEqual([])
    const side = new FixtureRepo()
    side.g(['checkout', '-q', '-b', 'side'])
    side.write(fileB, '{"b":1}\n')
    side.commit('side add')
    side.g(['checkout', '-q', 'main'])
    side.write(fileA, '{"a":1}\n')
    side.commit('main add')
    side.g(['merge', '-q', '--no-edit', 'side'])
    expect(violations(side)).toEqual([])
  })
  it('merge -s ours DROPS a side-branch FAIL: the ever-added path absent at H is a violation (RB-1)', () => {
    const repo = new FixtureRepo()
    repo.g(['checkout', '-q', '-b', 'side'])
    repo.write(fileB, '{"fail":1}\n')
    repo.commit('side FAIL')
    repo.g(['checkout', '-q', 'main'])
    repo.write(fileA, '{"pass":1}\n')
    repo.commit('PASS')
    repo.g(['merge', '-q', '-s', 'ours', '--no-edit', 'side'])
    expect(lsTree(repo.dir, 'HEAD', [ROOT_DIR]).map((e) => e.path)).toEqual([fileA])
    expect(violations(repo)).toContain(`ever-added absent at H ${fileB}`)
  })
  it('a normal merge followed by git rm is a violation (delete and absent)', () => {
    const repo = new FixtureRepo()
    repo.g(['checkout', '-q', '-b', 'side'])
    repo.write(fileB, '{"fail":1}\n')
    repo.commit('side FAIL')
    repo.g(['checkout', '-q', 'main'])
    repo.g(['merge', '-q', '--no-edit', 'side'])
    repo.g(['rm', '-q', fileB])
    repo.commit('drop FAIL')
    const v = violations(repo)
    expect(v).toContain(`D ${fileB}`)
    expect(v).toContain(`ever-added absent at H ${fileB}`)
  })
  it('an evil merge that rewrites a record is a violation (combined entry, blob changed)', () => {
    const repo = new FixtureRepo()
    repo.write(fileA, '{"pass":1}\n')
    repo.commit('PASS')
    repo.g(['checkout', '-q', '-b', 'e'])
    repo.write('y', 'y\n')
    repo.commit('e')
    repo.g(['checkout', '-q', 'main'])
    repo.write('z', 'z\n')
    repo.commit('z')
    repo.g(['merge', '-q', '--no-commit', 'e'])
    repo.write(fileA, '{"pass":2}\n')
    repo.g(['add', fileA])
    repo.g(['commit', '-q', '-m', 'evil'])
    const v = violations(repo)
    expect(v).toContain(`merge-entry ${fileA}`)
    expect(v).toContain(`introducing blob changed ${fileA}`)
  })
  it('add/add of one path on two branches is a violation, although the merge result looks clean', () => {
    const repo = new FixtureRepo()
    repo.g(['checkout', '-q', '-b', 'side'])
    repo.write(fileA, '{"v":2}\n')
    repo.commit('side add')
    repo.g(['checkout', '-q', 'main'])
    repo.write(fileA, '{"v":1}\n')
    repo.commit('main add')
    try {
      repo.g(['merge', '-q', '--no-edit', 'side'])
    } catch {
      repo.write(fileA, '{"v":2}\n')
      repo.g(['add', fileA])
      repo.g(['commit', '-q', '--no-edit'])
    }
    expect(violations(repo)).toContain(`adds=2 ${fileA}`)
  })
  it('delete then restart, modify, and rename are violations', () => {
    const restart = new FixtureRepo()
    restart.write(fileA, '{"a":1}\n')
    restart.commit('add')
    restart.g(['rm', '-q', fileA])
    restart.commit('delete')
    restart.write(fileB, '{"b":1}\n')
    restart.commit('restart')
    expect(violations(restart)).toEqual(expect.arrayContaining([`D ${fileA}`, `ever-added absent at H ${fileA}`]))
    const modify = new FixtureRepo()
    modify.write(fileA, '{"a":1}\n')
    modify.commit('add')
    modify.write(fileA, '{"a":2}\n')
    modify.commit('modify')
    expect(violations(modify)).toEqual(expect.arrayContaining([`M ${fileA}`, `introducing blob changed ${fileA}`]))
    const rename = new FixtureRepo()
    rename.write(fileA, '{"a":1}\n')
    rename.commit('add')
    rename.g(['mv', fileA, fileB])
    rename.commit('rename')
    expect(violations(rename)).toEqual(expect.arrayContaining([`D ${fileA}`, `ever-added absent at H ${fileA}`]))
  })
  it('raw output the parser does not expect (renames not disabled) is a violation, never skipped', () => {
    const repo = new FixtureRepo()
    repo.write(fileA, '{"a":1}\n')
    repo.commit('add')
    repo.g(['mv', fileA, fileB])
    repo.commit('rename')
    const renaming: Runner = (cwd, args, input) => cgit(cwd, args.map((a) => (a === '--no-renames' ? '-M' : a)), input)
    const at = new Map(lsTree(repo.dir, 'HEAD', [ROOT_DIR]).map((e) => [e.path, e.oid]))
    const v = everAddedViolations(repo.dir, ROOT_DIR, at, renaming)
    expect(v.some((x) => x.startsWith('unparsed '))).toBe(true)
  })
  it('a path present at H with zero adds is a violation (hidden history)', () => {
    expect(everAddedViolations(new FixtureRepo().dir, ROOT_DIR, new Map([[fileA, '0'.repeat(40)]]))).toContain(`adds=0 ${fileA}`)
  })
  it('an executable-mode add is a violation', () => {
    const repo = new FixtureRepo()
    repo.write(fileA, '{"a":1}\n')
    repo.g(['add', fileA])
    repo.g(['update-index', '--chmod=+x', fileA])
    repo.g(['commit', '-q', '-m', 'exec'])
    expect(violations(repo)).toContain(`add mode 100755 ${fileA}`)
  })
})

/* ========================================================================== */
/* §5 attempt and adjudication records                                        */
/* ========================================================================== */

describe('§5 RECERT_ATTEMPT and ADJUDICATION validation', () => {
  const att = stored(attemptFor(KS_A, [], { tip: 'e'.repeat(40) }))
  const adj = stored(adjudicationFor(KS_A, 'PASS', att, [att]))
  const readCtx = (s: Stored, existing: Stored[]): Ctx => ctxFor(s.record, { mode: 'read', existing, recordPath: s.path })
  it('a fresh attempt and its resolving adjudication are VALID at write and at read', () => {
    expect(validate(att.record, ctxFor(att.record))).toBe('VALID')
    expect(validate(adj.record, ctxFor(adj.record, { existing: [att] }))).toBe('VALID')
    expect(validate(att.record, readCtx(att, [att, adj]))).toBe('VALID')
    expect(validate(adj.record, readCtx(adj, [att, adj]))).toBe('VALID')
  })
  it('file names are content-addressed, typed by form, and at most 170 characters', () => {
    expect(att.path).toMatch(/\/a-[0-9a-f]{64}\.json$/)
    expect(adj.path).not.toMatch(/\/a-/)
    const longest = stored(attemptFor({ ...KS_B, subject_kind: PACKAGE }, [], { tip: 'e'.repeat(40) }))
    expect(longest.path.length).toBeLessThanOrEqual(170)
    expect(storeIntegrity(C(), [{ path: att.path.replace('/a-', '/'), mode: '100644', oid: '0', bytes: canonicalPretty(att.record) }])[0]).toMatch(/^record type\/file form/)
  })
  it('an adjudication without a resolvable attempt, or resolving a mismatching one, STOPS', () => {
    const cases: [string, (r: Adjudication) => void][] = [
      ['missing', (r) => { r.resolves_attempt.path = r.resolves_attempt.path.replace(/a-[0-9a-f]{64}/, `a-${'f'.repeat(64)}`) }],
      ['digest', (r) => { r.resolves_attempt.record_digest = 'f'.repeat(64) }],
      ['id', (r) => { r.resolves_attempt.attempt_id = 'OTHER-ATTEMPT' }],
      ['adjudicator', (r) => { r.provenance.independent_adjudicator.lane_id = 'ANOTHER-ADJUDICATOR-LANE' }],
      ['candidate', (r) => { r.subject.candidate_sha = SIBLING; r.provenance.independent_adjudicator.examined_candidate_sha = SIBLING }],
      ['tree', (r) => { r.subject.tree_sha = 'c'.repeat(40); r.provenance.independent_adjudicator.examined_tree_sha = 'c'.repeat(40) }],
      ['date', (r) => { r.provenance.independent_adjudicator.adjudication_date = '2025-12-31' }],
      ['digest-subject', (r) => { r.subject.package_digest = 'f'.repeat(64) }],
    ]
    for (const [name, edit] of cases) {
      const r = clone(adj.record) as Adjudication
      edit(r)
      const c = ctxFor(r, { existing: [att], derived: clone(r.subject), target: null })
      if (name === 'digest-subject') expect(validate(r, c, new Set(['W7_DIGEST']))).toBe('STOP_RECERT_ATTEMPT_RESOLUTION_INVALID')
      else expect(validate(r, c), name).toBe('STOP_RECERT_ATTEMPT_RESOLUTION_INVALID')
    }
  })
  it('an adjudication naming an attempt of ANOTHER kind STOPS (naming a LATER attempt is impossible: content addressing makes it circular)', () => {
    const other = stored(attemptFor(KS_B, [], { tip: 'e'.repeat(40) }))
    const r = clone(adj.record) as Adjudication
    r.resolves_attempt = { path: other.path, record_digest: recordDigest(other.record), attempt_id: (other.record as Attempt).attempt_id }
    expect(validate(r, ctxFor(r, { existing: [att, other] }))).toBe('STOP_RECERT_ATTEMPT_RESOLUTION_INVALID')
  })
  it('no attempt has two outcomes: a second adjudication of the same attempt STOPS at write and at read', () => {
    const second = stored(adjudicationFor(KS_A, 'FAIL', att, [att, adj]))
    expect(validate(second.record, ctxFor(second.record, { existing: [att, adj] }))).toBe('STOP_RECERT_ATTEMPT_DOUBLY_RESOLVED')
    expect(validate(adj.record, readCtx(adj, [att, adj, second]))).toBe('STOP_RECERT_ATTEMPT_DOUBLY_RESOLVED')
  })
  it('attempt ids are unique (separator-insensitive); every id follows the lane grammar', () => {
    const dup = stored(attemptFor(KS_B, [att, adj], { tip: 'e'.repeat(40), attemptId: (att.record as Attempt).attempt_id.split('-').join('') }))
    expect(validate(dup.record, ctxFor(dup.record, { existing: [att, adj] }))).toBe('STOP_RECERT_ATTEMPT_ID_DUPLICATE')
    for (const bad of ['fixture-attempt', 'FIXTURE_ATTEMPT', 'FIXTURE--A']) {
      const r = attemptFor(KS_A, [], { tip: 'e'.repeat(40), attemptId: bad })
      expect(validate(r, ctxFor(r))).toBe('STOP_PROVENANCE_IDENTITY_MALFORMED')
    }
  })
  it('prior_state must be the computed state; a second attempt while one is open STOPS', () => {
    const wrong = attemptFor(KS_A, [], { tip: 'e'.repeat(40), prior: { state: 'RESOLVED_PASS', disposition_status: 'CERTIFIED' } })
    expect(validate(wrong, ctxFor(wrong))).toBe('STOP_RECERT_ATTEMPT_PRIOR_STATE_MISMATCH')
    const second = attemptFor(KS_A, [att], { tip: 'e'.repeat(40) })
    expect(second.prior_state.state).toBe('OPEN_ATTEMPT')
    expect(validate(second, ctxFor(second, { existing: [att] }))).toBe('STOP_RECERT_ATTEMPT_ALREADY_OPEN')
    const after = attemptFor(KS_A, [att, adj], { tip: 'e'.repeat(40) })
    expect(after.prior_state).toEqual({ state: 'RESOLVED_PASS', disposition_status: 'CERTIFIED' })
    expect(validate(after, ctxFor(after, { existing: [att, adj] }))).toBe('VALID')
  })
  it('attempt subject, canonical store, contract, authority and shape are enforced', () => {
    const edits: [string, (r: Attempt) => void][] = [
      ['STOP_CANONICAL_STORE_REF_MISMATCH', (r) => { r.canonical_store.ref = 'refs/heads/main' }],
      ['STOP_CANONICAL_STORE_REF_MISMATCH', (r) => { r.canonical_store.tip_observed_at_reservation = 'HEAD' }],
      ['STOP_TREE_SHA_MISMATCH', (r) => { r.subject.tree_sha = 'c'.repeat(40) }],
      ['STOP_PACKAGE_DIGEST_MISMATCH', (r) => { r.subject.package_digest = 'f'.repeat(64) }],
      ['STOP_PACKAGE_DIGEST_MISMATCH', (r) => { r.subject.digest_algorithm = 'RCO_CLOSURE_DIGEST_V2' }],
      ['STOP_CANDIDATE_SHA_MALFORMED', (r) => { r.subject.candidate_sha = 'HEAD' }],
      ['STOP_ADJUDICATION_CONTRACT_MISMATCH', (r) => { r.contract.path = PATHS.v104 }],
      ['STOP_ADJUDICATION_CLAIMS_AUTHORITY', (r) => { r.authorizes = ['MERGE'] }],
      ['STOP_ADJUDICATION_CLAIMS_AUTHORITY', (r) => { r.meaning = C().meaning }],
      ['STOP_RECERT_ATTEMPT_SHAPE', (r) => { (r as unknown as Record<string, unknown>).extra = 1 }],
      ['STOP_ADJUDICATION_SHAPE', (r) => { r.record_type = 'ADJUDICATION' }],
      ['STOP_UNKNOWN_SUBJECT_KIND', (r) => { r.subject_kind = 'OTHER' }],
    ]
    for (const [want, edit] of edits) {
      const r = clone(att.record) as Attempt
      edit(r)
      expect(validate(r, ctxFor(r, { recordPath: recordPathFor(C(), r), target: 'KS-A', derived: identityOf(KS_A) })), want).toBe(want)
    }
  })
  it('a record citing the superseded v1.0.4 SECTION_E3 is rejected', () => {
    const r = clone(adj.record) as Adjudication
    r.contract = { path: PATHS.v104, section: 'SECTION_E3_ADJUDICATION_CONTRACT', blob: gitBlobSha(readBytes(PATHS.v104)) }
    expect(validate(r, ctxFor(r, { existing: [att] }))).toBe('STOP_ADJUDICATION_CONTRACT_MISMATCH')
  })
  it('positive literals parse strictly with the extended vocabulary; non-positive literals are opaque', () => {
    const v = C().verdict
    expect(parseStrict(v, 'RECOVERY_CERT_STORE_DURABILITY_RECERT_PASS')).toBe('PASS')
    expect(parseStrict(v, 'RECOVERY_CERT_CONTRACT_REVOCATION_RECERT_PASS_WITH_NONBLOCKING_FINDINGS')).toBe('PASS_WITH_NONBLOCKING_FINDINGS')
    expect(literalOk(v, 'FAIL', 'RECOVERY_CERT_CONTRACT_REVOCATION_RECERT_FAIL')).toBe(true)
    expect(literalOk(v, 'FAIL', 'RECOVERY_CERT_RECERT_PASS')).toBe(false)
    expect(parseStrict(v, 'NOT_RECERT_PASS')).toBeNull()
  })
})

/* ========================================================================== */
/* §6 attempt states on real git fixtures (R3-4, R3-5)                        */
/* ========================================================================== */

describe('§6 attempt states and suspension on real git repositories', () => {
  it('no record: NO_ATTEMPT, not certified', () => {
    const s = new Scenario()
    expect(s.consume()).toMatchObject({ result: 'STOP_NOT_CERTIFIED', state: 'NO_ATTEMPT' })
  })
  it('attempt, no result: OPEN_ATTEMPT (lack of materialization is a STOP)', () => {
    const s = new Scenario()
    s.attempt()
    expect(s.consume()).toMatchObject({ result: 'STOP_RECERT_ATTEMPT_OPEN', state: 'OPEN_ATTEMPT' })
  })
  it('attempt, PASS: USABLE (RESOLVED_PASS), with scope reported', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    expect(s.consume()).toMatchObject({ result: 'USABLE', state: 'RESOLVED_PASS', disposition: 'CERTIFIED', package_digest: KS_A.package_digest, scopes: ['FOCUSED_REMEDIATION'] })
  })
  it('PASS -> new attempt -> no result materialized: the old PASS is SUSPENDED (STOP_RECERT_ATTEMPT_OPEN)', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    s.attempt()
    expect(s.consume()).toMatchObject({ result: 'STOP_RECERT_ATTEMPT_OPEN', state: 'OPEN_ATTEMPT', disposition: 'CERTIFIED' })
  })
  for (const cls of ['FAIL', 'BLOCKED', 'INSUFFICIENT_EVIDENCE']) {
    it(`PASS -> attempt -> ${cls}: REVOKED`, () => {
      const s = new Scenario()
      s.adjudicate('PASS', s.attempt())
      s.adjudicate(cls, s.attempt())
      expect(s.consume()).toMatchObject({ result: 'STOP_CERTIFICATION_REVOKED', state: 'RESOLVED_NON_POSITIVE', disposition: 'REVOKED' })
    })
  }
  it('PASS -> attempt -> PASS: usable only once the second attempt is resolved', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const second = s.attempt()
    expect(s.consume().result).toBe('STOP_RECERT_ATTEMPT_OPEN')
    s.adjudicate('PASS_WITH_NONBLOCKING_FINDINGS', second)
    expect(s.consume()).toMatchObject({ result: 'USABLE', state: 'RESOLVED_PASS', scopes: ['FOCUSED_REMEDIATION', 'FOCUSED_REMEDIATION'] })
  })
  it('a PASS on a sibling candidate SHA with the same package digest is revoked by a later FAIL (owner v1.0.2)', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    s.adjudicate('FAIL', s.attempt(KS_A, { candidate: SIBLING }))
    expect(s.consume().result).toBe('STOP_CERTIFICATION_REVOKED')
  })
  it('attempt -> FAIL only: NEGATIVELY adjudicated; a later PASS is a CONTRADICTION', () => {
    const s = new Scenario()
    s.adjudicate('FAIL', s.attempt())
    expect(s.consume()).toMatchObject({ result: 'STOP_NOT_CERTIFIED', state: 'RESOLVED_NON_POSITIVE' })
    s.adjudicate('PASS', s.attempt())
    expect(s.consume()).toMatchObject({ result: 'STOP_CONTRADICTORY_CERTIFICATION', state: 'CONTRADICTED' })
  })
  it('an open attempt on a DIFFERENT package digest does not suspend this one', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    s.attempt(KS_A, { candidate: SIBLING, digest: 'f'.repeat(64) })
    expect(s.consume().result).toBe('USABLE')
    const s2 = new Scenario()
    s2.adjudicate('PASS', s2.attempt())
    s2.attempt(KS_A, { digest: 'f'.repeat(64) })
    expect(s2.consume().result).toBe('STOP_ADJUDICATION_INVALID_AT_READ')
  })
  it('an adjudication that resolves no reserved attempt makes the store unusable', () => {
    const s = new Scenario()
    const a = s.attempt()
    s.adjudicate('PASS', a)
    const rogue = adjudicationFor(KS_A, 'PASS', a, s.recs)
    rogue.resolves_attempt = { path: a.path.replace(/a-[0-9a-f]{64}/, `a-${'f'.repeat(64)}`), record_digest: 'f'.repeat(64), attempt_id: 'NO-SUCH-ATTEMPT' }
    const st = stored(rogue)
    s.repo.put(st)
    s.repo.commit('rogue')
    expect(s.consume().result).toBe('STOP_ADJUDICATION_INVALID_AT_READ')
  })
  it('an invalid attempt of ANOTHER kind also STOPS this kind (root-wide validation)', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const bad = attemptFor(KS_B, s.recs, { tip: s.repo.head(), prior: { state: 'RESOLVED_PASS', disposition_status: 'CERTIFIED' } })
    s.repo.put(stored(bad))
    s.repo.commit('bad other-kind attempt')
    expect(s.consume().result).toBe('STOP_ADJUDICATION_INVALID_AT_READ')
  })
})

/* ========================================================================== */
/* §7 canonical store, provider protection and the attacks (R3-1, R3-3)       */
/* ========================================================================== */

describe('§7 canonical monotonicity, provider protection and store attacks', () => {
  it('the recorded 2026-09-24 provider state is STOP_PROVIDER_PROTECTION_REQUIRED, whatever the store holds', () => {
    expect(protectionPass(measuredProvider(), CANONICAL_REF)).toBe(false)
    expect(MEASURED.evaluation).toBe('STOP_PROVIDER_PROTECTION_REQUIRED')
    expect(MEASURED.classic_protection).toMatch(/404/)
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    expect(s.consume(CENSUS, { provider: { ...measuredProvider(), tip: s.repo.head() } }).result).toBe('STOP_PROVIDER_PROTECTION_REQUIRED')
  })
  it('the required ruleset passes; each weakening of it, or of classic protection, fails', () => {
    const tip = 'e'.repeat(40)
    expect(protectionPass(protectedProvider(tip), CANONICAL_REF)).toBe(true)
    const weak: [string, (p: Provider) => void][] = [
      ['no deletion rule', (p) => { p.rules = p.rules.filter((r) => r.type !== 'deletion') }],
      ['no non_fast_forward rule', (p) => { p.rules = p.rules.filter((r) => r.type !== 'non_fast_forward') }],
      ['rules from two rulesets', (p) => { p.rules = p.rules.map((r) => (r.type === 'deletion' ? { ...r, ruleset_id: 8 } : r)); p.rulesets[8] = clone(p.rulesets[7]) }],
      ['evaluate mode', (p) => { p.rulesets[7].enforcement = 'evaluate' }],
      ['bypass actor', (p) => { p.rulesets[7].bypass_actors = [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }] }],
      ['other ref', (p) => { p.rulesets[7].conditions.ref_name.include = ['refs/heads/main'] }],
      ['tag target', (p) => { p.rulesets[7].target = 'tag' }],
    ]
    for (const [name, edit] of weak) {
      const p = protectedProvider(tip)
      edit(p)
      expect(protectionPass(p, CANONICAL_REF), name).toBe(false)
    }
    const classic = (fp: boolean, del: boolean, admins: boolean): Provider => ({
      ...measuredProvider(),
      classic: { allow_force_pushes: { enabled: fp }, allow_deletions: { enabled: del }, enforce_admins: { enabled: admins } },
    })
    expect(protectionPass(classic(false, false, true), CANONICAL_REF)).toBe(true)
    expect(protectionPass(classic(true, false, true), CANONICAL_REF)).toBe(false)
    expect(protectionPass(classic(false, true, true), CANONICAL_REF)).toBe(false)
    expect(protectionPass(classic(false, false, false), CANONICAL_REF)).toBe(false)
  })
  it('a force-push or branch deletion in the provider activity is STOP_CANONICAL_STORE_REWRITTEN', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    for (const t of ['force_push', 'branch_deletion']) {
      const p = protectedProvider(s.repo.head())
      p.activity.push({ activity_type: t })
      expect(s.consume(CENSUS, { provider: p }).result).toBe('STOP_CANONICAL_STORE_REWRITTEN')
    }
    const once = protectedProvider(s.repo.head())
    once.activity.push({ activity_type: 'branch_creation' })
    expect(s.consume(CENSUS, { provider: once }).result).toBe('USABLE')
    once.activity.push({ activity_type: 'branch_creation' })
    expect(s.consume(CENSUS, { provider: once }).result).toBe('STOP_CANONICAL_STORE_REWRITTEN')
  })
  it('a wrong provider ref, or an uncontrolled environment, STOPS', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    expect(s.consume(CENSUS, { provider: { ...protectedProvider(s.repo.head()), ref: 'refs/heads/main' } }).result).toBe('STOP_CANONICAL_STORE_REF_MISMATCH')
    const st = s.repo.storeAt()
    st.envViolations = ['pin log.showRoot=false']
    expect(s.consume(CENSUS, { store: st }).result).toBe('STOP_GIT_READ_ENVIRONMENT_UNCONTROLLED')
  })
  it('merge -s ours drop of a FAIL: STOP_ADJUDICATION_HISTORY_VIOLATED (the PASS is NOT usable)', () => {
    const s = new Scenario()
    const a1 = s.attempt()
    s.adjudicate('PASS', a1)
    const a2 = s.attempt()
    s.repo.g(['checkout', '-q', '-b', 'side'])
    s.adjudicate('FAIL', a2)
    s.repo.g(['checkout', '-q', 'main'])
    s.repo.g(['merge', '-q', '-s', 'ours', '--no-edit', 'side'])
    s.recs.pop()
    expect(s.consume().result).toBe('STOP_ADJUDICATION_HISTORY_VIOLATED')
  })
  it('merge -s ours drop of an attempt AND its FAIL together: only the ever-added rule sees it', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    s.repo.g(['checkout', '-q', '-b', 'side'])
    s.adjudicate('FAIL', s.attempt())
    s.repo.g(['checkout', '-q', 'main'])
    s.repo.g(['merge', '-q', '-s', 'ours', '--no-edit', 'side'])
    const st = s.repo.storeAt()
    expect(st.raw.length).toBe(2)
    expect(st.history.filter((v) => v.startsWith('ever-added absent at H')).length).toBe(2)
    expect(s.consume().result).toBe('STOP_ADJUDICATION_HISTORY_VIOLATED')
    expect(s.consume(CENSUS, { store: { ...st, history: [] } }).result).toBe('USABLE')
  })
  it('history is walked from the evaluated head H, not from the checkout HEAD (review B2)', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    s.repo.g(['checkout', '-q', '-b', 'side'])
    s.adjudicate('FAIL', s.attempt())
    s.repo.g(['checkout', '-q', 'main'])
    s.repo.g(['merge', '-q', '-s', 'ours', '--no-edit', 'side'])
    const h = s.repo.head()
    s.repo.g(['checkout', '-q', 'HEAD~1'])
    const st = s.repo.storeAt(h, h)
    expect(st.history.filter((v) => v.startsWith('ever-added absent at H')).length).toBe(2)
    expect(s.consume(CENSUS, { headSha: h, store: st, provider: protectedProvider(h) }).result).toBe('STOP_ADJUDICATION_HISTORY_VIOLATED')
  })
  it('a loose object forged in the store repository STOPS the consumer', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const st = s.repo.storeAt()
    expect(s.consume(CENSUS, { store: { ...st, objectIntegrity: ['fsck exit 3'] } }).result).toBe('STOP_GIT_OBJECT_STORE_CORRUPT')
  })
  it('a FAIL removed by a local replace of the head is still seen (controlled ls-tree and log)', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const before = s.repo.head()
    s.adjudicate('FAIL', s.attempt())
    const head = s.repo.head()
    const fake = s.repo.g(['commit-tree', `${before}^{tree}`, '-p', before, '-m', 'no fail'])
    s.repo.g(['replace', head, fake])
    expect(s.consume().result).toBe('STOP_CERTIFICATION_REVOKED')
    const naiveStore = s.repo.storeAt('HEAD', 'HEAD', naive)
    expect(naiveStore.raw.length).toBe(2)
  })
  it('an info/grafts file that hides the deletion of an attempt and its FAIL is ignored', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const a2 = s.attempt()
    const f = s.adjudicate('FAIL', a2)
    s.repo.g(['rm', '-q', a2.path, f.path])
    s.repo.commit('drop the attempt and its FAIL')
    writeFileSync(path.join(s.repo.dir, '.git', 'info', 'grafts'), `${s.repo.head()}\n`)
    const naiveStore = s.repo.storeAt('HEAD', 'HEAD', naive)
    expect(naiveStore.history).toEqual([])
    expect(s.consume(CENSUS, { store: { ...naiveStore, envViolations: [] } }).result).toBe('USABLE')
    expect(s.consume().result).toBe('STOP_ADJUDICATION_HISTORY_VIOLATED')
  })
  it('a shallow clone of the store is UNVERIFIABLE', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const dst = path.join(PRIVATE, `shallow${repoSeq++}`)
    execFileSync('git', ['clone', '-q', '--depth', '1', `file:///${s.repo.dir.replace(/\\/g, '/')}`, dst], { stdio: 'ignore' })
    const clone2 = new FixtureRepo(dst)
    const head = clone2.head()
    expect(
      consume({
        contract: C(), kind: CENSUS, head: introducingView(), headSha: head, store: clone2.storeAt(), provider: protectedProvider(head), genesis: head,
        isAncestor: (a, b) => clone2.isAncestor(a, b), contractPath: PATHS.v105, contractBlob: CONTRACT_BLOB, derivedFor: derivedDefault, targetFor: (r) => knownFor(r)?.id ?? null,
      }).result,
    ).toBe('STOP_ADJUDICATION_HISTORY_UNVERIFIABLE')
  })
  it('force-push preconditions: a provider tip that no longer contains a reservation tip is NOT_MONOTONIC; a tip not descending from genesis too', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const reserved = s.attempt()
    const rewritten = s.repo.g(['commit-tree', `${s.repo.head()}^{tree}`, '-p', s.repo.genesis, '-m', 'rewritten canonical'])
    s.repo.g(['reset', '-q', '--hard', rewritten])
    const st = s.repo.storeAt()
    expect(st.records.some((r) => r.path === reserved.path)).toBe(true)
    expect(s.consume().result).toBe('STOP_CANONICAL_STORE_NOT_MONOTONIC')
    const orphan = new FixtureRepo()
    expect(orphan.genesis).not.toBe(s.repo.genesis)
    expect(s.consume(CENSUS, { genesis: orphan.genesis }).result).toBe('STOP_CANONICAL_STORE_NOT_MONOTONIC')
  })
  it('a provider tip that does not descend from the pinned store genesis is NOT_MONOTONIC on its own', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    expect(s.consume().result).toBe('USABLE')
    const orphan = new FixtureRepo()
    expect(orphan.genesis).not.toBe(s.repo.genesis)
    expect(s.consume(CENSUS, { genesis: orphan.genesis }).result).toBe('STOP_CANONICAL_STORE_NOT_MONOTONIC')
  })
  it('canonical ancestry: a provider tip that is not an ancestor of H is STALE, even if H contains the same records', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const h = s.repo.head()
    s.repo.g(['checkout', '-q', '-b', 'canonical'])
    s.repo.write('other', 'x\n')
    const tip = s.repo.commit('canonical moved on')
    s.repo.g(['checkout', '-q', 'main'])
    expect(s.repo.head()).toBe(h)
    expect(s.consume(CENSUS, { provider: protectedProvider(tip), store: s.repo.storeAt('HEAD', tip) }).result).toBe('STOP_ADJUDICATION_STORE_STALE')
  })
  it('containment diagnostic: an entry of the tip missing at H is STALE even when ancestry is (wrongly) granted', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const st = s.repo.storeAt()
    st.tipRaw.set(`${C().path_and_identity.adjudication_root}CENSUS/${'f'.repeat(64)}/${'f'.repeat(64)}.json`, '0'.repeat(40))
    expect(s.consume(CENSUS, { store: st }).result).toBe('STOP_ADJUDICATION_STORE_STALE')
  })
  it('store integrity: a non-canonical, executable, mistyped-kind or foreign-directory entry makes the store INVALID', () => {
    const s = new Scenario()
    const a = s.attempt()
    s.adjudicate('PASS', a)
    const st = s.repo.storeAt()
    const mk = (edit: (e: RawEntry) => void): Store => {
      const x = { ...st, raw: st.raw.map((e) => ({ ...e })) }
      edit(x.raw[0])
      return x
    }
    expect(s.consume(CENSUS, { store: mk((e) => { e.bytes = e.bytes.replace('\n', '\n\n') }) }).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
    expect(s.consume(CENSUS, { store: mk((e) => { e.mode = '100755' }) }).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
    expect(s.consume(CENSUS, { store: mk((e) => { e.path = e.path.replace('/CENSUS/', '/OFFLINE/') }) }).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
    expect(s.consume(CENSUS, { store: mk((e) => { e.path = e.path.replace(/[0-9a-f]{64}\.json$/, `${'0'.repeat(64)}.json`) }) }).result).toBe('STOP_ADJUDICATION_STORE_INVALID')
  })
  it('a file under the retired occurrence root STOPS', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    s.repo.write(`${AUTH.SECTION_F7_MATERIALIZATION_AND_RESERVATION_WRITE_SET.retired_occurrence_root}x.json`, '{}\n')
    s.repo.commit('occurrence')
    expect(s.consume().result).toBe('STOP_RETIRED_OCCURRENCE_ROOT_USED')
  })
  it('a broken chain STOPS; a changed governing layer makes the certification STALE', () => {
    const s = new Scenario()
    s.adjudicate('PASS', s.attempt())
    const st = s.repo.storeAt()
    const linked = st.records.findIndex((r) => r.record.chain.predecessor !== null)
    const orphan = clone(st.records[linked])
    ;(orphan.record.chain.predecessor as Pred).record_digest = 'f'.repeat(64)
    expect(s.consume(CENSUS, { store: { ...st, records: st.records.map((r, i) => (i === linked ? orphan : r)) } }).result).toBe('STOP_CHAIN_INTEGRITY_VIOLATED')
    const layer = patchedView(introducingView(), { [PATHS.v104]: { blob: '5'.repeat(40), text: '{}' } })
    expect(s.consume(CENSUS, { head: layer }).result).toBe('STOP_NOT_CURRENT')
    const added = patchedView(introducingView(), { 'docs/ops/release/STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.6.json': { blob: '6'.repeat(40), text: '{}' } })
    expect(s.consume(CENSUS, { head: added }).result).toBe('STOP_NOT_CURRENT')
  })
})

/* ========================================================================== */
/* §8 consumer registry (R3-6)                                                */
/* ========================================================================== */

describe('§8 consumer registry: union of three discovery rules, every locus classified once', () => {
  const LAYERS = [PATHS.v100, PATHS.v101, PATHS.v102, PATHS.v103, PATHS.v104]
  const OWNERS = ['v1.0.0', 'v1.0.1', 'v1.0.2'].map((v) => `docs/ops/owner-ratifications/STAGING_RECOVERY_OWNER_DECISIONS_${v}.json`)
  const reg = AUTH.SECTION_F4_CONSUMER_REGISTRY
  const RULE3 = new RegExp(reg.discovery_rule_3.pattern)
  const norm = (s: string): string => s.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').toLowerCase()
  function leaves(file: string, withKeys: boolean): { locus: string; text: string }[] {
    const out: { locus: string; text: string }[] = []
    const walk = (v: unknown, p: string): void => {
      if (typeof v === 'string') out.push({ locus: p, text: v })
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`))
      else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          if (withKeys) out.push({ locus: `${p}.${k}#key`, text: k })
          walk((v as Record<string, unknown>)[k], `${p}.${k}`)
        }
      }
    }
    walk(readJson<unknown>(file), '$')
    return out
  }
  function discover(): Map<string, { file: string; locus: string; rules: Set<string> }> {
    const d = new Map<string, { file: string; locus: string; rules: Set<string> }>()
    const add = (file: string, locus: string, rule: string): void => {
      const k = `${file}\u0000${locus}`
      const e = d.get(k) ?? { file, locus, rules: new Set<string>() }
      e.rules.add(rule)
      d.set(k, e)
    }
    for (const l of leaves(PATHS.v103, false)) if (/occurrence|\bKS-[AB]\b/i.test(l.text) && /\bCURRENT\b|\bvalid\b|\bcurrency\b/.test(l.text)) add(PATHS.v103, l.locus, 'R1')
    for (const f of [PATHS.v100, PATHS.v101, PATHS.v102]) for (const l of leaves(f, false)) if (/\bcertif(ied|ication)\b/i.test(l.text) && /\b(census|offline|HX-[0-9]|authority)\b/i.test(l.text)) add(f, l.locus, 'R2')
    for (const f of [...LAYERS, ...OWNERS]) for (const l of leaves(f, true)) if (RULE3.test(norm(l.text))) add(f, l.locus, 'R3')
    return d
  }
  it('every discovered locus is classified exactly once; no entry or section rule is dead', () => {
    const d = discover()
    const exact = new Map(reg.registry.map((r) => [`${r.file}\u0000${r.locus}`, r]))
    const v: string[] = []
    for (const [k, e] of d) {
      const byRule = reg.section_rules.filter((r) => r.file === e.file && e.locus.startsWith(r.locus_prefix)).length
      if (exact.has(k)) {
        if (!sameList([...e.rules].sort(), exact.get(k)?.discovered_by ?? [])) v.push(`rules:${e.locus}`)
      } else if (byRule !== 1) v.push(`unclassified:${e.file}:${e.locus}`)
    }
    for (const k of exact.keys()) if (!d.has(k)) v.push(`dead:${k}`)
    for (const r of reg.section_rules) if (![...d.values()].some((e) => e.file === r.file && e.locus.startsWith(r.locus_prefix))) v.push(`dead rule:${r.locus_prefix}`)
    expect(v).toEqual([])
    expect(reg.counts.discovered).toBe(d.size)
  })
  it('RB-2 loci are discovered and are PACKAGE_CONSUMERS: M-1 (D12[0], E8[0]), next_gate (v1.0.3, v1.0.4), E7', () => {
    const cls = (file: string, locus: string): string | undefined => reg.registry.find((r) => r.file === file && r.locus === locus)?.class
    expect(cls(PATHS.v103, '$.SECTION_D12_PR220_DISPOSITION.merge_prerequisites_conjunctive[0]')).toBe('PACKAGE_CONSUMER')
    expect(cls(PATHS.v104, '$.SECTION_E8_PR220_DISPOSITION.merge_prerequisites_conjunctive[0]')).toBe('PACKAGE_CONSUMER')
    expect(cls(PATHS.v103, '$.next_gate')).toBe('PACKAGE_CONSUMER')
    expect(cls(PATHS.v104, '$.next_gate')).toBe('PACKAGE_CONSUMER')
    expect(cls(PATHS.v104, '$.SECTION_E7_MATERIALIZATION_WRITE_SET.first_authorized_directories_after_recert_of_this_artifact#key')).toBe('PACKAGE_CONSUMER')
    expect(cls(PATHS.v100, '$.PRESTATE.assertions[1].assertion')).toBe('PACKAGE_CONSUMER')
    expect(cls(PATHS.v102, '$.SECTION_C14_IMPLEMENTATION_AND_EXECUTION_STATUS.hosted_execution_prerequisites_conjunctive[0]')).toBe('PACKAGE_CONSUMER')
    expect(cls(PATHS.v100, '$.next_gate')).toBe('PACKAGE_CONSUMER')
    expect(cls(PATHS.v103, '$.SECTION_D13_HOSTED_PREREQUISITE_READING.HX-1')).toBe('PACKAGE_CONSUMER')
    for (const f of OWNERS) expect(cls(f, '$.next_gate'), f).toBe('PACKAGE_CONSUMER')
  })
  it('CERTIFIED_CENSUS_EXECUTION in every spelling is discovered; the registry holds it as EA-F1', () => {
    for (const s of ['CERTIFIED_CENSUS_EXECUTION', 'CERTIFIED_CENSUS_EXECUTIONS', 'certified census executions', 'Certified-Census-Execution', 'recertified PASS-class', 'On PASS-class', 'first_authorized_directories_after_recert_of_this_artifact', 'until that certification returns PASS', 'established by independent recertification']) {
      expect(RULE3.test(norm(s)), s).toBe(true)
    }
    const e = reg.registry.find((r) => r.locus === '$.SECTION_C4_EVENT_CLASS_REGISTRY.classes.EVENT_A_INITIAL_CORPUS.required_facts[0].required')
    expect(e).toMatchObject({ class: 'CONSUMER', consumer: 'EA-F1 (CERTIFIED_CENSUS_EXECUTION)' })
  })
  it('no bypass: every consumer id is restated in SECTION_F9 through consumer_rule', () => {
    const ids = new Set(reg.registry.filter((r) => r.class === 'CONSUMER' || r.class === 'PACKAGE_CONSUMER').map((r) => (r.consumer as string).split(' ')[0]))
    const f9 = AUTH.SECTION_F9_CONSUMERS_RESTATED
    const restated = Object.keys(f9).flatMap((k) => k.split('/'))
    for (const id of ids) expect(restated, id).toContain(id)
    for (const k of Object.keys(f9).filter((x) => x !== 'no_bypass' && x !== 'M-1/M-2/M-3' && x !== 'NEXT_GATE/E7')) expect(f9[k], k).toContain('consumer_rule')
    for (const m of AUTH.SECTION_F8_PR220_DISPOSITION.merge_prerequisites_conjunctive) expect(m).toMatch(/consumer_rule/)
  })
})

/* ========================================================================== */
/* §9 precedence anchors                                                      */
/* ========================================================================== */

describe('§9 precedence anchors and the RECOVERY topic count', () => {
  const allocation = readJson<{ SECTION_D2_CROSS_LINEAGE_PRECEDENCE: { topic_allocation: Record<string, string> } }>(PATHS.v103).SECTION_D2_CROSS_LINEAGE_PRECEDENCE.topic_allocation
  const domainOfPath = (p: string): string =>
    p.includes('STAGING_QUIESCE_READONLY_CENSUS_') ? 'CENSUS' : p.includes('STAGING_QUIESCE_MECHANISM_') ? 'QUIESCE' : p.includes('STAGING_RECOVERY_') ? 'RECOVERY' : 'UNKNOWN'
  function anchorViolations(anchors: Record<string, Anchor[]>): string[] {
    const v: string[] = []
    for (const [t, list] of Object.entries(anchors)) {
      if (list.length === 0) v.push(`empty:${t}`)
      for (const a of list) {
        if (domainOfPath(a.path) !== allocation[t]) v.push(`domain:${t}`)
        if (!existsSync(path.join(ROOT, a.path)) || !(a.section in readJson<Record<string, unknown>>(a.path))) v.push(`section:${t}`)
      }
    }
    return v
  }
  it('every topic is anchored to existing sections of files of its allocated domain', () => {
    const anchors = AUTH.SECTION_F6_PRECEDENCE_ANCHORS.anchors
    expect(Object.keys(anchors).sort()).toEqual(Object.keys(allocation).sort())
    expect(anchorViolations(anchors)).toEqual([])
  })
  it('an anchor moved to a file of another domain, to a missing section, or an empty anchor list is RED', () => {
    const base = AUTH.SECTION_F6_PRECEDENCE_ANCHORS.anchors
    const census = base.CENSUS_READ_SET_AND_OBSERVATION_CONTRACTS[0]
    const moved = { ...clone(base), RECOVERY_CERTIFICATION_OCCURRENCE_CONTRACT: [{ path: census.path, section: census.section }] }
    expect(anchorViolations(moved)).toEqual(['domain:RECOVERY_CERTIFICATION_OCCURRENCE_CONTRACT'])
    const missing = { ...clone(base), RECOVERY_CERTIFICATION_OCCURRENCE_CONTRACT: [{ path: PATHS.v105, section: 'SECTION_F99_ABSENT' }] }
    expect(anchorViolations(missing)).toEqual(['section:RECOVERY_CERTIFICATION_OCCURRENCE_CONTRACT'])
    expect(anchorViolations({ ...clone(base), EVENT_CLASS_REGISTRY: [] })).toEqual(['empty:EVENT_CLASS_REGISTRY'])
  })
  it('the allocation has 17 RECOVERY topics (not 22)', () => {
    const n = Object.values(allocation).filter((d) => d === 'RECOVERY').length
    expect(n).toBe(17)
    expect(AUTH.SECTION_F6_PRECEDENCE_ANCHORS.recovery_topic_count).toBe(n)
  })
})

/* ========================================================================== */
/* §10 preservation, write set and the real repository                        */
/* ========================================================================== */

describe('§10 preservation, write set and the real repository', () => {
  it('every earlier artifact of the chain is byte-identical to its blob at the base', () => {
    for (const p of IMMUTABLE) expect(gitBlobSha(storedBytes(p)), p).toBe(introducingView().blob(p))
  })
  it('the write set is exactly five added paths; the introducing tree holds no record and no occurrence', () => {
    expect(WRITE_SET.length).toBe(5)
    for (const p of WRITE_SET) expect(commitView(BASE_COMMIT).blob(p), p).toBeNull()
    expect(introducingView().list().filter((p) => p.startsWith(C().path_and_identity.adjudication_root))).toEqual([])
    expect(introducingView().list().filter((p) => p.startsWith(AUTH.SECTION_F7_MATERIALIZATION_AND_RESERVATION_WRITE_SET.retired_occurrence_root))).toEqual([])
    expect(C().canonical_store.STORE_GENESIS.commit).toBe(BASE_COMMIT)
  })
  it('declared layers are exactly the governing-family members added since each known candidate, with their blobs', () => {
    for (const ks of [KS_A, KS_B]) {
      const recorded = new Set(ks.governing_family_members_at_candidate.map((m) => m.path))
      const expected = introducingView()
        .list()
        .filter((p) => ks.governing_families.some((f) => p.startsWith(f)) && !recorded.has(p))
        .sort(byteOrder)
        .map((p) => ({ path: p, blob: p === PATHS.v105 ? null : introducingView().blob(p) }))
      const declared = (C().currency.declared_non_invalidating_governing_layers[ks.subject_kind] as Declared[]).map((d) => ({ path: d.path, blob: d.blob }))
      expect(declared).toEqual(expected)
    }
    expect(C().currency.declared_non_invalidating_governing_layers[PACKAGE]).toEqual([])
  })
  it('Event A is untouched; no operation added; no protection mutated; the final state is the provider boundary', () => {
    expect(AUTH.SECTION_F10_EVENT_A_PRESERVATION).toMatchObject({ CURRENT_EVENT_A_REACHABLE: 'NO', EVENT_A_POLICY: 'PENDING' })
    expect(AUTH.SECTION_F16_PRESERVATION.AUTHORIZED_OPERATIONS_DELTA).toEqual({ added: [], removed: [], modified: [] })
    expect(AUTH.SECTION_F18_PROVIDER_BOUNDARY_REPORT.ref).toBe(CANONICAL_REF)
    expect(AUTH.SECTION_F18_PROVIDER_BOUNDARY_REPORT.mutation_by_this_lane).toMatch(/^NONE/)
    expect(AUTH.final_state).toBe('RECOVERY_CERT_STORE_DURABILITY_CODE_READY__PROVIDER_PROTECTION_REQUIRED')
    for (const l of AUTH.SECTION_F11_SUPERSEDED_LOCI) expect(l.chain).toBe('RECOVERY')
  })
  it('stop codes: every code the interpreter returns is declared; consumer results are declared', () => {
    const src = readFileSync(path.join(ROOT, PATHS.self), 'utf8')
    const used = new Set([...src.matchAll(/'(STOP_[A-Z_]+)'/g)].map((m) => m[1]))
    const declared = new Set([...C().stop_codes, ...C().consumer_rule.consumer_results])
    const foreign = ['STOP_EVENT_A_CENSUS_UNKNOWN']
    for (const code of used) if (!foreign.includes(code)) expect(declared.has(code), code).toBe(true)
    for (const code of C().stop_codes) expect(used.has(code), code).toBe(true)
    for (const code of C().consumer_rule.consumer_results.filter((x) => x !== 'USABLE')) expect(used.has(code), code).toBe(true)
    expect(Object.values(C().state.stops).join(' ')).toContain('STOP_RECERT_ATTEMPT_OPEN')
  })
  it('the real repository: the controlled environment and the object store hold, the store was empty when v1.0.5 was introduced and stays intact at HEAD, and the recorded provider state STOPS every kind', { timeout: 900_000 }, () => {
    expect(environmentViolations(ROOT)).toEqual([])
    expect(objectIntegrityViolations(ROOT)).toEqual([])
    const root = C().path_and_identity.adjudication_root
    // Owner-authorized correction (Recovery v1.0.6 OF-PS-4): "empty" is a fact of the commit that
    // introduced v1.0.5, never of the evolving HEAD, where later governed lanes add records.
    const introducing = text(cgit(ROOT, ['log', '--full-history', '--diff-filter=A', '--format=%H', 'HEAD', '--', `:(top,literal)${PATHS.v105}`]))
    expect(introducing).toBe('ae958aa04f534be50a648bd1e43a069d0c2111c7')
    expect(lsTree(ROOT, introducing, [root])).toEqual([])
    expect(everAddedViolations(ROOT, root, new Map(), cgit, introducing)).toEqual([])
    // At HEAD whatever is present must keep the store contract: integrity, ever-added history, one chain per kind.
    // Record validation against the effective contract (v1.0.6 SECTION_G3) is the v1.0.6 companion test's live guard.
    const entries = lsTree(ROOT, 'HEAD', [root])
    const blobs = readBlobs(entries.filter((e) => e.type === 'blob').map((e) => e.oid))
    const raw: RawEntry[] = entries.map((e) => ({ path: e.path, mode: e.mode, oid: e.oid, bytes: e.type === 'blob' ? (blobs.get(e.oid) ?? '') : '' }))
    expect(storeIntegrity(C(), raw)).toEqual([])
    expect(everAddedViolations(ROOT, root, new Map(raw.map((e) => [e.path, e.oid])), cgit, 'HEAD')).toEqual([])
    const present: Stored[] = raw.map((e) => ({ path: e.path, record: JSON.parse(e.bytes) as Rec }))
    for (const kind of new Set(present.map((r) => r.record.subject_kind))) expect(chainIntegrity(present.filter((r) => r.record.subject_kind === kind)), kind).toBeNull()
    expect(isAncestorIn(ROOT, BASE_COMMIT, 'HEAD')).toBe(true)
    const head = text(cgit(ROOT, ['rev-parse', 'HEAD']))
    const store: Store = { raw: [], records: [], history: [], shallow: isShallow(ROOT), occurrenceRootFiles: [], envViolations: [], objectIntegrity: [], tipRaw: new Map() }
    const base: ConsumerInput = {
      contract: C(), kind: CENSUS, head: introducingView(), headSha: head, store, provider: measuredProvider(), genesis: BASE_COMMIT,
      isAncestor: (a, b) => isAncestorIn(ROOT, a, b), contractPath: PATHS.v105, contractBlob: CONTRACT_BLOB, derivedFor: derivedDefault, targetFor: () => null,
    }
    for (const kind of [CENSUS, OFFLINE, PACKAGE]) expect(consume({ ...base, kind }).result).toBe('STOP_PROVIDER_PROTECTION_REQUIRED')
    expect(consume({ ...base, provider: protectedProvider(BASE_COMMIT) })).toMatchObject({ result: 'STOP_NOT_CERTIFIED', state: 'NO_ATTEMPT' })
  })
})

/* ========================================================================== */
/* §11 kill matrix                                                            */
/* ========================================================================== */

describe('§11 kill matrix over the record checks', () => {
  const att = stored(attemptFor(KS_A, [], { tip: 'e'.repeat(40) }))
  const adj = stored(adjudicationFor(KS_A, 'PASS_WITH_NONBLOCKING_FINDINGS', att, [att]))
  interface Neg { id: string; record: Rec; ctx: Ctx; want: string }
  const negA = (id: string, want: string, edit: (r: Adjudication) => void, over: Partial<Ctx> = {}): Neg => {
    const r = clone(adj.record) as Adjudication
    edit(r)
    return { id, record: r, ctx: ctxFor(r, { existing: [att], ...over }), want }
  }
  const negT = (id: string, want: string, edit: (r: Attempt) => void, over: Partial<Ctx> = {}): Neg => {
    const r = clone(att.record) as Attempt
    edit(r)
    return { id, record: r, ctx: ctxFor(r, over), want }
  }
  const NEG: Neg[] = [
    negA('kind', 'STOP_UNKNOWN_SUBJECT_KIND', (r) => { r.subject_kind = 'OTHER' }),
    negA('shape', 'STOP_ADJUDICATION_SHAPE', (r) => { (r as unknown as Record<string, unknown>).x = 1 }),
    negA('contract', 'STOP_ADJUDICATION_CONTRACT_MISMATCH', (r) => { r.contract.blob = '0'.repeat(40) }),
    negA('authority', 'STOP_ADJUDICATION_CLAIMS_AUTHORITY', (r) => { r.authorizes = ['X'] }),
    negA('sha', 'STOP_CANDIDATE_SHA_MALFORMED', (r) => { r.subject.candidate_sha = 'x' }),
    negA('path', 'STOP_ADJUDICATION_PATH_IDENTITY_MISMATCH', () => undefined, { recordPath: 'docs/ops/release/rca/x.json' }),
    negA('covered', 'STOP_SUBJECT_KIND_MISMATCH', (r) => { r.subject.entries = r.subject.entries.filter((e) => e.role !== 'COVERED') }),
    negA('target-tree', 'STOP_TREE_SHA_MISMATCH', (r) => { r.subject.tree_sha = 'c'.repeat(40); r.provenance.independent_adjudicator.examined_tree_sha = 'c'.repeat(40) }, { derived: { ...identityOf(KS_A), tree_sha: 'c'.repeat(40) } }),
    negA('derived-tree', 'STOP_TREE_SHA_MISMATCH', () => undefined, { target: null, derived: { ...identityOf(KS_A), tree_sha: 'c'.repeat(40) } }),
    negA('digest', 'STOP_PACKAGE_DIGEST_MISMATCH', () => undefined, { target: null, derived: { ...identityOf(KS_A), package_digest: 'f'.repeat(64) } }),
    negA('literal', 'STOP_VERDICT_LITERAL_MISMATCH', (r) => { r.verdict.verdict_literal = 'CENSUS_PASS_WITH_NONBLOCKING_FINDINGS' }),
    negA('class', 'STOP_VERDICT_CLASS_INCONSISTENT', (r) => { r.verdict.blocking_findings_count = 1 }),
    negA('findings', 'STOP_NONBLOCKING_FINDINGS_INCOMPLETE', (r) => { r.verdict.nonblocking_findings_reported_count = 2 }),
    negA('open', 'STOP_FINDING_NOT_OPEN', (r) => { r.nonblocking_findings[0].status = 'CLOSED' }),
    negA('lane', 'STOP_PROVENANCE_IDENTITY_MALFORMED', (r) => { r.provenance.materializer.lane_id = 'lane' }),
    negA('independent', 'STOP_PROVENANCE_NOT_INDEPENDENT', (r) => { r.provenance.materializer.lane_id = 'FIXTUREAUTHOR-LANE' }),
    negA('binding', 'STOP_RECERT_SUBJECT_MISMATCH', (r) => { r.provenance.independent_adjudicator.examined_candidate_sha = SIBLING }),
    negA('scope', 'STOP_RECERT_SCOPE_UNDECLARED', (r) => { r.provenance.independent_adjudicator.scope_basis = [] }),
    negA('basis', 'STOP_MATERIALIZER_REPRODUCTION_CLAIM', (r) => { r.provenance.materializer_reproduced_adjudication_evidence = true }),
    negA('path-free', 'STOP_ADJUDICATION_PATH_EXISTS', () => undefined, { existing: [att, adj] }),
    negA('predecessor', 'STOP_CHAIN_PREDECESSOR_MISMATCH', (r) => { r.chain.predecessor = null }),
    negA('closure', 'STOP_FINDING_CLOSURE_INVALID', (r) => { r.closes_predecessor_findings = ['NOPE'] }),
    negA('resolves', 'STOP_RECERT_ATTEMPT_RESOLUTION_INVALID', (r) => { r.resolves_attempt.attempt_id = 'OTHER' }),
    negA('double', 'STOP_RECERT_ATTEMPT_DOUBLY_RESOLVED', () => undefined, { mode: 'read', existing: [att, adj, stored(adjudicationFor(KS_A, 'FAIL', att, [att, adj]))] }),
    negA('history', 'STOP_ADJUDICATION_HISTORY_VIOLATED', () => undefined, { mode: 'read', existing: [att, adj], historyViolations: ['D x'] }),
    negT('a-kind', 'STOP_UNKNOWN_SUBJECT_KIND', (r) => { r.subject_kind = 'OTHER' }),
    negT('a-shape', 'STOP_RECERT_ATTEMPT_SHAPE', (r) => { (r.reservation as unknown as Record<string, unknown>).x = 1 }),
    negT('a-date', 'STOP_RECERT_ATTEMPT_SHAPE', (r) => { r.reservation.reservation_date = '2026/01/01' }),
    negT('a-contract', 'STOP_ADJUDICATION_CONTRACT_MISMATCH', (r) => { r.contract.section = 'SECTION_E3_ADJUDICATION_CONTRACT' }),
    negT('a-authority', 'STOP_ADJUDICATION_CLAIMS_AUTHORITY', (r) => { r.authority_class = 'X' }),
    negT('a-sha', 'STOP_CANDIDATE_SHA_MALFORMED', (r) => { r.subject.candidate_sha = 'x' }),
    negT('a-path', 'STOP_ADJUDICATION_PATH_IDENTITY_MISMATCH', () => undefined, { recordPath: 'docs/ops/release/rca/x.json' }),
    negT('a-subject', 'STOP_TREE_SHA_MISMATCH', (r) => { r.subject.tree_sha = 'c'.repeat(40) }),
    negT('a-derived', 'STOP_PACKAGE_DIGEST_MISMATCH', () => undefined, { target: null, derived: { ...identityOf(KS_A), package_digest: 'f'.repeat(64) } }),
    negT('a-ids', 'STOP_PROVENANCE_IDENTITY_MALFORMED', (r) => { r.reservation.adjudicator_lane_id = 'x y' }),
    negT('a-unique', 'STOP_RECERT_ATTEMPT_ID_DUPLICATE', () => undefined, { existing: [stored(attemptFor(KS_B, [], { tip: 'e'.repeat(40), attemptId: (att.record as Attempt).attempt_id }))] }),
    negT('a-canonical', 'STOP_CANONICAL_STORE_REF_MISMATCH', (r) => { r.canonical_store.ref = 'refs/heads/x' }),
    negT('a-prior', 'STOP_RECERT_ATTEMPT_PRIOR_STATE_MISMATCH', (r) => { r.prior_state.disposition_status = 'CERTIFIED' }),
    ((): Neg => {
      const r = attemptFor(KS_A, [att], { tip: 'e'.repeat(40), attemptId: 'KM-OPEN' })
      return { id: 'a-open', record: r, ctx: ctxFor(r, { existing: [att] }), want: 'STOP_RECERT_ATTEMPT_ALREADY_OPEN' }
    })(),
    negT('a-path-free', 'STOP_ADJUDICATION_PATH_EXISTS', () => undefined, { existing: [att] }),
    negT('a-predecessor', 'STOP_CHAIN_PREDECESSOR_MISMATCH', (r) => { r.chain.predecessor = { path: 'x', record_digest: 'y' } }),
    negT('a-chain-read', 'STOP_CHAIN_INTEGRITY_VIOLATED', () => undefined, { mode: 'read', existing: [att, stored(attemptFor(KS_A, [], { tip: 'e'.repeat(40), attemptId: 'KM-SECOND-ROOT' }))] }),
    negA('chain-read', 'STOP_CHAIN_INTEGRITY_VIOLATED', () => undefined, { mode: 'read', existing: [att, adj, stored(attemptFor(KS_A, [], { tip: 'e'.repeat(40), attemptId: 'KM-OTHER-ROOT' }))] }),
  ]
  const run = (n: Neg, disabled: ReadonlySet<string> = new Set()): string => validate(n.record, n.ctx, disabled)
  it('every negative case STOPS with its expected code', () => {
    const v = NEG.filter((n) => run(n) !== n.want).map((n) => `${n.id}: ${run(n)} != ${n.want}`)
    expect(v).toEqual([])
  })
  it('disabling ANY single check lets at least one negative case through', () => {
    const ids = [...new Set([...ADJUDICATION_CHECKS, ...ATTEMPT_CHECKS].map((c) => c.id))]
    const inert = ids.filter((id) => NEG.every((n) => run(n, new Set([id])) === n.want))
    expect(inert).toEqual([])
  })
  it('self-test: a check that guards nothing survives', () => {
    const extended = [...ADJUDICATION_CHECKS, { id: 'NOOP', when: 'both' as const, check: (): string | null => null }]
    const inert = extended.map((c) => c.id).filter((id) => NEG.every((n) => run(n, new Set([id])) === n.want))
    expect(inert).toContain('NOOP')
  })
  it('the orders of this interpreter follow SECTION_F3 validation_order and attempt_contract.validation_order', () => {
    const adjOrder = [...new Set(ADJUDICATION_CHECKS.map((c) => c.id.split('_')[0]))]
    expect(adjOrder).toEqual(C().validation_order.map((l) => l.split(' ')[0]).flatMap((x) => (x === 'R1' ? ['R1', 'R2'] : [x])))
    const attOrder = [...new Set(ATTEMPT_CHECKS.map((c) => c.id.split('_')[0]))]
    expect(attOrder).toEqual(C().attempt_contract.validation_order.map((l) => l.split(' ')[0]).flatMap((x) => (x === 'R1' ? ['R1', 'R2'] : [x])))
  })
})
