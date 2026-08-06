// scripts/eval-idempotency-offline.ts
// RELEASE line (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1): offline evaluation
// gate over the operation-ticket idempotency contract. Mirrors
// scripts/eval-release-offline.ts's own pattern (check()/report/process.exit(1)
// on failure). Fully offline: no network, no DB, no provider, no env secrets.
//
// WIRING NOTE for integration: not yet in package.json (RELEASE cannot touch
// it — see docs/ops/workstreams/RELEASE.md §Rutas prohibidas). Runnable today as:
//   pnpm exec tsx scripts/eval-idempotency-offline.ts
// Suggested script name once wired, matching the existing
// "test:stella:release-eval" convention: "test:stella:idempotency-eval".

import { runIdempotencyEvalHarness, idempotencyEvalFailureReasons } from '../tests/eval/stella-release/idempotency-harness'
import { computeIdempotencyReleaseGateReport } from '../tests/eval/stella-release/idempotency-release-gate'

const run = runIdempotencyEvalHarness()
const { summary, results } = run

console.log(`[eval:idempotency] harness v${summary.harnessVersion}, matrix v${summary.matrixVersion}`)

for (const result of results) {
  const status = result.ok ? 'PASS' : 'FAIL'
  console.log(`[eval:idempotency] ${status} [${result.outcome}] ${result.caseId} — ${result.detail}`)
  for (const control of result.negativeControls) {
    const mark = control.detected ? 'detected' : 'NOT-DETECTED'
    console.log(`[eval:idempotency]     control ${mark}: ${control.controlId} — ${control.detail}`)
  }
}

console.log(`[eval:idempotency] ${summary.passed}/${summary.totalCases} cases passed`)
console.log(`[eval:idempotency] negative controls: ${summary.negativeControlsRun} run, ${summary.negativeControlsUndetected} undetected`)

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
  },
}
console.log(`[eval:idempotency] json ${JSON.stringify(structured)}`)

// --- idempotency release gates (Fase 7) -------------------------------------
const gateReport = computeIdempotencyReleaseGateReport(run)

console.log('[eval:idempotency] release gates:')
for (const gate of gateReport.gates) {
  console.log(`[eval:idempotency]   ${gate.passed ? 'PASS' : 'FAIL'} ${gate.id} — ${gate.detail}`)
}
console.log(
  `[eval:idempotency] readiness: idempotency-harness-ready=${gateReport.idempotencyHarnessReady} local-runtime-ready=false (unaffected — see docs/ops/workstreams/RELEASE.md)`,
)
console.log('[eval:idempotency] missing for operation-ticket runtime:')
for (const item of gateReport.missingForOperationTicketRuntime) console.log(`[eval:idempotency]   - ${item}`)

// --- failure gate ------------------------------------------------------------
const reasons = idempotencyEvalFailureReasons(summary)
if (!gateReport.idempotencyHarnessReady) {
  reasons.push(`idempotency-harness-ready is false: ${gateReport.missingForIdempotencyHarness.join('; ')}`)
}

if (reasons.length > 0) {
  for (const reason of reasons) console.error(`[eval:idempotency] FAILED: ${reason}`)
  process.exit(1)
}

console.log(
  `[eval:idempotency] OK — ${summary.totalCases}/${summary.totalCases} cases green, ${summary.negativeControlsRun} negative controls all detected, idempotency-harness-ready=true, local-runtime-ready=false (INT-INT-001 unresolved)`,
)
