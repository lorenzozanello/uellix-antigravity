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
import { expect, test } from '../harness'
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
  collectAppSourceFiles,
  detectNoEvaluateRuntime,
  detectNoRateLimitGoverningVerify,
  detectPlatformPrincipalAmbiguity,
  detectProxyLimiterGovernsVerify,
  detectPublicVerificationNotLive,
  findTraversableEvaluateRuntime,
  readPublicVerificationActivation,
} from '../posture'
import { scanForBypasses } from '../skip-patterns'
import {
  GoldenSourceParseError,
  findModuleReferences,
  findPlaywrightTestReferences,
  scanForPlaywrightTestImportOffenses,
} from '../import-boundary'
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

/**
 * EVERY TypeScript source under `tests/golden/`, as (path, content).
 *
 * ===========================================================================
 * WHY THIS IS NOT KEYED ON PLAYWRIGHT'S testMatch
 * ===========================================================================
 * R1 scanned only `*.journey.ts` and `*.guard.ts` — the files Playwright
 * collects. Independent review showed that leaves a hole: `contract-suite.ts`
 * is where 23 of the 24 generated tests are actually REGISTERED, and it matches
 * neither suffix. A `test.skip(` placed there would remove real steps from the
 * run while the bypass scan stayed green.
 *
 * The consequence would still have been caught downstream — the run reconciler
 * compares executed titles against the frozen step set — but "another control
 * would have noticed" is not a reason for this one to be blind. Two independent
 * controls that both fire is the design; one that cannot see the file is a gap
 * that happens to be covered.
 *
 * So the scan set is now every `.ts` under the directory, whatever collects it.
 * That deliberately includes helper modules, this guard, and
 * `skip-patterns.ts` — whose regular-expression literals cannot self-match,
 * because every pattern requires call position and a literal `(` that the
 * escaped source spelling does not provide.
 */
