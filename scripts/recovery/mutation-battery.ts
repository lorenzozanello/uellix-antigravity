// scripts/recovery/mutation-battery.ts — mutation pressure on the offline
// recovery mechanism (test manifest OR-M1..OR-M14, OR-M-SELF).
//
//   pnpm exec tsx scripts/recovery/mutation-battery.ts            # the battery
//   pnpm exec tsx scripts/recovery/mutation-battery.ts --self-test # proves it can FAIL
//
// Each mutant REMOVES or NEUTRALISES one safety guarantee in source, runs the
// unit tests that are supposed to notice, and restores the file from the
// ORIGINAL BYTES held in memory (never `git checkout`, which would also discard
// any uncommitted work in the same file). Restoration is verified by sha256.
//
// kill_class records WHY a mutant dies:
//   BYPASS          — the guarantee is the only thing standing between the bad
//                     input and a PASS; removing it lets the bad input through,
//                     and a negative test catches that.
//   TOKEN_PRECISION — another layer still refuses the bad input, and the test
//                     dies only because it pins the EXACT refusal reason. Kept,
//                     and labelled, so nobody mistakes defence in depth for a
//                     single point of failure — or the reverse.
//
// Precondition: the unmutated suite must be green, or every mutant "dies".

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { aggregateBattery, classifyMutant, observeVitest, type Expectation, type MutantOutcome } from './mutation-verdict'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const UNIT = 'tests/recovery'

export interface Mutant {
  id: string
  file: string
  anchor: string
  replacement: string
  tests: string[]
  expect: Expectation
  killClass: 'BYPASS' | 'TOKEN_PRECISION' | 'SELF_TEST_NEUTRAL'
  guarantee: string
}

const R = 'scripts/recovery/'
const T = 'tests/recovery/'

