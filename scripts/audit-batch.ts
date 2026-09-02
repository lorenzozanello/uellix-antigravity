// scripts/audit-batch.ts — ODS-ACCEL-03 PHASE B, the deterministic batch
// audit orchestrator.
//
//   pnpm audit:batch -- --base <ref> --head <ref> --target-branch <branch>
//                        [--authority <id>] [--test <pattern>]...
//                        [--postgres-manifest <path>] [--json]
//
// COMPOSE, DO NOT DUPLICATE: every fact below is produced by IMPORTING and
// calling the existing accelerator tools' own exported functions —
// scripts/ods-program-state.ts, scripts/ods-integration-plan.ts,
// scripts/ods-test-diff.ts, scripts/ods-scope.ts, scripts/ods-poststate.ts,
// scripts/ods-prestate.ts, scripts/db-audit-disposable.ts. None of their
// logic is reimplemented here; this file only orchestrates and normalizes
// their outputs into one packet.
//
// FACT VS ADJUDICATION: this tool never prints a semantic verdict
// (B2_CLOSED, AUTHORITY_ACCEPTED, SEMANTICALLY_SAFE, READY_FOR_PRODUCTION).
// AUDIT_PACKET_STATUS reports only whether the packet itself was fully
// assembled — never whether the audited change is good. A raw gate FAIL
// (ODS_POSTSTATE_RAW, HEAD_RAW_FAILURES, etc.) is never rewritten to PASS
// because a failure happens to be a KNOWN_SAME_CONDITION; those coexist by
// design (see docs/ops/ods/KNOWN_TEST_CONDITIONS_v1.0.0.json).
//
// WINDOWS SHELL HARDENING: the historical failure this mission was built to
// avoid is a `pnpm ods:scope -- --allow <path> ...` invocation with 100+
// paths blowing past cmd.exe's argv/quoting limits (`realRunner` in
// scripts/ods-poststate.ts shells out via a single pre-quoted string, which
// is safe for a short fixed command but not for an arbitrarily long
// allow-list). audit:batch's own scope-equivalent check
// (`computeInProcessScopeCheck` below) NEVER shells out at all — it calls
// scripts/ods-scope.ts's pure `classifyPaths` directly with a plain JS
// array, which has no length limit of any kind. The four fixed-length
// commands this file does still shell out to (typecheck, secrets-scan,
// authority-seal-verify, journal/baseline verify) take zero dynamic
// arguments, so they carry none of that risk — see `realRunner`'s own
// header comment in ods-poststate.ts for why `shell:true` is safe there.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { classifyPaths, resolveProtectedGrant, DEFAULT_PROTECTED_PATTERNS } from './ods-scope'
import { buildIntegrationPlanFromRepo, type IntegrationPlan } from './ods-integration-plan'
import {
  loadRegistry as loadProgramStateRegistry,
  findUnit as findProgramStateUnit,
  buildProgramStateReport,
  DEFAULT_REGISTRY_RELATIVE_PATH as DEFAULT_PROGRAM_STATE_REGISTRY_PATH,
  type ProgramStateReport,
} from './ods-program-state'
import {
  loadConditionRegistry,
  loadReport as loadTestDiffReport,
  extractFailures,
  classifyFailures,
  DEFAULT_CONDITION_REGISTRY_RELATIVE_PATH,
  DEFAULT_TEST_PATTERNS,
  type ClassificationSummary,
} from './ods-test-diff'
import { composeSteps, runComposedSteps, realRunner } from './ods-poststate'
import { fetchActual, checkClean } from './ods-prestate'
import { runDisposableHarness, DEFAULT_IMAGE, type SetupManifest, type ProbeManifest, type HarnessOutcome } from './db-audit-disposable'

// ---------------------------------------------------------------------------
// Small git primitives specific to this orchestrator (lineage only — path
// classification and diffing are delegated to ods-scope.ts/ods-integration-plan.ts).
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { code: res.status ?? 1, stdout: res.stdout ?? '' }
}

export type Lineage = 'HEAD_DESCENDANT_OF_BASE' | 'HEAD_NOT_DESCENDANT_OF_BASE' | 'UNKNOWN'

