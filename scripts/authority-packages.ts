// scripts/authority-packages.ts
// COMMIT 4 — the operator entry point for the governed chain.
//
// `generate` runs the whole pipeline and publishes only if every gate passed.
// `verify` regenerates in memory and byte-compares what is on disk, which is
// what makes a checked-in generated artefact auditable rather than merely
// present. Neither reaches a database.

import {
  assertDeterministicGeneration,
  buildGovernedChain,
  publishGovernedChain,
  verifyGovernedChain,
} from '@/db/hosted/authority/governed-publication'

const mode = process.argv[2] ?? 'verify'

if (mode === 'generate' || mode === 'repin') {
  const built = buildGovernedChain({ repin: mode === 'repin' })
  const files = publishGovernedChain(built)
  console.log(`[authority] pre-generation gate: ${built.gateChecks.length} checks PASS`)
  console.log(`[authority] generated-output validation: ${built.outputChecks.length} checks PASS`)
  for (const file of files) console.log(`[authority] published ${file}`)
  console.log(`[authority] ${files.length} governed packages published`)
} else if (mode === 'verify') {
  assertDeterministicGeneration()
  const problems = verifyGovernedChain()
  if (problems.length > 0) {
    console.error('[authority] VERIFICATION FAILED')
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(2)
  }
  const built = buildGovernedChain()
  console.log(
    `[authority] verification OK — ${built.packages.length} governed artefacts match a fresh ` +
      `deterministic regeneration`,
  )
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
