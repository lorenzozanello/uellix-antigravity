// scripts/ods-test-diff.ts — ODS-ACCEL-02 NODE 2, deterministic BASE/HEAD
// test-failure classifier.
//
//   pnpm ops:test-diff -- --base <ref-or-capture-file> --head <ref-or-capture-file>
//                          [--test <pattern>]... [--condition-registry <path>] [--json]
//
// Consumes structured Vitest JSON-reporter output (the repository already
// supports `vitest run --reporter=json --outputFile=<path>` out of the box
// — this tool adds no new capture format, only a small orchestration layer
// around it) and classifies every HEAD failure against every BASE failure
// and against docs/ops/ods/KNOWN_TEST_CONDITIONS_v1.0.0.json.
//
// GOVERNANCE RULE: this tool NEVER converts a failure into a pass, never
// skips or filters which tests run, and the condition registry is consulted
// only to LABEL an already-observed failure — it cannot change whether a
// test ran or what it reported. `NO_NEW_FAILURES=true` is reported
// alongside RAW_HEAD_FAILURES, never in place of it, and the tool never
// prints an overall PASS/FAIL verdict for that reason (see composeSummary).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Vitest JSON-reporter shape (the subset this tool reads).
// ---------------------------------------------------------------------------

export interface VitestJsonAssertionResult {
  ancestorTitles: string[]
  fullName: string
  title: string
  status: string
  failureMessages: string[]
}

export interface VitestJsonTestFileResult {
  name: string
  assertionResults: VitestJsonAssertionResult[]
}

export interface VitestJsonReport {
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
  testResults: VitestJsonTestFileResult[]
}

// ---------------------------------------------------------------------------
// Pure: path normalization. Windows path separators are normalized before
// any comparison, and an absolute capture path (from a disposable worktree
// or CI runner, different on every machine) is reduced to a stable
// repo-relative path so two captures taken in different locations still
// compare equal.
// ---------------------------------------------------------------------------

export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Reduces an absolute or relative captured file path to a repo-relative
 * path. If `knownRoot` is supplied (the cwd a live capture ran from) and the
 * path is rooted there, strips exactly that prefix. Otherwise falls back to
 * locating the last `tests/` segment — every condition this registry can
 * describe lives under tests/, so this is a safe, generic reduction for a
 * pre-captured file whose original capture root is unknown to the caller.
 */
export function toRepoRelativePath(rawPath: string, knownRoot?: string): string {
  const normalized = normalizeSeparators(rawPath)
  if (knownRoot) {
    const normalizedRoot = normalizeSeparators(knownRoot).replace(/\/$/, '')
    if (normalized === normalizedRoot) return ''
    if (normalized.startsWith(`${normalizedRoot}/`)) return normalized.slice(normalizedRoot.length + 1)
  }
  const marker = '/tests/'
  const idx = normalized.lastIndexOf(marker)
  if (idx !== -1) return normalized.slice(idx + 1)
  if (normalized.startsWith('tests/')) return normalized
  return normalized
}

// ---------------------------------------------------------------------------
// Pure: extracting observed failures from a parsed report.
// ---------------------------------------------------------------------------

export interface ObservedFailure {
  testFile: string
  testId: string
  /** First line only of the first failure message — see module docstring: this is the mechanically comparable proxy for a semantic signature, since the JSON reporter does not serialize assertion diff bodies. */
  signature: string
}

export function extractFailures(report: VitestJsonReport, knownRoot?: string): ObservedFailure[] {
  const failures: ObservedFailure[] = []
  for (const fileResult of report.testResults) {
    const testFile = toRepoRelativePath(fileResult.name, knownRoot)
    for (const assertion of fileResult.assertionResults) {
      if (assertion.status !== 'failed') continue
      const firstMessage = assertion.failureMessages[0] ?? ''
      const signature = firstMessage.split('\n')[0]
      failures.push({ testFile, testId: assertion.fullName, signature })
    }
  }
  // Stable, deterministic ordering — never left to reporter/OS iteration order.
  return failures.sort((a, b) => (a.testFile === b.testFile ? a.testId.localeCompare(b.testId) : a.testFile.localeCompare(b.testFile)))
}

