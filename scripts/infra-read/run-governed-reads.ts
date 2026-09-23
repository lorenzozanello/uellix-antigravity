// scripts/infra-read/run-governed-reads.ts
//
// Entry point for the READ-EXECUTION lane. NOT RUN by the executor-hardening
// lane that authored it; running it performs real authenticated control-plane
// reads. It refuses unless every one of --execute, --certified-candidate and
// --out is supplied, and then follows the terminating protocol in
// protocol.ts. It writes ONLY validated, projected evidence records, and runs
// the supplemental evidence scan over what it wrote before reporting success.
//
//   pnpm tsx scripts/infra-read/run-governed-reads.ts --execute \
//     --certified-candidate <40-hex> --out docs/ops/release/evidence/<dir>

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PINNED_TOOL_VERSIONS, Refusal, SHA40_RE } from './ops'
import { buildGhEnv, buildVercelEnv, type Invocation, type ToolContext } from './guards'
import { SafeReadExecutor, assertEnvelopeConforms, isValidatedEvidence, type RunResult } from './executor'
import { assertBundleEnvelopeConforms, runGovernedReadPhase, type Dn0Config, type LocalGit } from './protocol'
import { buildXcc1Env, createXcc1Context } from './xcc1'
import { scanEvidenceFiles } from './evidence-adjudication'

export interface CliArgs { readonly execute: boolean; readonly certifiedCandidate?: string; readonly out?: string }

export function parseArgs(argv: readonly string[]): CliArgs {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }
  return { execute: argv.includes('--execute'), certifiedCandidate: get('--certified-candidate'), out: get('--out') }
}

/** Refuses anything short of an explicit, fully-specified execution request. */
export function assertExecutionRequested(a: CliArgs): asserts a is Required<CliArgs> {
  if (!a.execute) throw new Refusal('STOP_EXECUTION_NOT_REQUESTED', 'refusing: --execute not given')
  if (!a.certifiedCandidate || !SHA40_RE.test(a.certifiedCandidate)) throw new Refusal('STOP_EXECUTION_NOT_REQUESTED', 'refusing: --certified-candidate <40-hex> required')
  if (!a.out) throw new Refusal('STOP_EXECUTION_NOT_REQUESTED', 'refusing: --out <dir> required')
}

