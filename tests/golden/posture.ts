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
import ts from 'typescript'
import { REPO_ROOT } from './authority'
import { findModuleReferences } from './import-boundary'
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
  surface: 'app/** application entrypoints wired to the Evaluate domain surface',
  remediationMeaning:
    'an evaluation runtime now exists, so J1 step 12 must be converted from a blocked contract ' +
    'into a positive traversal of the evaluation leg',
}

/**
 * ===========================================================================
 * WHAT FALSIFIES "THE EVALUATION SURFACE HAS NO RUNTIME" (B-4)
 * ===========================================================================
 * R3 read "runtime" as `a route segment named evaluate` OR `lib/evaluate
 * exists`. The second disjunct is wrong, and wrong in the direction that
 * silently CREDITS work that was never done.
 *
 * `EVALUATE_COMMERCIAL_V1_AUTHORITY_v1.0.0.json` defines write-set W-EV-2 as
 * the "Pure scoring and DecisionPolicy engine" over exactly
 * `lib/evaluate/{scoring,decision-policy,divergence,types}.ts`, constrained to
 * "Pure functions only: no db import, no fetch, no Date.now, no Math.random,
 * no process.env". A module that is structurally forbidden from touching the
 * database, the network or the environment cannot be reached by a browser, and
 * J1's own pass criteria require a BROWSER JOURNEY that "traverses ...
 * evaluation". So the arrival of W-EV-2 — which is what landed in integration —
 * falsifies nothing about traversal, yet flipped this probe to REMEDIATED and
 * demanded J1 step 12 be rewritten as a positive traversal of a leg that still
 * cannot be walked.
 *
 * The authority also names what a runtime IS: W-EV-5 "Server actions"
 * (`app/actions/evaluate/**`) is the execution surface, and W-EV-6 "UI read
 * model" is explicitly ordered "After W-EV-5" — the UI is downstream of the
 * runtime, not a substitute for it.
 *
 * So the minimum repository fact that falsifies the blocker is a CONJUNCTION:
 *
 *   1. an application/runtime ENTRYPOINT the running app executes on request
 *      — a server action, a route handler, or a routable page; AND
 *   2. a PRODUCTION LINKAGE from that entrypoint to the Evaluate domain
 *      surface — it actually references the engine or the Evaluate actions.
 *
 * Either half alone is exactly the false signal B-4 names: a pure engine with
 * nothing in front of it, or an entrypoint that merely has "evaluate" in its
 * name. Both halves are read from SYNTAX (module specifiers, directive
 * prologues, export names), never from a path substring, so an unrelated
 * action called `evaluateProxyRubric` and a comment mentioning the engine
 * cannot vote.
 */

/** Files whose content must never vote: tests describe a runtime, they are not one. */
function isTestPath(path: string): boolean {
  return /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
}

/**
 * Does this module specifier name the Evaluate PRODUCTION surface?
 *
 * Matches the engine (W-EV-2) and the Evaluate server-action group (W-EV-5),
 * through the repository's `@/` alias, a bare path, or a relative path.
 */
export function isEvaluateDomainModule(specifier: string): boolean {
  const normalized = specifier.replace(/\\/g, '/').replace(/^@\//, '')
  return (
    /(^|\/)lib\/(evaluate|evaluation)(\/|$)/.test(normalized) ||
    /(^|\/)app\/actions\/(evaluate|evaluation)(\/|$)/.test(normalized)
  )
}

export type EvaluateEntrypointKind = 'server-action' | 'route-handler' | 'page'

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind) : false
}

/** A `'use server'` directive prologue, at file level or opening a function body. */
function hasUseServerDirective(sourceFile: ts.SourceFile): boolean {
  const prologueHasUseServer = (statements: readonly ts.Statement[]): boolean => {
    for (const statement of statements) {
      // A directive prologue is a RUN of leading string-literal expression
      // statements. The first statement that is anything else ends it, so a
      // `'use server'` sitting further down the file is ordinary dead string
      // data and is correctly not counted.
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteralLike(statement.expression)) return false
      if (statement.expression.text === 'use server') return true
    }
    return false
  }

  if (prologueHasUseServer(sourceFile.statements)) return true

  // Next.js also allows an INLINE server action: a function whose own body
  // opens with the directive. A page or component carrying one is a real
  // execution surface, so the whole tree is walked, not just the file head.
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isBlock(node) && prologueHasUseServer(node.statements)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