export function resolveLineage(cwd: string, base: string, head: string): { lineage: Lineage; mergeCount: number | null } {
  const ancestor = git(cwd, ['merge-base', '--is-ancestor', base, head])
  const lineage: Lineage = ancestor.code === 0 ? 'HEAD_DESCENDANT_OF_BASE' : ancestor.code === 1 ? 'HEAD_NOT_DESCENDANT_OF_BASE' : 'UNKNOWN'
  const countRes = git(cwd, ['rev-list', '--count', `${base}..${head}`])
  const mergeCount = countRes.code === 0 && countRes.stdout.trim() !== '' ? Number(countRes.stdout.trim()) : null
  return { lineage, mergeCount: mergeCount !== null && Number.isFinite(mergeCount) ? mergeCount : null }
}

export function resolveRef(cwd: string, ref: string): string | null {
  const res = git(cwd, ['rev-parse', '--verify', ref])
  return res.code === 0 ? res.stdout.trim() : null
}

// ---------------------------------------------------------------------------
// In-process ODS_SCOPE equivalent — see the Windows-shell-hardening note
// above. Treats the audited diff's own CHANGED_FILES as its allow-list: the
// only way this fails is a genuinely protected surface with no authorizing
// grant, or a non-canonical-cased protected path — exactly what a real
// `pnpm ods:scope --allow <every changed file>` invocation would report,
// computed here as a single in-memory function call.
// ---------------------------------------------------------------------------

export interface InProcessScopeCheck {
  pass: boolean
  protectedViolationCount: number
  nonCanonicalCount: number
}

export function computeInProcessScopeCheck(changedFiles: string[], targetBranch: string, authority: string | undefined): InProcessScopeCheck {
  const grantResolution = resolveProtectedGrant(authority, targetBranch)
  const result = classifyPaths(changedFiles, DEFAULT_PROTECTED_PATTERNS, changedFiles, grantResolution.grant)
  return {
    pass: result.protectedViolations.length === 0 && result.nonCanonicalProtectedPaths.length === 0,
    protectedViolationCount: result.protectedViolations.length,
    nonCanonicalCount: result.nonCanonicalProtectedPaths.length,
  }
}

// ---------------------------------------------------------------------------
// Packet assembly.
// ---------------------------------------------------------------------------

export interface AuditBatchOptions {
  base: string
  head: string
  targetBranch: string
  authority?: string
  testPatterns: string[]
  postgresManifestPath?: string
  /**
   * What to hand to ops:test-diff's own loadReport for BASE/HEAD test
   * evidence. Defaults to `base`/`head` themselves, which is correct when
   * one of them is the current worktree HEAD (live capture) — but an
   * arbitrary historical git ref is not a valid ops:test-diff input at all
   * (see its own fail-closed contract), so a caller auditing a historical
   * base/head pair supplies a previously captured JSON file path here
   * instead. audit:batch never generates that capture itself — see the
   * module docstring's TEST CAPTURE section.
   */
  baseTestCapture?: string
  headTestCapture?: string
  cwd: string
}

export interface PostgresManifestFile {
  setup?: SetupManifest
  probe?: ProbeManifest
}

/**
 * The expensive, real-subprocess-driven parts of packet assembly, injected
 * so tests can substitute fast fakes for them while still exercising real
 * git/integration-plan/test-diff/scope composition against real temporary
 * repositories. `realAuditBatchDeps` is what the CLI actually uses.
 */
export interface AuditBatchDeps {
  runGovernanceGates: (testPatterns: string[], cwd: string) => { typecheck: 'PASS' | 'FAIL'; secretsScan: 'PASS' | 'FAIL'; authoritySealVerify: 'PASS' | 'FAIL' }
  runJournalVerify: (cwd: string) => 'PASS' | 'FAIL'
  runBaselineVerify: (cwd: string) => 'PASS' | 'FAIL'
  runPostgresHarness: (manifest: PostgresManifestFile) => HarnessOutcome
}

