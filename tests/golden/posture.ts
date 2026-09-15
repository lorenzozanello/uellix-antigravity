// tests/golden/posture.ts
//
// THE UPSTREAM BLOCKERS, ASSERTED AGAINST THE REPOSITORY RATHER THAN QUOTED.
//
// ===========================================================================
// WHAT A BLOCKED CONTRACT HAS TO DO TO BE WORTH ANYTHING
// ===========================================================================
// The frozen authority records, for each journey, a list of
// `known_upstream_blockers`. A blocked contract that merely restates one of
// those sentences asserts nothing: the sentence is true because it is written
// down, and it will keep being true after the blocker is fixed, because
// nothing re-reads the world.
//
// A blocked contract earns its place only if it is FALSIFIABLE — if there is a
// change to this repository that makes it fail. That is the whole point of the
// mechanism: when the blocker is remediated, the contract must turn RED and
// force its step to be converted into a positive journey assertion. A contract
// that cannot go red is a comment with a green tick next to it.
//
// So each probe here measures a CURRENT PROPERTY OF THE SOURCE, and the
// journey specs assert that the property still holds. Remediate the property
// and the assertion fails, loudly, naming the step that must now be rewritten.
//
// ===========================================================================
// WHY THE DETECTORS ARE PURE FUNCTIONS OVER CONTENT
// ===========================================================================
// Every probe is split into `read the file` and `decide from its content`. The
// decision half takes a string and returns a boolean, which lets the meta
// guard drive it BOTH ways: once with the real content (expecting the blocker
// present) and once with a remediated fixture (expecting the blocker gone).
//
// A detector that can only be run against the tree it ships with has never
// been shown to be capable of returning false, and a check that cannot return
// false is indistinguishable from `expect(true).toBe(true)`. This repository
// has been bitten by exactly that shape before — a duplicate-key check built
// on a JSON.parse reviver that passed happily on input containing duplicates.
//
// ===========================================================================
// SCOPE HONESTY
// ===========================================================================
// There are four probes here, and the frozen authority lists eight upstream
// blockers across the three journeys. The four implemented are the ones that
// can be measured from source ROBUSTLY at this base. The remainder are
// recorded in the registry as blocked by target absence alone and are NOT
// dressed up as substantive controls — see `BLOCKED_BY_TARGET_ONLY` there.
// Overstating coverage would be a worse defect than having less of it.

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './authority'
// The CAP-02 descriptor is imported so `enabled` is read as a VALUE rather than
// scraped out of source text. A relative path, not the `@/` alias: this module
// runs under Playwright, which has no tsconfig-path resolution configured.
import { PUBLIC_VERIFICATION_CAPABILITY } from '../../lib/capabilities/contracts'

export interface PostureProbe {
  /** Stable identifier, referenced by the registry. */
  readonly id: string
  /** The frozen blocker sentence this probe makes falsifiable. */
  readonly frozenBlocker: string
  /** The repository surface measured. */
  readonly surface: string
  /** What a reader should conclude when this probe flips to false. */
  readonly remediationMeaning: string
}

export interface PostureReading {
  readonly probe: PostureProbe
  /** True when the blocker is STILL present, i.e. the step remains blocked. */
  readonly blockerStillPresent: boolean
  /** Human-readable measurement, carried into the evidence. */
  readonly evidence: string
}

function readRepoFile(relativePath: string): string {
  const absolute = join(REPO_ROOT, relativePath)
  // Read as one string, never line by line. A line-oriented scan cannot see a
  // multi-line expression, and this repository has previously had a `grep -c`
  // return the expected count by matching a commented-out line.
  return readFileSync(absolute, 'utf8')
}

// ---------------------------------------------------------------------------
// J2 — the platform principal is a flag that is also a tenant role value
// ---------------------------------------------------------------------------

export const PROBE_J2_PLATFORM_PRINCIPAL: PostureProbe = {
  id: 'J2-PLATFORM-PRINCIPAL-AMBIGUOUS',
  frozenBlocker:
    'the platform principal is a single flag that is also a tenant role value, so a negative ' +
    'control must prove the distinction rather than assume it',
  surface: 'db/schema.ts',
  remediationMeaning:
    'the platform principal and the tenant role no longer share the literal super_admin, so ' +
    "J2's negative control can stop proving the distinction and start relying on it",
}

