// scripts/custody/d1-mint-operator-channel-mutation.ts
//
//   pnpm custody:operator-channel:mutation [-- --only=M-ECHO,M-HOST-CHECK] [--check-anchors]
//
// THE MUTATION CONTROLS OF THE OPERATOR-CHANNEL SUCCESSOR (manifest
// FIBDB-053-D1-MINT-OPERATOR-CHANNEL-SUCCESSOR-R1, mutation_controls). Each
// mutant removes ONE safety guarantee from the real source, runs the targeted
// test files, and must turn them RED. The comment-only self-test must SURVIVE
// (GREEN): a battery that can report nothing but RED proves nothing.
//
// Originals are held in memory and written back byte for byte after every
// mutant (and on any failure); `git checkout` is never used, so uncommitted
// work is never lost. --check-anchors verifies every anchor is unique and
// changes nothing.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Mutant {
  readonly id: string
  readonly file: string
  readonly from: string
  readonly to: string
  readonly tests: readonly string[]
  readonly expect: 'RED' | 'GREEN'
}

const CH = 'db/custody/mint-operator-channel.ts'
const LA = 'scripts/custody/d1-mint-operator-launcher.ts'
const PL = 'scripts/custody/d1-mint-operator-plan.ts'
const EV = 'scripts/custody/d1-mint-operator-evidence.ts'
const N6 = 'scripts/custody/d1-n06-closure.ts'
const T_CH = 'tests/custody/d1-mint-operator-channel.test.ts'
const T_PR = 'tests/custody/d1-oep1-probe-contract.test.ts'
const T_V7 = 'tests/custody/d1-dag-amendment-v107.test.ts'
const T_PM = 'tests/custody/d1-pre-hc1-post-mint.test.ts'

export const MUTANTS: readonly Mutant[] = [
  { id: 'M-ECHO', file: CH, from: '          buf[len++] = b\n', to: '          buf[len++] = b\n          output.write(String.fromCharCode(b))\n', tests: [T_CH], expect: 'RED' },
  { id: 'M-NO-RAW', file: CH, from: '  if (input.isRaw !== true) {\n    input.setRawMode(wasRaw)', to: '  if (false) {\n    input.setRawMode(wasRaw)', tests: [T_CH], expect: 'RED' },
  { id: 'M-ENV-SPREAD', file: CH, from: '  const env: Record<string, string> = {}\n', to: '  const env: Record<string, string> = { ...(base as Record<string, string>) }\n', tests: [T_CH], expect: 'RED' },
  { id: 'M-PARENT-ENV-WRITE', file: LA, from: '    child = io.spawn(', to: '    ;(io.env as Record<string, string>)[OPERATOR_ENV_VAR_NAME] = secret.toString(\'utf8\')\n    child = io.spawn(', tests: [T_CH], expect: 'RED' },
  { id: 'M-WINDOWS-HIDE', file: CH, from: 'export const TOOL_SPAWN_FLAGS = { windowsHide: false,', to: 'export const TOOL_SPAWN_FLAGS = { windowsHide: true,', tests: [T_CH], expect: 'RED' },
  { id: 'M-ARGV-CHECK', file: CH, from: '      if (bytes.includes(passwordRaw) || bytes.includes(b64)) {', to: '      if (false) {', tests: [T_CH], expect: 'RED' },
  { id: 'M-HOST-CHECK', file: CH, from: '  if (facts.host !== plan.targetHost.toLowerCase()) {', to: '  if (false) {', tests: [T_CH], expect: 'RED' },
  { id: 'M-PLAN-HOST', file: PL, from: "    ['targetHost', onDisk.targetHost, derived.targetHost],\n", to: '', tests: [T_CH], expect: 'RED' },
  { id: 'M-PLAN-VALID-UNTIL', file: PL, from: "    ['validUntil', onDisk.validUntil, derived.validUntil],\n", to: '', tests: [T_CH], expect: 'RED' },
  { id: 'M-PLAN-DRIVER', file: PL, from: "    ['driverRoot', onDisk.driverRoot, derived.driverRoot],\n", to: '', tests: [T_CH], expect: 'RED' },
  { id: 'M-TOOL-HASH', file: LA, from: '  if (sha256Hex(toolBytes) !== plan.tool.sha256) throw', to: '  if (false) throw', tests: [T_CH], expect: 'RED' },
  { id: 'M-SYNTHETIC-GATE', file: CH, from: '  return /\\.invalid$/i.test(targetHost)', to: '  return targetHost.length > 0', tests: [T_CH], expect: 'RED' },
  { id: 'M-N06-OPERATOR', file: N6, from: ', ...checkOperatorCredentialSection(inv.operator_credential)]', to: ']', tests: [T_V7], expect: 'RED' },
  { id: 'M-OEP1-VERDICT', file: CH, from: "  if (logStatement !== null) rule(logStatement === 'none' || logStatement === 'ddl',", to: '  if (logStatement !== null) rule(true,', tests: [T_PR], expect: 'RED' },
  { id: 'M-PMR13-PINS', file: EV, from: '    if (s(\'probe_tool_sha256\') !== ctx.binding.tools.probe.sha256)', to: '    if (false)', tests: [T_PM], expect: 'RED' },
  { id: 'M-SELF-TEST', file: PL, from: '// CLI\n', to: '// CLI (comment-only self-test mutant)\n', tests: [T_CH], expect: 'GREEN' },
]

