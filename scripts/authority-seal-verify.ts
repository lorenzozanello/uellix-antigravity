// scripts/authority-seal-verify.ts — ODS-C2, the broad active authority integrity gate.
//
//   pnpm authority:seal:verify
//
// Replaces the LLM/manual hashing that established "sealed authority bytes
// unchanged" in every prior certification round with one deterministic,
// fail-closed check. See docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json,
// authority_corpus.measured_gap_closed_by_this_gate (GAP-1).
//
// Three things are proven, in order, none of them circular:
//
//   A. ODS_AUTHORITY_INPUT_INTEGRITY
//      The frozen ODS authority artifact itself (the file THIS gate reads
//      its corpus definition from) is byte-identical to the version
//      committed at ODS_AUTHORITY_FROZEN_COMMIT below. If this fails, the
//      corpus data below cannot be trusted, so the gate stops here rather
//      than validating a possibly-tampered definition.
//
//   B. PROTECTED_CORPUS_INTEGRITY (9 artifacts, read from the ODS authority
//      artifact — never hardcoded here)
//      Each artifact's current tracked blob is compared against the
//      corresponding certified Git blob at the external anchor commit
//      (authority_corpus.anchor_commit), which is independent of anything
//      the artifacts say about themselves.
//
//   C. NATIVE_RELATIONSHIPS
//      Every seal/manifest/ratification/closure attestation this project's
//      authority chain makes about another file (e.g. "this seal's
//      canonical_authority_sha256 describes that .md") is recomputed from
//      the attested file's current content and compared to the declared
//      value. This includes the four transitively attested PC-01B/IM-01B
//      files, which are NOT members of the protected corpus (reading them
//      is required to prove a seal's claim about them, not to expand
//      HPO-ODS-03's corpus).
//
// Content hashing reproduces the LF-normalized digest already used for this
// authority chain (db/hosted/authority/certification/governed-input.ts,
// sha256OfFileContent) rather than inventing a new normalization rule.

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Pure primitives — no fs/git access. Directly unit-testable.
// ---------------------------------------------------------------------------

/** Mirrors db/hosted/authority/certification/governed-input.ts sha256OfFileContent. */
export function sha256OfTextLfNormalized(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

export function checkOdsAuthorityInputIntegrity(currentBlobSha1: string, frozenBlobSha1: string): boolean {
  return currentBlobSha1 === frozenBlobSha1
}

export const EXPECTED_PROTECTED_CORPUS_COUNT = 9

export function assertCorpusCount(count: number, expected: number = EXPECTED_PROTECTED_CORPUS_COUNT): boolean {
  return count === expected
}

export interface CorpusArtifactRecord {
  path: string
  blob_sha1: string
  content_sha256: string
}

/** Reads the 9-member corpus list from a parsed ODS authority object. Throws on shape mismatch rather than silently substituting a default list. */
export function extractCorpusArtifacts(authority: unknown): CorpusArtifactRecord[] {
  const a = authority as { authority_corpus?: { artifacts?: unknown } }
  const artifacts = a?.authority_corpus?.artifacts
  if (!Array.isArray(artifacts)) {
    throw new Error('authority_corpus.artifacts missing or not an array in ODS authority artifact')
  }
  return artifacts.map((entry) => {
    const e = entry as Partial<CorpusArtifactRecord>
    if (typeof e.path !== 'string' || typeof e.blob_sha1 !== 'string' || typeof e.content_sha256 !== 'string') {
      throw new Error(`malformed authority_corpus.artifacts entry: ${JSON.stringify(entry)}`)
    }
    return { path: e.path, blob_sha1: e.blob_sha1, content_sha256: e.content_sha256 }
  })
}

/** Reads the 4 transitively-attested file paths. These are NOT corpus members. */
export function extractTransitivelyAttestedFiles(authority: unknown): string[] {
  const a = authority as { authority_corpus?: { transitively_attested_files?: { files?: unknown } } }
  const files = a?.authority_corpus?.transitively_attested_files?.files
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) {
    throw new Error('authority_corpus.transitively_attested_files.files missing or malformed')
  }
  return files as string[]
}