/**
 * True while BOTH representations of `super_admin` coexist.
 *
 * The blocker is not "there is a boolean" and not "there is a role value" — it
 * is that the SAME literal names a platform capability and a tenant role, so a
 * control which merely sees the string cannot tell which one it found. Both
 * halves are therefore required, and the probe reports false as soon as either
 * disappears.
 */
export function detectPlatformPrincipalAmbiguity(schemaSource: string): boolean {
  const hasPlatformFlag = /is_super_admin/.test(schemaSource)
  // The role CHECK constraint, matched as one string across newlines, because
  // the constraint is written over several lines in the schema.
  const roleCheck = /role_check[\s\S]{0,400}?'super_admin'/.test(schemaSource)
  return hasPlatformFlag && roleCheck
}

export function probePlatformPrincipalAmbiguity(): PostureReading {
  const source = readRepoFile('db/schema.ts')
  const present = detectPlatformPrincipalAmbiguity(source)
  return {
    probe: PROBE_J2_PLATFORM_PRINCIPAL,
    blockerStillPresent: present,
    evidence: present
      ? "db/schema.ts declares the boolean column is_super_admin AND a role_check admitting 'super_admin'"
      : 'db/schema.ts no longer carries both the is_super_admin flag and a super_admin role value',
  }
}

// ---------------------------------------------------------------------------
// J3 — the public verification read is fail-closed for an anonymous caller
// ---------------------------------------------------------------------------

export const PROBE_J3_PUBLIC_VERIFICATION_NOT_LIVE: PostureProbe = {
  id: 'J3-PUBLIC-VERIFICATION-NOT-LIVE',
  frozenBlocker:
    'public verification is not available to an anonymous caller: CAP-02 is designed but not ' +
    'wired, so the positive leg of J3 cannot resolve a locator that does exist',
  surface: 'lib/capabilities/contracts.ts (CAP-02 descriptor) + lib/reports/public-verify.ts',
  remediationMeaning:
    'CAP-02 is enabled AND the verifier calls the capability function, so J3 step 1 must be ' +
    'converted from a blocked contract into a positive resolution assertion',
}

/**
 * The three facts that decide whether public verification is genuinely live.
 *
 * ===========================================================================
 * WHY THE R1 VERSION OF THIS PROBE WAS BLIND
 * ===========================================================================
 * R1 watched `lib/reports/public-verify.ts` for a `service_role` escape and
 * called that "the anonymous read is fail-closed". Independent review was right
 * to reject it. The repository's design FORBIDS a service-role bypass — CAP-02
 * exists precisely to avoid one — so the thing R1 watched for is a thing that
 * must never happen. A detector whose trigger is a prohibited change is a
 * detector that will never fire, and it named a remediation nobody intends to
 * perform.
 *
 * ===========================================================================
 * WHAT THE GOVERNED TRANSITION ACTUALLY IS
 * ===========================================================================
 * `docs/ops/capabilities/CAP_02_PUBLIC_VERIFICATION.md` states it: "Estado:
 * DISEÑO. No aplicado. No habilitado." The capability is delivered by the
 * prepared package `db/prepared/stella_0007_public_verification_capability.sql`,
 * which installs `uellix_capability.verify_report` as a SECURITY DEFINER
 * function owned by a zero-member role, and the runtime reaches it through the
 * descriptor in `lib/capabilities/contracts.ts`, where `enabled` is `false`.
 *
 * So becoming live requires BOTH:
 *
 *   1. the capability is wired at runtime  (`enabled === true`), and
 *   2. the verifier actually calls it      (`verify_report` on the read path).
 *
 * Either alone is insufficient, and the conjunction is what this returns.
 *
 * ===========================================================================
 * DESIGN PRESENCE IS NOT REMEDIATION — ASSERTED, NOT ASSUMED
 * ===========================================================================
 * `designPackagePresent` is carried deliberately even though it does NOT
 * participate in the verdict. The 58KB SQL package is already in the tree
 * TODAY, so a probe keyed on file presence would report the blocker resolved
 * while nothing had been enabled and nothing had been wired. Recording the flag
 * without letting it vote is what makes that distinction inspectable — and the
 * meta guard drives exactly that combination to prove it changes nothing.
 */