// ---------------------------------------------------------------------------
// Known-condition registry.
// ---------------------------------------------------------------------------

export interface KnownCondition {
  condition_id: string
  status: string
  test_file: string
  test_id: string
  semantic_category: string
  first_known_base_ref?: string
  evidence_artifact?: string
  expected_failure_signature: string
  cause_fingerprint?: Record<string, unknown>
  authority_or_closure_reference?: string
  notes?: string
}

export interface ConditionRegistry {
  registry_id: string
  version: string
  conditions: KnownCondition[]
}

export function loadConditionRegistry(registryAbsolutePath: string): ConditionRegistry {
  const raw = readFileSync(registryAbsolutePath, 'utf8')
  const parsed = JSON.parse(raw) as ConditionRegistry
  if (!Array.isArray(parsed.conditions)) throw new Error(`${registryAbsolutePath}: missing "conditions" array`)
  return parsed
}

function findCondition(registry: ConditionRegistry, testFile: string, testId: string): KnownCondition | undefined {
  return registry.conditions.find((c) => normalizeSeparators(c.test_file) === testFile && c.test_id === testId)
}

// ---------------------------------------------------------------------------
// Pure: classification.
// ---------------------------------------------------------------------------

export type Classification = 'KNOWN_SAME_CONDITION' | 'NEW_FAILURE' | 'CHANGED_KNOWN_CONDITION' | 'RESOLVED' | 'UNKNOWN'

export interface FailureClassificationResult {
  testFile: string
  testId: string
  signature: string
  classification: Classification
  conditionId?: string
  reason: string
}

export interface ResolvedResult {
  testFile: string
  testId: string
  conditionId?: string
  reason: string
}

export interface ClassificationSummary {
  headClassifications: FailureClassificationResult[]
  resolved: ResolvedResult[]
  baseFailureCount: number
  headFailureCount: number
  knownSameConditionCount: number
  newFailureCount: number
  changedKnownConditionCount: number
  resolvedCount: number
  unknownCount: number
  noNewFailures: boolean
}

function failureKey(f: { testFile: string; testId: string }): string {
  return `${f.testFile}::${f.testId}`
}

/**
 * Pure: classifies every HEAD failure against BASE failures and the
 * registry, and every BASE failure not repeated at HEAD as RESOLVED.
 * `evidenceArtifactExists` is injected so this stays pure and testable —
 * the real CLI answers it against the actual filesystem (see
 * classifyFailures below).
 */
