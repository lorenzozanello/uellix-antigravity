// scripts/eval-release-offline.ts
// RELEASE line (STELLA_RELEASE_EVALUATION_FOUNDATION_TRAIN_1): offline
// evaluation gate over the grounding + isolation release matrix.
// Mirrors scripts/eval-offline.ts and scripts/eval-roles-offline.ts.
// Fully offline: no network, no DB, no provider, no env secrets. The only
// I/O is reading committed files under db/prepared/** and tests/** to
// confirm the CAP-01..CAP-05 regression surface is present (never executed
// here — see docs/ops/workstreams/RELEASE.md).
// Exits non-zero on any failure.
//
// Wired as `pnpm test:stella:release-eval` (package.json "scripts" block,
// added by the Stella train 2 shared-root preparation unit). Still runnable
// directly:
//   pnpm exec tsx scripts/eval-release-offline.ts

import { runReleaseEvalHarness } from '../tests/eval/stella-release/harness'
import { RELEASE_EVAL_MATRIX_VERSION } from '../tests/eval/stella-release/matrix'
import { RELEASE_FIXTURES_VERSION } from '../tests/eval/stella-release/fixtures'

const { summary, results } = runReleaseEvalHarness()

console.log(`[eval:release] matrix v${RELEASE_EVAL_MATRIX_VERSION}, fixtures v${RELEASE_FIXTURES_VERSION}`)

let failed = 0
for (const result of results) {
  const status = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  console.log(`[eval:release] ${status} [${result.outcome}] ${result.checkId} — ${result.detail}`)
}

console.log(`[eval:release] ${summary.passed}/${summary.totalChecks} checks passed`)
console.log(`[eval:release] outcomes: pass=${summary.passed - summary.abstentionResponses} abstention=${summary.abstentionResponses} system-error=${summary.systemErrors} isolation-violation=${summary.isolationViolations}`)

console.log('[eval:release] metrics:')
for (const metric of summary.metrics) {
  const value = metric.measurable ? metric.value : 'N/A (offline)'
  console.log(`[eval:release]   ${metric.metric}: ${value} — ${metric.detail}`)
}

if (failed > 0) {
  console.error(`[eval:release] FAILED: ${failed} check(s) did not pass`)
  process.exit(1)
}
if (summary.providerCalls !== 0) {
  console.error('[eval:release] FAILED: harness made a provider call — must stay fully offline')
  process.exit(1)
}
console.log(`[eval:release] OK — ${summary.totalChecks}/${summary.totalChecks} checks green, zero provider calls, zero isolation violations, zero system errors`)