export interface PublicVerificationActivation {
  /** `CapabilityDescriptor.enabled` for CAP-02 — the runtime wiring switch. */
  readonly capabilityEnabled: boolean
  /** Whether the verifier's read path calls the capability function. */
  readonly verifierCallsCapability: boolean
  /** Whether the prepared SQL package exists. DESIGN ONLY — never a vote. */
  readonly designPackagePresent: boolean
}

/** True while public verification is NOT live. */
export function detectPublicVerificationNotLive(activation: PublicVerificationActivation): boolean {
  return !(activation.capabilityEnabled && activation.verifierCallsCapability)
}

/**
 * Read the activation facts off the repository.
 *
 * The descriptor is IMPORTED, not text-matched. `enabled` is a real value in a
 * frozen object; scraping it out of the source with a regular expression would
 * make the probe sensitive to formatting rather than to the fact, which is the
 * class of mistake that produced the R1 defect in the first place.
 */
export function readPublicVerificationActivation(): PublicVerificationActivation {
  const descriptor = PUBLIC_VERIFICATION_CAPABILITY
  const verifierSource = readRepoFile('lib/reports/public-verify.ts')

  // Both the schema-qualified name and the bare function name, because the
  // call site may reach it through either spelling.
  const verifierCallsCapability = descriptor.functions.some((qualified) => {
    const bare = qualified.split('.').pop() ?? qualified
    return verifierSource.includes(qualified) || verifierSource.includes(bare)
  })

  // Read through a `boolean`-typed local rather than comparing to `true`.
  // The descriptor is a frozen literal, so TypeScript narrows `enabled` to the
  // literal type `false` and rejects `=== true` as a comparison with no
  // overlap. That narrowing is a fact about today's value, not about the field,
  // and the probe must keep compiling on the day the value becomes `true`.
  const capabilityEnabled: boolean = descriptor.enabled

  return {
    capabilityEnabled,
    verifierCallsCapability,
    designPackagePresent: existsSync(join(REPO_ROOT, descriptor.package)),
  }
}

export function probePublicVerificationNotLive(): PostureReading {
  const activation = readPublicVerificationActivation()
  const present = detectPublicVerificationNotLive(activation)
  return {
    probe: PROBE_J3_PUBLIC_VERIFICATION_NOT_LIVE,
    blockerStillPresent: present,
    evidence: present
      ? `CAP-02 is not live: enabled=${activation.capabilityEnabled}, ` +
        `verifier calls the capability=${activation.verifierCallsCapability} ` +
        `(the prepared package IS present=${activation.designPackagePresent}, which is design, not activation)`
      : 'CAP-02 is enabled AND the verifier calls the capability function; public verification is live',
  }
}

// ---------------------------------------------------------------------------
// J3 — the public verification surface has no rate limiting
// ---------------------------------------------------------------------------

export const PROBE_J3_NO_RATE_LIMIT: PostureProbe = {
  id: 'J3-NO-RATE-LIMIT',
  frozenBlocker: 'the public verification surface has no rate limiting',
  surface: 'app/(public)/verify/**',
  remediationMeaning:
    "a rate limiter now guards the public surface, so J3's rate-limit disposition becomes " +
    'exercisable and must be asserted rather than recorded as absent',
}

/** Every `.ts`/`.tsx` file under the public verify surface, as (path, content). */
export function readPublicVerifySurface(): ReadonlyArray<readonly [string, string]> {
  const surfaceRoot = join(REPO_ROOT, 'app', '(public)', 'verify')
  const collected: Array<readonly [string, string]> = []
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childAbsolute = join(dir, entry.name)
      const childRelative = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative)
      } else if (/\.tsx?$/.test(entry.name)) {
        collected.push([childRelative, readFileSync(childAbsolute, 'utf8')] as const)
      }
    }
  }
  if (existsSync(surfaceRoot)) walk(surfaceRoot, 'app/(public)/verify')
  return collected
}

