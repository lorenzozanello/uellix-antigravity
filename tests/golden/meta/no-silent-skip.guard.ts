// tests/golden/meta/no-silent-skip.guard.ts
//
// THE META GUARD — A GREEN GOLDEN RUN MUST NOT BE GREEN BY ABSENCE.
//
// ===========================================================================
// THE FAILURE THIS FILE EXISTS TO MAKE IMPOSSIBLE
// ===========================================================================
// "A battery that reports green while collecting zero required tests is a
// failure." That is not a hypothetical: the companion
// RELEASE_GATE_LEDGER_v1.0.0.json already records, under TEST_EVIDENCE_MODEL,
// that an exit code cannot distinguish a passing run from a run that lost its
// files — "a file skipped for an environmental reason yields neither a failure
// nor a row, so it is invisible in a green run".
//
// The Golden battery is unusually exposed to this. Most of its steps are
// blocked, blocked steps are cheap to express, and the difference between
// "expressed as a blocked contract" and "quietly not written" is invisible in
// the reporter output. So the set must be reconciled, not counted.
//
// ===========================================================================
// WHY EVERY CHECK HERE HAS A POSITIVE CONTROL
// ===========================================================================
// Each assertion below is paired with a mutation that must make it RED. Not as
// decoration — this repository has shipped a duplicate-key checker built on a
// JSON.parse reviver that passed happily on input containing duplicates, and a
// `grep -c` that returned the expected count by matching a commented-out line.
// Both were green, both were vacuous, and both looked exactly like a control.
//
// So: the bypass scanner is pointed at a fixture full of bypasses and must
// report them; the registry reconciler is handed a registry with a step
// removed and must report the hole; the authority parser is handed a
// single-step path and must refuse it; and every posture detector is handed
// remediated content and must flip to false.
//
// A check that has never been observed to fail is not yet a check.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  GoldenAuthorityShapeError,
  REPO_ROOT,
  loadFrozenJourneys,
  readRepoJson,
  splitJourneyPath,
  totalFrozenStepCount,
} from '../authority'
import {
  NEGATIVE_CONTROLS,
  STEP_CONTRACTS,
  contractKey,
  reconcileRegistry,
  targetOnlyContractCount,
} from '../registry'
import {
  POSTURE_PROBES,
  detectAnonymousReadBlocked,
  detectNoEvaluateRuntime,
  detectNoRateLimitOnSurface,
  detectPlatformPrincipalAmbiguity,
} from '../posture'
import { scanForBypasses } from '../skip-patterns'
import {
  GoldenTargetDeclarationError,
  m9DisqualificationReason,
  resolveGoldenTarget,
} from '../target'

/** The pinned expectation this skeleton publishes. */
const SKELETON_ARTIFACT_PATH = join('docs', 'ops', 'release', 'GOLDEN_JOURNEY_SKELETON_v1.0.0.json')

interface SkeletonPin {
  readonly PINNED_DERIVATION: {
    readonly journey_count: number
    readonly total_step_count: number
    readonly journeys: ReadonlyArray<{
      readonly id: string
      readonly step_count: number
      readonly step_ids: readonly string[]
    }>
  }
  readonly PINNED_COVERAGE: {
    readonly posture_probe_count: number
    readonly target_only_step_count: number
    readonly negative_control_count: number
  }
}

/** Every file the Golden runner collects, as (path, content). */
function collectedGoldenFiles(): ReadonlyArray<readonly [string, string]> {
  const root = join(REPO_ROOT, 'tests', 'golden')
  const files: Array<readonly [string, string]> = []
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childAbsolute = join(dir, entry.name)
      const childRelative = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative)
      } else if (/\.(journey|guard)\.ts$/.test(entry.name)) {
        files.push([childRelative, readFileSync(childAbsolute, 'utf8')] as const)
      }
    }
  }
  walk(root, 'tests/golden')
  return files
}

