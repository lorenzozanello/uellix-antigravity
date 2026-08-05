// tests/eval/stella-release/local-release-gate.ts
// RELEASE line — local Stella release gate
// (STELLA_RELEASE_RUNTIME_GATE_FOUNDATION_TRAIN_3, Fases 3 and 5).
//
// Fase 3 defines 11 named local gates over the release-eval harness's own
// summary; Fase 5 asks for a focused harness that reduces those gates to 5
// readiness levels (library/integration/local-runtime-ready, plus
// staging/hosted-blocked) and lists EXACTLY what evidence is missing for the
// two blocked levels — never a bare "blocked", always the reason.
//
// This module reads the harness's OWN output (ReleaseEvalRun) and,
// read-only, whether db/prepared/stella_0003_suggestion_decisions.sql exists
// on disk (same discipline as checkCapRegressionSurfacePresent: existence
// only, never executed, never applied). It runs zero SQL, opens zero
// database connections, and calls zero providers.
//
// staging-ready is a claim this module is STRUCTURALLY INCAPABLE of making:
// STELLA_DECISIONS_PERSISTENCE_ENABLED is false in every environment this
// harness can see, and the prepared SQL package for the decisions table has
// never been applied to any database from this worktree. See
// evaluateLocalReleaseGates() — there is no boolean input that flips
// stagingBlocked to false; the only way to change it is to run gate G2 for
// real, outside this harness, which this module cannot do and does not
// pretend to.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { stellaConfig } from '@/lib/stella/config'
import type { ReleaseEvalRun, ReleaseEvalSummary } from './harness'

export type LocalReleaseGateId =
  | 'contract-complete'
  | 'isolation'
  | 'citation-validity'
  | 'unsupported-claims'
  | 'abstention-correctness'
  | 'contradiction-attribution'
  | 'feature-flag-safety'
  | 'decision-provenance'
  | 'no-provider-calls'
  | 'no-secrets'
  | 'determinism'
  | 'runtime-entrypoint'

export interface LocalReleaseGateResult {
  id: LocalReleaseGateId
  passed: boolean
  detail: string
}

/** Checks whose pass/fail together stand for "the human-decision journey step
 *  (accept/reject/rollback + its two failure modes) is honest about what it
 *  measures" — see matrix.ts's train-3 section for what each one covers. */
const DECISION_PROVENANCE_CHECKS = [
  'stella-decision-accepted-contract-valid',
  'stella-decision-rejected-contract-valid',
  'stella-decision-rollback-append-only',
  'stella-decision-persistence-error-non-leaking',
] as const

const CONTRADICTION_ATTRIBUTION_CHECKS = ['contradiction-acknowledgment-heuristic', 'grounding-contradiction-marked'] as const

/** Checks whose passing is this harness's only available evidence that a
 *  secret cannot leak through the presentation or persistence-error paths.
 *  Not a substitute for a real secret scan of the deployed artifact — that is
 *  outside this train's scope (no gates pesados, no remote access). */
const NO_SECRETS_CHECKS = ['provider-unavailable-presentation', 'stella-decision-persistence-error-non-leaking'] as const

function allPassed(summary: ReleaseEvalSummary, results: ReleaseEvalRun['results'], ids: readonly string[]): LocalReleaseGateResult['passed'] {
  const byId = new Map(results.map((r) => [r.checkId, r]))
  return ids.every((id) => byId.get(id)?.ok === true)
}

function metricValue(summary: ReleaseEvalSummary, metric: string): number | null {
  return summary.metrics.find((m) => m.metric === metric)?.value ?? null
}

/**
 * Evaluates the 11 Fase-3 gates against one harness run. `determinism` needs a
 * SECOND independent run of the same matrix to compare against — passing one
 * in is the caller's job (running the harness twice is cheap, ~30ms each, but
 * this module does not decide how many times to run it).
 */
