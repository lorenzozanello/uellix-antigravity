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

export const PROBE_J3_ANON_READ_BLOCKED: PostureProbe = {
  id: 'J3-ANON-READ-BLOCKED',
  frozenBlocker:
    'the public verification read returns zero rows for an anonymous caller after the runtime ' +
    'cutover, so the positive leg of J3 cannot resolve a locator that does exist',
  surface: 'lib/reports/public-verify.ts',
  remediationMeaning:
    'a SELECT policy now expresses the locator capability in the database, so J3 step 1 must ' +
    'be converted from a blocked contract into a positive resolution assertion',
}

/**
 * True while the read goes through the ordinary, claim-scoped `db` client.
 *
 * This is the property that makes the anonymous read return nothing: the
 * module has no privileged client and adds no claims, so row-level security
 * sees an anonymous principal and matches no member-scoped policy. If a
 * service-role or bypass client ever appears here, or the module stops using
 * the shared client, this returns false and the step must be re-examined —
 * which is the correct outcome either way, because both changes alter exactly
 * what J3 traverses.
 */
export function detectAnonymousReadBlocked(publicVerifySource: string): boolean {
  const usesSharedClient = /from\s+'@\/db\/client'/.test(publicVerifySource)
  const hasPrivilegedEscape =
    /service_role|serviceRole|SERVICE_ROLE|bypassRls|BYPASSRLS/.test(publicVerifySource)
  return usesSharedClient && !hasPrivilegedEscape
}

export function probeAnonymousReadBlocked(): PostureReading {
  const source = readRepoFile('lib/reports/public-verify.ts')
  const present = detectAnonymousReadBlocked(source)
  return {
    probe: PROBE_J3_ANON_READ_BLOCKED,
    blockerStillPresent: present,
    evidence: present
      ? 'lib/reports/public-verify.ts reads through the shared @/db/client with no service-role or RLS-bypass escape'
      : 'lib/reports/public-verify.ts no longer reads through the plain shared client, or has acquired a privileged escape',
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

/**
 * True while NO file on the surface references a rate limiter.
 *
 * Deliberately broad on the symbol side — the repository has two unrelated
 * limiters (`lib/security/rate-limit.ts` and `lib/stella/rate-limit.ts`) plus
 * the Upstash one used by the proxy — because the blocker is "no rate limiting
 * of any kind", and a narrow matcher would report the blocker still present
 * after someone wired up whichever limiter this matcher did not know about.
 */
export function detectNoRateLimitOnSurface(
  files: ReadonlyArray<readonly [string, string]>,
): boolean {
  const limiterReference = /checkAndRecordRateLimit|Ratelimit|rateLimit|rate-limit|rateLimiter/
  return !files.some(([, content]) => limiterReference.test(content))
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
  const present = detectNoRateLimitOnSurface(files)
  return {
    probe: PROBE_J3_NO_RATE_LIMIT,
    blockerStillPresent: present,
    evidence: present
      ? `no rate-limiter reference in ${files.length} file(s) under app/(public)/verify/**`
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
  { probe: PROBE_J3_ANON_READ_BLOCKED, run: probeAnonymousReadBlocked },
  { probe: PROBE_J3_NO_RATE_LIMIT, run: probeNoRateLimitOnVerifySurface },
]

export function runPostureProbe(id: string): PostureReading {
  const entry = POSTURE_PROBES.find((candidate) => candidate.probe.id === id)
  if (!entry) throw new Error(`GOLDEN_POSTURE_PROBE_UNKNOWN: ${id}`)
  return entry.run()
}
