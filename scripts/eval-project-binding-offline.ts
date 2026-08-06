// scripts/eval-project-binding-offline.ts
// RELEASE line (STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2): offline
// evaluation gate over the project-bound ticket-attribution contract (R2-INT).
// Mirrors scripts/eval-idempotency-offline.ts's own pattern
// (check()/report/process.exit(1) on failure). Fully offline: no network, no
// DB, no provider, no env secrets.
//
// WIRING NOTE for integration: not yet in package.json (RELEASE cannot touch
// it — see docs/ops/workstreams/RELEASE.md §Rutas prohibidas). Runnable today as:
//   pnpm exec tsx scripts/eval-project-binding-offline.ts
// Suggested script name once wired, matching the existing
// "test:stella:idempotency-eval" convention: "test:stella:project-binding-eval".

import { runProjectBindingEvalHarness, projectBindingEvalFailureReasons } from '../tests/eval/stella-release/project-binding-harness'
import { computeProjectBindingGateReport } from '../tests/eval/stella-release/project-binding-release-gate'

const run = runProjectBindingEvalHarness()
const { summary, results } = run

console.log(`[eval:project-binding] harness v${summary.harnessVersion}, matrix v${summary.matrixVersion}`)

for (const result of results) {
  const status = result.ok ? 'PASS' : 'FAIL'
  console.log(`[eval:project-binding] ${status} [${result.outcome}] ${result.caseId} — ${result.detail}`)
  for (const control of result.negativeControls) {
    const mark = control.detected ? 'detected' : 'NOT-DETECTED'
    console.log(`[eval:project-binding]     control ${mark}: ${control.controlId} — ${control.detail}`)
  }
}

console.log(`[eval:project-binding] ${summary.passed}/${summary.totalCases} cases passed`)
console.log(`[eval:project-binding] negative controls: ${summary.negativeControlsRun} run, ${summary.negativeControlsUndetected} undetected`)
console.log(`[eval:project-binding] observability safe: ${summary.observabilitySafe}`)

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
  },
}
console.log(`[eval:project-binding] json ${JSON.stringify(structured)}`)

// --- project-binding release gates (Fase 6) ---------------------------------
const gateReport = computeProjectBindingGateReport(run)

console.log('[eval:project-binding] release gates:')
for (const gate of gateReport.gates) {
  console.log(`[eval:project-binding]   ${gate.passed ? 'PASS' : 'FAIL'} ${gate.id} — ${gate.detail}`)
}
console.log(
  `[eval:project-binding] readiness: project-binding-harness-ready=${gateReport.projectBindingHarnessReady} local-runtime-ready=false (unaffected — see docs/ops/workstreams/RELEASE.md)`,
)
console.log('[eval:project-binding] missing for project-binding runtime:')
for (const item of gateReport.missingForProjectBindingRuntime) console.log(`[eval:project-binding]   - ${item}`)

// --- failure gate ------------------------------------------------------------
const reasons = projectBindingEvalFailureReasons(summary)
if (!gateReport.projectBindingHarnessReady) {
  reasons.push(`project-binding-harness-ready is false: ${gateReport.missingForProjectBindingHarness.join('; ')}`)
}

if (reasons.length > 0) {
  for (const reason of reasons) console.error(`[eval:project-binding] FAILED: ${reason}`)
  process.exit(1)
}

console.log(
  `[eval:project-binding] OK — ${summary.totalCases}/${summary.totalCases} cases green, ${summary.negativeControlsRun} negative controls all detected, project-binding-harness-ready=true, local-runtime-ready=false (R2-INT unresolved)`,
)