export function classifyFailuresPure(
  baseFailures: ObservedFailure[],
  headFailures: ObservedFailure[],
  registry: ConditionRegistry,
  evidenceArtifactExists: (relativePath: string) => boolean,
): ClassificationSummary {
  const baseByKey = new Map(baseFailures.map((f) => [failureKey(f), f]))
  const headKeys = new Set(headFailures.map((f) => failureKey(f)))

  const headClassifications: FailureClassificationResult[] = headFailures.map((f) => {
    const key = failureKey(f)
    const baseMatch = baseByKey.get(key)
    const condition = findCondition(registry, f.testFile, f.testId)

    if (condition) {
      if (condition.evidence_artifact && !evidenceArtifactExists(condition.evidence_artifact)) {
        return {
          ...f,
          classification: 'UNKNOWN',
          conditionId: condition.condition_id,
          reason: `registry entry ${condition.condition_id} declares evidence_artifact "${condition.evidence_artifact}", which could not be found — fail closed rather than trusting a stale registration`,
        }
      }
      if (f.signature === condition.expected_failure_signature) {
        return {
          ...f,
          classification: 'KNOWN_SAME_CONDITION',
          conditionId: condition.condition_id,
          reason: `matches registry entry ${condition.condition_id}: identical test_file, test_id, and failure signature`,
        }
      }
      return {
        ...f,
        classification: 'CHANGED_KNOWN_CONDITION',
        conditionId: condition.condition_id,
        reason: `same test_file/test_id as ${condition.condition_id}, but the observed failure signature differs from expected_failure_signature — never auto-adjudicated as the same condition`,
      }
    }

    if (baseMatch) {
      return {
        ...f,
        classification: 'UNKNOWN',
        reason: 'this exact test_file/test_id already failed at BASE, but no known-condition registry entry describes it — fail closed rather than guessing it is pre-existing',
      }
    }

    return {
      ...f,
      classification: 'NEW_FAILURE',
      reason: 'did not fail at BASE and has no known-condition registry entry',
    }
  })

  const resolved: ResolvedResult[] = baseFailures
    .filter((f) => !headKeys.has(failureKey(f)))
    .map((f) => {
      const condition = findCondition(registry, f.testFile, f.testId)
      return { testFile: f.testFile, testId: f.testId, conditionId: condition?.condition_id, reason: 'failed at BASE, no longer present at HEAD' }
    })
    .sort((a, b) => (a.testFile === b.testFile ? a.testId.localeCompare(b.testId) : a.testFile.localeCompare(b.testFile)))

  const knownSameConditionCount = headClassifications.filter((c) => c.classification === 'KNOWN_SAME_CONDITION').length
  const newFailureCount = headClassifications.filter((c) => c.classification === 'NEW_FAILURE').length
  const changedKnownConditionCount = headClassifications.filter((c) => c.classification === 'CHANGED_KNOWN_CONDITION').length
  const unknownCount = headClassifications.filter((c) => c.classification === 'UNKNOWN').length

  return {
    headClassifications,
    resolved,
    baseFailureCount: baseFailures.length,
    headFailureCount: headFailures.length,
    knownSameConditionCount,
    newFailureCount,
    changedKnownConditionCount,
    resolvedCount: resolved.length,
    unknownCount,
    // Deliberately narrow: true means zero HEAD failures were classified
    // NEW_FAILURE. It says nothing about CHANGED_KNOWN_CONDITION or UNKNOWN
    // counts — those remain separately reported so a caller can never read
    // this one field as an overall PASS.
    noNewFailures: newFailureCount === 0,
  }
}

// ---------------------------------------------------------------------------
// Git/filesystem-backed I/O.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

export function evidenceArtifactExistsOnDisk(cwd: string, relativePath: string): boolean {
  try {
    return statSync(path.join(cwd, relativePath)).isFile()
  } catch {
    return false
  }
}

export type ReportSource = { kind: 'file'; path: string } | { kind: 'live'; testPatterns: string[] } | { kind: 'unreadable'; reason: string }

/**
 * Fail-closed by construction: a git ref is only ever captured LIVE (no
 * checkout performed) when it names the CURRENT worktree HEAD. Any other
 * ref — including a real, resolvable historical commit — is UNREADABLE
 * unless the caller supplies an existing pre-captured JSON file instead.
 * This tool never creates or removes a git worktree as a side effect of an
 * "evidence" command; see docs/ops/ods/KNOWN_TEST_CONDITIONS_v1.0.0.json's
 * own reference fixtures for how a historical capture is produced
 * out-of-band and then passed in as a file.
 */
export function resolveReportSource(cwd: string, refOrPath: string, testPatterns: string[]): ReportSource {
  const resolvedFilePath = path.isAbsolute(refOrPath) ? refOrPath : path.join(cwd, refOrPath)
  if (existsSync(resolvedFilePath) && statSync(resolvedFilePath).isFile()) {
    return { kind: 'file', path: resolvedFilePath }
  }

  const currentHead = git(cwd, ['rev-parse', 'HEAD'])
  const resolvedRef = git(cwd, ['rev-parse', '--verify', refOrPath])
  if (currentHead.code === 0 && resolvedRef.code === 0 && resolvedRef.stdout.trim() === currentHead.stdout.trim()) {
    return { kind: 'live', testPatterns }
  }

  return {
    kind: 'unreadable',
    reason: `"${refOrPath}" is neither an existing capture file nor the current worktree HEAD. This tool never checks out an arbitrary historical ref automatically (zero side effects on an evidence command) — capture it out-of-band with \`vitest run --reporter=json --outputFile=<path>\` against that ref (e.g. in a disposable \`git worktree add\`) and pass the resulting file path instead.`,
  }
}

