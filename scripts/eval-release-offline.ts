// scripts/eval-release-offline.ts
// RELEASE line (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2): offline
// evaluation gate over the grounding + isolation release matrix.
// Mirrors scripts/eval-offline.ts and scripts/eval-roles-offline.ts.
// Fully offline: no network, no DB, no provider, no env secrets. The only
// I/O is reading committed files under db/prepared/**, tests/** and
// vitest.shared.ts to confirm the CAP-01..CAP-05 regression surface is
// present and still collected (never executed here).
// Exits non-zero on any failure.
//
// Invoked as `pnpm test:stella:release-eval`. Still runnable directly:
//   pnpm exec tsx scripts/eval-release-offline.ts

import { releaseEvalFailureReasons, runReleaseEvalHarness } from '../tests/eval/stella-release/harness'
import { RELEASE_EVAL_MATRIX_VERSION } from '../tests/eval/stella-release/matrix'
import { RELEASE_FIXTURES_VERSION } from '../tests/eval/stella-release/fixtures'

const { summary, results } = runReleaseEvalHarness()

console.log(`[eval:release] matrix v${RELEASE_EVAL_MATRIX_VERSION}, fixtures v${RELEASE_FIXTURES_VERSION}`)

for (const result of results) {
  const status = result.ok ? 'PASS' : 'FAIL'
  console.log(`[eval:release] ${status} [${result.outcome}] ${result.checkId} <${result.fixtureId}> — ${result.detail}`)
  // Every negative control is printed with its verdict. A check is only worth
  // its green if the mutation it claims to catch was actually caught, and that
  // has to be visible in the log, not just inside the harness.
  for (const control of result.negativeControls) {
    const mark = control.detected ? 'detected' : 'NOT-DETECTED'
    console.log(`[eval:release]     control ${mark}: ${control.controlId} — ${control.detail}`)
  }
}

console.log(`[eval:release] ${summary.passed}/${summary.totalChecks} checks passed`)
console.log(
  `[eval:release] outcomes: pass=${summary.passed - summary.abstentionResponses} abstention=${summary.abstentionResponses} system-error=${summary.systemErrors} isolation-violation=${summary.isolationViolations}`,
)
// Train 1 reported a bare "14/14" that made no distinction between a category
// measured end-to-end offline and one whose measurement is limited (B-M5).
console.log(
  `[eval:release] offline coverage: ${summary.offlineMeasurableChecks} fully measurable, ${summary.offlineLimitedChecks} offline-limited (see matrix offlineLimitation)`,
)
console.log(
  `[eval:release] negative controls: ${summary.negativeControlsRun} run, ${summary.negativeControlsUndetected} undetected`,
)

console.log('[eval:release] metrics:')
for (const metric of summary.metrics) {
  const value = metric.measurable ? metric.value : 'N/A (offline)'
  console.log(`[eval:release]   ${metric.metric}: ${value} — ${metric.detail}`)
}

// The gate logic lives in the harness (releaseEvalFailureReasons) so it can be
// tested against synthetic summaries: proving "the process fails on an
// isolation violation" must not require engineering a real tenant leak.
const reasons = releaseEvalFailureReasons(summary)

if (reasons.length > 0) {
  for (const reason of reasons) console.error(`[eval:release] FAILED: ${reason}`)
  process.exit(1)
}

console.log(
  `[eval:release] OK — ${summary.totalChecks}/${summary.totalChecks} checks green, ${summary.negativeControlsRun} negative controls all detected, zero provider calls, zero isolation violations, zero system errors`,
)
