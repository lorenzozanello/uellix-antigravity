// tests/golden/reconcile-run.ts
//
// SET RECONCILIATION OVER THE RUN RECORD — RUN BY CI, NOT BY THE RUNNER.
//
//   pnpm tsx tests/golden/reconcile-run.ts <run.json> <expected-sha>
//
// ===========================================================================
// WHY THE EXIT CODE OF THE RUNNER IS NOT THE EVIDENCE
// ===========================================================================
// The frozen RELEASE_GATE_LEDGER_v1.0.0.json states it directly under
// TEST_EVIDENCE_MODEL: "Evidence is a SET RECONCILIATION, not an exit code.
// The question a release must answer is not whether the runner returned zero,
// but which files actually ran."
//
// Playwright exits zero when every test it COLLECTED passed. It also exits
// zero when it collected nothing — a mistyped `testMatch`, a `testDir` that
// moved, a config that threw before registration — and those two outcomes are
// indistinguishable from the exit code alone. For a battery whose whole
// purpose is to prove that 23 frozen steps are each expressed somewhere, that
// is the one failure mode that must not be survivable.
//
// So the workflow does not trust the runner's exit code. It reads the run
// record and reconciles the set of executed tests against the set the frozen
// authority requires, and the difference is the verdict.
//
// ===========================================================================
// WHAT IS RECONCILED
// ===========================================================================
//   1. every frozen step has an executed test whose title names it
//   2. no test was skipped, for any reason, including an environmental one
//   3. no test is in a non-terminal state
//   4. the run is bound to the exact SHA CI is building
//
// (4) is checked here rather than trusted because the authority requires the
// run be bound to "the exact SHA, with no merge-ref substitution", and a CI
// job that reports `github.sha` while having checked out a merge ref would
// otherwise produce evidence for a tree that was never tested.

import { readFileSync } from 'node:fs'
import { loadFrozenJourneys } from './authority'

interface PlaywrightSpec {
  readonly title?: string
  readonly ok?: boolean
  readonly tests?: ReadonlyArray<{ readonly status?: string; readonly results?: ReadonlyArray<{ readonly status?: string }> }>
}
interface PlaywrightSuite {
  readonly specs?: readonly PlaywrightSpec[]
  readonly suites?: readonly PlaywrightSuite[]
}
interface PlaywrightRun {
  readonly suites?: readonly PlaywrightSuite[]
  readonly stats?: { readonly expected?: number; readonly skipped?: number; readonly unexpected?: number }
}

function flattenSpecs(suites: readonly PlaywrightSuite[] | undefined): readonly PlaywrightSpec[] {
  if (!suites) return []
  const out: PlaywrightSpec[] = []
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) out.push(spec)
    out.push(...flattenSpecs(suite.suites))
  }
  return out
}

function fail(lines: readonly string[]): never {
  console.error('GOLDEN_RUN_RECONCILIATION=FAIL')
  for (const line of lines) console.error(`  - ${line}`)
  process.exit(1)
}

function main(): void {
  const [runPath, expectedSha] = process.argv.slice(2)
  if (!runPath) fail(['usage: reconcile-run.ts <run.json> [expected-sha]'])

  let run: PlaywrightRun
  try {
    run = JSON.parse(readFileSync(runPath, 'utf8')) as PlaywrightRun
  } catch (cause) {
    // An unreadable run record is a FAILURE, never a pass-by-absence. This is
    // the case a naive `if (exists)` guard would turn into a silent skip.
    fail([`the run record at ${runPath} could not be read or parsed: ${(cause as Error).message}`])
  }

  const specs = flattenSpecs(run.suites)
  const problems: string[] = []

  if (specs.length === 0) {
    problems.push('the run record contains ZERO executed tests; a battery that collects nothing is not green')
  }

  // 1. Every frozen step must appear in an executed test title.
  const journeys = loadFrozenJourneys()
  const titles = specs.map((spec) => spec.title ?? '')
  for (const journey of journeys) {
    for (const step of journey.steps) {
      const needle = `${journey.id}.${step.ordinal} ${step.id}`
      if (!titles.some((title) => title.includes(needle))) {
        problems.push(`frozen step ${needle} has no executed test; it was collected away or never written`)
      }
    }
  }

  // 2 and 3. No skip, no non-terminal state.
  for (const spec of specs) {
    for (const testCase of spec.tests ?? []) {
      const statuses = [testCase.status, ...(testCase.results ?? []).map((result) => result.status)]
      for (const status of statuses) {
        if (status === undefined) continue
        if (status === 'skipped') {
          problems.push(`test "${spec.title}" reports status=skipped; the Golden battery permits no skip`)
        }
        if (status === 'interrupted' || status === 'timedOut') {
          problems.push(`test "${spec.title}" reports status=${status}, which is not a terminal pass or fail`)
        }
      }
    }
    if (spec.ok === false) problems.push(`test "${spec.title}" did not pass`)
  }

  if ((run.stats?.skipped ?? 0) > 0) {
    problems.push(`the reporter stats record ${run.stats?.skipped} skipped test(s)`)
  }
  if ((run.stats?.unexpected ?? 0) > 0) {
    problems.push(`the reporter stats record ${run.stats?.unexpected} unexpected failure(s)`)
  }

  // 4. SHA binding.
  if (expectedSha !== undefined && expectedSha.length > 0) {
    const actual = process.env.GOLDEN_JOURNEY_EVIDENCE_SHA ?? ''
    if (actual !== expectedSha) {
      problems.push(
        `the run is bound to SHA ${JSON.stringify(actual)} but CI is building ${JSON.stringify(expectedSha)}; ` +
          'evidence must name the exact SHA with no merge-ref substitution',
      )
    }
  }

  if (problems.length > 0) fail(problems)

  console.log('GOLDEN_RUN_RECONCILIATION=PASS')
  console.log(`  executed_tests=${specs.length}`)
  console.log(`  frozen_steps_reconciled=${journeys.reduce((n, j) => n + j.steps.length, 0)}`)
}

main()
