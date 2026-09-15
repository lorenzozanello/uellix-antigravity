// tests/golden/authority.ts
//
// THE FROZEN JOURNEY DEFINITION, READ AT RUNTIME — NEVER TRANSCRIBED.
//
// ===========================================================================
// WHY THIS FILE PARSES PROSE INSTEAD OF HOLDING A LIST
// ===========================================================================
// HPO-G-03 binds Playwright as THE browser Golden Journey runner, and
// `docs/ops/release/STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json` DEFINES
// the three journeys under `GOLDEN_JOURNEY_RUNNER.journeys`. That artifact is
// frozen; this lane consumes it and has no authority to restate it.
//
// The obvious implementation — copy the thirteen J1 steps into a TypeScript
// array — is the one thing that must not happen. A transcribed list agrees
// with the authority exactly once: at the moment it is typed. Afterwards the
// authority can gain a step, lose one, or rename one, and the harness keeps
// reporting a confident green against a step set that no longer exists. That
// is precisely the failure the ledger's own TEST_EVIDENCE_MODEL names — a
// green that is green because nothing reconciled the two sets.
//
// So the step set is DERIVED from the authority's own `path` string on every
// run. If the authority changes, this derivation changes with it, and the
// pinned expectation in GOLDEN_JOURNEY_SKELETON_v1.0.0.json (checked by the
// meta guard) goes RED rather than silently disagreeing.
//
// ===========================================================================
// THE HAZARD THIS CREATES, AND WHY IT IS STILL THE RIGHT TRADE
// ===========================================================================
// `path` is a comma-separated English sentence, not a machine list. Splitting
// it is therefore a PARSE, and a parse can be wrong in a way a literal array
// cannot. Two things contain that risk:
//
//   1. The derivation is total and fail-closed. A journey whose `path` does
//      not split into at least two non-empty steps raises rather than
//      returning a short list, because a silently-short list is exactly how a
//      required journey count drops without anyone noticing.
//
//   2. The derived set is compared against a PINNED set in the skeleton
//      artifact. Derivation alone could drift; pinning alone could go stale.
//      Requiring the two to agree means a change to either side is visible,
//      which is the property that matters.
//
// The alternative — hand-maintaining the list — fails control 1 and 2 both.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Repository root, resolved from this file rather than from `process.cwd()`. */
export const REPO_ROOT = join(__dirname, '..', '..')

/**
 * The frozen authority this lane consumes. Named as a constant so the single
 * place the path is written is also the place the reason is written: a test
 * that read some other file would be testing some other authority.
 */
export const STAGING_RELEASE_AUTHORITY_PATH = join(
  'docs',
  'ops',
  'release',
  'STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json',
)

/** The companion ledger. Read for the J1/J2/J3 gate rows, not for the paths. */
export const RELEASE_GATE_LEDGER_PATH = join(
  'docs',
  'ops',
  'release',
  'RELEASE_GATE_LEDGER_v1.0.0.json',
)

/** The HPO binding this lane consumes rather than re-authors. */
export const HPO_G_BINDING = 'HPO-G-03'

export interface FrozenStep {
  /** Stable slug derived from `phrase`. The registry key. */
  readonly id: string
  /** The authority's own words for this step, unedited apart from a leading `then`. */
  readonly phrase: string
  /** 1-based position within the journey, as the authority orders it. */
  readonly ordinal: number
}

export interface FrozenJourney {
  readonly id: string
  readonly name: string
  /** The raw `path` sentence, retained so a diff against the authority is readable. */
  readonly rawPath: string
  readonly steps: readonly FrozenStep[]
  readonly negativeControlIntent: string
  readonly knownUpstreamBlockers: readonly string[]
}

/**
 * Raised whenever the authority cannot be read or does not have the shape this
 * harness depends on.
 *
 * A distinct class, not a bare `Error`, because the meta guard asserts that an
 * unreadable or reshaped authority FAILS rather than degrades. `name` is the
 * greppable contract, matching the convention of
 * `TestRealGeminiNetworkBlockedError` in vitest.setup.network-guard.ts.
 */
export class GoldenAuthorityShapeError extends Error {
  constructor(message: string) {
    super(`GOLDEN_AUTHORITY_SHAPE: ${message}`)
    this.name = 'GOLDEN_AUTHORITY_SHAPE'
  }
}

/**
 * Slugify one step phrase.
 *
 * Articles are deliberately NOT stripped. "the governed assistant" becomes
 * `the-governed-assistant`, not `governed-assistant`. Stripping them would be a
 * small editorial judgement applied to frozen text, and every such judgement is
 * a place where the harness and the authority can quietly mean different
 * things. The slug is an identifier, not a label — it does not need to read
 * well, it needs to be a total, reversible function of the authority's words.
 */
export function slugifyStep(phrase: string): string {
  const slug = phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length === 0) {
    throw new GoldenAuthorityShapeError(
      `step phrase ${JSON.stringify(phrase)} slugified to the empty string`,
    )
  }
  return slug
}