/** Any of the repository's three unrelated limiters, plus the generic spellings. */
const LIMITER_REFERENCE = /checkAndRecordRateLimit|Ratelimit|rateLimit|rate-limit|rateLimiter/

/**
 * True while NO file on the route surface itself references a rate limiter.
 *
 * Deliberately broad on the symbol side — the repository has two in-process
 * limiters (`lib/security/rate-limit.ts`, `lib/stella/rate-limit.ts`) plus the
 * Upstash one in the proxy — because the blocker is "no rate limiting of any
 * kind", and a narrow matcher would report the blocker still present after
 * someone wired up whichever limiter this matcher did not know about.
 */
export function detectNoRateLimitOnSurface(
  files: ReadonlyArray<readonly [string, string]>,
): boolean {
  return !files.some(([, content]) => LIMITER_REFERENCE.test(content))
}

/**
 * Whether the proxy's limiter GOVERNS `/verify`.
 *
 * ===========================================================================
 * WHY THE ROUTE SURFACE ALONE WAS THE WRONG PLACE TO LOOK
 * ===========================================================================
 * R1 scanned only `app/(public)/verify/**`. Independent review pointed out that
 * the request path to `/verify` does not begin there: `proxy.ts` has a matcher
 * covering every non-asset route and already constructs an Upstash limiter. A
 * probe blind to the proxy would keep reporting "no rate limiting" after a
 * limiter had been extended to cover the public surface — reporting a blocker
 * that had in fact been remediated, which is the same class of error as missing
 * one that had not.
 *
 * ===========================================================================
 * WHY A LIMITER IN THE PROXY IS NOT AUTOMATICALLY A VERIFIER LIMITER
 * ===========================================================================
 * The proxy's limiter exists TODAY and does not govern `/verify`: it sits
 * behind `request.nextUrl.pathname.startsWith('/api/')`. Counting it would
 * declare the blocker resolved on the strength of middleware that demonstrably
 * never runs for this route.
 *
 * So route evidence is REQUIRED. The path gates in the file are collected, and
 * the limiter counts only when some gate actually admits `/verify` — or when
 * there is no gate at all, in which case the limiter governs every route the
 * matcher passes, `/verify` included.
 *
 * This is a heuristic over source text and is worth naming as one: it reads the
 * gates in the file rather than proving which gate encloses the limiter block.
 * It is calibrated so that the CURRENT tree reports "not governed" and the
 * realistic remediation — widening the gate to the public surface — flips it.
 */
export function detectProxyLimiterGovernsVerify(proxySource: string): boolean {
  if (!LIMITER_REFERENCE.test(proxySource)) return false

  const gates = [...proxySource.matchAll(/pathname\s*\.\s*startsWith\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1],
  )

  // An ungated limiter in a proxy whose matcher covers every non-asset route
  // governs `/verify` by construction.
  if (gates.length === 0) return true

  return gates.some((gate) => '/verify'.startsWith(gate) || gate.startsWith('/verify'))
}

/** True while NOTHING on the request path to `/verify` rate-limits it. */
export function detectNoRateLimitGoverningVerify(
  surfaceFiles: ReadonlyArray<readonly [string, string]>,
  proxySource: string,
): boolean {
  return detectNoRateLimitOnSurface(surfaceFiles) && !detectProxyLimiterGovernsVerify(proxySource)
}

