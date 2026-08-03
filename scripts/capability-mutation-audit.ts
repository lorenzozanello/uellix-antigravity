#!/usr/bin/env tsx
/**
 * scripts/capability-mutation-audit.ts
 *
 * Applies every catalogued mutation to db/prepared ON DISK, runs the suites
 * against it, restores the file and verifies the restoration by SHA-256.
 *
 * WHY ON DISK. tests/capability-mutation.test.ts proves the new gates refuse
 * each mutation, but it does so in memory, against a function it imports. It
 * cannot answer the other half of the question the reaudit asked: did the
 * EXISTING suite let these through? tests/capability-isolation.test.ts reads
 * db/prepared itself, so the only way to measure it is to put a mutant there.
 *
 * SAFETY. The original bytes are held in memory, restored in a finally, and the
 * SHA is compared before and after. A mismatch aborts the whole run rather than
 * continuing with a modified tree. Nothing here touches a database, a network,
 * or any file outside db/prepared.
 *
 * RUN IT ALONE. While this script is running, db/prepared contains a
 * deliberately broken file. Anything else reading the working tree at the same
 * time — another vitest run, a lint, an editor's type checker — will see the
 * mutant and report failures that have nothing to do with what it was asked to
 * check. Observed, not theorised: three unrelated suites went red mid-audit and
 * the diagnosis cost more than the run.
 *
 *   pnpm tsx scripts/capability-mutation-audit.ts            # full matrix
 *   pnpm tsx scripts/capability-mutation-audit.ts --legacy   # M-* vs old suite
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { MUTATIONS, type Mutation } from '../tests/helpers/capability-mutations'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')
const LEGACY = 'tests/capability-isolation.test.ts'
const GATES = 'tests/capability-policy-contract.test.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

interface Run {
  readonly passed: number
  readonly failed: number
}

function vitest(file: string): Run {
  try {
    const out = execFileSync('pnpm', ['vitest', 'run', file, '--reporter=json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    })
    return summarize(out)
  } catch (e) {
    const out = (e as { stdout?: string }).stdout ?? ''
    return summarize(out)
  }
}

/**
 * A run that produced no parseable result is a MEASUREMENT FAILURE, not a run
 * with zero failures.
 *
 * The first version returned `{passed: 0, failed: -1}` here and then rendered
 * `failed > 0 ? 'RED' : 'GREEN — SURVIVES'` — so a crashed vitest printed that a
 * mutation had SURVIVED, while the survivor tally counted only `failed === 0`
 * and the exit code stayed 0. The script would have reported the strongest
 * possible finding and exited successfully. It now refuses to guess.
 */
function summarize(raw: string): Run {
  const at = raw.indexOf('{')
  if (at === -1) throw new Error('vitest produced no JSON: the measurement failed, so nothing can be concluded')
  const j = JSON.parse(raw.slice(at)) as { numPassedTests: number; numFailedTests: number }
  if (typeof j.numPassedTests !== 'number' || typeof j.numFailedTests !== 'number')
    throw new Error('vitest JSON lacks the test counts')
  return { passed: j.numPassedTests, failed: j.numFailedTests }
}

interface Row {
  readonly m: Mutation
  readonly shaBefore: string
  readonly shaAfter: string
  readonly restored: boolean
  readonly legacy: Run | null
  readonly gates: Run
}

function audit(m: Mutation, withLegacy: boolean): Row {
  const file = path.join(PREPARED, m.file)
  const original = readFileSync(file, 'utf8')
  const before = sha(original)
  let legacy: Run | null = null
  let gates: Run | null = null
  try {
    const mutated = m.apply(original)
    if (mutated === original) throw new Error(`${m.id} is a no-op`)
    writeFileSync(file, mutated, 'utf8')
    if (withLegacy) legacy = vitest(LEGACY)
    gates = vitest(GATES)
  } finally {
    writeFileSync(file, original, 'utf8')
  }
  const after = sha(readFileSync(file, 'utf8'))
  if (gates === null) throw new Error(`${m.id}: the gate measurement never completed`)
  return { m, shaBefore: before, shaAfter: after, restored: before === after, legacy, gates }
}

const legacyOnly = process.argv.includes('--legacy')
const targets = legacyOnly ? MUTATIONS.filter((x) => x.id.startsWith('M-')) : MUTATIONS

const rows: Row[] = []
for (const m of targets) {
  const row = audit(m, m.id.startsWith('M-'))
  if (!row.restored) {
    console.error(`FATAL: ${m.file} was not restored after ${m.id}. Aborting.`)
    process.exit(1)
  }
  rows.push(row)
  const l = row.legacy ? `legacy ${row.legacy.failed} failed` : 'legacy n/a'
  console.error(`${m.id.padEnd(5)} ${l.padEnd(18)} gates ${row.gates.failed} failed  restored=ok`)
}

console.log('\n| Mutation | Sev | Cap | Legacy suite | New gates | Restored | SHA before→after |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const r of rows) {
  const legacy = r.legacy
    ? r.legacy.failed > 0
      ? `RED (${r.legacy.failed})`
      : `**GREEN — survives**`
    : '—'
  const gates = r.gates.failed > 0 ? `**RED (${r.gates.failed})**` : 'GREEN — SURVIVES'
  console.log(
    `| ${r.m.id} | ${r.m.severity} | ${r.m.capability} | ${legacy} | ${gates} | ${r.restored ? 'yes' : 'NO'} | \`${r.shaBefore.slice(0, 8)}\`→\`${r.shaAfter.slice(0, 8)}\` |`,
  )
}

const survivingLegacy = rows.filter((r) => r.legacy && r.legacy.failed === 0).length
const survivingGates = rows.filter((r) => r.gates.failed === 0).length
console.log(`\nsurvive the legacy suite: ${survivingLegacy}`)
console.log(`survive the new gates:    ${survivingGates}`)
console.log(`restored intact:          ${rows.filter((r) => r.restored).length}/${rows.length}`)
if (survivingGates > 0) process.exitCode = 1