export function evaluateLocalReleaseGates(
  run: ReleaseEvalRun,
  secondRunForDeterminism: ReleaseEvalRun,
  /** Repo root, for the twelfth (train 3) gate's existence checks. */
  root: string = process.cwd(),
): LocalReleaseGateResult[] {
  const { summary, results } = run

  const gates: LocalReleaseGateResult[] = [
    {
      id: 'contract-complete',
      passed: summary.totalChecks === results.length && summary.failed === 0 && summary.tautologicalChecks.length === 0,
      detail: `${summary.totalChecks} checks, ${summary.failed} failed, ${summary.tautologicalChecks.length} tautological (a check that cannot fail proves nothing — see harness.ts withNegativeControls)`,
    },
    {
      id: 'isolation',
      passed: summary.isolationViolations === 0,
      detail: `${summary.isolationViolations} structural cross-tenant/cross-project/prompt-injection leak(s) — application + grounding-contract layer only, never a substitute for RLS/gate G3`,
    },
    {
      id: 'citation-validity',
      passed: summary.citationValidationFailures === 0,
      detail: `${summary.citationValidationFailures} citation validation failure(s) — a citation resolved, drifted, or projected incorrectly`,
    },
    {
      id: 'unsupported-claims',
      passed: metricValue(summary, 'unsupported-claim-rate') === 0,
      detail: `unsupported-claim-rate = ${metricValue(summary, 'unsupported-claim-rate')} (target: 0)`,
    },
    {
      id: 'abstention-correctness',
      passed: metricValue(summary, 'abstention-correctness') === 1,
      detail: `abstention-correctness = ${metricValue(summary, 'abstention-correctness')} (target: 1 — every genuine abstention contract held)`,
    },
    {
      id: 'contradiction-attribution',
      passed: allPassed(summary, results, CONTRADICTION_ATTRIBUTION_CHECKS),
      detail: `${CONTRADICTION_ATTRIBUTION_CHECKS.join(', ')} — heuristic structural check plus the grounding-contract marker check`,
    },
    {
      id: 'feature-flag-safety',
      passed: allPassed(summary, results, ['stella-decision-feature-flag-blocks-persistence']),
      detail: 'STELLA_DECISIONS_PERSISTENCE_ENABLED gate is textually first in recordStellaDecision, before schema validation and the auth check',
    },
    {
      id: 'decision-provenance',
      passed: allPassed(summary, results, DECISION_PROVENANCE_CHECKS),
      detail: `${DECISION_PROVENANCE_CHECKS.join(', ')} — accept/reject/rollback contracts and the persistence-error non-leak invariant`,
    },
    {
      id: 'no-provider-calls',
      passed: summary.providerCalls === 0,
      detail: `providerCalls = ${summary.providerCalls}`,
    },
    {
      id: 'no-secrets',
      passed: allPassed(summary, results, NO_SECRETS_CHECKS),
      detail: `${NO_SECRETS_CHECKS.join(', ')} both pass — not a substitute for a real secret scan of a deployed artifact, which is outside this train's offline scope`,
    },
    {
      id: 'determinism',
      passed: JSON.stringify(secondRunForDeterminism.summary) === JSON.stringify(summary) && JSON.stringify(secondRunForDeterminism.results) === JSON.stringify(results),
      detail: 'two independent runs of the same matrix produce byte-identical summary and results (harness wall-clock excluded from both, by design)',
    },
    // TRAIN 3 — the twelfth gate. See RUNTIME_ENTRYPOINT_MODULES.
    runtimeEntrypointGate(root),
  ]

  return gates
}

/* -------------------------------------------------------------------------- */
/* Runtime entrypoint (train 3)                                               */
/* -------------------------------------------------------------------------- */

/**
 * THE GATE THAT STOPS THIS HARNESS FROM CERTIFYING ITSELF.
 *
 * Every one of the eleven gates above reads the harness's OWN output over the
 * harness's OWN fixtures. All eleven passed for the whole of train 2, when
 * `components/stella/**` had zero call sites and no server action existed at
 * all — so "local-runtime-ready" was true for a system in which no user could
 * reach a single one of the paths being measured. A gate set that cannot tell
 * a library from a running system is not measuring readiness.
 *
 * This one asks a question the fixtures cannot answer: does the seam EXIST on
 * disk, end to end — client contract, server action, repository adapter over
 * the governed SQL surface, and a typed wrapper that binds a server-derived
 * project? Existence only, by path: nothing is imported, nothing is executed,
 * no database is opened and no flag is read for its value here. That is the
 * same discipline as `decisionsPersistencePackageIsPrepared`.
 */
const RUNTIME_ENTRYPOINT_MODULES: readonly (readonly [label: string, relativePath: string])[] = [
  ['client contract', path.posix.join('components', 'stella', 'grounded-query.ts')],
  ['client panel', path.posix.join('components', 'stella', 'StellaGroundedQueryPanel.tsx')],
  ['server action', path.posix.join('app', 'actions', 'stella', 'grounded-query.ts')],
  ['repository adapter', path.posix.join('db', 'grounding', 'grounding-chunk-repository.ts')],
  [
    'server/client wrapper',
    path.posix.join('app', 'app', 'projects', '[projectId]', 'pipeline', 'StellaGroundedQuerySection.tsx'),
  ],
]

export function missingRuntimeEntrypointModules(root: string): string[] {
  return RUNTIME_ENTRYPOINT_MODULES.filter(([, rel]) => !existsSync(path.join(root, rel))).map(
    ([label, rel]) => `${label} missing: ${rel}`,
  )
}

