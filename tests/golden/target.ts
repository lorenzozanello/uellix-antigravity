// tests/golden/target.ts
//
// WHICH TARGET THE JOURNEYS RAN AGAINST — DECLARED, NEVER INFERRED.
//
// ===========================================================================
// THE CONDITION THIS EXISTS TO MAKE VISIBLE
// ===========================================================================
// STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json fixes the Golden Journey
// target as "A Preview deployment satisfying S4, so that the journey exercises
// the certified SHA against the matching schema". S4 is NOT satisfied at this
// base. So the honest state of this skeleton is: the runner exists, the
// journeys are expressed, and the target the authority requires is absent.
//
// There is a tempting way to write that and a correct way.
//
//   TEMPTING:  if no base URL is configured, skip the browser specs.
//   CORRECT:   the tier is a REQUIRED, DECLARED input; every disposition is a
//              function of it; and the run records which tier it ran under.
//
// The tempting version is the exact defect the companion ledger's
// TEST_EVIDENCE_MODEL names: "a file skipped for an environmental reason
// yields neither a failure nor a row, so it is invisible in a green run". An
// absent target would become an absent journey, and an absent journey reports
// as success. This module exists so that "there was no target" is a value that
// travels into the evidence rather than a silence that vanishes from it.
//
// ===========================================================================
// WHY THE DEFAULT IS THE WEAKEST TIER AND NOT AN ERROR
// ===========================================================================
// Defaulting to NONE, rather than refusing to run, is deliberate. The
// contract-tier assertions are real work that does not need a server, and they
// are the assertions that go RED when an upstream blocker is remediated. A
// harness that refused to start without a Preview deployment would run nothing
// at all until S4 lands, which is the same zero-coverage outcome as skipping,
// reached by a louder route.
//
// What must never default is the CLAIM. NONE can never satisfy M9, and
// `assertTierCanSatisfyM9` is the single place that is decided.

/**
 * The declared kinds of Golden Journey target.
 *
 * Ordered weakest to strongest. The order is meaningful: `PREVIEW_S4` is the
 * only tier the frozen authority accepts as evidence for M9, J1, J2 or J3.
 */
export const TARGET_KINDS = ['NONE', 'LOCAL_APP', 'PREVIEW_S4'] as const

export type TargetKind = (typeof TARGET_KINDS)[number]

/** The environment variable that declares the tier. */
export const TARGET_KIND_ENV = 'GOLDEN_JOURNEY_TARGET_KIND'

/** The environment variable that carries the base URL for the two served tiers. */
export const TARGET_BASE_URL_ENV = 'GOLDEN_JOURNEY_BASE_URL'

/** The environment variable carrying the exact SHA the target was built from. */
export const TARGET_SHA_ENV = 'GOLDEN_JOURNEY_TARGET_SHA'

/** The environment variable carrying the deployment identifier, when there is one. */
export const TARGET_DEPLOYMENT_ENV = 'GOLDEN_JOURNEY_DEPLOYMENT_ID'

export interface GoldenTarget {
  readonly kind: TargetKind
  /** Absent exactly when `kind` is NONE. */
  readonly baseURL: string | undefined
  /** The SHA the target was built from, when declared. */
  readonly sha: string | undefined
  /** The deployment identifier, when the tier has one. */
  readonly deploymentId: string | undefined
}

/** Raised when the declared target is internally inconsistent. */
export class GoldenTargetDeclarationError extends Error {
  constructor(message: string) {
    super(`GOLDEN_TARGET_DECLARATION: ${message}`)
    this.name = 'GOLDEN_TARGET_DECLARATION'
  }
}

function isTargetKind(value: string): value is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(value)
}

/**
 * Resolve the declared target from an environment.
 *
 * Takes the environment as an argument rather than reading `process.env`
 * directly so the meta guard can drive every branch — including the invalid
 * ones — without mutating the real process. A resolver that can only be
 * exercised through the ambient environment can only be tested in the
 * configuration it already has.
 */