export function probeNoRateLimitOnVerifySurface(): PostureReading {
  const files = readPublicVerifySurface()
  if (files.length === 0) {
    // An empty surface would make the "no limiter found" answer vacuously true.
    return {
      probe: PROBE_J3_NO_RATE_LIMIT,
      blockerStillPresent: false,
      evidence:
        'app/(public)/verify/** contains no TypeScript files; the surface this probe measures does not exist',
    }
  }
  const proxySource = readRepoFile('proxy.ts')
  const present = detectNoRateLimitGoverningVerify(files, proxySource)
  const proxyGoverns = detectProxyLimiterGovernsVerify(proxySource)
  return {
    probe: PROBE_J3_NO_RATE_LIMIT,
    blockerStillPresent: present,
    evidence: present
      ? `no rate limiter governs /verify: none in ${files.length} file(s) under app/(public)/verify/**, ` +
        'and the proxy limiter is gated to a path that does not admit /verify'
      : proxyGoverns
        ? 'the proxy rate limiter now governs /verify'
        : `a rate-limiter reference now appears under app/(public)/verify/** (${files.length} file(s) scanned)`,
  }
}

// ---------------------------------------------------------------------------
// J1 — the evaluation surface has no runtime
// ---------------------------------------------------------------------------

export const PROBE_J1_NO_EVALUATE_RUNTIME: PostureProbe = {
  id: 'J1-EVALUATE-RUNTIME-ABSENT',
  frozenBlocker: 'the evaluation surface has no runtime, so the evaluation leg has nothing to traverse',
  surface: 'app/** route segments and lib/** modules named for evaluation',
  remediationMeaning:
    'an evaluation runtime now exists, so J1 step 12 must be converted from a blocked contract ' +
    'into a positive traversal of the evaluation leg',
}

/** Route segment directories under `app/` whose name is an evaluation surface. */
export function findEvaluateRouteSegments(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string, relative: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const childRelative = `${relative}/${entry.name}`
      if (/^evaluate$|^evaluation$|^evaluations$/i.test(entry.name)) found.push(childRelative)
      walk(join(dir, entry.name), childRelative)
    }
  }
  walk(join(REPO_ROOT, 'app'), 'app')
  return found
}

/**
 * True while there is no evaluation runtime.
 *
 * "Runtime" is read as a routable surface or a dedicated library module, NOT as
 * any file whose name contains the word. `evaluateProxyRubric.action.ts` is a
 * server action belonging to the proxy leg and is not the evaluation surface
 * J1 step 12 names, so a probe that counted it would report the blocker
 * resolved while nothing had been built.
 */
export function detectNoEvaluateRuntime(
  routeSegments: readonly string[],
  libModuleExists: boolean,
): boolean {
  return routeSegments.length === 0 && !libModuleExists
}

export function probeNoEvaluateRuntime(): PostureReading {
  const segments = findEvaluateRouteSegments()
  const libModuleExists =
    existsSync(join(REPO_ROOT, 'lib', 'evaluate')) || existsSync(join(REPO_ROOT, 'lib', 'evaluation'))
  const present = detectNoEvaluateRuntime(segments, libModuleExists)
  return {
    probe: PROBE_J1_NO_EVALUATE_RUNTIME,
    blockerStillPresent: present,
    evidence: present
      ? 'no app/** route segment named evaluate|evaluation|evaluations and no lib/evaluate or lib/evaluation module'
      : `an evaluation runtime now exists (route segments: ${segments.join(', ') || 'none'}; lib module: ${libModuleExists})`,
  }
}

// ---------------------------------------------------------------------------
// Registry of probes
// ---------------------------------------------------------------------------

export const POSTURE_PROBES: ReadonlyArray<{
  readonly probe: PostureProbe
  readonly run: () => PostureReading
}> = [
  { probe: PROBE_J1_NO_EVALUATE_RUNTIME, run: probeNoEvaluateRuntime },
  { probe: PROBE_J2_PLATFORM_PRINCIPAL, run: probePlatformPrincipalAmbiguity },
  { probe: PROBE_J3_PUBLIC_VERIFICATION_NOT_LIVE, run: probePublicVerificationNotLive },
  { probe: PROBE_J3_NO_RATE_LIMIT, run: probeNoRateLimitOnVerifySurface },
]

export function runPostureProbe(id: string): PostureReading {
  const entry = POSTURE_PROBES.find((candidate) => candidate.probe.id === id)
  if (!entry) throw new Error(`GOLDEN_POSTURE_PROBE_UNKNOWN: ${id}`)
  return entry.run()
}