export function extractAnchorCommit(authority: unknown): string {
  const a = authority as { authority_corpus?: { anchor_commit?: unknown } }
  const anchor = a?.authority_corpus?.anchor_commit
  if (typeof anchor !== 'string' || anchor.length === 0) {
    throw new Error('authority_corpus.anchor_commit missing from ODS authority artifact')
  }
  return anchor
}

export interface CorpusCheckResult {
  path: string
  gitBlobIdentityPass: boolean
  recordedBlobMatchesAnchorPass: boolean
  contentSha256MatchesRecordPass: boolean
  contentSha256MatchesAnchorPass: boolean
  pass: boolean
}

/**
 * Pure comparison for one corpus artifact. All hashes/blobs are supplied by
 * the caller (already fetched from git/fs) so this can be exercised with
 * fabricated or fixture-derived values without touching the real repo.
 */
export function checkCorpusArtifact(params: {
  record: CorpusArtifactRecord
  currentBytes: Buffer
  currentGitBlobSha1: string
  certifiedGitBlobSha1: string
  certifiedBytes: Buffer
}): CorpusCheckResult {
  const { record, currentBytes, currentGitBlobSha1, certifiedGitBlobSha1, certifiedBytes } = params
  const currentContentSha256 = sha256OfTextLfNormalized(currentBytes.toString('utf8'))
  const certifiedContentSha256 = sha256OfTextLfNormalized(certifiedBytes.toString('utf8'))

  const gitBlobIdentityPass = currentGitBlobSha1 === certifiedGitBlobSha1
  const recordedBlobMatchesAnchorPass = record.blob_sha1 === certifiedGitBlobSha1
  const contentSha256MatchesRecordPass = currentContentSha256 === record.content_sha256
  const contentSha256MatchesAnchorPass = currentContentSha256 === certifiedContentSha256

  return {
    path: record.path,
    gitBlobIdentityPass,
    recordedBlobMatchesAnchorPass,
    contentSha256MatchesRecordPass,
    contentSha256MatchesAnchorPass,
    pass:
      gitBlobIdentityPass &&
      recordedBlobMatchesAnchorPass &&
      contentSha256MatchesRecordPass &&
      contentSha256MatchesAnchorPass,
  }
}

export type RelationHashKind = 'content_sha256' | 'git_blob_sha1'

export interface NativeRelation {
  attestingFile: string
  field: string
  attestedFile: string
  hashKind: RelationHashKind
}