export function resolveGoldenTarget(
  // `Record<string, string | undefined>` rather than `NodeJS.ProcessEnv`: the
  // latter requires NODE_ENV, which would force every caller that wants to
  // drive ONE variable to supply an unrelated one. A resolver that is awkward
  // to call with a minimal environment ends up being tested only with the
  // ambient one.
  env: Record<string, string | undefined> = process.env,
): GoldenTarget {
  const declared = (env[TARGET_KIND_ENV] ?? '').trim()
  const baseURL = (env[TARGET_BASE_URL_ENV] ?? '').trim()

  // An unset tier is NONE. An explicitly WRONG tier is an error: a typo such as
  // `PREVIEW` or `preview_s4` must not silently degrade to the tier that runs
  // the fewest assertions, because that degradation reads as a green.
  if (declared.length === 0) {
    if (baseURL.length > 0) {
      throw new GoldenTargetDeclarationError(
        `${TARGET_BASE_URL_ENV} is set to ${JSON.stringify(baseURL)} but ${TARGET_KIND_ENV} ` +
          'is unset. A base URL without a declared tier would run browser journeys ' +
          'against an unidentified target and record no tier in the evidence.',
      )
    }
    return { kind: 'NONE', baseURL: undefined, sha: undefined, deploymentId: undefined }
  }

  if (!isTargetKind(declared)) {
    throw new GoldenTargetDeclarationError(
      `${TARGET_KIND_ENV}=${JSON.stringify(declared)} is not one of ${TARGET_KINDS.join(', ')}`,
    )
  }

  if (declared === 'NONE') {
    if (baseURL.length > 0) {
      throw new GoldenTargetDeclarationError(
        `${TARGET_KIND_ENV}=NONE contradicts ${TARGET_BASE_URL_ENV}=${JSON.stringify(baseURL)}`,
      )
    }
    return { kind: 'NONE', baseURL: undefined, sha: undefined, deploymentId: undefined }
  }

  if (baseURL.length === 0) {
    throw new GoldenTargetDeclarationError(
      `${TARGET_KIND_ENV}=${declared} requires ${TARGET_BASE_URL_ENV}; a served tier with no ` +
        'base URL cannot traverse anything',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new GoldenTargetDeclarationError(
      `${TARGET_BASE_URL_ENV}=${JSON.stringify(baseURL)} is not a valid absolute URL`,
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GoldenTargetDeclarationError(
      `${TARGET_BASE_URL_ENV} must be http or https, got ${parsed.protocol}`,
    )
  }

  const sha = (env[TARGET_SHA_ENV] ?? '').trim() || undefined

  // The authority requires the run be "bound to the exact SHA and the
  // deployment identifier". For PREVIEW_S4 that is not optional, so a missing
  // SHA is refused here rather than discovered when the evidence is read.
  if (declared === 'PREVIEW_S4' && sha === undefined) {
    throw new GoldenTargetDeclarationError(
      `${TARGET_KIND_ENV}=PREVIEW_S4 requires ${TARGET_SHA_ENV}. The frozen authority binds ` +
        'the run to the exact SHA and the deployment identifier; a Preview run that cannot ' +
        'name its SHA is unevidenced, which is worse than a run that failed.',
    )
  }

  return {
    kind: declared,
    baseURL: parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname),
    sha,
    deploymentId: (env[TARGET_DEPLOYMENT_ENV] ?? '').trim() || undefined,
  }
}

/** True when the tier can serve HTTP, i.e. a browser can traverse it. */
export function tierIsServed(kind: TargetKind): boolean {
  return kind === 'LOCAL_APP' || kind === 'PREVIEW_S4'
}

/**
 * The single place a run may be claimed as M9-satisfying evidence.
 *
 * Returns a reason string when the tier CANNOT satisfy M9, and `null` when it
 * can. Phrased as "why not" rather than a boolean so the reason reaches the
 * skeleton report instead of being reconstructed by whoever reads a `false`.
 *
 * LOCAL_APP is explicitly refused. A locally booted application is a useful
 * place to express a journey, and it is not a Preview deployment satisfying
 * S4: it does not carry the certified SHA against the matching schema, and the
 * authority's binding for M9 is about exactly that pairing. Letting a local
 * boot count would be fabricating staging readiness.
 */
export function m9DisqualificationReason(target: GoldenTarget): string | null {
  switch (target.kind) {
    case 'NONE':
      return 'no target was declared, so no browser journey was traversed'
    case 'LOCAL_APP':
      return (
        'the target is a locally booted application, not a Preview deployment satisfying S4; ' +
        'the frozen authority binds M9 to the certified SHA against the matching schema'
      )
    case 'PREVIEW_S4':
      return target.sha === undefined
        ? 'the Preview target did not declare the exact SHA it was built from'
        : null
  }
}