test.describe('Golden meta guard — no silent skip', () => {
  // -------------------------------------------------------------------
  // 1. The scan set is real
  // -------------------------------------------------------------------
  test('the bypass scan covers a non-empty set that includes this guard', () => {
    const files = collectedGoldenFiles()
    expect(files.length, 'the Golden runner collects no files at all').toBeGreaterThan(0)

    // The guard must be inside its own scope. A policing file exempt from its
    // own policy is exactly where a bypass would be parked.
    const selfPath = 'tests/golden/meta/no-silent-skip.guard.ts'
    expect(
      files.map(([path]) => path),
      'the meta guard is not covered by its own bypass scan',
    ).toContain(selfPath)
  })

  // -------------------------------------------------------------------
  // 2. Zero bypasses — with the scanner proven capable of finding them
  // -------------------------------------------------------------------
  test('POSITIVE CONTROL — the scanner reports every bypass form in the fixture', () => {
    const fixturePath = join(REPO_ROOT, 'tests', 'golden', 'meta', 'fixtures', 'bypassed-suite.fixture.txt')
    expect(existsSync(fixturePath), 'the bypass positive-control fixture is missing').toBe(true)

    const findings = scanForBypasses([['fixture', readFileSync(fixturePath, 'utf8')]])
    const found = [...new Set(findings.map((finding) => finding.patternId))].sort()

    // The EXACT set, not merely "more than zero". A pattern that silently
    // stopped matching would still leave the count positive.
    expect(found).toEqual(
      [
        'bare-skip-call',
        'describe-fixme',
        'describe-only',
        'describe-skip',
        'test-fixme',
        'test-only',
        'test-skip',
        'test-info-skip',
      ].sort(),
    )
  })

  test('zero bypasses in the collected Golden files', () => {
    const findings = scanForBypasses(collectedGoldenFiles())
    expect(
      findings,
      `bypass markers found: ${findings.map((f) => `${f.file}:${f.patternId}(${f.matched})`).join(', ')}`,
    ).toEqual([])
  })

  // -------------------------------------------------------------------
  // 3. The frozen step set cannot silently drop
  // -------------------------------------------------------------------
  test('the derived step set matches the pinned skeleton artifact exactly', () => {
    const journeys = loadFrozenJourneys()
    const pin = readRepoJson(SKELETON_ARTIFACT_PATH) as SkeletonPin

    expect(journeys.length).toBe(pin.PINNED_DERIVATION.journey_count)
    expect(totalFrozenStepCount(journeys)).toBe(pin.PINNED_DERIVATION.total_step_count)

    for (const pinnedJourney of pin.PINNED_DERIVATION.journeys) {
      const derived = journeys.find((candidate) => candidate.id === pinnedJourney.id)
      expect(derived, `the authority no longer defines journey ${pinnedJourney.id}`).toBeDefined()
      expect(derived?.steps.length).toBe(pinnedJourney.step_count)
      // Ordered comparison. The authority orders the steps of a journey, and a
      // reordering is a different journey even with the same members.
      expect(derived?.steps.map((step) => step.id)).toEqual(pinnedJourney.step_ids)
    }
  })

  test('MUTATION CONTROL — a one-step path is refused by the parser', () => {
    // A path that fails to split is far more likely to be a parse failure than
    // a real one-step journey, and a short list is how a required step count
    // drops without a failure anywhere.
    expect(() => splitJourneyPath('a single step with no comma')).toThrow(GoldenAuthorityShapeError)
  })

  test('MUTATION CONTROL — a duplicated step phrase is refused by the parser', () => {
    expect(() => splitJourneyPath('evidence, evidence')).toThrow(GoldenAuthorityShapeError)
  })

  // -------------------------------------------------------------------
  // 4. Registry reconciliation, both directions
  // -------------------------------------------------------------------
  test('every frozen step has exactly one contract and no contract is orphaned', () => {
    const reconciliation = reconcileRegistry(loadFrozenJourneys())
    expect(reconciliation.uncoveredSteps, 'frozen steps with no contract').toEqual([])
    expect(reconciliation.orphanedContracts, 'contracts naming a step the authority does not define').toEqual([])
    expect(reconciliation.duplicateContracts, 'a step covered twice').toEqual([])
  })

  test('MUTATION CONTROL — removing one contract is reported as an uncovered step', () => {
    const journeys = loadFrozenJourneys()
    const mutated = STEP_CONTRACTS.filter((contract) => contract.stepId !== 'evidence')
    const reconciliation = reconcileRegistry(journeys, mutated)
    expect(reconciliation.uncoveredSteps).toEqual([contractKey('J1', 'evidence')])
  })

  test('MUTATION CONTROL — a contract for an unknown step is reported as orphaned', () => {
    const journeys = loadFrozenJourneys()
    const mutated = [
      ...STEP_CONTRACTS,
      {
        journeyId: 'J1',
        stepId: 'a-step-the-authority-does-not-define',
        blockedBy: { kind: 'TARGET_ONLY' } as const,
        positiveIntent: 'nothing — this contract is the mutation',
      },
    ]
    const reconciliation = reconcileRegistry(journeys, mutated)
    expect(reconciliation.orphanedContracts).toEqual([
      contractKey('J1', 'a-step-the-authority-does-not-define'),
    ])
  })

  // -------------------------------------------------------------------
  // 5. Coverage honesty — substantive contracts counted separately
  // -------------------------------------------------------------------
  test('the pinned coverage split matches the registry', () => {
    const pin = readRepoJson(SKELETON_ARTIFACT_PATH) as SkeletonPin
    expect(POSTURE_PROBES.length).toBe(pin.PINNED_COVERAGE.posture_probe_count)
    expect(targetOnlyContractCount()).toBe(pin.PINNED_COVERAGE.target_only_step_count)
    expect(NEGATIVE_CONTROLS.length).toBe(pin.PINNED_COVERAGE.negative_control_count)
  })

  test('every journey declares at least one negative control', () => {
    const journeys = loadFrozenJourneys()
    for (const journey of journeys) {
      const controls = NEGATIVE_CONTROLS.filter((control) => control.journeyId === journey.id)
      expect(controls.length, `journey ${journey.id} declares no negative control`).toBeGreaterThan(0)
    }
  })

  // -------------------------------------------------------------------
  // 6. Every posture detector can return false
  // -------------------------------------------------------------------
  test('all posture probes currently read as blocked', () => {
    for (const { probe, run } of POSTURE_PROBES) {
      const reading = run()
      expect(
        reading.blockerStillPresent,
        `${probe.id} no longer holds — ${probe.remediationMeaning}`,
      ).toBe(true)
    }
  })

  test('MUTATION CONTROL — each posture detector flips to false on remediated content', () => {
    // The platform principal: remove the tenant role literal, keep the flag.
    expect(
      detectPlatformPrincipalAmbiguity("is_super_admin: boolean('is_super_admin')"),
      'the ambiguity detector still reports a blocker with no super_admin role value',
    ).toBe(false)

    // The anonymous read: a privileged escape appears.
    expect(
      detectAnonymousReadBlocked("import { db } from '@/db/client'\nconst c = service_role"),
      'the anonymous-read detector still reports fail-closed with a service_role escape present',
    ).toBe(false)

    // The rate limiter: one file on the surface now references a limiter.
    expect(
      detectNoRateLimitOnSurface([['verify/page.tsx', 'await checkAndRecordRateLimit(key, opts)']]),
      'the rate-limit detector still reports absence with a limiter present',
    ).toBe(false)

    // The evaluation runtime: a route segment now exists.
    expect(
      detectNoEvaluateRuntime(['app/app/evaluate'], false),
      'the evaluate-runtime detector still reports absence with a route segment present',
    ).toBe(false)
    expect(
      detectNoEvaluateRuntime([], true),
      'the evaluate-runtime detector still reports absence with a lib module present',
    ).toBe(false)
  })

  // -------------------------------------------------------------------
  // 7. The target declaration cannot degrade silently
  // -------------------------------------------------------------------
  test('an invalid target tier is refused rather than degraded to the weakest one', () => {
    expect(() => resolveGoldenTarget({ GOLDEN_JOURNEY_TARGET_KIND: 'PREVIEW' })).toThrow(
      GoldenTargetDeclarationError,
    )
    expect(() => resolveGoldenTarget({ GOLDEN_JOURNEY_BASE_URL: 'http://127.0.0.1:3000' })).toThrow(
      GoldenTargetDeclarationError,
    )
    expect(() =>
      resolveGoldenTarget({ GOLDEN_JOURNEY_TARGET_KIND: 'PREVIEW_S4', GOLDEN_JOURNEY_BASE_URL: 'https://x.test' }),
    ).toThrow(GoldenTargetDeclarationError)
  })

  test('no tier available at this base may be claimed as M9 evidence', () => {
    expect(m9DisqualificationReason(resolveGoldenTarget({}))).not.toBeNull()
    expect(
      m9DisqualificationReason({
        kind: 'LOCAL_APP',
        baseURL: 'http://127.0.0.1:3100',
        sha: 'deadbeef',
        deploymentId: undefined,
      }),
      'a locally booted application must never satisfy M9; only a Preview deployment satisfying S4 can',
    ).not.toBeNull()
  })
})
