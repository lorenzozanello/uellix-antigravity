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
//
// OUTPUT CONTRACT (train 2, Fase 4). The structured block emitted under
// [eval:release] json is deterministic: two runs over the same matrix produce
// byte-identical output. Harness wall-clock is printed OUTSIDE that block,
// because it is a real measurement that is not reproducible and must never be
// mistaken for provider latency.

import { releaseEvalFailureReasons, runReleaseEvalHarness } from '../tests/eval/stella-release/harness'

const { summary, results, observations } = runReleaseEvalHarness()

const structured = {
  version: {
    harness: summary.harnessVersion,
    matrix: summary.matrixVersion,
    fixtures: summary.fixturesVersion,
  },
  results: results.map((result) => ({
    checkId: result.checkId,
    fixtureId: result.fixtureId,
    result: result.ok ? 'pass' : 'fail',
    outcome: result.outcome,
    detail: result.detail,
    negativeControls: result.negativeControls.map((control) => ({
      controlId: control.controlId,
      property: control.property,
      detected: control.detected,
      detail: control.detail,
    })),
  })),
  metrics: summary.metrics.map((metric) => ({
    metric: metric.metric,
    measurable: metric.measurable,
    value: metric.value,
    nullReason: metric.nullReason,
    detail: metric.detail,
  })),
  totals: {
    totalChecks: summary.totalChecks,
    passed: summary.passed,
    failed: summary.failed,
    abstentionResponses: summary.abstentionResponses,
    systemErrors: summary.systemErrors,
    isolationViolations: summary.isolationViolations,
    citationValidationFailures: summary.citationValidationFailures,
    offlineMeasurableChecks: summary.offlineMeasurableChecks,
    offlineLimitedChecks: summary.offlineLimitedChecks,
    negativeControlsRun: summary.negativeControlsRun,
    negativeControlsUndetected: summary.negativeControlsUndetected,
    tautologicalChecks: summary.tautologicalChecks,
    providerCalls: summary.providerCalls,
  },
}

console.log(
  `[eval:release] harness v${summary.harnessVersion}, matrix v${summary.matrixVersion}, fixtures v${summary.fixturesVersion}`,
)

for (const result of results) {
  const status = result.ok ? 'PASS' : 'FAIL'
  console.log(`[eval:release] ${status} [${result.outcome}] ${result.checkId} <${result.fixtureId}> — ${result.detail}`)
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
  if (metric.value === null && metric.nullReason) {
    console.log(
      `[eval:release]   ${metric.metric}: null [${metric.nullReason.code}${metric.nullReason.gate ? `, gate ${metric.nullReason.gate}` : ''}] — ${metric.nullReason.detail}`,
    )
  } else {
    console.log(`[eval:release]   ${metric.metric}: ${metric.value} — ${metric.detail}`)
  }
}

console.log(`[eval:release] json ${JSON.stringify(structured)}`)
// Deliberately outside the deterministic block — see the header note.
console.log(`[eval:release] observation (non-deterministic): harnessWallClockMs=${observations.harnessWallClockMs}`)

// --- failure gates ---------------------------------------------------------
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