/**
 * Split one `path` sentence into ordered steps.
 *
 * Exported so the meta guard can exercise it directly against a known input,
 * rather than only through the authority — a parser whose only test data is the
 * file it parses cannot be shown to reject anything.
 *
 * The leading `then ` of a trailing clause is removed because it is a
 * conjunction joining two steps, not part of either step's name: J3's path is
 * "resolve a public verification locator as an anonymous caller, then its
 * document rendering", where the second step is "its document rendering". No
 * other rewriting is performed.
 */
export function splitJourneyPath(rawPath: string): readonly FrozenStep[] {
  const phrases = rawPath
    .split(',')
    .map((segment) => segment.trim().replace(/^then\s+/i, '').trim())
    .filter((segment) => segment.length > 0)

  if (phrases.length < 2) {
    throw new GoldenAuthorityShapeError(
      `journey path ${JSON.stringify(rawPath)} split into ${phrases.length} step(s); ` +
        'a journey with fewer than two steps is far more likely to be a parse failure ' +
        'than a real one-step journey, and a short list is how a required step count ' +
        'drops silently',
    )
  }

  const steps = phrases.map((phrase, index) => ({
    id: slugifyStep(phrase),
    phrase,
    ordinal: index + 1,
  }))

  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new GoldenAuthorityShapeError(
        `journey path ${JSON.stringify(rawPath)} produced duplicate step id ${step.id}; ` +
          'the registry is keyed by step id, so a duplicate would let one contract ' +
          'stand in for two frozen steps',
      )
    }
    seen.add(step.id)
  }

  return steps
}

interface RawJourney {
  id?: unknown
  name?: unknown
  path?: unknown
  negative_control_intent?: unknown
  known_upstream_blockers?: unknown
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoldenAuthorityShapeError(`${what} is missing or not a non-empty string`)
  }
  return value
}

function requireStringArray(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new GoldenAuthorityShapeError(`${what} is missing or not an array of strings`)
  }
  return value as readonly string[]
}

/** Read and parse a repository-relative JSON file, failing closed on both. */
export function readRepoJson(relativePath: string): unknown {
  const absolute = join(REPO_ROOT, relativePath)
  let raw: string
  try {
    raw = readFileSync(absolute, 'utf8')
  } catch (cause) {
    throw new GoldenAuthorityShapeError(
      `cannot read ${relativePath} at ${absolute}: ${(cause as Error).message}`,
    )
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (cause) {
    throw new GoldenAuthorityShapeError(
      `${relativePath} is not valid JSON: ${(cause as Error).message}`,
    )
  }
}

/**
 * The three frozen journeys, derived from the frozen authority.
 *
 * NOT memoised. This is read once per process by a handful of callers, and a
 * cache would mean a test that mutated a fixture path could observe a stale
 * parse — a cheap way to manufacture a green.
 */
export function loadFrozenJourneys(): readonly FrozenJourney[] {
  const document = readRepoJson(STAGING_RELEASE_AUTHORITY_PATH) as Record<string, unknown>

  const runner = document['GOLDEN_JOURNEY_RUNNER']
  if (runner === null || typeof runner !== 'object') {
    throw new GoldenAuthorityShapeError(
      'GOLDEN_JOURNEY_RUNNER is absent from the staging/release authority; ' +
        'this harness has nothing to derive its journeys from',
    )
  }
  const runnerRecord = runner as Record<string, unknown>

  const binding = requireString(runnerRecord['hpo_g_binding'], 'GOLDEN_JOURNEY_RUNNER.hpo_g_binding')
  if (binding !== HPO_G_BINDING) {
    throw new GoldenAuthorityShapeError(
      `GOLDEN_JOURNEY_RUNNER.hpo_g_binding is ${binding}, expected ${HPO_G_BINDING}; ` +
        'this skeleton consumes HPO-G-03 specifically and must not silently ' +
        'attach itself to a different binding',
    )
  }

  const runnerName = requireString(runnerRecord['runner'], 'GOLDEN_JOURNEY_RUNNER.runner')
  if (runnerName !== 'Playwright') {
    throw new GoldenAuthorityShapeError(
      `GOLDEN_JOURNEY_RUNNER.runner is ${runnerName}, expected Playwright; ` +
        'a Playwright skeleton must not survive the authority naming a different runner',
    )
  }

  const journeys = runnerRecord['journeys']
  if (!Array.isArray(journeys) || journeys.length === 0) {
    throw new GoldenAuthorityShapeError('GOLDEN_JOURNEY_RUNNER.journeys is absent or empty')
  }

  return journeys.map((entry) => {
    const raw = entry as RawJourney
    const id = requireString(raw.id, 'journey id')
    const rawPath = requireString(raw.path, `journey ${id} path`)
    return {
      id,
      name: requireString(raw.name, `journey ${id} name`),
      rawPath,
      steps: splitJourneyPath(rawPath),
      negativeControlIntent: requireString(
        raw.negative_control_intent,
        `journey ${id} negative_control_intent`,
      ),
      knownUpstreamBlockers: requireStringArray(
        raw.known_upstream_blockers,
        `journey ${id} known_upstream_blockers`,
      ),
    }
  })
}

/** Total number of frozen steps across all journeys. The count that must not drop. */
export function totalFrozenStepCount(journeys: readonly FrozenJourney[]): number {
  return journeys.reduce((sum, journey) => sum + journey.steps.length, 0)
}