export function readCaptureFile(filePath: string): VitestJsonReport | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as VitestJsonReport
  } catch {
    return undefined
  }
}

/** Real subprocess capture: runs vitest now, in `cwd`, for `testPatterns`, via the JSON reporter. Isolated so tests can inject a fake. */
export function captureLiveReport(cwd: string, testPatterns: string[]): VitestJsonReport | undefined {
  const dir = mkdtempSync(path.join(tmpdir(), 'ods-test-diff-'))
  const outputFile = path.join(dir, 'result.json')
  try {
    const args = ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outputFile}`, ...testPatterns]
    const command = ['pnpm', ...args].map((a) => (/^[A-Za-z0-9_.\-/:=]+$/.test(a) ? a : `"${a}"`)).join(' ')
    spawnSync(command, { cwd, stdio: 'ignore', shell: true })
    if (!existsSync(outputFile)) return undefined
    return JSON.parse(readFileSync(outputFile, 'utf8')) as VitestJsonReport
  } catch {
    return undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface LoadedReport {
  report: VitestJsonReport
  knownRoot?: string
  unreadableReason?: undefined
}

export interface UnreadableReport {
  report?: undefined
  unreadableReason: string
}

export function loadReport(cwd: string, refOrPath: string, testPatterns: string[]): LoadedReport | UnreadableReport {
  const source = resolveReportSource(cwd, refOrPath, testPatterns)
  if (source.kind === 'unreadable') return { unreadableReason: source.reason }
  if (source.kind === 'file') {
    const report = readCaptureFile(source.path)
    if (!report) return { unreadableReason: `capture file "${source.path}" could not be read or parsed as JSON` }
    return { report }
  }
  const report = captureLiveReport(cwd, source.testPatterns)
  if (!report) return { unreadableReason: `live capture of the current worktree HEAD failed (vitest did not produce a JSON report)` }
  return { report, knownRoot: cwd }
}

export function classifyFailures(cwd: string, baseFailures: ObservedFailure[], headFailures: ObservedFailure[], registry: ConditionRegistry): ClassificationSummary {
  return classifyFailuresPure(baseFailures, headFailures, registry, (relativePath) => evidenceArtifactExistsOnDisk(cwd, relativePath))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const DEFAULT_CONDITION_REGISTRY_RELATIVE_PATH = 'docs/ops/ods/KNOWN_TEST_CONDITIONS_v1.0.0.json'
export const DEFAULT_TEST_PATTERNS = ['tests/eval/stella-release/hosted-baseline-gate.test.ts']

interface TestDiffArgs {
  base?: string
  head?: string
  testPatterns: string[]
  registryPath?: string
  json: boolean
}

const RECOGNIZED_FLAGS = new Set(['--base', '--head', '--test', '--condition-registry', '--json'])

function looksLikeMissingOperand(token: string | undefined): boolean {
  return token === undefined || token === '--' || RECOGNIZED_FLAGS.has(token)
}

function parseArgs(argv: string[]): TestDiffArgs {
  const args: TestDiffArgs = { testPatterns: [], json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--json') {
      args.json = true
      continue
    }
    if (!RECOGNIZED_FLAGS.has(arg)) {
      console.error(`ops:test-diff: unrecognized argument "${arg}"`)
      process.exit(2)
    }
    const value = argv[i + 1]
    if (looksLikeMissingOperand(value)) {
      console.error(`ops:test-diff: ${arg} requires a value`)
      process.exit(2)
    }
    i++
    if (arg === '--base') args.base = value
    else if (arg === '--head') args.head = value
    else if (arg === '--test') args.testPatterns.push(value)
    else if (arg === '--condition-registry') args.registryPath = value
  }
  return args
}

function stableStringify(summary: ClassificationSummary, base: string, head: string): string {
  const ordered = {
    base,
    head,
    baseFailureCount: summary.baseFailureCount,
    headFailureCount: summary.headFailureCount,
    knownSameConditionCount: summary.knownSameConditionCount,
    newFailureCount: summary.newFailureCount,
    changedKnownConditionCount: summary.changedKnownConditionCount,
    resolvedCount: summary.resolvedCount,
    unknownCount: summary.unknownCount,
    noNewFailures: summary.noNewFailures,
    headClassifications: summary.headClassifications,
    resolved: summary.resolved,
  }
  return JSON.stringify(ordered, null, 2)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.base || !args.head) {
    console.error('ops:test-diff: --base <ref-or-capture-file> and --head <ref-or-capture-file> are required')
    console.log('ODS_TEST_DIFF=USAGE_ERROR')
    process.exit(2)
  }

  const cwd = process.cwd()
  const testPatterns = args.testPatterns.length > 0 ? args.testPatterns : DEFAULT_TEST_PATTERNS
  const registryAbsolutePath = path.join(cwd, args.registryPath ?? DEFAULT_CONDITION_REGISTRY_RELATIVE_PATH)
  const registry = loadConditionRegistry(registryAbsolutePath)

  const baseLoaded = loadReport(cwd, args.base, testPatterns)
  const headLoaded = loadReport(cwd, args.head, testPatterns)

  if (baseLoaded.unreadableReason !== undefined || headLoaded.unreadableReason !== undefined) {
    const lines: string[] = []
    lines.push(`BASE_UNREADABLE=${baseLoaded.unreadableReason !== undefined ? 'true' : 'false'}`)
    if (baseLoaded.unreadableReason !== undefined) lines.push(`  ${baseLoaded.unreadableReason}`)
    lines.push(`HEAD_UNREADABLE=${headLoaded.unreadableReason !== undefined ? 'true' : 'false'}`)
    if (headLoaded.unreadableReason !== undefined) lines.push(`  ${headLoaded.unreadableReason}`)
    lines.push('ODS_TEST_DIFF=UNREADABLE')
    console.log(lines.join('\n'))
    process.exit(2)
  }

  const baseFailures = extractFailures(baseLoaded.report, baseLoaded.knownRoot)
  const headFailures = extractFailures(headLoaded.report, headLoaded.knownRoot)
  const summary = classifyFailures(cwd, baseFailures, headFailures, registry)

  if (args.json) {
    console.log(stableStringify(summary, args.base, args.head))
    process.exit(0)
  }

  const lines: string[] = []
  lines.push(`BASE=${args.base}`)
  lines.push(`HEAD=${args.head}`)
  lines.push(`BASE_FAILURE_COUNT=${summary.baseFailureCount}`)
  lines.push(`HEAD_FAILURE_COUNT=${summary.headFailureCount}`)
  lines.push(`KNOWN_SAME_CONDITION_COUNT=${summary.knownSameConditionCount}`)
  lines.push(`NEW_FAILURE_COUNT=${summary.newFailureCount}`)
  lines.push(`CHANGED_KNOWN_CONDITION_COUNT=${summary.changedKnownConditionCount}`)
  lines.push(`RESOLVED_COUNT=${summary.resolvedCount}`)
  lines.push(`UNKNOWN_COUNT=${summary.unknownCount}`)
  lines.push(`NO_NEW_FAILURES=${summary.noNewFailures}`)
  for (const c of summary.headClassifications) {
    lines.push(`HEAD_FAILURE=${c.testFile}::${c.testId} => ${c.classification}${c.conditionId ? ` (${c.conditionId})` : ''}`)
  }
  for (const r of summary.resolved) {
    lines.push(`RESOLVED=${r.testFile}::${r.testId}${r.conditionId ? ` (${r.conditionId})` : ''}`)
  }
  lines.push('ODS_TEST_DIFF=REPORTED')
  console.log(lines.join('\n'))
  process.exit(0)
}

// Only when run as a script — tests/ods/ods-test-diff.test.ts imports the
// pure functions above. See scripts/authority-seal-verify.ts for why argv
// is checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-test-diff.ts')

if (invokedDirectly) main()