export const realAuditBatchDeps: AuditBatchDeps = {
  runGovernanceGates(testPatterns, cwd) {
    // See module docstring: composeSteps/runComposedSteps/realRunner are
    // IMPORTED from ods-poststate.ts, never reimplemented. Passing no
    // `base` means composeSteps never adds its ods-scope sub-step — this
    // orchestrator's own in-process computeInProcessScopeCheck covers that
    // fact instead, precisely to avoid the large-allowlist shell hazard.
    const steps = composeSteps({ allow: [], tests: testPatterns, requireClean: false })
    const { results } = runComposedSteps(steps, realRunner, cwd)
    const stepStatus = (name: string): 'PASS' | 'FAIL' => (results.find((r) => r.name === name)?.exitCode === 0 ? 'PASS' : 'FAIL')
    return { typecheck: stepStatus('typecheck'), secretsScan: stepStatus('secrets-scan'), authoritySealVerify: stepStatus('authority-seal-verify') }
  },
  runJournalVerify(cwd) {
    return realRunner(['run', 'journal:verify'], cwd) === 0 ? 'PASS' : 'FAIL'
  },
  runBaselineVerify(cwd) {
    return realRunner(['run', 'baseline:verify'], cwd) === 0 ? 'PASS' : 'FAIL'
  },
  runPostgresHarness(manifest) {
    return runDisposableHarness({ image: DEFAULT_IMAGE, setup: manifest.setup, probe: manifest.probe })
  },
}

export interface AuditPacket {
  prestate: { branch: string; head: string; tree: string; clean: boolean }
  baseRef: string
  headRef: string
  targetRef: string | null
  lineage: Lineage
  mergeCount: number | null

  changedFileCount: number
  changedFiles: string[]

  protectedFileCount: number
  protectedFiles: string[]
  nonCanonicalProtectedPaths: string[]
  protectedAuthorityDisposition: string

  semanticOverlapCount: number
  semanticReviewRequiredFiles: string[]

  programState: ProgramStateReport | { status: 'NOT_CONFIGURED' | 'NO_MATCHING_UNIT' }

  testDiff:
    | (ClassificationSummary & { status: 'CLASSIFIED' })
    | { status: 'UNREADABLE'; baseUnreadableReason: string | null; headUnreadableReason: string | null }

  typecheck: 'PASS' | 'FAIL'
  secretsScan: 'PASS' | 'FAIL'
  authoritySealVerify: 'PASS' | 'FAIL'
  journalVerify: 'PASS' | 'FAIL'
  baselineVerify: 'PASS' | 'FAIL'

  postgresRequired: boolean
  postgresStatus: 'SUCCESS' | 'FAILED' | 'NOT_REQUIRED'
  postgresProbeCount: number
  postgresFailures: number
  postgresOutcome: HarnessOutcome | null

  odsScope: 'PASS' | 'FAIL'
  odsPoststateRaw: 'PASS' | 'FAIL'

  cleanState: boolean

  auditPacketStatus: 'ASSEMBLED' | 'PARTIAL' | 'ASSEMBLY_FAILED'
  assemblyNotes: string[]
}

