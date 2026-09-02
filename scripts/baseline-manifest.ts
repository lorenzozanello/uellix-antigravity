// scripts/baseline-manifest.ts
// TRAIN 5C0 — inspect or verify the Uellix baseline manifest.
//
//   pnpm baseline:verify    manifest vs the files on disk; exits 1 on any problem
//   pnpm baseline:report    the derived inventory, for a human or a document
//
// CONNECTS TO NOTHING. It reads db/migrations/**, supabase/migrations/** and
// db/policies/**, and exits. There is no apply mode here on purpose: applying
// the baseline to a hosted database is `db/hosted/hosted-provisioning-runner.ts`
// plus an operator, and a script that could do it by accident is a script that
// eventually will.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import {
  BASELINE_ORDER,
  BASELINE_UNITS,
  verifyBaselineManifest,
} from '../db/hosted/baseline-manifest'
import { scanBaselineSql } from '../db/hosted/baseline-scanner'

const ROOT = path.resolve(import.meta.dirname, '..')

const read = (file: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8')
  } catch {
    return null
  }
}

/** Every SQL file the three baseline directories hold, as repo-relative POSIX paths. */
export function discoverBaselineFiles(root: string = ROOT): string[] {
  const dirs: [string, (name: string) => boolean][] = [
    ['db/migrations', (n) => /^\d{4}_.*\.sql$/.test(n)],
    ['supabase/migrations', (n) => n.endsWith('.sql')],
    ['db/policies', (n) => n.endsWith('.sql')],
  ]
  const found: string[] = []
  for (const [dir, accept] of dirs) {
    let names: string[]
    try {
      names = readdirSync(path.join(root, dir))
    } catch {
      continue
    }
    for (const name of names.sort()) if (accept(name)) found.push(`${dir}/${name}`)
  }
  return found
}

function verify(): void {
  const problems = verifyBaselineManifest(read, scanBaselineSql, discoverBaselineFiles())
  if (problems.length > 0) {
    console.error(`[baseline] verification FAILED — ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  - [${p.kind}] ${p.unit}: ${p.detail}`)
    process.exit(1)
  }
  console.log(
    `[baseline] verification OK — ${BASELINE_UNITS.length} units, order pinned, hashes match, ` +
      `derived scan matches every pinned expectation`,
  )
}

function report(): void {
  console.log(`# Uellix baseline — ${BASELINE_UNITS.length} units, in application order\n`)
  console.log('| # | unit | kind | managed | DML | reapply |')
  console.log('|---|---|---|---|---|---|')
  for (const u of BASELINE_UNITS) {
    console.log(`| ${u.ordinal} | \`${u.id}\` | ${u.kind} | ${u.managed} | ${u.dml} | ${u.reapply} |`)
  }

  const byClass = new Map<string, number>()
  for (const u of BASELINE_UNITS) byClass.set(u.managed, (byClass.get(u.managed) ?? 0) + 1)
  console.log('\n## Managed-Supabase classes\n')
  for (const [k, v] of [...byClass].sort()) console.log(`- ${k}: ${v}`)

  const dml = BASELINE_UNITS.filter((u) => u.dml !== 'none')
  console.log(`\n## DML: ${dml.length} unit(s)\n`)
  for (const u of dml) console.log(`- ${u.id}: ${u.dml}`)

  const nonIdempotent = BASELINE_UNITS.filter((u) => u.reapply !== 'idempotent')
  console.log(`\n## Not safe to re-apply: ${nonIdempotent.length} unit(s)\n`)
  for (const u of nonIdempotent) console.log(`- ${u.id}: ${u.reapply}`)

  console.log(`\n## Order digest\n\n${BASELINE_ORDER.join('\n')}`)
}

/** One repo-relative path per line, in application order. Consumed by the rehearsal. */
function order(): void {
  for (const unit of BASELINE_UNITS) console.log(unit.file)
}

const mode = process.argv[2]
if (mode === 'verify') verify()
else if (mode === 'report') report()
else if (mode === 'order') order()
else {
  console.error('usage: tsx scripts/baseline-manifest.ts <verify|report|order>')
  process.exit(2)
}