function goldenSourceFiles(): ReadonlyArray<readonly [string, string]> {
  const root = join(REPO_ROOT, 'tests', 'golden')
  const files: Array<readonly [string, string]> = []
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childAbsolute = join(dir, entry.name)
      const childRelative = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative)
      } else if (/\.ts$/.test(entry.name)) {
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
  test('the bypass scan covers this guard AND the file that registers the steps', () => {
    const files = goldenSourceFiles()
    expect(files.length, 'the Golden runner collects no files at all').toBeGreaterThan(0)
    const paths = files.map(([path]) => path)

    // The guard must be inside its own scope. A policing file exempt from its
    // own policy is exactly where a bypass would be parked.
    expect(paths, 'the meta guard is not covered by its own bypass scan').toContain(
      'tests/golden/meta/no-silent-skip.guard.ts',
    )

    // The R1 hole, named so it cannot quietly reopen. `contract-suite.ts`
    // registers 23 of the generated tests and matches NO Playwright testMatch
    // suffix, so a scan keyed on collection could not see it at all.
    expect(
      paths,
      'contract-suite.ts is outside the bypass scan; it registers most of the battery',
    ).toContain('tests/golden/contract-suite.ts')
  })

  test('no Golden file imports test() outside the guarded harness', () => {
    // A file referencing @playwright/test directly — import, re-export, or
    // require — would run OUTSIDE the worker-scoped auto fixture, and
    // therefore outside the Node egress guard. Not a style preference: it is
    // precisely how the B-1 defect — a guard with nothing in front of it —
    // would come back. Detection is syntax-aware (N-2): see
    // `import-boundary.ts` for why a quote-anchored regex was not closed-world.
    const offenses = scanForPlaywrightTestImportOffenses(
      goldenSourceFiles().filter(([path]) => path !== 'tests/golden/harness.ts'),
    )

    expect(
      offenses,
      `these files bypass tests/golden/harness.ts and so run without the Node egress guard: ${offenses
        .map((o) => `${o.file}:${o.kind}(${o.matched})`)
        .join(', ')}`,
    ).toEqual([])
  })

  // -----------------------------------------------------------------
  // 1b. N-2 — the import-boundary detector is syntax-aware, not quote-spelled
  // -----------------------------------------------------------------
  test('POSITIVE CONTROL — a single-quoted import from @playwright/test is reported', () => {
    const offenses = findPlaywrightTestReferences('offender.ts', "import { test } from '@playwright/test'")
    expect(offenses.map((o) => o.kind)).toEqual(['import'])
  })

  test('POSITIVE CONTROL — a double-quoted import from @playwright/test is reported', () => {
    // The exact form the prior quote-anchored regex could not see.
    const offenses = findPlaywrightTestReferences('offender.ts', 'import { test } from "@playwright/test"')
    expect(offenses.map((o) => o.kind)).toEqual(['import'])
  })

  test('POSITIVE CONTROL — a re-export of @playwright/test is reported', () => {
    const offenses = findPlaywrightTestReferences('offender.ts', "export { test } from '@playwright/test'")
    expect(offenses.map((o) => o.kind)).toEqual(['export'])
  })

  test('POSITIVE CONTROL — require("@playwright/test") is reported regardless of quote style', () => {
    const single = findPlaywrightTestReferences('offender.ts', "const { test } = require('@playwright/test')")
    const double = findPlaywrightTestReferences('offender.ts', 'const { test } = require("@playwright/test")')
    expect(single.map((o) => o.kind)).toEqual(['require'])
    expect(double.map((o) => o.kind)).toEqual(['require'])
  })

  test('POSITIVE CONTROL — a statically-resolvable dynamic import(...) is reported', () => {
    const offenses = findPlaywrightTestReferences('offender.ts', "void import('@playwright/test')")
    expect(offenses.map((o) => o.kind)).toEqual(['dynamic-import'])
  })

  test('a dynamic import(...) that is NOT statically resolvable is not reported', () => {
    // The module specifier is a variable, not a literal — the detector cannot
    // know what it names without evaluating the program, so it must not guess.
    const offenses = findPlaywrightTestReferences('offender.ts', 'void import(someModuleName)')
    expect(offenses).toEqual([])
  })

  test('a type-only import from @playwright/test is not reported', () => {
    // Erases at compile time; no runtime binding to `test` is produced, so it
    // cannot run a test outside the guarded harness.
    const offenses = findPlaywrightTestReferences('offender.ts', "import type { Page } from '@playwright/test'")
    expect(offenses).toEqual([])
  })

  test('N-4 — source that does not PARSE fails closed rather than reporting nothing', () => {
    // `ts.createSourceFile` never throws: handed broken source it returns a
    // best-effort recovery tree, and a walk over that tree can legitimately
    // find no imports at all. A scanner that answered "no offenders" there
    // would be green because it failed to read the file — the exact shape
    // this meta surface exists to make impossible.
    expect(() => findModuleReferences('broken.ts', "import { from '@playwright/test' ; const = (((")).toThrow(
      GoldenSourceParseError,
    )
    expect(() =>
      findPlaywrightTestReferences('broken.ts', "import { from '@playwright/test' ; const = ((("),
    ).toThrow(GoldenSourceParseError)
  })

  test('N-4 — valid TSX is NOT mistaken for unparseable source', () => {
    // The script kind is chosen from the extension. Parsing `.tsx` as TS would
    // turn every JSX element into a parse diagnostic, so fail-closed parsing
    // would raise on ordinary valid React source — a self-inflicted red that
    // would get the whole check switched off.
    expect(() =>
      findModuleReferences('page.tsx', "import { x } from 'y'\nexport default function P() { return <main>hi</main> }"),
    ).not.toThrow()
  })

  test('@playwright/test mentioned in a comment or a string is not reported', () => {
    const commented = findPlaywrightTestReferences('offender.ts', "// import { test } from '@playwright/test'")
    const stringed = findPlaywrightTestReferences('offender.ts', 'const s = "from \'@playwright/test\'"')
    expect(commented).toEqual([])
    expect(stringed).toEqual([])
  })

  test('GREEN — the real harness.ts legitimately imports @playwright/test, and is the only such file', () => {
    // The authorised boundary crossing. harness.ts itself references the
    // module (with single quotes, today) — that is expected and is why the
    // guard excludes it by path rather than the detector exempting it.
    const harness = goldenSourceFiles().find(([path]) => path === 'tests/golden/harness.ts')
    expect(harness, 'tests/golden/harness.ts is missing from the scan set').toBeDefined()
    const [, harnessContent] = harness!
    expect(findPlaywrightTestReferences('tests/golden/harness.ts', harnessContent).map((o) => o.kind)).toEqual([
      'import',
    ])

    // And with that one legitimate path excluded, the rest of the tree is
    // clean — the same reconciliation the enforcement test above performs.
    const offenses = scanForPlaywrightTestImportOffenses(
      goldenSourceFiles().filter(([path]) => path !== 'tests/golden/harness.ts'),
    )
    expect(offenses).toEqual([])
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

  test('POSITIVE CONTROL — a real bypass in CODE is reported', () => {
    const findings = scanForBypasses([['code', "test.skip('a real bypass', async () => {})"]])
    expect(findings.map((f) => f.patternId)).toEqual(['test-skip'])
  })

  test('a bypass QUOTED IN A COMMENT OR A STRING is not reported', () => {
    // Neither executes, so neither removes a test. This is why widening the
    // scan to every .ts required reducing to executable text first: the initial
    // findings were documentation quoting the patterns it defines, and this
    // guard's own positive-control test DATA.
    expect(scanForBypasses([['doc', '// explaining that test.skip( removes a test']])).toEqual([])
    expect(scanForBypasses([['str', 'const sample = "test.skip(" ']])).toEqual([])
  })

  test('SAFETY CONTROL — a bypass inside a ${} interpolation IS still reported', () => {
    // Template chunks are blanked, but interpolations are real code and are
    // left intact. Blanking them wholesale would be the one way this reduction
    // could hide a genuine bypass.
    const source = ['const x = `prefix ${', "test.skip('inside an interpolation', () => {})", '}`'].join('')
    expect(
      scanForBypasses([['tpl', source]]).map((f) => f.patternId),
      'a bypass written inside a template interpolation was blanked away',
    ).toEqual(['test-skip'])
  })

  test('SAFETY CONTROL — comment stripping does not swallow code after a URL string', () => {
    // The naive `replace(/\/\/.*$/gm, '')` truncates at the `//` inside
    // 'https://…', taking the rest of the line — and any bypass on it — out of
    // the scan. A bypass would then be invisible for a reason that has nothing
    // to do with bypasses.
    const source = "const u = 'https://example.invalid/x'; test.skip('hidden', () => {})"
    const findings = scanForBypasses([['url', source]])
    expect(
      findings.map((f) => f.patternId),
      'a bypass on the same line as a URL string was lost to comment stripping',
    ).toEqual(['test-skip'])
  })

  test('zero bypasses in the collected Golden files', () => {
    const findings = scanForBypasses(goldenSourceFiles())
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

    // The rate limiter, wired on the route surface itself.
    expect(
      detectNoRateLimitGoverningVerify(
        [['verify/page.tsx', 'await checkAndRecordRateLimit(key, opts)']],
        'export async function proxy() { return sessionResponse }',
      ),
      'the rate-limit detector still reports absence with a limiter on the surface',
    ).toBe(false)

    // The evaluation runtime: a real server action wired to the engine.
    // The full A/B/C/D matrix is asserted separately below — this line is the
    // "can it return false at all" half that every probe here must satisfy.
    expect(
      detectNoEvaluateRuntime([
        {
          path: 'app/actions/evaluate/decide.ts',
          content: "'use server'\nimport { decide } from '@/lib/evaluate/decision-policy'\nexport async function decideEvaluation() { return decide() }",
        },
      ]),
      'the evaluate-runtime detector still reports absence with a wired server action present',
    ).toBe(false)
  })

  // -------------------------------------------------------------------
  // 6a-bis. B-4 — a PURE ENGINE IS NOT A TRAVERSABLE RUNTIME
  // -------------------------------------------------------------------
  // R3 flipped this probe on the mere existence of `lib/evaluate`. That
  // directory is write-set W-EV-2, "Pure scoring and DecisionPolicy engine",
  // constrained by its own authority to "Pure functions only: no db import,
  // no fetch, no Date.now, no Math.random, no process.env" — code a browser
  // cannot reach. J1 step 12 was therefore ordered to be rewritten as a
  // positive traversal of a leg that still cannot be walked.
  //
  // Each case below is a FIXTURE written by hand, never derived from the
  // production detector, so the matrix cannot agree with the implementation
  // merely by sharing its logic.

  test('B-4 CASE A — the pure lib/evaluate engine alone is NOT a runtime', () => {
    // Exactly the W-EV-2 shape that landed in integration.
    const files = [
      {
        path: 'lib/evaluate/scoring.ts',
        content:
          'import type { Criterion, Response } from "./types"\nexport function score(criteria: Criterion[], responses: Response[]) { return { score_status: "COMPLETE", score: 1 } }',
      },
      { path: 'lib/evaluate/decision-policy.ts', content: 'export function decide() { return "RECOMMEND" }' },
      { path: 'lib/evaluate/types.ts', content: 'export type Criterion = { id: string }' },
    ]
    expect(findTraversableEvaluateRuntime(files)).toEqual([])
    expect(
      detectNoEvaluateRuntime(files),
      'a pure computational engine under lib/ was credited as a traversable Evaluate runtime',
    ).toBe(true)
  })

  test('B-4 CASE B — an UNRELATED app action whose name contains "evaluate" is NOT a runtime', () => {
    // A real server action, on the proxy leg, that merely has the word in its
    // name and its prose. It is an entrypoint; it reaches nothing Evaluate.
    const files = [
      {
        path: 'app/actions/proxies.ts',
        content: [
          "'use server'",
          '// Scores a proxy rubric. Nothing to do with lib/evaluate.',
          "import { db } from '@/db/client'",
          'export async function evaluateProxyRubric() { return db.query.proxies.findMany() }',
        ].join('\n'),
      },
    ]
    expect(
      detectNoEvaluateRuntime(files),
      'an unrelated action was credited as the Evaluate runtime because of its NAME',
    ).toBe(true)
  })

  test('B-4 CASE C — a real server action WIRED to the engine flips the probe', () => {
    const files = [
      {
        path: 'app/actions/evaluate/decide.ts',
        content: [
          "'use server'",
          "import { decide } from '@/lib/evaluate/decision-policy'",
          "import { requireOrganizationAccess } from '@/lib/auth/session'",
          'export async function decideEvaluation(id: string) {',
          '  await requireOrganizationAccess()',
          '  return decide(id)',
          '}',
        ].join('\n'),
      },
    ]
    expect(findTraversableEvaluateRuntime(files)).toEqual(['app/actions/evaluate/decide.ts'])
    expect(
      detectNoEvaluateRuntime(files),
      'a real server action wired to the production engine did NOT flip the probe',
    ).toBe(false)
  })

  test('B-4 CASE C2 — a route handler wired to the engine also flips the probe', () => {
    const files = [
      {
        path: 'app/api/evaluate/route.ts',
        content: [
          "import { NextResponse } from 'next/server'",
          "import { score } from '@/lib/evaluate/scoring'",
          'export async function POST(request: Request) { return NextResponse.json(score([], [])) }',
        ].join('\n'),
      },
    ]
    expect(
      detectNoEvaluateRuntime(files),
      'a route handler wired to the production engine did NOT flip the probe',
    ).toBe(false)
  })

  test('B-4 CASE D — a UI page with NO Evaluate execution path is NOT a runtime', () => {
    // A routable page that renders static copy. The authority orders the UI
    // read model (W-EV-6) AFTER the server actions (W-EV-5), so a page that
    // executes nothing is not what makes the leg traversable.
    const files = [
      {
        path: 'app/app/projects/[projectId]/evaluate/page.tsx',
        content: 'export default function EvaluatePage() { return <main>Evaluation coming soon</main> }',
      },
    ]
    expect(
      detectNoEvaluateRuntime(files),
      'a static UI page with no Evaluate execution path was credited as a runtime',
    ).toBe(true)
  })

  test('B-4 — a comment or a string mentioning the engine does NOT vote', () => {
    const files = [
      {
        path: 'app/actions/notes.ts',
        content: [
          "'use server'",
          "// TODO: wire this to '@/lib/evaluate/scoring' once W-EV-5 lands",
          'const planned = "@/lib/evaluate/decision-policy"',
          'export async function notes() { return planned }',
        ].join('\n'),
      },
    ]
    expect(
      detectNoEvaluateRuntime(files),
      'a commented-out or quoted module specifier was counted as a production linkage',
    ).toBe(true)
  })

  test('B-4 — a TYPE-ONLY import of the engine does NOT vote', () => {
    // Erased at compile time: it wires no runtime and traverses nothing.
    const files = [
      {
        path: 'app/actions/evaluate/types-only.ts',
        content: [
          "'use server'",
          "import type { EvaluateResult } from '@/lib/evaluate/types'",
          'export async function shape(): Promise<EvaluateResult | null> { return null }',
        ].join('\n'),
      },
    ]
    expect(
      detectNoEvaluateRuntime(files),
      'a type-only import was counted as a runtime linkage',
    ).toBe(true)
  })

  test('B-4 — a TEST file wired to the engine does NOT vote', () => {
    const files = [
      {
        path: 'app/actions/evaluate/__tests__/decide.test.ts',
        content: [
          "'use server'",
          "import { decide } from '@/lib/evaluate/decision-policy'",
          'export async function decideEvaluation() { return decide() }',
        ].join('\n'),
      },
      {
        path: 'app/actions/evaluate/decide.spec.ts',
        content: "'use server'\nimport { score } from '@/lib/evaluate/scoring'\nexport async function x() { return score([], []) }",
      },
    ]
    expect(
      detectNoEvaluateRuntime(files),
      'a test file was credited as the production Evaluate runtime',
    ).toBe(true)
  })

  test('B-4 — the CURRENT tree has a pure engine but no traversable runtime', () => {
    // The live reading, against whatever tree this runs on — branch or
    // synthetic merge. This is the assertion that would have caught B-4.
    const runtime = findTraversableEvaluateRuntime(collectAppSourceFiles())
    expect(
      runtime,
      `app/** entrypoints were found wired to Evaluate: ${runtime.join(', ')}`,
    ).toEqual([])
  })

  // -------------------------------------------------------------------
  // 6b. J3 — the CAP-02 activation probe, and what it must NOT react to
  // -------------------------------------------------------------------
  test('the current tree reports CAP-02 designed but NOT live', () => {
    const activation = readPublicVerificationActivation()

    // The design IS present. Stating it positively matters: it is what makes
    // the next two assertions non-trivial, and it is the exact condition a
    // file-presence probe would have misread as remediation.
    expect(
      activation.designPackagePresent,
      'the CAP-02 prepared package is absent; this probe is measuring a capability that does not exist',
    ).toBe(true)

    expect(activation.capabilityEnabled, 'CAP-02 is enabled at this base').toBe(false)
    expect(
      activation.verifierCallsCapability,
      'the verifier already calls the capability function at this base',
    ).toBe(false)
    expect(detectPublicVerificationNotLive(activation)).toBe(true)
  })

  test('MUTATION CONTROL — CAP-02 going live flips the J3 probe', () => {
    // The governed future posture: the capability is wired AND the verifier
    // calls it. This is the transition CAP_02_PUBLIC_VERIFICATION.md describes
    // — "Estado: DISEÑO. No aplicado. No habilitado." ceasing to be true.
    expect(
      detectPublicVerificationNotLive({
        capabilityEnabled: true,
        verifierCallsCapability: true,
        designPackagePresent: true,
      }),
      'the J3 probe still reports blocked after CAP-02 is enabled AND wired',
    ).toBe(false)
  })

  test('MUTATION CONTROL — DESIGN PRESENCE ALONE MUST NOT flip the J3 probe', () => {
    // The defect this whole probe was rebuilt to avoid. The prepared SQL
    // package is 58KB of real design that already sits in the tree; a probe
    // keyed on its presence would report public verification remediated while
    // nothing was enabled and nothing was wired.
    //
    // Each half alone is also insufficient, and both are asserted, because
    // "enabled but unwired" and "wired but disabled" are both reachable
    // intermediate states during the real rollout.
    expect(
      detectPublicVerificationNotLive({
        capabilityEnabled: false,
        verifierCallsCapability: false,
        designPackagePresent: true,
      }),
      'design-file presence alone was treated as runtime remediation',
    ).toBe(true)

    expect(
      detectPublicVerificationNotLive({
        capabilityEnabled: true,
        verifierCallsCapability: false,
        designPackagePresent: true,
      }),
      'an enabled capability that the verifier never calls was treated as live',
    ).toBe(true)

    expect(
      detectPublicVerificationNotLive({
        capabilityEnabled: false,
        verifierCallsCapability: true,
        designPackagePresent: true,
      }),
      'a verifier calling a DISABLED capability was treated as live',
    ).toBe(true)
  })

  // -------------------------------------------------------------------
  // 6c. F-5 — the rate-limit probe must see the proxy, with route evidence
  // -------------------------------------------------------------------
  test('the proxy limiter does NOT currently govern /verify', () => {
    // The limiter exists in proxy.ts today and is gated to /api/. Counting it
    // would declare the blocker resolved on the strength of middleware that
    // demonstrably never runs for this route.
    const proxySource = readFileSync(join(REPO_ROOT, 'proxy.ts'), 'utf8')
    expect(
      detectProxyLimiterGovernsVerify(proxySource),
      'the proxy limiter is being credited with governing /verify',
    ).toBe(false)
  })

  test('MUTATION CONTROL — widening the proxy route gate to /verify flips the probe', () => {
    const realistic = `
      if (request.nextUrl.pathname.startsWith('/verify')) {
        const rateLimit = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m') })
        const { success } = await rateLimit.limit(key)
      }
    `
    expect(
      detectProxyLimiterGovernsVerify(realistic),
      'a proxy limiter gated ON /verify was not recognised as governing it',
    ).toBe(true)

    // And the composed probe agrees: nothing on the route surface, but the
    // proxy now governs it, so the blocker is gone.
    expect(
      detectNoRateLimitGoverningVerify([['verify/page.tsx', 'export default function Page() {}']], realistic),
      'the composed rate-limit probe ignored a proxy limiter that governs /verify',
    ).toBe(false)
  })

  test('an UNRELATED proxy limiter is not credited without route evidence', () => {
    // "Do not classify unrelated generic middleware as a verifier limiter
    // without route evidence." A limiter gated to /api/ governs /api/.
    const apiOnly = `
      if (request.nextUrl.pathname.startsWith('/api/')) {
        const rateLimit = new Ratelimit({ redis })
      }
    `
    expect(detectProxyLimiterGovernsVerify(apiOnly)).toBe(false)
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