export function assembleAuditPacket(options: AuditBatchOptions, deps: AuditBatchDeps = realAuditBatchDeps): AuditPacket {
  const { cwd } = options
  const notes: string[] = []

  const prestateActual = fetchActual(cwd)
  const clean = checkClean(prestateActual.statusPorcelain)

  const targetRef = resolveRef(cwd, options.targetBranch)
  if (!targetRef) notes.push(`target-branch "${options.targetBranch}" did not resolve — integration/protected facts are unavailable`)

  const { lineage, mergeCount } = resolveLineage(cwd, options.base, options.head)

  let plan: IntegrationPlan | null = null
  if (targetRef) {
    plan = buildIntegrationPlanFromRepo(cwd, options.head, targetRef, options.base, options.targetBranch)
  }

  const changedFileCount = plan?.integrationFileCount ?? 0
  const changedFiles = plan?.sourceChangedFiles ?? []
  const protectedFileCount = plan?.protectedFileCount ?? 0
  const protectedFiles = plan?.protectedFiles ?? []
  const nonCanonicalProtectedPaths = plan?.nonCanonicalProtectedPaths ?? []
  const protectedAuthorityDisposition = plan?.currentProtectedAuthorityDisposition ?? 'NOT_APPLICABLE'
  const semanticOverlapCount = plan?.overlapFileCount ?? 0
  const semanticReviewRequiredFiles = plan?.semanticReviewRequiredFiles ?? []

  // Program state — only when --authority names a real registered unit.
  let programState: AuditPacket['programState'] = { status: 'NOT_CONFIGURED' }
  if (options.authority) {
    try {
      const registry = loadProgramStateRegistry(path.join(cwd, DEFAULT_PROGRAM_STATE_REGISTRY_PATH))
      const unit = findProgramStateUnit(registry, options.authority)
      programState = unit ? buildProgramStateReport(cwd, unit, [options.targetBranch]) : { status: 'NO_MATCHING_UNIT' }
    } catch {
      programState = { status: 'NOT_CONFIGURED' }
      notes.push(`program-state registry could not be read — PROGRAM_STATE reported as NOT_CONFIGURED`)
    }
  }

  // Test-diff classification — fail-closed exactly as ops:test-diff itself
  // does, INCLUDING when the known-conditions registry itself cannot be
  // read: that must never crash packet assembly, only omit this section.
  const testPatterns = options.testPatterns.length > 0 ? options.testPatterns : DEFAULT_TEST_PATTERNS
  let testDiff: AuditPacket['testDiff']
  try {
    const conditionRegistry = loadConditionRegistry(path.join(cwd, DEFAULT_CONDITION_REGISTRY_RELATIVE_PATH))
    const baseLoaded = loadTestDiffReport(cwd, options.baseTestCapture ?? options.base, testPatterns)
    const headLoaded = loadTestDiffReport(cwd, options.headTestCapture ?? options.head, testPatterns)
    if (baseLoaded.unreadableReason !== undefined || headLoaded.unreadableReason !== undefined) {
      testDiff = { status: 'UNREADABLE', baseUnreadableReason: baseLoaded.unreadableReason ?? null, headUnreadableReason: headLoaded.unreadableReason ?? null }
      notes.push('test-diff evidence unreadable for base and/or head — failure classification omitted, never assumed')
    } else {
      const baseFailures = extractFailures(baseLoaded.report, baseLoaded.knownRoot)
      const headFailures = extractFailures(headLoaded.report, headLoaded.knownRoot)
      const summary = classifyFailures(cwd, baseFailures, headFailures, conditionRegistry)
      testDiff = { ...summary, status: 'CLASSIFIED' }
    }
  } catch (error) {
    testDiff = { status: 'UNREADABLE', baseUnreadableReason: null, headUnreadableReason: null }
    notes.push(`test-diff could not run: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Governance gates on the CURRENT worktree — typecheck/secrets/authority
  // seal always reflect the environment audit:batch is actually running in,
  // never a checkout of the historical base/head refs (which this tool
  // never mutates the worktree to reach — see module docstring).
  const gates = deps.runGovernanceGates(options.testPatterns, cwd)
  const { typecheck, secretsScan, authoritySealVerify } = gates
  const journalVerify = deps.runJournalVerify(cwd)
  const baselineVerify = deps.runBaselineVerify(cwd)

  // PostgreSQL — one disposable harness invocation, only if requested.
  let postgresOutcome: HarnessOutcome | null = null
  if (options.postgresManifestPath) {
    const manifestAbsolute = path.isAbsolute(options.postgresManifestPath) ? options.postgresManifestPath : path.join(cwd, options.postgresManifestPath)
    const manifest = JSON.parse(readFileSync(manifestAbsolute, 'utf8')) as PostgresManifestFile
    postgresOutcome = deps.runPostgresHarness(manifest)
  }
  const postgresRequired = Boolean(options.postgresManifestPath)
  const postgresStatus: AuditPacket['postgresStatus'] = postgresOutcome ? postgresOutcome.harnessStatus : 'NOT_REQUIRED'
  const postgresProbeCount = postgresOutcome?.probeCount ?? 0
  const postgresFailures = postgresOutcome?.probeFailureCount ?? 0

  const scopeCheck = computeInProcessScopeCheck(changedFiles, options.targetBranch, options.authority)
  const odsScope: 'PASS' | 'FAIL' = scopeCheck.pass ? 'PASS' : 'FAIL'
  const odsPoststateRaw: 'PASS' | 'FAIL' =
    odsScope === 'PASS' && typecheck === 'PASS' && secretsScan === 'PASS' && authoritySealVerify === 'PASS' ? 'PASS' : 'FAIL'

  const auditPacketStatus: AuditPacket['auditPacketStatus'] = !targetRef || testDiff.status === 'UNREADABLE' ? 'PARTIAL' : 'ASSEMBLED'

  return {
    prestate: { branch: prestateActual.branch, head: prestateActual.head, tree: prestateActual.tree, clean },
    baseRef: options.base,
    headRef: options.head,
    targetRef,
    lineage,
    mergeCount,
    changedFileCount,
    changedFiles,
    protectedFileCount,
    protectedFiles,
    nonCanonicalProtectedPaths,
    protectedAuthorityDisposition,
    semanticOverlapCount,
    semanticReviewRequiredFiles,
    programState,
    testDiff,
    typecheck,
    secretsScan,
    authoritySealVerify,
    journalVerify,
    baselineVerify,
    postgresRequired,
    postgresStatus,
    postgresProbeCount,
    postgresFailures,
    postgresOutcome,
    odsScope,
    odsPoststateRaw,
    cleanState: clean,
    auditPacketStatus,
    assemblyNotes: notes,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  base?: string
  head?: string
  targetBranch?: string
  authority?: string
  testPatterns: string[]
  postgresManifestPath?: string
  baseTestCapture?: string
  headTestCapture?: string
  json: boolean
}

const RECOGNIZED_FLAGS = new Set([
  '--base',
  '--head',
  '--target-branch',
  '--authority',
  '--test',
  '--postgres-manifest',
  '--base-test-capture',
  '--head-test-capture',
  '--json',
])

function looksLikeMissingOperand(token: string | undefined): boolean {
  return token === undefined || token === '--' || RECOGNIZED_FLAGS.has(token)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { testPatterns: [], json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--json') {
      args.json = true
      continue
    }
    if (!RECOGNIZED_FLAGS.has(arg)) {
      console.error(`audit:batch: unrecognized argument "${arg}"`)
      process.exit(2)
    }
    const value = argv[i + 1]
    if (looksLikeMissingOperand(value)) {
      console.error(`audit:batch: ${arg} requires a value`)
      process.exit(2)
    }
    i++
    if (arg === '--base') args.base = value
    else if (arg === '--head') args.head = value
    else if (arg === '--target-branch') args.targetBranch = value
    else if (arg === '--authority') args.authority = value
    else if (arg === '--test') args.testPatterns.push(value)
    else if (arg === '--postgres-manifest') args.postgresManifestPath = value
    else if (arg === '--base-test-capture') args.baseTestCapture = value
    else if (arg === '--head-test-capture') args.headTestCapture = value
  }
  return args
}

function stableStringify(packet: AuditPacket): string {
  return JSON.stringify(packet, null, 2)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.base || !args.head || !args.targetBranch) {
    console.error('audit:batch: --base, --head, and --target-branch are required')
    console.log('AUDIT_PACKET_STATUS=USAGE_ERROR')
    process.exit(2)
  }
  if (args.postgresManifestPath && !existsSync(path.isAbsolute(args.postgresManifestPath) ? args.postgresManifestPath : path.join(process.cwd(), args.postgresManifestPath))) {
    console.error(`audit:batch: --postgres-manifest path does not exist: ${args.postgresManifestPath}`)
    console.log('AUDIT_PACKET_STATUS=USAGE_ERROR')
    process.exit(2)
  }

  let packet: AuditPacket
  try {
    packet = assembleAuditPacket({
      base: args.base,
      head: args.head,
      targetBranch: args.targetBranch,
      authority: args.authority,
      testPatterns: args.testPatterns,
      postgresManifestPath: args.postgresManifestPath,
      baseTestCapture: args.baseTestCapture,
      headTestCapture: args.headTestCapture,
      cwd: process.cwd(),
    })
  } catch (error) {
    console.error(`audit:batch: packet assembly failed: ${error instanceof Error ? error.message : String(error)}`)
    console.log('AUDIT_PACKET_STATUS=ASSEMBLY_FAILED')
    process.exit(1)
  }

  if (args.json) {
    console.log(stableStringify(packet))
  } else {
    console.log(`AUDIT_PACKET_STATUS=${packet.auditPacketStatus}`)
    console.log(`BASE_REF=${packet.baseRef}`)
    console.log(`HEAD_REF=${packet.headRef}`)
    console.log(`TARGET_REF=${packet.targetRef ?? '(unresolved)'}`)
    console.log(`LINEAGE=${packet.lineage}`)
    console.log(`MERGE_COUNT=${packet.mergeCount ?? '(unknown)'}`)
    console.log(`CHANGED_FILE_COUNT=${packet.changedFileCount}`)
    console.log(`PROTECTED_FILE_COUNT=${packet.protectedFileCount}`)
    console.log(`NON_CANONICAL_PROTECTED_PATHS=${packet.nonCanonicalProtectedPaths.length}`)
    console.log(`PROTECTED_AUTHORITY_DISPOSITION=${packet.protectedAuthorityDisposition}`)
    console.log(`SEMANTIC_OVERLAP_COUNT=${packet.semanticOverlapCount}`)
    for (const f of packet.semanticReviewRequiredFiles) console.log(`SEMANTIC_REVIEW_REQUIRED_FILE=${f}`)
    if (packet.testDiff.status === 'CLASSIFIED') {
      console.log(`BASE_RAW_FAILURES=${packet.testDiff.baseFailureCount}`)
      console.log(`HEAD_RAW_FAILURES=${packet.testDiff.headFailureCount}`)
      console.log(`KNOWN_SAME_CONDITION_COUNT=${packet.testDiff.knownSameConditionCount}`)
      console.log(`NEW_FAILURE_COUNT=${packet.testDiff.newFailureCount}`)
      console.log(`CHANGED_KNOWN_CONDITION_COUNT=${packet.testDiff.changedKnownConditionCount}`)
      console.log(`RESOLVED_COUNT=${packet.testDiff.resolvedCount}`)
      console.log(`UNKNOWN_COUNT=${packet.testDiff.unknownCount}`)
      console.log(`NO_NEW_FAILURES=${packet.testDiff.noNewFailures}`)
    } else {
      console.log('TEST_DIFF_STATUS=UNREADABLE')
      if (packet.testDiff.baseUnreadableReason) console.log(`  BASE_UNREADABLE_REASON=${packet.testDiff.baseUnreadableReason}`)
      if (packet.testDiff.headUnreadableReason) console.log(`  HEAD_UNREADABLE_REASON=${packet.testDiff.headUnreadableReason}`)
    }
    console.log(`TYPECHECK=${packet.typecheck}`)
    console.log(`SECRETS_SCAN=${packet.secretsScan}`)
    console.log(`AUTHORITY_SEAL_VERIFY=${packet.authoritySealVerify}`)
    console.log(`JOURNAL_VERIFY=${packet.journalVerify}`)
    console.log(`BASELINE_VERIFY=${packet.baselineVerify}`)
    console.log(`POSTGRES_REQUIRED=${packet.postgresRequired}`)
    console.log(`POSTGRES_STATUS=${packet.postgresStatus}`)
    console.log(`POSTGRES_PROBE_COUNT=${packet.postgresProbeCount}`)
    console.log(`POSTGRES_FAILURES=${packet.postgresFailures}`)
    console.log(`ODS_SCOPE=${packet.odsScope}`)
    console.log(`ODS_POSTSTATE_RAW=${packet.odsPoststateRaw}`)
    console.log(`CLEAN_STATE=${packet.cleanState}`)
    for (const n of packet.assemblyNotes) console.log(`NOTE=${n}`)
  }
  process.exit(0)
}

// Only when run as a script — tests/ods/audit-batch.test.ts imports the
// pure/composable functions above. See scripts/authority-seal-verify.ts for
// why argv is checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/audit-batch.ts')

if (invokedDirectly) main()
