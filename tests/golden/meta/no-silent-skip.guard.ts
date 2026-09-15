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
  detectNoEvaluateRuntime,
  detectNoRateLimitGoverningVerify,
  detectPlatformPrincipalAmbiguity,
  detectProxyLimiterGovernsVerify,
  detectPublicVerificationNotLive,
  readPublicVerificationActivation,
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
    // A file importing `test` straight from @playwright/test would run OUTSIDE
    // the worker-scoped auto fixture, and therefore outside the Node egress
    // guard. Not a style preference: it is precisely how the B-1 defect — a
    // guard with nothing in front of it — would come back.
    const offenders = goldenSourceFiles()
      .filter(([path]) => path !== 'tests/golden/harness.ts')
      .filter(([, content]) => /import\s+(?!type\b)[^;]*from\s+'@playwright\/test'/.test(content))
      .map(([path]) => path)

    expect(
      offenders,
      'these files bypass tests/golden/harness.ts and so run without the Node egress guard',
    ).toEqual([])
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