export const MUTANTS: Mutant[] = [
  {
    id: 'OR-M1',
    file: `${R}artifact-integrity.ts`,
    anchor: "return { ok: false, code: 'ARTIFACT_TOC_RELATIONS_MISMATCH' }",
    replacement: 'return null',
    tests: [`${T}artifact-integrity.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'structural TOC check: TABLE entries must equal the captured relations',
  },
  {
    id: 'OR-M2',
    file: `${R}artifact-integrity.ts`,
    anchor: "if (sha256 !== packet.backup_identifier.artifact_sha256) return { ok: false, code: 'ARTIFACT_DIGEST_MISMATCH' }",
    replacement: '',
    tests: [`${T}artifact-integrity.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'recomputed digest must equal the packet digest',
  },
  {
    id: 'OR-M3',
    file: `${R}substrate.ts`,
    anchor: 'if (c.Id !== identity.containerId || labels[RUN_LABEL] !== identity.runId || labels[ROLE_LABEL] !== expectedRole || identity.role !== expectedRole) {',
    replacement: 'if (false) {',
    tests: [`${T}restore-runner.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'restore target must be the substrate this run labelled for restore',
  },
  {
    id: 'OR-M4',
    file: `${R}tool-pin.ts`,
    anchor: "if (value !== pin.serverVersionNum) refusals.push({ code: 'TOOL_SOURCE_SERVER_VERSION_SKEW', field })",
    replacement: '',
    tests: [`${T}tool-pin.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'source server version must equal the pin',
  },
  {
    id: 'OR-M5',
    file: `${R}offline-rehearsal.ts`,
    anchor: "if (r.verdict === 'FAIL') reasons.push(`INVARIANT_FAIL_${code}`)",
    replacement: '',
    tests: [`${T}restore-runner.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'a FAILED invariant fails the rehearsal whatever the restore exit status',
  },
  {
    id: 'OR-M6',
    file: `${R}post-restore-invariants.ts`,
    anchor: "if (!pub.acl.some((a) => a.startsWith('PUBLIC:USAGE:'))) return { ...base, verdict: 'FAIL', reason_code: 'RR_CAP_7_PUBLIC_USAGE_ABSENT' }",
    replacement: '',
    tests: [`${T}post-restore-invariants.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'RR-CAP-7 is absolute: PUBLIC USAGE on schema public, even when the source lacks it',
  },
  {
    id: 'OR-M7',
    file: `${R}post-restore-invariants.ts`,
    anchor: "return compare(expected, fmt(dst), 'REQUIRED_EXTENSION_MISSING_OR_VERSION_SKEW')",
    replacement: "return compare(expected, expected, 'REQUIRED_EXTENSION_MISSING_OR_VERSION_SKEW')",
    tests: [`${T}post-restore-invariants.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'required extensions present with the source version',
  },
  {
    id: 'OR-M8',
    file: `${R}post-restore-invariants.ts`,
    anchor: "compare(triggerFacts(src), triggerFacts(dst), 'TRIGGER_STATE_MISMATCH')",
    replacement: "compare(triggerFacts(src), triggerFacts(src), 'TRIGGER_STATE_MISMATCH')",
    tests: [`${T}post-restore-invariants.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'trigger enabled state compared with the source',
  },
  {
    id: 'OR-M8b',
    file: `${R}post-restore-invariants.ts`,
    anchor: '`${r.schema}.${r.name}:rls=${r.rls}:force=${r.force_rls}`',
    replacement: '`${r.schema}.${r.name}:rls=${r.rls}`',
    tests: [`${T}post-restore-invariants.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'FORCE ROW LEVEL SECURITY compared per relation',
  },
  {
    id: 'OR-M9',
    file: `${R}substrate.ts`,
    anchor: "const removed = docker.run(['rm', '-f', '-v', target])",
    replacement: "const removed = docker.run(['rm', '-f', target])",
    tests: [`${T}substrate.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'container removal takes its anonymous volumes with it (the baseline-rehearsal precedent weakness)',
  },
  {
    id: 'OR-M9b',
    file: `${R}substrate.ts`,
    anchor: "if (v.kind === 'named') removeExit = docker.run(['volume', 'rm', v.name]).status",
    replacement: '',
    tests: [`${T}substrate.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'the run-named PGDATA volume is removed explicitly (rm -v does not remove named volumes)',
  },
  {
    id: 'OR-M10',
    file: `${R}substrate.ts`,
    anchor: "if (net) throw new SubstrateRefusal('SUBSTRATE_NETWORK_NOT_ISOLATED', net)",
    replacement: '',
    tests: [`${T}substrate.test.ts`, `${T}restore-runner.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'inspected network state must be "none" before any byte is streamed',
  },
  {
    id: 'OR-M10b',
    file: `${R}substrate.ts`,
    anchor: "'--network',\n      'none',\n",
    replacement: '',
    tests: [`${T}substrate.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'the substrate is created with --network none',
  },
  {
    id: 'OR-M11',
    file: `${R}evidence-privacy.ts`,
    anchor: "if (!Object.prototype.hasOwnProperty.call(shape.fields, key)) out.push({ path: `${path}.${key}`, problem: 'key not in the evidence grammar' })",
    replacement: '',
    tests: [`${T}evidence-privacy.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'closed evidence objects: an unknown key (e.g. sample rows) is refused',
  },
  {
    id: 'OR-M11b',
    file: `${R}evidence-privacy.ts`,
    anchor: "if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) out.push({ path, problem: 'not a non-negative safe integer' })",
    replacement: '',
    tests: [`${T}evidence-privacy.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'a count is an integer, never text',
  },
  {
    id: 'OR-M12',
    file: `${R}recovery-target.ts`,
    anchor: 'const verdict = verifyStagingTarget(input, production, sentinelPolicy, expectedProjectRef)',
    replacement: 'const verdict = { ok: true, projectRef: input.declaredProjectRef, signals: [], sentinelDeferred: false } as ReturnType<typeof verifyStagingTarget>',
    tests: [`${T}recovery-target.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'hosted identity only through verifyStagingTarget (production veto first)',
  },
  {
    id: 'OR-M13',
    file: `${R}recovery-target.ts`,
    anchor: 'if (nameKeys.length > 0) {',
    replacement: 'if (false) {',
    tests: [`${T}recovery-target.test.ts`],
    expect: 'KILLED',
    killClass: 'TOKEN_PRECISION',
    guarantee: 'a name-like selector key is refused as SELECTED_BY_NAME (the unknown-key layer would still refuse it)',
  },
  {
    id: 'OR-M14',
    file: `${R}post-restore-invariants.ts`,
    anchor: "if (PHASE_RANK[entry.phase] < rank) problems.push({ index, problem: 'PHASE_REGRESSION' })",
    replacement: '',
    tests: [`${T}post-restore-invariants.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'no mutating probe before a non-mutating check',
  },
]

/** A REAL edit that changes no behaviour. Declared KILLED on purpose: the self-test demands it be reported SURVIVED. */
export const NEUTRAL_MUTANT: Mutant = {
  id: 'OR-M-SELF-NEUTRAL',
  file: `${R}tool-pin.ts`,
  anchor: '// EXACT, NOT "COMPATIBLE".',
  replacement: '// EXACT, NOT "COMPATIBLE" (neutral self-test edit).',
  tests: [`${T}tool-pin.test.ts`],
  expect: 'KILLED',
  killClass: 'SELF_TEST_NEUTRAL',
  guarantee: 'none — a comment',
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function runVitest(files: string[]): { exit: number | null; output: string } {
  const res = spawnSync(process.execPath, [VITEST, 'run', ...files], { cwd: ROOT, encoding: 'utf8', timeout: 180_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  return { exit: res.status, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` }
}

export function runMutant(m: Mutant): MutantOutcome & { killClass: Mutant['killClass'] } {
  const abs = path.join(ROOT, m.file)
  const original = readFileSync(abs)
  const originalSha = sha(original)
  const text = original.toString('utf8')
  const anchorFound = text.includes(m.anchor)
  let observed: MutantOutcome['observed'] = 'ERROR'
  if (anchorFound) {
    try {
      // Function replacement: `$` sequences in the replacement are taken literally.
      writeFileSync(abs, text.replace(m.anchor, () => m.replacement))
      const run = runVitest(m.tests)
      observed = observeVitest(run.exit, run.output)
    } finally {
      writeFileSync(abs, original)
    }
  }
  const restoredByteIdentical = sha(readFileSync(abs)) === originalSha
  return { id: m.id, expect: m.expect, observed, anchorFound, restoredByteIdentical, killClass: m.killClass }
}

function main(): void {
  const selfTest = process.argv.includes('--self-test')
  const mutants = selfTest ? [MUTANTS.find((m) => m.id === 'OR-M2')!, NEUTRAL_MUTANT] : MUTANTS
  const files = [...new Set(mutants.map((m) => m.file))]
  const before = new Map(files.map((f) => [f, sha(readFileSync(path.join(ROOT, f)))]))

  const baseline = runVitest([UNIT])
  const baselineGreen = observeVitest(baseline.exit, baseline.output) === 'SURVIVED'
  console.log(`BASELINE ${UNIT}: ${baselineGreen ? 'GREEN' : 'NOT GREEN'}`)

  const outcomes = baselineGreen ? mutants.map((m) => runMutant(m)) : []
  for (const o of outcomes) {
    console.log(`${o.id.padEnd(20)} expect=${o.expect.padEnd(8)} observed=${o.observed.padEnd(8)} ${classifyMutant(o).padEnd(11)} kill_class=${o.killClass} anchor=${o.anchorFound} restored=${o.restoredByteIdentical}`)
  }
  const agg = aggregateBattery(outcomes, baselineGreen)
  const after = files.every((f) => sha(readFileSync(path.join(ROOT, f))) === before.get(f))
  console.log(`FILES_RESTORED_BYTE_IDENTICAL=${after}`)
  console.log(`BATTERY=${agg.battery}${agg.reasons.length ? ` (${agg.reasons.join(',')})` : ''}`)

  if (selfTest) {
    const neutral = outcomes.find((o) => o.id === NEUTRAL_MUTANT.id)
    const real = outcomes.find((o) => o.id === 'OR-M2')
    const ok = agg.battery === 'FAIL' && neutral?.observed === 'SURVIVED' && real !== undefined && classifyMutant(real) === 'AS_EXPECTED' && after
    console.log(`SELF_TEST=${ok ? 'PASS' : 'FAIL'} (a battery that cannot report a survivor is not evidence)`)
    process.exit(ok ? 0 : 1)
  }
  process.exit(agg.battery === 'PASS' && after ? 0 : 1)
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/recovery/mutation-battery.ts')
if (invokedDirectly) main()