/**
 * A mutant of the launcher closure also changes the pinned launcher digest, so
 * the pin test (P-2) fails for EVERY such mutant. That is a real control, but
 * it says nothing about the behaviour the mutant removed. A mutant therefore
 * counts as KILLED only by a failing test OUTSIDE the pin block.
 */
const PIN_BLOCK = 'P-2: the launcher build is deterministic and pinned'

function runTests(root: string, tests: readonly string[]): { green: boolean; failed: number | null; killedBy: string[] } {
  const r = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--testTimeout=180000', '--reporter=json', ...tests], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  let failed: number | null = null
  let killedBy: string[] = []
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as {
      numFailedTests: number
      numTotalTests: number
      testResults: Array<{ assertionResults: Array<{ status: string; fullName: string }> }>
    }
    failed = j.numFailedTests
    if (j.numTotalTests === 0) failed = null
    killedBy = j.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed' && !a.fullName.startsWith(PIN_BLOCK)).map((a) => a.fullName))
  } catch {
    failed = null
  }
  // GREEN = nothing outside the pin block failed (and the run produced a report).
  return { green: failed !== null && killedBy.length === 0, failed, killedBy }
}

export function runBattery(root: string, opts: { only?: readonly string[]; checkAnchorsOnly?: boolean } = {}) {
  const chosen = MUTANTS.filter((m) => opts.only === undefined || opts.only.includes(m.id))
  const originals = new Map<string, string>()
  for (const m of chosen) if (!originals.has(m.file)) originals.set(m.file, readFileSync(join(root, m.file), 'utf8'))
  for (const m of chosen) {
    const n = originals.get(m.file)!.split(m.from).length - 1
    if (n !== 1) throw new Error(`${m.id}: anchor occurs ${n} times in ${m.file}`)
  }
  if (opts.checkAnchorsOnly) return { anchors: 'OK', mutants: chosen.map((m) => m.id) }
  const results: Array<{ id: string; expect: string; observed: string; failedTests: number | null; killedBy: string[]; asExpected: boolean }> = []
  try {
    for (const m of chosen) {
      const original = originals.get(m.file)!
      writeFileSync(join(root, m.file), original.replace(m.from, m.to))
      let r: { green: boolean; failed: number | null; killedBy: string[] }
      try {
        r = runTests(root, m.tests)
      } finally {
        writeFileSync(join(root, m.file), original)
      }
      if (readFileSync(join(root, m.file), 'utf8') !== original) throw new Error(`${m.file} was not restored byte for byte`)
      const observed = r.green ? 'GREEN' : 'RED'
      results.push({ id: m.id, expect: m.expect, observed, failedTests: r.failed, killedBy: r.killedBy, asExpected: observed === m.expect })
      process.stdout.write(`${JSON.stringify(results[results.length - 1])}\n`)
    }
  } finally {
    for (const [f, t] of originals) writeFileSync(join(root, f), t)
  }
  const selfTest = results.find((r) => r.id === 'M-SELF-TEST')
  return {
    results,
    red: results.filter((r) => r.expect === 'RED' && r.observed === 'RED').length,
    expectedRed: results.filter((r) => r.expect === 'RED').length,
    survivors: results.filter((r) => r.expect === 'RED' && r.observed !== 'RED').map((r) => r.id),
    selfTestSurvived: selfTest === undefined ? null : selfTest.observed === 'GREEN',
    allAsExpected: results.every((r) => r.asExpected),
  }
}

if (/d1-mint-operator-channel-mutation\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',')
  const summary = runBattery(process.cwd(), { only, checkAnchorsOnly: process.argv.includes('--check-anchors') })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