function runtimeEntrypointGate(root: string): LocalReleaseGateResult {
  const missing = missingRuntimeEntrypointModules(root)
  return {
    id: 'runtime-entrypoint',
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${RUNTIME_ENTRYPOINT_MODULES.length} modules of the grounded-query seam exist (existence only — never imported, never executed here)`
        : missing.join('; '),
  }
}

/**
 * Is the seam REACHABLE by a human? Existence is not reachability: an action
 * nothing renders is dead code with tests.
 *
 * Answered by asking whether any `page.tsx` under `app/` names the wrapper.
 * As of train 3 the answer is NO, deliberately — seven pipeline pages each
 * mount Stella under a different `AdvisorPipelineStep`, so there is no single
 * unambiguous surface, and inventing an eighth page would create a second
 * Stella experience. PRODUCT-002 is therefore
 * IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE and this returns the reason
 * rather than a bare false.
 */
const RUNTIME_WRAPPER_SYMBOL = 'StellaGroundedQuerySection'

export function runtimeEntrypointMountReasons(root: string): string[] {
  const pagesDir = path.join(root, 'app')
  if (!existsSync(pagesDir)) return ['app/ not found — cannot determine whether the seam is mounted']

  const mountedIn: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue
        walk(full)
      } else if (entry.name === 'page.tsx' && readFileSync(full, 'utf8').includes(RUNTIME_WRAPPER_SYMBOL)) {
        mountedIn.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  walk(pagesDir)

  return mountedIn.length > 0
    ? []
    : [
        `no page.tsx under app/ renders <${RUNTIME_WRAPPER_SYMBOL}>: the grounded-query seam exists and is typed end to end but no human can reach it — PRODUCT-002 is IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE (seven pipeline steps, no unambiguous canonical surface; integration did not invent an eighth page)`,
      ]
}

export interface LocalReleaseGateReport {
  gates: LocalReleaseGateResult[]
  libraryReady: boolean
  integrationReady: boolean
  localRuntimeReady: boolean
  /** Always true from this module — see the file header. */
  stagingBlocked: true
  /** Always true from this module — see the file header. */
  hostedBlocked: true
  /**
   * TRAIN 3. What stands between `integration-ready` and
   * `local-runtime-ready`. Empty iff `localRuntimeReady` is true — never a
   * bare false, for the same reason `missingForStaging` is never a bare
   * "blocked".
   */
  missingForLocalRuntime: string[]
  missingForStaging: string[]
  missingForHosted: string[]
}

/** Repo-relative path to the prepared (not applied) decisions-persistence
 *  package. Existence-only check — never read for content, never executed,
 *  matching the discipline of checkCapRegressionSurfacePresent. */
const DECISIONS_PERSISTENCE_PACKAGE = path.posix.join('db', 'prepared', 'stella_0003_suggestion_decisions.sql')

/** The two prepared packages the grounded-query repository adapter reads. */
const GROUNDING_PERSISTENCE_PACKAGES: readonly string[] = [
  path.posix.join('db', 'prepared', 'grounding_0002_document_versions.sql'),
  path.posix.join('db', 'prepared', 'grounding_0003_evidence_chunks.sql'),
]

function decisionsPersistencePackageIsPrepared(root: string): boolean {
  return existsSync(path.join(root, DECISIONS_PERSISTENCE_PACKAGE))
}

/**
 * Reduces the 11 gates to the 5 readiness levels Fase 5 asks for, and lists
 * exactly what is missing for the two levels this module can never grant.
 *
 * library-ready       — the eval library itself is internally honest: every
 *                        matrix entry has exactly one check, nothing is
 *                        tautological, zero negative controls went undetected.
 * integration-ready    — library-ready AND zero provider calls AND
 *                        deterministic across runs — matches the "Local
 *                        integration" gate list in RELEASE.md.
 * local-runtime-ready  — integration-ready AND every one of the 11 named
 *                        gates passes — the full offline runtime journey
 *                        (evidence → ingestion/version/chunks → retrieval →
 *                        grounded answer → citations → human decision) is
 *                        verified against everything this harness can see
 *                        without a database or a provider.
 * staging-blocked      — ALWAYS true. Reasons enumerated in missingForStaging.
 * hosted-blocked       — ALWAYS true. Reasons enumerated in missingForHosted.
 */
export function computeLocalReleaseGateReport(
  run: ReleaseEvalRun,
  secondRunForDeterminism: ReleaseEvalRun,
  root: string = process.cwd(),
): LocalReleaseGateReport {
  const gates = evaluateLocalReleaseGates(run, secondRunForDeterminism, root)
  const byId = new Map(gates.map((g) => [g.id, g]))

  const libraryReady =
    (byId.get('contract-complete')?.passed ?? false) &&
    run.summary.negativeControlsUndetected === 0 &&
    run.summary.tautologicalChecks.length === 0

  const integrationReady =
    libraryReady &&
    (byId.get('no-provider-calls')?.passed ?? false) &&
    (byId.get('determinism')?.passed ?? false)

  // TRAIN 3 — local-runtime-ready is NO LONGER derivable from the harness's
  // own gates alone. See runtimeEntrypointGate: eleven fixture-fed gates all
  // passed throughout train 2, when nothing was reachable. A level named
  // "runtime ready" must depend on something outside the fixtures.
  const missingForLocalRuntime: string[] = [
    ...gates.filter((g) => !g.passed).map((g) => `gate ${g.id} failed: ${g.detail}`),
    ...missingRuntimeEntrypointModules(root),
    ...runtimeEntrypointMountReasons(root),
    ...GROUNDING_PERSISTENCE_PACKAGES.filter((rel) => !existsSync(path.join(root, rel))).map(
      (rel) => `${rel} not found — the grounded-query repository adapter reads the surface this package creates`,
    ),
    // Not conditional, and not verifiable from here: this harness opens no
    // database, so it can never observe that a package was applied. Stated as
    // permanently-missing evidence rather than silently assumed satisfied.
    `${GROUNDING_PERSISTENCE_PACKAGES.join(' + ')} exist as PREPARED SQL and have been applied to NO database — until they are, every grounded query returns provider_unavailable. Applying them is a gate this harness cannot run and does not simulate`,
    `no grounded-answer generator exists: app/actions/stella/grounded-query.ts injects a provider that REJECTS by contract, so the seam is exercised end to end but produces no drafted answer (that is gate G1, a real provider round trip)`,
    // Adversarial review, train 3 (reviewer B, #9). checkStellaQuota counts
    // stella_interactions rows, and stella_interactions_stella_role_check
    // admits six roles of which `grounded_query` is not one — so this
    // capability ENFORCES a monthly quota it cannot CONSUME. Not fixable from
    // integration (widening a CHECK is a CAPABILITIES-owned schema change);
    // listed here so the flag cannot be turned on while it is open.
    `quota is enforced but not consumed: stella_interactions has no \`grounded_query\` role (contract INT-CAP-001), so a live grounded query would read the org's monthly quota and never charge it`,
  ]

  const localRuntimeReady = integrationReady && missingForLocalRuntime.length === 0

  const missingForStaging: string[] = [
    ...missingForLocalRuntime,
    `STELLA_GROUNDED_QUERY_ENABLED is ${stellaConfig.isGroundedQueryEnabled} (must reach staging still false; enabling it requires the grounding packages applied first)`,
    `STELLA_DECISIONS_PERSISTENCE_ENABLED is ${stellaConfig.isDecisionsPersistenceEnabled} (must reach staging still false; enabling it is its own gate, never automatic)`,
    decisionsPersistencePackageIsPrepared(root)
      ? `${DECISIONS_PERSISTENCE_PACKAGE} exists as PREPARED SQL but has not been applied to any database — that is gate G2 (docs/ops/gates/G2_PACKAGE.md), owned by CAPABILITIES, not run by this harness`
      : `${DECISIONS_PERSISTENCE_PACKAGE} not found — the persistence package itself would need to exist before G2 could even apply it`,
    'gate G2 (RLS/schema) and gate G3 (RLS policy tests against a live database) have not been executed by this train — no database was opened',
    'no p50/p95 latency or cost-per-interaction budget exists yet — both require gate G1 (a real provider round-trip), which this train makes zero of',
  ]

  const missingForHosted: string[] = [
    ...missingForStaging,
    'gate G1 (real Gemini evaluation, docs/ops/gates/G1_PACKAGE.md) has not been executed or reviewed by Lorenzo',
    'gate G4 (flag activation in Vercel, docs/ops/gates/G4_PACKAGE.md) has not been applied',
    'gate G7 (legal review, docs/ops/gates/G7_PACKAGE.md) has no signed fitness determination on file for this train',
    'RR-CAP-14-A, RR-CAP-10-C, RR-CAP-02-H and RR-CAP-02-I remain OPEN per docs/ops/workstreams/RELEASE.md — none is closed by this train, none is RELEASE\'s to close (db/SQL and functional contracts are out of scope for this line)',
  ]

  return {
    gates,
    libraryReady,
    integrationReady,
    localRuntimeReady,
    stagingBlocked: true,
    hostedBlocked: true,
    missingForLocalRuntime,
    missingForStaging,
    missingForHosted,
  }
}
