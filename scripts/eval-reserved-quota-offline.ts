// scripts/eval-reserved-quota-offline.ts
// RELEASE line (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3): offline
// evaluation gate over the reserved-quota interference contract between a
// grounded reservation and the six sibling categories (R1/R6-INT). Mirrors
// scripts/eval-idempotency-offline.ts / scripts/eval-project-binding-offline.ts's
// own pattern (check()/report/process.exit(1) on failure). Fully offline: no
// network, no DB, no provider, no env secrets.
//
// WIRING NOTE for integration: not yet in package.json (RELEASE cannot touch
// it — see docs/ops/workstreams/RELEASE.md §Rutas prohibidas). Runnable today as:
//   pnpm exec tsx scripts/eval-reserved-quota-offline.ts
// Suggested script name once wired, matching the existing
// "test:stella:idempotency-eval" / "test:stella:project-binding-eval"
// convention: "test:stella:reserved-quota-eval".

import { runReservedQuotaEvalHarness, reservedQuotaEvalFailureReasons } from '../tests/eval/stella-release/reserved-quota-harness'
import { computeReservedQuotaGateReport } from '../tests/eval/stella-release/reserved-quota-release-gate'

const run = runReservedQuotaEvalHarness()
const { summary, results } = run

console.log(`[eval:reserved-quota] harness v${summary.harnessVersion}, matrix v${summary.matrixVersion}`)

for (const result of results) {
  const status = result.ok ? 'PASS' : 'FAIL'
  console.log(`[eval:reserved-quota] ${status} [${result.outcome}] ${result.caseId} — ${result.detail}`)
  for (const control of result.negativeControls) {
    const mark = control.detected ? 'detected' : 'NOT-DETECTED'
    console.log(`[eval:reserved-quota]     control ${mark}: ${control.controlId} — ${control.detail}`)
  }
}

console.log(`[eval:reserved-quota] ${summary.passed}/${summary.totalCases} cases passed`)
console.log(`[eval:reserved-quota] negative controls: ${summary.negativeControlsRun} run, ${summary.negativeControlsUndetected} undetected`)
console.log(`[eval:reserved-quota] observability safe: ${summary.observabilitySafe}`)
console.log(`[eval:reserved-quota] feature flag safe: ${summary.featureFlagSafe}`)

const structured = {
  version: { harness: summary.harnessVersion, matrix: summary.matrixVersion },
  results: results.map((r) => ({
    caseId: r.caseId,
    result: r.ok ? 'pass' : 'fail',
    outcome: r.outcome,
    detail: r.detail,
    negativeControls: r.negativeControls.map((c) => ({ controlId: c.controlId, property: c.property, detected: c.detected, detail: c.detail })),
  })),
  totals: {
    totalCases: summary.totalCases,
    passed: summary.passed,
    failed: summary.failed,
    negativeControlsRun: summary.negativeControlsRun,
    negativeControlsUndetected: summary.negativeControlsUndetected,
    tautologicalCases: summary.tautologicalCases,
    observabilitySafe: summary.observabilitySafe,
    featureFlagSafe: summary.featureFlagSafe,
  },
}
console.log(`[eval:reserved-quota] json ${JSON.stringify(structured)}`)

// --- reserved-quota release gates (Fase 7) ----------------------------------
const gateReport = computeReservedQuotaGateReport(run)

console.log('[eval:reserved-quota] release gates:')
for (const gate of gateReport.gates) {
  console.log(`[eval:reserved-quota]   ${gate.passed ? 'PASS' : 'FAIL'} ${gate.id} — ${gate.detail}`)
}
console.log(
  `[eval:reserved-quota] readiness: reserved-quota-harness-ready=${gateReport.reservedQuotaHarnessReady} local-runtime-ready=false (unaffected — see docs/ops/workstreams/RELEASE.md)`,
)
console.log('[eval:reserved-quota] missing for reserved-quota runtime:')
for (const item of gateReport.missingForReservedQuotaRuntime) console.log(`[eval:reserved-quota]   - ${item}`)

// --- failure gate ------------------------------------------------------------
const reasons = reservedQuotaEvalFailureReasons(summary)
if (!gateReport.reservedQuotaHarnessReady) {
  reasons.push(`reserved-quota-harness-ready is false: ${gateReport.missingForReservedQuotaHarness.join('; ')}`)
}

if (reasons.length > 0) {
  for (const reason of reasons) console.error(`[eval:reserved-quota] FAILED: ${reason}`)
  process.exit(1)
}

console.log(
  `[eval:reserved-quota] OK — ${summary.totalCases}/${summary.totalCases} cases green, ${summary.negativeControlsRun} negative controls all detected, reserved-quota-harness-ready=true, local-runtime-ready=false (R1/R6-INT unresolved)`,
)
