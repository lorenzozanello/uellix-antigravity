// scripts/authority-repin.mts
// COMMIT 5.1 — re-pin the governed manifest from a fresh generation.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `pnpm authority:generate` refuses when a pin has moved, which is the whole
// point: a generated artefact whose digest nobody re-reviewed is not evidence.
// But the recovery from a DELIBERATE change was a manual transcription of
// nineteen 64-character hex strings into `governed-manifest.ts`, and this
// commit had to do it eleven times. A transcription done eleven times by hand
// is a transcription that will eventually be done wrong, and the failure mode
// is a pin that matches nothing anybody generated.
//
// So the transcription is mechanical, and the REVIEW stays where it belongs:
// `authority:verify` still regenerates and byte-compares afterwards, the plan
// digest is printed so a silent plan change cannot pass unnoticed, and the
// window/segment/transfer counts are printed beside it for the same reason.
//
// This never decides that a change is CORRECT. It only records what was
// generated, so that a human comparing the diff is comparing artefacts rather
// than proofreading hex.

import { readFileSync, writeFileSync } from 'node:fs'

import { buildGovernedChain } from '../db/hosted/authority/governed-publication'
import { authorityPlanDigest } from '../db/hosted/authority/governed-manifest'

const MANIFEST = 'db/hosted/authority/governed-manifest.ts'

const built = buildGovernedChain({ repin: true })
const planDigest = authorityPlanDigest(built.plan)
let source = readFileSync(MANIFEST, 'utf8')

source = source.replace(
  /export const GOVERNED_PLAN_DIGEST = '[0-9a-f]{64}'/,
  () => `export const GOVERNED_PLAN_DIGEST = '${planDigest}'`,
)

// POSITIONAL, in GOVERNED_PINS order — which is CHAIN_PACKAGE_FILES order, the
// same order `buildGovernedChain` returns. A regex keyed on `packageId: 'T1'`
// was tried first and is fragile in the one way that matters: it silently
// matches nothing when the block is reformatted, and a pin that was not
// rewritten looks exactly like a pin that did not need rewriting.
let index = 0
source = source.replace(
  /(sourceDigest: '|generatedDigest: ')[0-9a-f]{64}(')/g,
  (_match, head: string, tail: string) => {
    const generated = built.packages[Math.floor(index / 2)]
    const digest = index % 2 === 0 ? generated.sourceDigest : generated.generatedDigest
    index += 1
    return `${head}${digest}${tail}`
  },
)

const expected = built.packages.length * 2
if (index !== expected) {
  throw new Error(
    `re-pinned ${index} digests, expected ${expected}. The manifest's shape moved; ` +
      `refusing to write a partially updated pin set.`,
  )
}

writeFileSync(MANIFEST, source, 'utf8')

console.log(`[repin] plan digest      ${planDigest}`)
console.log(
  `[repin] windows/segments ${built.plan.windows.length}/${built.plan.segments.length}, ` +
    `${built.plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER').length} transfers`,
)
for (const generated of built.packages) {
  console.log(`[repin] ${generated.packageId} ${generated.generatedDigest}`)
}
console.log(`[repin] ${built.packages.length} pins written — now run \`pnpm authority:verify\``)
