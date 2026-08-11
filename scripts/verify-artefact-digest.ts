// scripts/verify-artefact-digest.ts
// The last thing an operator runs before psql (Fable HARDENING-1).
//
//   pnpm artefact:verify --path=<PACKAGE_PATH> --digest=<PACKAGE_DIGEST>
//
// ---------------------------------------------------------------------------
// THE WINDOW THIS CLOSES
// ---------------------------------------------------------------------------
// A plan prints PACKAGE_PATH and PACKAGE_DIGEST and then a human runs psql.
// Between those two moments the file is just a file: a regeneration, a stash
// pop, a branch checkout or a half-finished edit all change it silently, and
// the operator would apply whatever is on disk against staging inside one
// transaction. The plan authorises BYTES; the filename is only how they are
// found.
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY CANNOT DO
// ---------------------------------------------------------------------------
// Grant anything. It opens no connection, reads no environment variable,
// spawns no process, touches no attempt ledger and prints no command to run
// next. Its entire output is whether two digests are equal. A helper that
// could also say "and therefore you may apply it" would be a second place
// authorisation lives, and the whole point of the ledger is that there is one.
//
// The expected digest comes from the OPERATOR, pasted from the plan — never
// re-derived here. A verifier that resolved the pin itself would agree with
// itself, and would report PASS for a governed artefact that was regenerated
// after the plan was issued: one of the exact situations this exists to catch.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { verifyArtefactDigest } from '../db/hosted/governed-artefact'

const ROOT = path.resolve(import.meta.dirname, '..')

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

function die(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const relativePath = arg('path')
const expectedDigest = arg('digest')

if (relativePath === undefined || expectedDigest === undefined) {
  die(
    'usage: verify-artefact-digest.ts --path=<PACKAGE_PATH> --digest=<PACKAGE_DIGEST>\n' +
      'Both come from the plan output, copied exactly. There is no default for either: a ' +
      'check that supplied its own expectation would be a check that always passes.',
  )
}

const verdict = verifyArtefactDigest({
  relativePath,
  expectedDigest,
  readFile: (rel) => readFileSync(path.resolve(ROOT, rel), 'utf8'),
})

if (!verdict.ok) {
  process.stderr.write(
    `ARTEFACT_DIGEST = FAIL\nREFUSED  ${verdict.code}\n\n${verdict.detail}\n`,
  )
  process.exit(1)
}

process.stdout.write(
  [
    'ARTEFACT_DIGEST = PASS',
    `  path    ${verdict.relativePath}`,
    `  sha256  ${verdict.digest}`,
    '',
    'The bytes on disk are the bytes the plan named. That is ALL this establishes:',
    'it is not an authorisation, it consumed nothing, and it changed nothing. The',
    'human checkpoint is next.',
    '',
  ].join('\n'),
)
