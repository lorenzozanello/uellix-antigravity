// tests/eval/stella-release/e2e/print-harness-gate.ts
// RELEASE line — Train 4. Final step of scripts/stella-release-e2e-dry-run.sh:
// patches the two fields only the bash wrapper can know for certain
// (containerDestroyed, packagesApplied — set AFTER the container is gone,
// never assumed while it might still be running) into the journey's report,
// then reduces it through the real, fail-closed
// evaluateLocalRuntimeHarnessReadiness and exits non-zero on any gap.
//
// Usage:
//   tsx tests/eval/stella-release/e2e/print-harness-gate.ts \
//     --report <path-to-report.json> \
//     --container-destroyed <true|false> \
//     --packages <comma-separated-basenames> \
//     [--train4-status applied|not-yet-available]

import { readFileSync, writeFileSync } from 'node:fs'
import { evaluateLocalRuntimeHarnessReadiness, type LocalRuntimeHarnessReport } from '../harness-report'

function parseArgs(argv: readonly string[]) {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? ''
  }
  const reportPath = args.report
  if (!reportPath) throw new Error('print-harness-gate: --report <path> is required')
  return {
    reportPath,
    containerDestroyed: args['container-destroyed'] === 'true',
    packagesApplied: (args.packages ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    train4PackageStatus: (args['train4-status'] === 'applied' ? 'applied' : 'not-yet-available') as LocalRuntimeHarnessReport['train4PackageStatus'],
  }
}

const { reportPath, containerDestroyed, packagesApplied, train4PackageStatus } = parseArgs(process.argv.slice(2))

const raw = JSON.parse(readFileSync(reportPath, 'utf8')) as LocalRuntimeHarnessReport
const patched: LocalRuntimeHarnessReport = { ...raw, containerDestroyed, packagesApplied, train4PackageStatus }
writeFileSync(reportPath, JSON.stringify(patched, null, 2))

const readiness = evaluateLocalRuntimeHarnessReadiness(patched)

console.log(`[e2e-gate] local-runtime-harness-ready=${readiness.localRuntimeHarnessReady}`)
console.log(`[e2e-gate] packagesApplied=${patched.packagesApplied.join(', ')}`)
console.log(`[e2e-gate] train4PackageStatus=${patched.train4PackageStatus}`)
if (readiness.missingForLocalRuntimeHarness.length > 0) {
  console.log('[e2e-gate] missing:')
  for (const item of readiness.missingForLocalRuntimeHarness) console.log(`[e2e-gate]   - ${item}`)
} else {
  console.log('[e2e-gate] every claim in the harness report checks out — real ingestion, real SQL functions, real retrieval, real (non-provider) generation, real citation validation, real cross-project rejection, real idempotency, container destroyed, no persistent volume')
}

process.exit(readiness.localRuntimeHarnessReady ? 0 : 1)