const realRunner = (inv: Invocation): RunResult => {
  const r = spawnSync(inv.file, [...inv.argv], {
    // Built from scratch or filtered by guards.ts; Next.js' ProcessEnv augmentation (NODE_ENV) does not apply to a child.
    env: inv.env as unknown as NodeJS.ProcessEnv, cwd: inv.cwd, encoding: 'utf8', shell: false, maxBuffer: 256 * 1024 * 1024, timeout: 180_000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function resolveTools(): ToolContext {
  const gh = spawnSync('gh', ['--version'], { encoding: 'utf8', shell: false })
  if (gh.status !== 0 || !(gh.stdout ?? '').includes(`gh version ${PINNED_TOOL_VERSIONS.gh} `)) {
    throw new Refusal('STOP_TOOL_VERSION_DRIFT', `gh is not the measured ${PINNED_TOOL_VERSIONS.gh}`)
  }
  const appData = process.env.APPDATA
  if (!appData) throw new Refusal('STOP_TOOL_VERSION_DRIFT', 'APPDATA unset; cannot locate the vercel CLI entry')
  const pkgDir = path.join(appData, 'npm', 'node_modules', 'vercel')
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version?: string }
  if (pkg.version !== PINNED_TOOL_VERSIONS.vercel) throw new Refusal('STOP_TOOL_VERSION_DRIFT', `vercel is not the measured ${PINNED_TOOL_VERSIONS.vercel}`)
  const vercelEntry = path.join(pkgDir, 'dist', 'vc.js')
  if (!existsSync(vercelEntry)) throw new Refusal('STOP_TOOL_VERSION_DRIFT', 'vercel entry dist/vc.js absent')
  const x = createXcc1Context()
  return {
    ghFile: 'gh', nodeFile: process.execPath, vercelEntry,
    ghEnv: buildGhEnv(process.env), vercelEnv: buildVercelEnv(process.env),
    xcc1Env: buildXcc1Env(x, process.env), xcc1Cwd: x.cwd,
  }
}

const localGit: LocalGit = {
  run: (args, envOverrides) => {
    const env = envOverrides ? ({ ...process.env, ...envOverrides } as NodeJS.ProcessEnv) : process.env
    const r = spawnSync('git', [...args], { encoding: 'utf8', shell: false, env })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
}

/**
 * Where the read-execution lane MUST materialize the bounded recertification of
 * the executor candidate, and the package_id it must carry. These are the
 * MATERIALIZER's names (the executing lane writes the file). The reviewer's
 * verdict token is never read by name: see certification.ts.
 */
export const EXECUTOR_RECERT_EVENT = {
  path: 'docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_RECERT_IC_v1.0.0.json',
  packageId: 'CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_RECERT_IC',
  /** Materialized at 56294d14; it certifies the executor base, and stays bound to it (v1.0.6). */
  certifiedCandidate: '81b56ed44e9f6744c3949eff7ab9ad1b7137a5b5',
} as const

/**
 * v1.0.6: the short certification of ONLY the safe-diagnostic delta on top of
 * that base. THIS is the event bound to the candidate being executed. The base
 * recert above is append-only and certifies 81b56ed4, so it can never certify a
 * later candidate: binding it to --certified-candidate would make every later
 * candidate unarmable (the B-1 dead end, moved to the event path).
 */
export const EXECUTOR_DIAGNOSTIC_RECERT_EVENT = {
  path: 'docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_DIAGNOSTIC_RECERT_IC_v1.0.0.json',
  packageId: 'CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_DIAGNOSTIC_RECERT_IC',
  /** Materialized at 5375c697; it certifies the safe-diagnostic delta and stays bound to it (v1.0.7). */
  certifiedCandidate: '4a3c2837595abb57e35ba6b4230d66ee4e1da229',
} as const

/**
 * v1.0.7: the certification of the delta that produced the candidate being
 * executed. Its PATH is derived from that candidate, so every future candidate
 * has its own event and no append-only event is ever asked to certify a SHA it
 * does not name (the one-use dead end of v1.0.5 / v1.0.6 cannot recur). The
 * name matches the allowedPostCertificationAdditions class. When a later delta
 * is authored, its predecessor's delta recert is added to the fixed list above.
 */
export const EXECUTOR_DELTA_RECERT_PACKAGE_ID = 'CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_DELTA_RECERT_IC'
export function deltaRecertEventPathFor(candidate: string): string {
  if (!SHA40_RE.test(candidate)) throw new Refusal('STOP_EXECUTION_NOT_REQUESTED', 'candidate is not a 40-hex SHA')
  return `docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_DELTA_RECERT_${candidate.slice(0, 12).toUpperCase()}_IC_v1.0.0.json`
}

export function dn0ConfigFor(certifiedCandidate: string): Dn0Config {
  const authority = JSON.parse(readFileSync('docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_AUTHORITY_v1.0.0.json', 'utf8')) as {
    EFFECTIVE_PACKAGE_CONSUMED: { pins: { path: string; blob: string }[] }
  }
  return {
    expectedBranch: 'codex/cv1-infra-control-plane-read-authority-r1',
    certifiedCandidate,
    allowedPostCertificationAdditions: [/^docs\/ops\/release\/CV1_INFRA_[A-Z0-9_]+_IC_v[0-9.]+\.json$/],
    parentBinding: '6f747e86e0a3eb62d4db87fabe6b331cd4c4a7b2',
    integrationRef: 'origin/integration/commercial-v1',
    pins: authority.EFFECTIVE_PACKAGE_CONSUMED.pins,
    // Each event is bound to the EXACT candidate it certified (v1.0.5, B-1). No verdict name appears here.
    certificationEvents: [
      { path: 'docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EFFECTIVE_AUTHORITY_IC_v1.0.0.json', packageId: 'CV1_INFRA_CONTROL_PLANE_READ_EFFECTIVE_AUTHORITY_IC', certifiedCandidate: '455b5426e11e5518606328dc0f1c3cd6bc7887ca' },
      { path: 'docs/ops/release/CV1_INFRA_RC9_ARMING_PACKAGE_IC_v1.0.0.json', packageId: 'CV1_INFRA_RC9_ARMING_PACKAGE_IC', certifiedCandidate: '3dc12909bb5b584ebc2266900659ab6f158d9eef' },
      { path: EXECUTOR_RECERT_EVENT.path, packageId: EXECUTOR_RECERT_EVENT.packageId, certifiedCandidate: EXECUTOR_RECERT_EVENT.certifiedCandidate },
      { path: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.path, packageId: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.packageId, certifiedCandidate: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.certifiedCandidate },
      { path: deltaRecertEventPathFor(certifiedCandidate), packageId: EXECUTOR_DELTA_RECERT_PACKAGE_ID, certifiedCandidate },
    ],
  }
}

export function main(argv: readonly string[]): number {
  const args = parseArgs(argv)
  try {
    assertExecutionRequested(args)
    const executor = new SafeReadExecutor(realRunner, resolveTools())
    const bundle = runGovernedReadPhase({ executor, git: localGit, dn0: dn0ConfigFor(args.certifiedCandidate) })
    mkdirSync(args.out, { recursive: true })
    const written: string[] = []
    bundle.records.forEach((r, i) => {
      if (!isValidatedEvidence(r)) throw new Refusal('STOP_UNVALIDATED_EVIDENCE', 'refusing to write an unvalidated record')
      assertEnvelopeConforms(r)
      const file = path.join(args.out, `${String(i).padStart(3, '0')}_${r.op_id}.json`)
      writeFileSync(file, `${JSON.stringify(r, null, 1)}\n`)
      written.push(file)
    })
    const summary = path.join(args.out, 'BUNDLE_SUMMARY.json')
    const summaryObject = { ...bundle, records: bundle.records.map((r) => r.op_id) }
    assertBundleEnvelopeConforms(summaryObject)
    writeFileSync(summary, `${JSON.stringify(summaryObject, null, 1)}\n`)
    written.push(summary)
    // EC-1 in-run: serialized + decoded leaves; only the SAME-RUN witness can explain a finding.
    const scan = scanEvidenceFiles(written, (v) => executor.isAdjudicatedValue(v))
    const ser = scan.unexplained.filter((f) => f.level === 'SERIALIZED').length
    const dec = scan.unexplained.filter((f) => f.level === 'DECODED').length
    for (const f of scan.unexplained) console.error(`  ${f.level} ${f.detector} ${f.file} ${f.where}`)
    console.log(`GOVERNED_READ_RECORDS=${bundle.records.filter((r) => r.record_kind === 'GOVERNED_READ_EVIDENCE').length}`)
    console.log(`GOVERNED_READ_CLASSES=${[...new Set(bundle.records.filter((r) => r.record_kind === 'GOVERNED_READ_EVIDENCE').map((r) => r.read_id))].sort().join(',')}`)
    console.log(`EVIDENCE_FILES=${written.length}`)
    console.log(`EC1_SERIALIZED_SCAN=${ser === 0 ? 'PASS' : 'FAIL'}`)
    console.log(`EC1_DECODED_LEAF_SCAN=${dec === 0 ? 'PASS' : 'FAIL'}`)
    console.log(`SAME_RUN_ADJUDICATED_FINDINGS=${scan.adjudicatedExplained}`)
    console.log(`DN0_HEAD=${bundle.dn0.head}`)
    console.log('NEXT: commit the evidence directory ONLY, with parent == DN0_HEAD, then run assertEvidenceCommitParent.')
    return ser + dec === 0 ? 0 : 1
  } catch (e) {
    console.error(e instanceof Refusal ? e.message : `STOP_UNEXPECTED: ${(e as Error).message}`)
    return 2
  }
}

const invokedDirectly = process.argv[1] !== undefined && /run-governed-reads\.[cm]?[jt]s$/.test(process.argv[1])
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
