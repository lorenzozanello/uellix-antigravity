// playwright.config.ts
//
// THE BROWSER GOLDEN JOURNEY RUNNER (HPO-G-03, ledger gate M9).
//
// ===========================================================================
// WHAT THIS CONFIGURES AND WHAT IT DOES NOT CLAIM
// ===========================================================================
// `STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json` binds Playwright as THE
// browser Golden Journey runner for J1, J2 and J3, and records that at its
// base "no browser automation dependency of any kind exists". This file is
// that dependency's configuration and nothing more.
//
// Standing the runner up does NOT satisfy M9. M9 requires the three journeys
// green against a Preview deployment satisfying S4, and S4 is not satisfied.
// The single place that judgement is made is `m9DisqualificationReason` in
// tests/golden/target.ts, so that no reader of this config has to infer it.
//
// ===========================================================================
// WHY THE FILE SUFFIXES ARE `.journey.ts` AND `.guard.ts`
// ===========================================================================
// Not a style choice — a collision this lane is not authorised to fix at the
// other end.
//
// `vitest.config.ts` sets no `include`, so Vitest uses its default
// `**/*.{test,spec}.?(c|m)[jt]s?(x)` across the repository. A Playwright spec
// named `*.test.ts` under `tests/golden/` would therefore be collected by
// `pnpm test`, where `@playwright/test` cannot run — breaking the default
// suite, which is a gate every other lane depends on.
//
// The natural fix is a `tests/golden/**` entry in `vitest.shared.ts`. That
// file is OUTSIDE this lane's authorised write-set, and widening a write-set
// because a change would be convenient is precisely the "it changed anyway"
// scope inference the operating discipline forbids. So the collision is
// avoided from this side instead, with suffixes Vitest's default glob cannot
// match. `tests/golden/meta/no-silent-skip.guard.ts` is the meta guard the
// mission specifies; only its extension differs, for this reason.
//
// ===========================================================================
// TWO PROJECTS, BECAUSE THEY FAIL FOR DIFFERENT REASONS
// ===========================================================================
//   contract   no browser, no target, always runs. Reconciles the registry
//              against the frozen authority and asserts the upstream blockers
//              still hold. These are the assertions that go RED when a blocker
//              is remediated.
//
//   browser    real Chromium against a declared target. Runs only when a
//              target is declared, and its absence is RECORDED by the contract
//              project rather than expressed as a skip.
//
// Splitting them means a green `contract` run can never be mistaken for a
// traversed journey, and a missing browser project is visible as a missing
// project rather than as an absent row.

import { defineConfig, devices } from '@playwright/test'
import { resolveGoldenTarget, tierIsServed } from './tests/golden/target'

// Resolved once, at config load. A malformed declaration throws HERE, before
// any test is collected, so a contradictory target fails the run outright
// instead of quietly selecting the tier that asserts least.
const target = resolveGoldenTarget()

/**
 * Every Playwright output — the JSON run record, traces, screenshots — lands
 * here. Overridable so CI can route it to the runner's own scratch space and
 * leave the checkout untouched. See the note on `outputDir` below for why the
 * default is inside `tests/golden/` rather than `artifacts/`.
 */
const GOLDEN_OUTPUT_DIR = process.env.GOLDEN_JOURNEY_OUTPUT_DIR ?? 'tests/golden/.playwright-output'

export default defineConfig({
  testDir: './tests/golden',

  // See the note above. These two suffixes are the contract with Vitest's
  // default glob, not a preference.
  testMatch: ['**/*.journey.ts', '**/*.guard.ts'],

  // `forbidOnly` unconditionally, not `!!process.env.CI`. A stray `.only`
  // reduces a battery to one test while still exiting zero, which is the
  // silent-skip failure mode in its purest form; there is no environment in
  // which that should be tolerated, including a developer's machine.
  forbidOnly: true,

  // No retries. A Golden Journey that passes on the second attempt has not
  // demonstrated that the product works, it has demonstrated that the failure
  // is intermittent — and the frozen evidence model treats a run's collected
  // set, not its eventual exit code, as the evidence.
  retries: 0,

  // Deterministic ordering. The journeys describe a sequence a customer
  // performs, and interleaving them across workers would make a trace
  // unreadable for no gain at this size.
  fullyParallel: false,
  workers: 1,

  // WHERE THE RUN RECORD GOES, AND WHY NOT THE OBVIOUS PLACE.
  //
  // `artifacts/` is the repository's conventional home for run records and is
  // exactly where this belongs. It is also on this lane's FORBIDDEN list, and
  // Playwright's default `test-results/` is untracked and unignored — neither
  // is gitignored, so both would surface as changed paths in the scope gate,
  // and one of them as a forbidden-surface violation.
  //
  // The correct long-term fix is two `.gitignore` entries. `.gitignore` is not
  // in this lane's authorised write-set, and adding it because it would be
  // convenient is the "it changed anyway" scope inference the operating
  // discipline forbids. So the output is routed inside `tests/golden/**`,
  // which this lane does own, and the ignore entries are left as a declared
  // follow-up rather than taken silently.
  outputDir: GOLDEN_OUTPUT_DIR,

  reporter: [
    ['list'],
    // A machine-readable run record. The workflow reads this to enforce the
    // collected-set reconciliation the frozen TEST_EVIDENCE_MODEL requires:
    // an exit code cannot distinguish "all green" from "collected nothing".
    ['json', { outputFile: `${GOLDEN_OUTPUT_DIR}/run.json` }],
  ],

  use: {
    baseURL: target.baseURL,
    // Traces are the evidence class the authority names for M9, J1, J2 and J3
    // ("BROWSER_RUN_PLUS_TRACES_BOUND_TO_SHA"). Retained on failure rather
    // than always, because a green skeleton run with no target produces no
    // browser activity worth storing.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'contract',
      testMatch: ['**/*.guard.ts', '**/*.contract.journey.ts'],
    },
    // Present only when a target is declared. An always-present browser
    // project with no target would report every journey as failed for an
    // environmental reason, which is as uninformative as skipping them.
    ...(tierIsServed(target.kind)
      ? [
          {
            name: 'browser',
            testMatch: ['**/*.browser.journey.ts'],
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],
})
