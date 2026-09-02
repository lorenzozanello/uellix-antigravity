// scripts/hosted-packages.ts
// TRAIN 5B — generate or verify the managed-Supabase artefacts.
//
//   pnpm hosted:generate   writes db/prepared/hosted/*.sql
//   pnpm hosted:verify     regenerates in memory and compares, byte for byte
//
// CONNECTS TO NOTHING. It reads `db/prepared/**`, writes `db/prepared/hosted/**`
// and exits. The hosted artefacts are checked in — not because they are a second
// source of truth, but so that a reviewer can read the SQL that would actually
// run without having to execute a generator to see it. `hosted:verify` is what
// keeps "checked in" from becoming "diverged": the unit suite runs the same
// comparison through the hosted gate.
//
// The computation lives in `db/hosted/artefacts.ts`. This file is only the
// entry point, and the split is deliberate — see that file's header.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { buildHostedArtefacts, hostedArtefactDir } from '../db/hosted/artefacts'
import { HOSTED_PACKAGE_MANIFEST } from '../db/hosted/hosted-package-manifest'

const HOSTED_DIR = hostedArtefactDir()

function generate(): void {
  mkdirSync(HOSTED_DIR, { recursive: true })
  for (const artefact of buildHostedArtefacts()) {
    writeFileSync(path.join(HOSTED_DIR, artefact.fileName), artefact.sql, { encoding: 'utf8' })
    console.log(`[hosted] wrote db/prepared/hosted/${artefact.fileName}`)
  }
  console.log(`[hosted] ${HOSTED_PACKAGE_MANIFEST.length} artefacts generated`)
}

function verify(): void {
  const expected = buildHostedArtefacts()
  const onDisk = new Set(
    readdirSync(HOSTED_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.hosted.sql'))
      .map((d) => d.name),
  )

  const problems: string[] = []

  for (const artefact of expected) {
    onDisk.delete(artefact.fileName)
    let actual: string
    try {
      actual = readFileSync(path.join(HOSTED_DIR, artefact.fileName), 'utf8').replace(/\r\n?/g, '\n')
    } catch {
      problems.push(`${artefact.fileName}: MISSING. Run \`pnpm hosted:generate\`.`)
      continue
    }
    if (actual !== artefact.sql) {
      problems.push(
        `${artefact.fileName}: DIVERGED from what the canonical source plus the rewrite rules produce. ` +
          `Do not edit the artefact — edit db/prepared/<source>.sql, update the manifest pin and the ` +
          `expected rewrite counts, then regenerate.`,
      )
    }
  }

  // An EXTRA artefact is a problem too, and a subtle one: a file nobody
  // generates is a file nobody regenerates, so it is the one that quietly
  // becomes the second source of truth.
  for (const orphan of onDisk) {
    problems.push(`${orphan}: ORPHAN — no manifest entry produces it.`)
  }

  if (problems.length > 0) {
    console.error('[hosted] verification FAILED:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  console.log(`[hosted] verification OK — ${expected.length} artefacts match their sources`)
}

const mode = process.argv[2]
if (mode === 'generate') generate()
else if (mode === 'verify') verify()
else {
  console.error('usage: tsx scripts/hosted-packages.ts <generate|verify>')
  process.exit(2)
}