/** Reads a dotted path (e.g. "authority_chain_at_closure.baseline_sha256") out of a parsed JSON object. */
export function getDottedField(obj: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

export function checkRelation(attestedValue: unknown, computedHash: string): boolean {
  return typeof attestedValue === 'string' && attestedValue === computedHash
}

// ---------------------------------------------------------------------------
// Declarative native-relation table.
//
// Each row was confirmed by direct inspection of the attesting file at
// ODS-01/ODS-02 time. This table is script logic, not authority data — the
// ODS authority artifact only narrates a subset of these in prose
// (relations_independently_confirmed_at_freeze); this table is what makes
// ALL of them, including the ones ODS-01 explicitly deferred, executable.
// ---------------------------------------------------------------------------

const FIB_MD = 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.md'
const FIB_INDEX = 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.index.json'
const FIB_MANIFEST = 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.manifest.json'
const FIB_RATIFICATION = 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.ratification.json'
const FIB_SEAL = 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.seal.json'
const PC01B_SEAL = 'docs/ops/pc01b/PC01B_HUMAN_METHODOLOGY_AUTHORITY_v1.0.0.seal.json'
const IM01B_SEAL = 'docs/ops/im01b/IM01B_HUMAN_PRODUCT_AUTHORITY_v1.0.0.seal.json'
const FIB_ADDENDUM = 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.addendum-w1rm2.json'
const WAVE1_CLOSURE = 'docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.wave1-closure.json'
const PC01B_MD = 'docs/ops/pc01b/PC01B_HUMAN_METHODOLOGY_AUTHORITY_v1.0.0.md'
const PC01B_RATIFICATION_MD = 'docs/ops/pc01b/PC01B_HUMAN_METHODOLOGY_AUTHORITY_v1.0.0.ratification.md'
const IM01B_MD = 'docs/ops/im01b/IM01B_HUMAN_PRODUCT_AUTHORITY_v1.0.0.md'
const IM01B_RATIFICATION_MD = 'docs/ops/im01b/IM01B_HUMAN_PRODUCT_AUTHORITY_v1.0.0.ratification.md'

export const NATIVE_RELATIONS: NativeRelation[] = [
  { attestingFile: FIB_MANIFEST, field: 'baseline_file_sha256', attestedFile: FIB_MD, hashKind: 'content_sha256' },
  { attestingFile: FIB_MANIFEST, field: 'index_file_sha256', attestedFile: FIB_INDEX, hashKind: 'content_sha256' },
  { attestingFile: FIB_MANIFEST, field: 'pc01b_authority_sha256', attestedFile: PC01B_MD, hashKind: 'content_sha256' },
  { attestingFile: FIB_MANIFEST, field: 'im01b_authority_sha256', attestedFile: IM01B_MD, hashKind: 'content_sha256' },
  { attestingFile: FIB_SEAL, field: 'baseline_sha256', attestedFile: FIB_MD, hashKind: 'content_sha256' },
  { attestingFile: FIB_SEAL, field: 'index_sha256', attestedFile: FIB_INDEX, hashKind: 'content_sha256' },
  { attestingFile: FIB_RATIFICATION, field: 'baseline_sha256', attestedFile: FIB_MD, hashKind: 'content_sha256' },
  { attestingFile: FIB_RATIFICATION, field: 'index_sha256', attestedFile: FIB_INDEX, hashKind: 'content_sha256' },
  { attestingFile: PC01B_SEAL, field: 'canonical_authority_sha256', attestedFile: PC01B_MD, hashKind: 'content_sha256' },
  { attestingFile: PC01B_SEAL, field: 'ratification_file_sha256', attestedFile: PC01B_RATIFICATION_MD, hashKind: 'content_sha256' },
  { attestingFile: IM01B_SEAL, field: 'canonical_authority_sha256', attestedFile: IM01B_MD, hashKind: 'content_sha256' },
  { attestingFile: IM01B_SEAL, field: 'ratification_file_sha256', attestedFile: IM01B_RATIFICATION_MD, hashKind: 'content_sha256' },
  { attestingFile: IM01B_SEAL, field: 'pc01b_authority_sha256', attestedFile: PC01B_MD, hashKind: 'content_sha256' },
  { attestingFile: FIB_ADDENDUM, field: 'baseline_sha256', attestedFile: FIB_MD, hashKind: 'content_sha256' },
  { attestingFile: FIB_ADDENDUM, field: 'index_sha256', attestedFile: FIB_INDEX, hashKind: 'content_sha256' },
  { attestingFile: FIB_ADDENDUM, field: 'pc01b_authority_sha256', attestedFile: PC01B_MD, hashKind: 'content_sha256' },
  { attestingFile: FIB_ADDENDUM, field: 'im01b_authority_sha256', attestedFile: IM01B_MD, hashKind: 'content_sha256' },
  {
    attestingFile: WAVE1_CLOSURE,
    field: 'authority_chain_at_closure.baseline_sha256',
    attestedFile: FIB_MD,
    hashKind: 'content_sha256',
  },
  {
    attestingFile: WAVE1_CLOSURE,
    field: 'authority_chain_at_closure.index_sha256',
    attestedFile: FIB_INDEX,
    hashKind: 'content_sha256',
  },
  {
    attestingFile: WAVE1_CLOSURE,
    field: 'authority_chain_at_closure.pc01b_authority_sha256',
    attestedFile: PC01B_MD,
    hashKind: 'content_sha256',
  },
  {
    attestingFile: WAVE1_CLOSURE,
    field: 'authority_chain_at_closure.im01b_authority_sha256',
    attestedFile: IM01B_MD,
    hashKind: 'content_sha256',
  },
  {
    attestingFile: WAVE1_CLOSURE,
    field: 'authority_chain_at_closure.addendum_sha256',
    attestedFile: FIB_ADDENDUM,
    hashKind: 'content_sha256',
  },
  {
    attestingFile: WAVE1_CLOSURE,
    field: 'authority_chain_at_closure.addendum_git_blob',
    attestedFile: FIB_ADDENDUM,
    hashKind: 'git_blob_sha1',
  },
]

// ---------------------------------------------------------------------------
// Git-backed I/O. Kept thin and isolated so `main()` is the only place that
// touches the filesystem or spawns a process.
// ---------------------------------------------------------------------------

const ODS_AUTHORITY_PATH = 'docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json'
/**
 * The commit at which ODS_V1_AUTHORITY_v1.0.0.json was frozen (ODS-01,
 * commit "docs(ods): freeze development operating system v1 authority").
 * Update ONLY through an explicit HPO-authorized re-freeze of that artifact.
 */
const ODS_AUTHORITY_FROZEN_COMMIT = '2aecf625a49ec673fd4185052e71ec6e5c750edf'

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function getRepoRoot(): string {
  const res = git(['rev-parse', '--show-toplevel'], process.cwd())
  if (res.code !== 0) throw new Error(`git rev-parse --show-toplevel failed: ${res.stderr}`)
  return res.stdout.trim()
}

function gitHashObject(repoRoot: string, relativePath: string): string {
  const res = git(['hash-object', relativePath], repoRoot)
  if (res.code !== 0) throw new Error(`git hash-object ${relativePath} failed: ${res.stderr}`)
  return res.stdout.trim()
}

function gitBlobAt(repoRoot: string, commit: string, relativePath: string): string {
  const res = git(['rev-parse', `${commit}:${relativePath}`], repoRoot)
  if (res.code !== 0) throw new Error(`git rev-parse ${commit}:${relativePath} failed: ${res.stderr}`)
  return res.stdout.trim()
}

function gitCatFile(repoRoot: string, blobSha1: string): Buffer {
  const res = spawnSync('git', ['cat-file', 'blob', blobSha1], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`git cat-file blob ${blobSha1} failed: ${res.stderr?.toString()}`)
  return res.stdout as Buffer
}

function readBytes(repoRoot: string, relativePath: string): Buffer {
  return readFileSync(`${repoRoot}/${relativePath}`)
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

function main(): void {
  const repoRoot = getRepoRoot()
  const lines: string[] = []
  let overallPass = true

  // --- A. ODS authority input integrity -------------------------------------------------
  const currentAuthorityBlob = gitHashObject(repoRoot, ODS_AUTHORITY_PATH)
  const frozenAuthorityBlob = gitBlobAt(repoRoot, ODS_AUTHORITY_FROZEN_COMMIT, ODS_AUTHORITY_PATH)
  const authorityInputPass = checkOdsAuthorityInputIntegrity(currentAuthorityBlob, frozenAuthorityBlob)
  lines.push(`ODS_AUTHORITY_INPUT_INTEGRITY=${authorityInputPass ? 'PASS' : 'FAIL'}`)
  if (!authorityInputPass) {
    lines.push(`  current_blob=${currentAuthorityBlob}`)
    lines.push(`  frozen_blob=${frozenAuthorityBlob} (at ${ODS_AUTHORITY_FROZEN_COMMIT})`)
    lines.push('  the ODS authority artifact itself has changed since it was frozen — refusing to trust its corpus definition.')
    console.log(lines.join('\n'))
    process.exit(1)
  }

  // --- Parse the (now-trusted) ODS authority artifact -----------------------------------
  const authority = JSON.parse(readBytes(repoRoot, ODS_AUTHORITY_PATH).toString('utf8'))
  const anchorCommit = extractAnchorCommit(authority)
  const corpus = extractCorpusArtifacts(authority)
  const transitivelyAttested = extractTransitivelyAttestedFiles(authority)

  const corpusCountPass = assertCorpusCount(corpus.length)
  lines.push(`PROTECTED_CORPUS_COUNT=${corpus.length}`)
  if (!corpusCountPass) {
    lines.push(`  expected ${EXPECTED_PROTECTED_CORPUS_COUNT}, found ${corpus.length} — HPO-ODS-03 requires the broad 9-artifact corpus.`)
    overallPass = false
  }

  // --- B. Protected corpus integrity ----------------------------------------------------
  const corpusResults: CorpusCheckResult[] = []
  for (const record of corpus) {
    if (!existsSync(`${repoRoot}/${record.path}`)) {
      lines.push(`PROTECTED_ARTIFACT_MISSING=${record.path}`)
      overallPass = false
      continue
    }
    const currentBytes = readBytes(repoRoot, record.path)
    const currentGitBlobSha1 = gitHashObject(repoRoot, record.path)
    const certifiedGitBlobSha1 = gitBlobAt(repoRoot, anchorCommit, record.path)
    const certifiedBytes = gitCatFile(repoRoot, certifiedGitBlobSha1)
    const result = checkCorpusArtifact({ record, currentBytes, currentGitBlobSha1, certifiedGitBlobSha1, certifiedBytes })
    corpusResults.push(result)
    if (!result.pass) {
      overallPass = false
      lines.push(`CORPUS_VIOLATION path=${result.path}`)
      if (!result.gitBlobIdentityPass) lines.push('    git blob differs from the certified anchor commit')
      if (!result.recordedBlobMatchesAnchorPass) lines.push('    ODS authority recorded blob_sha1 does not match the anchor blob')
      if (!result.contentSha256MatchesRecordPass) lines.push('    current content SHA-256 does not match ODS authority record')
      if (!result.contentSha256MatchesAnchorPass) lines.push('    current content SHA-256 does not match the certified anchor content')
    }
  }
  const protectedCorpusIntegrityPass = corpusResults.length === corpus.length && corpusResults.every((r) => r.pass)
  lines.push(`PROTECTED_CORPUS_INTEGRITY=${protectedCorpusIntegrityPass ? 'PASS' : 'FAIL'}`)

  // --- C. Native relationships -----------------------------------------------------------
  let relationsPass = true
  for (const relation of NATIVE_RELATIONS) {
    const attestingJson = JSON.parse(readBytes(repoRoot, relation.attestingFile).toString('utf8'))
    const attestedValue = getDottedField(attestingJson, relation.field)
    const computedHash =
      relation.hashKind === 'content_sha256'
        ? sha256OfTextLfNormalized(readBytes(repoRoot, relation.attestedFile).toString('utf8'))
        : gitHashObject(repoRoot, relation.attestedFile)
    const pass = checkRelation(attestedValue, computedHash)
    if (!pass) {
      relationsPass = false
      overallPass = false
      lines.push(
        `RELATION_VIOLATION attestingFile=${relation.attestingFile} field=${relation.field} attestedFile=${relation.attestedFile}`,
      )
      lines.push(`    declared=${String(attestedValue)} computed=${computedHash}`)
    }
  }
  lines.push(`TRANSITIVE_ATTESTATION_COUNT=${transitivelyAttested.length}`)
  lines.push(`NATIVE_RELATIONSHIPS=${relationsPass ? 'PASS' : 'FAIL'}`)

  lines.push(`AUTHORITY_SEAL_VERIFY=${overallPass ? 'PASS' : 'FAIL'}`)
  console.log(lines.join('\n'))
  process.exit(overallPass ? 0 : 1)
}

// Only when run as a script. tests/ods/authority-seal-verify.test.ts imports
// the pure functions above, and a bare main() would run against the real
// repo — and call process.exit — in the middle of the suite. Compared
// against argv rather than `import.meta.url`: see scripts/scan-secrets.ts,
// which documents `import.meta` as not reliably present under this
// project's tsx/CommonJS combination.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/authority-seal-verify.ts')

if (invokedDirectly) main()