function exportsHttpVerb(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name && HTTP_VERBS.has(statement.name.text)) return true
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && HTTP_VERBS.has(declaration.name.text)) return true
      }
    }
  }
  return false
}

function hasDefaultExport(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return true
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) return true
  }
  return false
}

/**
 * The application/runtime entrypoint kind of a file, or `null` if the running
 * application never executes it on request.
 *
 * Only files under `app/` can qualify: that is the application boundary in
 * this repository. A module under `lib/` is library code by construction —
 * which is the whole of B-4.
 */
export function evaluateEntrypointKind(path: string, content: string): EvaluateEntrypointKind | null {
  const normalized = path.replace(/\\/g, '/')
  if (!/^app\//.test(normalized) || isTestPath(normalized)) return null

  const sourceFile = ts.createSourceFile(
    normalized,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    /\.tsx$/i.test(normalized) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  if (hasUseServerDirective(sourceFile)) return 'server-action'
  if (/(^|\/)route\.[cm]?tsx?$/i.test(normalized) && exportsHttpVerb(sourceFile)) return 'route-handler'
  if (/(^|\/)page\.[cm]?tsx?$/i.test(normalized) && hasDefaultExport(sourceFile)) return 'page'
  return null
}

/**
 * Does this file actually reach the Evaluate production surface?
 *
 * Read from module specifiers via the shared syntax-aware walk, so a mention
 * in a comment or a string cannot vote, and a type-only import — which erases
 * at compile time and wires nothing — does not count as a runtime linkage.
 */
export function hasEvaluateProductionLinkage(path: string, content: string): boolean {
  return findModuleReferences(path, content).some(
    (reference) => !reference.typeOnly && isEvaluateDomainModule(reference.specifier),
  )
}

export interface EvaluateRuntimeFile {
  /** Repository-relative path, forward slashes. */
  readonly path: string
  readonly content: string
}

/** The files that are BOTH an application entrypoint AND wired to Evaluate. */
export function findTraversableEvaluateRuntime(
  files: readonly EvaluateRuntimeFile[],
): readonly string[] {
  return files
    .filter(({ path }) => !isTestPath(path.replace(/\\/g, '/')))
    .filter(
      ({ path, content }) =>
        evaluateEntrypointKind(path, content) !== null && hasEvaluateProductionLinkage(path, content),
    )
    .map(({ path }) => path.replace(/\\/g, '/'))
}

/** True while there is no TRAVERSABLE evaluation runtime. */
export function detectNoEvaluateRuntime(files: readonly EvaluateRuntimeFile[]): boolean {
  return findTraversableEvaluateRuntime(files).length === 0
}

/** Every `.ts`/`.tsx` source under `app/`, as (path, content). */
export function collectAppSourceFiles(): readonly EvaluateRuntimeFile[] {
  const files: EvaluateRuntimeFile[] = []
  const walk = (dir: string, relative: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childRelative = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(join(dir, entry.name), childRelative)
      } else if (/\.tsx?$/i.test(entry.name) && !isTestPath(childRelative)) {
        files.push({ path: childRelative, content: readFileSync(join(dir, entry.name), 'utf8') })
      }
    }
  }
  walk(join(REPO_ROOT, 'app'), 'app')
  return files
}

export function probeNoEvaluateRuntime(): PostureReading {
  const runtimeFiles = findTraversableEvaluateRuntime(collectAppSourceFiles())
  const present = runtimeFiles.length === 0
  // Recorded for the evidence string only. The engine's PRESENCE is precisely
  // what must not decide this probe, so it is reported and not counted.
  const pureEngineExists =
    existsSync(join(REPO_ROOT, 'lib', 'evaluate')) || existsSync(join(REPO_ROOT, 'lib', 'evaluation'))
  return {
    probe: PROBE_J1_NO_EVALUATE_RUNTIME,
    blockerStillPresent: present,
    evidence: present
      ? `no app/** entrypoint (server action, route handler or page) is wired to the Evaluate domain surface ` +
        `(pure lib/evaluate engine present: ${pureEngineExists} — a W-EV-2 pure engine is not a traversable runtime)`
      : `an evaluation runtime now exists and is reachable: ${runtimeFiles.join(', ')}`,
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
