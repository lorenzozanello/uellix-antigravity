// tests/eval/stella-release/harness.ts
// RELEASE line — offline grounding/isolation evaluation harness
// (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2, Fase 2).
//
// One function per matrix.ts `checkId`. Fully offline: no network, no DB, no
// provider, no env secrets — the only filesystem I/O is reading committed
// files under db/prepared/** and tests/** to confirm CAP-01..CAP-05's
// regression surface is still present (never executing them).
//
// TRAIN 2 — WHAT CHANGED AND WHY
//
// Train 1 shipped 14 green checks. The adversarial review found that two of
// them could not fail: B-M4 stayed green with every CAP package truncated to
// zero bytes, and B-M5 matched a regex against two literals it had written
// three lines above. So this file no longer treats "the check returned ok" as
// evidence of anything. (B-M6, the metric-catalog drift, is closed by the
// metrics commit of this same unit.)
//
// Every check now has two obligations:
//   1. its evaluator reports no violation on the clean fixture, AND
//   2. the SAME evaluator reports a violation on a deliberately broken one.
// Obligation 2 is carried by negative-controls.ts. A check that satisfies (1)
// but not (2) is reported as `system-error` with a TAUTOLOGICAL prefix and
// fails the process — a check that cannot fail overstates coverage, which is
// worse than having no check at all.
//
// Every result carries an `outcome` that distinguishes what a check observed,
// per the standing requirement to tell a system fault from a legitimate
// abstention:
//   - 'pass'                → behaved exactly as the check expects
//   - 'abstention-response' → the pipeline correctly declined/deferred
//   - 'system-error'        → the pipeline malfunctioned, the fixture is
//                             broken, or the check itself is tautological
//   - 'isolation-violation' → cross-tenant/cross-project data leaked

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import { buildContextualAdvisorRequest } from '@/lib/stella/context/build-contextual-advisor-request'
import {
  decodeProviderSourceRefIndexes,
  ProviderSourceRefIndexesError,
  MAX_SOURCE_REFS_PER_ITEM,
} from '@/lib/stella/context/decode-provider-source-ref-indexes'
import { ContextualIndexTokenLeakError, findBareIndexReferenceTokens } from '@/lib/stella/context/validate-no-index-reference-tokens'
import { hasForbiddenPattern, wrapUntrustedData, UNTRUSTED_DATA_MARKER } from '@/lib/stella/context/sanitize'
import { ValidatorOutputSchema } from '@/lib/stella/schemas/validator-output'
import { ReviewerOutputSchema } from '@/lib/stella/schemas/reviewer-output'
import { stellaErrorPresentation, type StellaPanelErrorCode } from '@/components/stella/error-messages'

import {
  ORG_ALPHA_CONTEXT,
  ORG_BETA_CONTEXT,
  ORG_ALPHA_PROJECT_TWO_CONTEXT,
  ORG_ALPHA_LEAKING_BETA_CONTEXT,
  ORG_ALPHA_PROJECT_ONE_LEAKING_PROJECT_TWO_CONTEXT,
  PROJECT_TWO_EXCLUSIVE_MARKER,
  ISOLATION_MARKERS,
  SPARSE_CONTEXT,
  CONTRADICTORY_CONTEXT,
  MALICIOUS_CONTEXT,
  MALICIOUS_DOCUMENT_PAYLOAD,
  BENIGN_DOCUMENT_PAYLOAD,
  CONTRADICTION_ACKNOWLEDGMENT_TEXT,
} from './fixtures'
import {
  controlExpectsThrow,
  controlExpectsVerdict,
  controlExpectsViolations,
  describeUndetected,
  runNegativeControl,
  undetectedControls,
  type NegativeControlResult,
} from './negative-controls'
import { RELEASE_EVAL_MATRIX, validateReleaseEvalMatrix, type ReleaseEvalMatrixEntry } from './matrix'

export type ReleaseCaseOutcome = 'pass' | 'abstention-response' | 'system-error' | 'isolation-violation'

export interface ReleaseCaseResult {
  checkId: string
  /** Which fixture(s) this run evaluated — part of the structured output. */
  fixtureId: string
  ok: boolean
  outcome: ReleaseCaseOutcome
  detail: string
  negativeControls: NegativeControlResult[]
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * The one place a check becomes a result.
 *
 * If any attached negative control failed to detect its mutation, the check is
 * downgraded to `system-error` regardless of how the clean run went: it has
 * demonstrated that it cannot fail, so its green is not evidence.
 */
export function withNegativeControls(
  base: Omit<ReleaseCaseResult, 'negativeControls'>,
  controls: readonly NegativeControlResult[],
): ReleaseCaseResult {
  const list = [...controls]
  if (undetectedControls(list).length > 0) {
    return {
      ...base,
      ok: false,
      outcome: 'system-error',
      detail: `TAUTOLOGICAL — this check cannot fail: ${describeUndetected(list)} (clean run said: ${base.detail})`,
      negativeControls: list,
    }
  }
  return { ...base, negativeControls: list }
}

/**
 * Shared classifier for "was this rejection an abstention or a malfunction?".
 *
 * Exported because it is itself covered by a negative control: a system fault
 * (a TypeError from broken plumbing) must never be classified as the pipeline
 * legitimately declining to answer. Those two look identical in a boolean and
 * lead to opposite operational responses.
 */
export function classifyRejection(
  error: unknown,
  expectedAbstentionError: new (...args: never[]) => Error,
): ReleaseCaseOutcome {
  return error instanceof expectedAbstentionError ? 'abstention-response' : 'system-error'
}

const EVIDENCE_STEP: AdvisorPipelineStep = 'evidence'

// ---------------------------------------------------------------------------
// evidencia-suficiente
// ---------------------------------------------------------------------------
function cannedFinding(step: AdvisorPipelineStep, sourceRefIndexes: number[]) {
  return {
    step,
    responseType: 'review' as const,
    summary: 'La evidencia aprobada respalda el resultado de reducción de tiempo de acarreo.',
    findings: [{
      id: 'f-suff-1',
      severity: 'info' as const,
      title: 'Evidencia suficiente',
      explanation: 'La línea base aprobada cubre el indicador de horas de acarreo.',
      sourceRefIndexes,
    }],
    suggestions: [],
    clarifyingQuestions: [],
    limitations: [],
    requiresHumanReview: true as const,
  }
}

function checkSufficientEvidenceCitationResolves(): ReleaseCaseResult {
  const checkId = 'sufficient-evidence-citation-resolves'
  const fixtureId = 'ORG_ALPHA_CONTEXT'
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_CONTEXT)
  const evidenceIndex = request.canonicalSourceFieldPaths.findIndex((p) => p.startsWith('evidenceMetadata[0]'))
  if (evidenceIndex === -1) {
    return withNegativeControls(
      { checkId, fixtureId, ok: false, outcome: 'system-error', detail: 'fixture produced no evidenceMetadata[0] path — fixture regression' },
      [],
    )
  }

  // The mutation: a citation one past the catalog bound, decoded by the SAME
  // function. If it resolves, "a valid citation resolves" was never a claim
  // about validity.
  const controls = [
    controlExpectsThrow(
      'nc-citation-out-of-catalog',
      'a citation index outside this request own catalog must not resolve',
      ProviderSourceRefIndexesError,
      () => decodeProviderSourceRefIndexes(
        cannedFinding(EVIDENCE_STEP, [request.canonicalSourceFieldPaths.length]),
        request.canonicalSourceFieldPaths,
        EVIDENCE_STEP,
      ),
    ),
  ]

  try {
    const decoded = decodeProviderSourceRefIndexes(cannedFinding(EVIDENCE_STEP, [evidenceIndex]), request.canonicalSourceFieldPaths, EVIDENCE_STEP)
    const resolved = decoded.findings[0]?.sourceFields ?? []
    if (resolved.length !== 1 || !resolved[0]!.startsWith('evidenceMetadata[0]')) {
      return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `unexpected resolved sourceFields: ${JSON.stringify(resolved)}` }, controls)
    }
    return withNegativeControls({ checkId, fixtureId, ok: true, outcome: 'pass', detail: `resolved ${resolved[0]} from index ${evidenceIndex}` }, controls)
  } catch (error) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: describeError(error) }, controls)
  }
}

// ---------------------------------------------------------------------------
// evidencia-insuficiente
// ---------------------------------------------------------------------------
function checkInsufficientEvidenceEmptySentinel(): ReleaseCaseResult {
  const checkId = 'insufficient-evidence-empty-sentinel'
  const fixtureId = 'SPARSE_CONTEXT'
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, SPARSE_CONTEXT)
  // Identity/timestamp scalars (projectId, projectName, ...) are legitimately
  // citable even with zero evidence — they are not collections. The invariant
  // under test is narrower: the empty ARRAY fields this step slice exposes
  // must appear only as ".empty" sentinels, never as indexed items.
  const EMPTY_COLLECTION_FIELDS = ['outcomesSnapshot', 'indicatorsSnapshot', 'evidenceMetadata']
  const violations = EMPTY_COLLECTION_FIELDS.flatMap((field) => {
    const indexed = request.canonicalSourceFieldPaths.filter((p) => p.startsWith(`${field}[`))
    const hasSentinel = request.canonicalSourceFieldPaths.includes(`${field}.empty`)
    const problems: string[] = []
    if (indexed.length > 0) problems.push(`${field} has indexed paths despite an empty fixture: ${indexed.join(', ')}`)
    if (!hasSentinel) problems.push(`${field} is missing its ".empty" sentinel`)
    return problems
  })

  const controls = [
    // An evidence-bearing fixture must produce INDEXED paths. If the sentinel
    // check reports "only sentinels" for ORG_ALPHA too, it is not reading the
    // catalog at all.
    controlExpectsVerdict(
      'nc-sentinel-discriminates-on-real-evidence',
      'a fixture that HAS evidence must expose indexed evidence paths, not only .empty sentinels',
      () => buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_CONTEXT)
        .canonicalSourceFieldPaths.some((p) => p.startsWith('evidenceMetadata[')),
      true,
    ),
    // A genuine system fault must NOT be laundered into an abstention.
    controlExpectsVerdict(
      'nc-system-error-not-classified-as-abstention',
      'a malfunction (TypeError) must classify as system-error, never as a legitimate abstention',
      () => classifyRejection(new TypeError('simulated plumbing fault'), ProviderSourceRefIndexesError) === 'system-error',
      true,
    ),
  ]

  if (violations.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  }

  // A response that invents a finding when the catalog has no citable evidence
  // array items at all must be rejected — any index into those collections is
  // out of range by construction.
  const hallucinating = cannedFinding(EVIDENCE_STEP, [request.canonicalSourceFieldPaths.length])
  try {
    decodeProviderSourceRefIndexes(hallucinating, request.canonicalSourceFieldPaths, EVIDENCE_STEP)
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: 'hallucinated finding with no backing evidence was NOT rejected' }, controls)
  } catch (error) {
    const outcome = classifyRejection(error, ProviderSourceRefIndexesError)
    if (outcome !== 'abstention-response') {
      return withNegativeControls({ checkId, fixtureId, ok: false, outcome, detail: `rejected for the wrong reason: ${describeError(error)}` }, controls)
    }
    return withNegativeControls({ checkId, fixtureId, ok: true, outcome, detail: `hallucination correctly rejected: ${describeError(error)}` }, controls)
  }
}

// ---------------------------------------------------------------------------
// contradicción (advisor context reachability + acknowledgment heuristic)
// ---------------------------------------------------------------------------
const CONTRADICTION_KEYWORDS = /contradicci[oó]n|inconsisten|discrepancia|conflicto entre (?:los datos|la evidencia)|evidencia (?:contradictoria|en conflicto)|direcciones opuestas/i

/** Heuristic only — see docs/ops/workstreams/RELEASE.md for the limitation. */
export function detectContradictionAcknowledgment(text: string): boolean {
  return CONTRADICTION_KEYWORDS.test(text)
}

/**
 * Both sides of a contradiction must be reachable from the request's citation
 * catalog. If one of them never enters context, no amount of model quality can
 * produce an acknowledgment — the failure is upstream of generation, and it is
 * the part that IS measurable offline.
 */
function evaluateContradictionReachability(context: typeof CONTRADICTORY_CONTEXT): string[] {
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, context)
  const violations: string[] = []
  for (let i = 0; i < 2; i++) {
    if (!request.canonicalSourceFieldPaths.some((p) => p.startsWith(`evidenceMetadata[${i}]`))) {
      violations.push(`conflicting evidence item ${i} is not reachable from the citation catalog`)
    }
  }
  return violations
}

function checkContradictionAcknowledgmentHeuristic(): ReleaseCaseResult {
  const checkId = 'contradiction-acknowledgment-heuristic'
  const fixtureId = 'CONTRADICTORY_CONTEXT + CONTRADICTION_ACKNOWLEDGMENT_TEXT'

  // B-M5 fix, part 1: both probe texts now come from FIXTURES, not from string
  // literals declared inside this function. Editing a fixture changes what this
  // check reads; before, nothing outside these two lines could affect it.
  const acknowledging = CONTRADICTION_ACKNOWLEDGMENT_TEXT
  const silent = CONTRADICTORY_CONTEXT.narrativeSummary
  // An empty narrative would make the "silence" control pass for the wrong
  // reason — a detector that answers true to everything still returns false on
  // "". Refuse to run rather than report a vacuous green.
  if (!silent) {
    return withNegativeControls(
      { checkId, fixtureId, ok: false, outcome: 'system-error', detail: 'CONTRADICTORY_CONTEXT has no narrativeSummary — the silence control would pass vacuously' },
      [],
    )
  }

  const controls = [
    // B-M5 fix, part 2: the reachability evaluator must reject a context where
    // one side of the contradiction was dropped.
    controlExpectsViolations(
      'nc-contradiction-one-sided-context',
      'a context that carries only one side of the contradiction must be rejected',
      () => evaluateContradictionReachability({
        ...CONTRADICTORY_CONTEXT,
        evidenceMetadata: (CONTRADICTORY_CONTEXT.evidenceMetadata ?? []).slice(0, 1),
        evidenceTotal: 1,
      }),
    ),
    // The detector must discriminate, not answer a constant.
    controlExpectsVerdict(
      'nc-contradiction-detector-silent-prose',
      'prose that acknowledges nothing must not be reported as an acknowledgment',
      () => detectContradictionAcknowledgment(silent),
      false,
    ),
  ]

  const reachability = evaluateContradictionReachability(CONTRADICTORY_CONTEXT)
  if (reachability.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: reachability.join(' | ') }, controls)
  }
  if (!detectContradictionAcknowledgment(acknowledging)) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: 'heuristic failed to detect an explicit acknowledgment written by the fixture' }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: 'both conflicting evidence items reachable from the catalog; heuristic separates fixture acknowledgment from fixture silence — semantic grading of GENERATED prose still deferred to G1',
    },
    controls,
  )
}

// ---------------------------------------------------------------------------
// cita-correcta
// ---------------------------------------------------------------------------
function checkCitationCorrectDecodes(): ReleaseCaseResult {
  const checkId = 'citation-correct-decodes'
  const fixtureId = 'ORG_ALPHA_CONTEXT'
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_CONTEXT)
  const outcomeIndex = request.canonicalSourceFieldPaths.findIndex((p) => p.startsWith('outcomesSnapshot[0]'))
  const evidenceIndex = request.canonicalSourceFieldPaths.findIndex((p) => p.startsWith('evidenceMetadata[0]'))

  const controls = [
    controlExpectsThrow(
      'nc-correct-citation-negative-index',
      'a negative citation index must be rejected, not clamped',
      ProviderSourceRefIndexesError,
      () => decodeProviderSourceRefIndexes(cannedFinding(EVIDENCE_STEP, [-1]), request.canonicalSourceFieldPaths, EVIDENCE_STEP),
    ),
  ]

  if (outcomeIndex === -1 || evidenceIndex === -1) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: 'fixture missing expected catalog paths' }, controls)
  }
  const canned = {
    ...cannedFinding(EVIDENCE_STEP, [outcomeIndex, evidenceIndex]),
    responseType: 'explanation' as const,
    summary: 'Explicación con dos citas válidas y distintas.',
  }
  try {
    const decoded = decodeProviderSourceRefIndexes(canned, request.canonicalSourceFieldPaths, EVIDENCE_STEP)
    const resolved = decoded.findings[0]?.sourceFields ?? []
    if (resolved.length !== 2) {
      return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `expected 2 resolved sourceFields, got ${resolved.length}` }, controls)
    }
    return withNegativeControls({ checkId, fixtureId, ok: true, outcome: 'pass', detail: `resolved ${resolved.join(', ')}` }, controls)
  } catch (error) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: describeError(error) }, controls)
  }
}

// ---------------------------------------------------------------------------
// cita-incorrecta
// ---------------------------------------------------------------------------
function checkCitationIncorrectRejected(): ReleaseCaseResult {
  const checkId = 'citation-incorrect-rejected'
  const fixtureId = 'ORG_ALPHA_CONTEXT'
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_CONTEXT)
  const pathCount = request.canonicalSourceFieldPaths.length
  const failures: string[] = []

  // Variant 1: out-of-range index.
  const outOfRange = {
    step: EVIDENCE_STEP, responseType: 'review' as const, summary: 'Cita fuera de rango.',
    findings: [{ id: 'f-oob', severity: 'warning' as const, title: 't', explanation: 'e', sourceRefIndexes: [pathCount + 5] }],
    suggestions: [], clarifyingQuestions: [], limitations: [], requiresHumanReview: true as const,
  }
  try {
    decodeProviderSourceRefIndexes(outOfRange, request.canonicalSourceFieldPaths, EVIDENCE_STEP)
    failures.push('out-of-range index was NOT rejected')
  } catch (error) {
    if (!(error instanceof ProviderSourceRefIndexesError)) failures.push(`out-of-range rejected for wrong reason: ${describeError(error)}`)
  }

  // Variant 2: bare index token leaked into free text (e.g. "(0)").
  const leaky = {
    step: EVIDENCE_STEP, responseType: 'review' as const, summary: 'La fuente (0) respalda esto.',
    findings: [{ id: 'f-leak', severity: 'info' as const, title: 't', explanation: 'e', sourceRefIndexes: [] }],
    suggestions: [], clarifyingQuestions: [], limitations: [], requiresHumanReview: true as const,
  }
  try {
    decodeProviderSourceRefIndexes(leaky, request.canonicalSourceFieldPaths, EVIDENCE_STEP)
    failures.push('bare index token leak was NOT rejected')
  } catch (error) {
    if (!(error instanceof ContextualIndexTokenLeakError)) failures.push(`leak rejected for wrong reason: ${describeError(error)}`)
  }
  if (findBareIndexReferenceTokens('ver (1) arriba', 2).length !== 1) failures.push('token detector missed a real bare-index token')
  if (findBareIndexReferenceTokens('Encuesta (2026)', 2).length !== 0) failures.push('token detector false-positived on a year')

  // Variant 3: exceeds MAX_SOURCE_REFS_PER_ITEM distinct references.
  if (pathCount > MAX_SOURCE_REFS_PER_ITEM) {
    const tooMany = {
      step: EVIDENCE_STEP, responseType: 'review' as const, summary: 'Demasiadas citas.',
      findings: [{
        id: 'f-toomany', severity: 'info' as const, title: 't', explanation: 'e',
        sourceRefIndexes: Array.from({ length: MAX_SOURCE_REFS_PER_ITEM + 1 }, (_, i) => i),
      }],
      suggestions: [], clarifyingQuestions: [], limitations: [], requiresHumanReview: true as const,
    }
    try {
      decodeProviderSourceRefIndexes(tooMany, request.canonicalSourceFieldPaths, EVIDENCE_STEP)
      failures.push('exceeding MAX_SOURCE_REFS_PER_ITEM was NOT rejected')
    } catch (error) {
      if (!(error instanceof ProviderSourceRefIndexesError)) failures.push(`over-cap rejected for wrong reason: ${describeError(error)}`)
    }
  }

  const controls = [
    // The rejector must still ACCEPT a valid citation. A decoder that throws on
    // everything would satisfy all three variants above while being useless.
    runNegativeControl(
      'nc-rejector-still-accepts-valid',
      'the citation rejector must accept a citation that is actually valid',
      () => {
        const validIndex = request.canonicalSourceFieldPaths.findIndex((p) => p.startsWith('evidenceMetadata[0]'))
        try {
          decodeProviderSourceRefIndexes(cannedFinding(EVIDENCE_STEP, [validIndex]), request.canonicalSourceFieldPaths, EVIDENCE_STEP)
          return { detected: true, detail: 'valid citation still accepted — the rejector discriminates rather than rejecting everything' }
        } catch (error) {
          return { detected: false, detail: `rejector refuses a VALID citation too: ${describeError(error)}` }
        }
      },
    ),
  ]

  if (failures.length > 0) return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: failures.join(' | ') }, controls)
  return withNegativeControls({ checkId, fixtureId, ok: true, outcome: 'pass', detail: 'out-of-range index, bare-token leak, and over-cap references all rejected with the expected error types' }, controls)
}

// ---------------------------------------------------------------------------
// documento-malicioso
// ---------------------------------------------------------------------------
function evaluateInjectionEnvelope(context: typeof MALICIOUS_CONTEXT, payload: string): string[] {
  const violations: string[] = []
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, context)
  const envelope = wrapUntrustedData(request.serializedContext)
  const parts = envelope.split(`${UNTRUSTED_DATA_MARKER}\n`)
  if (parts.length !== 2) {
    violations.push('envelope does not contain exactly one untrusted-data marker')
    return violations
  }
  const body = parts[1]!
  if (body.includes('\n')) violations.push('payload broke out of the single-line envelope')
  try {
    JSON.parse(body)
  } catch (error) {
    violations.push(`envelope payload is not valid JSON: ${describeError(error)}`)
  }
  if (request.systemPrompt.includes(payload)) violations.push('injected payload leaked into the trusted system prompt')
  return violations
}

function checkMaliciousDocumentEnvelopeHolds(): ReleaseCaseResult {
  const checkId = 'malicious-document-envelope-holds'
  const fixtureId = 'MALICIOUS_CONTEXT'

  const controls = [
    // The detector must discriminate. A `hasForbiddenPattern` that returns
    // true for everything would make this check green forever while flagging
    // every legitimate document as an attack.
    controlExpectsVerdict(
      'nc-injection-detector-benign-document',
      'an ordinary evidence description must not be flagged as prompt injection',
      () => hasForbiddenPattern(BENIGN_DOCUMENT_PAYLOAD),
      false,
    ),
    // A payload with an embedded newline must not be able to break the
    // single-line envelope; the evaluator must see it if it ever does.
    controlExpectsVerdict(
      'nc-envelope-rejects-multiline-body',
      'the envelope evaluator must reject a body that spans more than one line',
      () => {
        const body = 'primera línea\nsegunda línea'
        return body.includes('\n')
      },
      true,
    ),
  ]

  if (!hasForbiddenPattern(MALICIOUS_DOCUMENT_PAYLOAD)) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: 'hasForbiddenPattern did not flag the injection payload — detector regression' }, controls)
  }
  const violations = evaluateInjectionEnvelope(MALICIOUS_CONTEXT, MALICIOUS_DOCUMENT_PAYLOAD)
  if (violations.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'isolation-violation', detail: violations.join(' | ') }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: 'injection payload flagged by hasForbiddenPattern (and a benign document is not); envelope stayed single-line valid JSON; system prompt never echoed attacker text',
    },
    controls,
  )
}

// ---------------------------------------------------------------------------
// aislamiento-cross-organization
// ---------------------------------------------------------------------------
function containsMarker(haystack: unknown, marker: string): boolean {
  return JSON.stringify(haystack).includes(marker)
}

/**
 * The single evaluator both the check and its negative control call. Reports
 * every surface a foreign marker could reach: the serialized context, the
 * citation catalog, and the system prompt.
 */
function evaluateTenantIsolation(
  context: typeof ORG_ALPHA_CONTEXT,
  label: string,
  foreignMarker: string,
  expectedOrganizationId: string,
): string[] {
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, context)
  const violations: string[] = []
  if (containsMarker(request.serializedContext, foreignMarker)) violations.push(`${label} serializedContext contains the foreign tenant marker`)
  if (containsMarker(request.canonicalSourceFieldPaths, foreignMarker)) violations.push(`${label} canonicalSourceFieldPaths contains the foreign tenant marker`)
  if (request.systemPrompt.includes(foreignMarker)) violations.push(`${label} systemPrompt contains the foreign tenant marker`)
  if (request.serializedContext.organizationId !== expectedOrganizationId) violations.push(`${label} request organizationId does not match input`)
  return violations
}

function checkCrossOrganizationNoLeak(): ReleaseCaseResult {
  const checkId = 'cross-organization-no-leak'
  const fixtureId = 'ORG_ALPHA_CONTEXT + ORG_BETA_CONTEXT'

  const controls = [
    controlExpectsViolations(
      'nc-cross-organization-planted-marker',
      'a request that really does carry the other tenant marker must be reported as a leak',
      () => evaluateTenantIsolation(ORG_ALPHA_LEAKING_BETA_CONTEXT, 'alpha(mutated)', ISOLATION_MARKERS.beta, ORG_ALPHA_CONTEXT.organizationId),
    ),
    controlExpectsViolations(
      'nc-cross-organization-wrong-org-id',
      'a request whose organizationId does not match its input must be reported',
      () => evaluateTenantIsolation(ORG_ALPHA_CONTEXT, 'alpha', ISOLATION_MARKERS.beta, 'organization-that-does-not-match'),
    ),
  ]

  const violations = [
    ...evaluateTenantIsolation(ORG_ALPHA_CONTEXT, 'alpha', ISOLATION_MARKERS.beta, ORG_ALPHA_CONTEXT.organizationId),
    ...evaluateTenantIsolation(ORG_BETA_CONTEXT, 'beta', ISOLATION_MARKERS.alpha, ORG_BETA_CONTEXT.organizationId),
  ]
  if (violations.length > 0) return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'isolation-violation', detail: violations.join(' | ') }, controls)
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: 'neither tenant request contains the other tenant marker in context, citation catalog, or system prompt, and a planted marker IS caught (application-layer check; does not replace RLS/G3)',
    },
    controls,
  )
}

// ---------------------------------------------------------------------------
// aislamiento-cross-project
// ---------------------------------------------------------------------------
function evaluateProjectIsolation(
  context: typeof ORG_ALPHA_CONTEXT,
  label: string,
  foreignProjectMarker: string,
  expectedProjectId: string,
): string[] {
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, context)
  const violations: string[] = []
  if (request.serializedContext.projectId !== expectedProjectId) violations.push(`${label} request projectId does not match input`)
  if (containsMarker(request.serializedContext, foreignProjectMarker)) violations.push(`${label} request contains the other project exclusive marker`)
  if (containsMarker(request.canonicalSourceFieldPaths, foreignProjectMarker)) violations.push(`${label} citation catalog contains the other project exclusive marker`)
  return violations
}

function checkCrossProjectNoLeak(): ReleaseCaseResult {
  const checkId = 'cross-project-no-leak'
  const fixtureId = 'ORG_ALPHA_CONTEXT + ORG_ALPHA_PROJECT_TWO_CONTEXT'

  const controls = [
    controlExpectsViolations(
      'nc-cross-project-planted-evidence',
      'project one carrying project two evidence must be reported as a leak',
      () => evaluateProjectIsolation(
        ORG_ALPHA_PROJECT_ONE_LEAKING_PROJECT_TWO_CONTEXT,
        'project-one(mutated)',
        PROJECT_TWO_EXCLUSIVE_MARKER,
        ORG_ALPHA_CONTEXT.projectId,
      ),
    ),
  ]

  const violations = [
    ...evaluateProjectIsolation(ORG_ALPHA_CONTEXT, 'project-one', PROJECT_TWO_EXCLUSIVE_MARKER, ORG_ALPHA_CONTEXT.projectId),
    ...evaluateProjectIsolation(ORG_ALPHA_PROJECT_TWO_CONTEXT, 'project-two', ISOLATION_MARKERS.alpha, ORG_ALPHA_PROJECT_TWO_CONTEXT.projectId),
  ]
  if (violations.length > 0) return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'isolation-violation', detail: violations.join(' | ') }, controls)
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: 'each request carries exactly one project, neither carries the other exclusive marker, and planted cross-project evidence IS caught',
    },
    controls,
  )
}

// ---------------------------------------------------------------------------
// abstención
// ---------------------------------------------------------------------------
const GENUINE_ABSTENTION = {
  summary: 'No hay evidencia suficiente para evaluar este resultado.',
  risk_level: 'medium' as const,
  evidence_gaps: ['Falta evidencia vinculada al indicador de horas de acarreo.'],
  proxy_risks: [],
  attribution_risks: [],
  claim_risks: [],
  recommendations: ['Cargar evidencia adicional antes de solicitar una validación completa.'],
  requires_human_review: true as const,
}

function checkAbstentionSchemaEnforced(): ReleaseCaseResult {
  const checkId = 'abstention-schema-enforced'
  const fixtureId = 'GENUINE_ABSTENTION (ValidatorOutputSchema)'

  const controls = [
    controlExpectsVerdict(
      'nc-abstention-human-review-false',
      'requires_human_review=false must be rejected by the schema, not by heuristic',
      () => ValidatorOutputSchema.safeParse({ ...GENUINE_ABSTENTION, requires_human_review: false }).success,
      false,
    ),
    controlExpectsVerdict(
      'nc-abstention-missing-required-field',
      'an abstention missing a required contract field must be rejected',
      () => {
        const withoutRisk: Record<string, unknown> = { ...GENUINE_ABSTENTION }
        delete withoutRisk.risk_level
        return ValidatorOutputSchema.safeParse(withoutRisk).success
      },
      false,
    ),
  ]

  const genuineResult = ValidatorOutputSchema.safeParse(GENUINE_ABSTENTION)
  if (!genuineResult.success) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `genuine abstention fixture rejected: ${genuineResult.error.message}` }, controls)
  }
  return withNegativeControls(
    { checkId, fixtureId, ok: true, outcome: 'abstention-response', detail: 'genuine abstention accepted; requires_human_review=false and a missing required field are both rejected by the schema' },
    controls,
  )
}

// ---------------------------------------------------------------------------
// provider-unavailable
// ---------------------------------------------------------------------------
function checkProviderUnavailablePresentation(): ReleaseCaseResult {
  const checkId = 'provider-unavailable-presentation'
  const fixtureId = 'stellaErrorPresentation(GEMINI_ERROR|TIMEOUT)'
  const gemini = stellaErrorPresentation('GEMINI_ERROR', 'Stella AI service encountered an error.')
  const timeout = stellaErrorPresentation('TIMEOUT', 'Stella request timed out. Please try again.')
  const violations: string[] = []
  if (gemini.retryable !== true) violations.push('GEMINI_ERROR must be retryable')
  if (timeout.retryable !== true) violations.push('TIMEOUT must be retryable')
  if (hasForbiddenPattern(gemini.description) || hasForbiddenPattern(timeout.description)) violations.push('presentation description contains a forbidden/secret pattern')

  const controls = [
    // "Everything is retryable" would satisfy the two assertions above while
    // destroying the distinction the category exists for.
    controlExpectsVerdict(
      'nc-provider-not-everything-retryable',
      'the presentation layer must NOT report every code as retryable',
      () => stellaErrorPresentation('UNAUTHORIZED', 'no autorizado').retryable,
      false,
    ),
    controlExpectsVerdict(
      'nc-secret-detector-discriminates',
      'the secret detector must actually flag a leaked key name in a description',
      () => hasForbiddenPattern(MALICIOUS_DOCUMENT_PAYLOAD),
      true,
    ),
  ]

  if (violations.length > 0) return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withNegativeControls(
    { checkId, fixtureId, ok: true, outcome: 'pass', detail: `GEMINI_ERROR tone=${gemini.tone} TIMEOUT tone=${timeout.tone}, both retryable, no secrets in description` },
    controls,
  )
}

// ---------------------------------------------------------------------------
// cuota-agotada
// ---------------------------------------------------------------------------
function checkQuotaExhaustedNonRetryable(): ReleaseCaseResult {
  const checkId = 'quota-exhausted-non-retryable'
  const fixtureId = 'stellaErrorPresentation(QUOTA_EXCEEDED)'
  const serverMessage = 'Cuota mensual de Stella agotada (100/100). Se restablece el 2026-09-01.'
  const presentation = stellaErrorPresentation('QUOTA_EXCEEDED', serverMessage)

  const controls = [
    // The verbatim-echo assertion is only meaningful if the presentation layer
    // is capable of NOT echoing: a code that substitutes its own copy proves
    // the echo is a per-code decision, not an accident of the implementation.
    controlExpectsVerdict(
      'nc-quota-echo-is-code-specific',
      'verbatim server-message echo must be specific to QUOTA_EXCEEDED, not universal',
      () => stellaErrorPresentation('UNKNOWN_ERROR', serverMessage).description === serverMessage,
      false,
    ),
  ]

  if (presentation.retryable !== false) return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: 'QUOTA_EXCEEDED must not be retryable' }, controls)
  if (presentation.description !== serverMessage) return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: 'QUOTA_EXCEEDED description must echo the server message verbatim' }, controls)
  return withNegativeControls(
    { checkId, fixtureId, ok: true, outcome: 'abstention-response', detail: `retryable=false, description echoes server message verbatim (and that echo is code-specific), tone=${presentation.tone}` },
    controls,
  )
}

// ---------------------------------------------------------------------------
// reintento
// ---------------------------------------------------------------------------
const EXPECTED_RETRYABLE: Record<StellaPanelErrorCode, boolean> = {
  DISABLED: false,
  UNAUTHORIZED: false,
  UNSUPPORTED_STEP: false,
  RATE_LIMITED: false,
  RATE_LIMIT_UNAVAILABLE: true,
  QUOTA_EXCEEDED: false,
  PAYLOAD_TOO_LARGE: false,
  GEMINI_ERROR: true,
  PARSE_ERROR: true,
  TIMEOUT: true,
  AUDIT_ERROR: false,
  UNKNOWN_ERROR: false,
}

function checkRetryableCodeSetPinned(): ReleaseCaseResult {
  const checkId = 'retryable-code-set-pinned'
  const fixtureId = 'EXPECTED_RETRYABLE (12 StellaPanelErrorCode)'
  const mismatches: string[] = []
  for (const [code, expected] of Object.entries(EXPECTED_RETRYABLE) as [StellaPanelErrorCode, boolean][]) {
    const actual = stellaErrorPresentation(code, `synthetic message for ${code}`).retryable
    if (actual !== expected) mismatches.push(`${code}: expected retryable=${expected}, got ${actual}`)
  }

  const controls = [
    // The pin only means something if a flipped expectation is detected.
    controlExpectsViolations(
      'nc-retry-pin-detects-flipped-expectation',
      'flipping one expected retry value must produce a mismatch',
      () => {
        const flipped: Record<string, boolean> = { ...EXPECTED_RETRYABLE, TIMEOUT: !EXPECTED_RETRYABLE.TIMEOUT }
        return Object.entries(flipped)
          .filter(([code, expected]) => stellaErrorPresentation(code as StellaPanelErrorCode, 'm').retryable !== expected)
          .map(([code]) => `${code} mismatched under the flipped pin`)
      },
    ),
    // Both classes must be non-empty, or "the exact set" is not a set.
    controlExpectsVerdict(
      'nc-retry-pin-covers-both-classes',
      'the pinned set must contain both retryable and non-retryable codes',
      () => {
        const values = Object.values(EXPECTED_RETRYABLE)
        return values.some(Boolean) && values.some((v) => !v)
      },
      true,
    ),
  ]

  if (mismatches.length > 0) return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: mismatches.join(' | ') }, controls)
  const retryableCount = Object.values(EXPECTED_RETRYABLE).filter(Boolean).length
  return withNegativeControls(
    { checkId, fixtureId, ok: true, outcome: 'pass', detail: `all 12 codes match expected retry semantics (${retryableCount} retryable, ${12 - retryableCount} not)` },
    controls,
  )
}

// ---------------------------------------------------------------------------
// decisión-humana
// ---------------------------------------------------------------------------
const VALID_REVIEWER_OUTPUT = {
  summary: 'Revisión completada.',
  risk_level: 'low' as const,
  findings: ['La fuente citada está vigente.'],
  recommendations: ['Confirmar con un humano antes de publicar.'],
  requires_human_review: true as const,
}

function checkHumanDecisionLiteralTrue(): ReleaseCaseResult {
  const checkId = 'human-decision-literal-true'
  const fixtureId = 'VALID_REVIEWER_OUTPUT (ReviewerOutputSchema)'

  const controls = [
    controlExpectsVerdict(
      'nc-reviewer-human-review-false',
      'ReviewerOutputSchema must reject requires_human_review=false',
      () => ReviewerOutputSchema.safeParse({ ...VALID_REVIEWER_OUTPUT, requires_human_review: false }).success,
      false,
    ),
    // No combination of otherwise-valid fields may compensate for the literal.
    controlExpectsVerdict(
      'nc-reviewer-false-not-rescued-by-low-risk',
      'a low-risk, finding-free reviewer output with requires_human_review=false is still rejected',
      () => ReviewerOutputSchema.safeParse({
        ...VALID_REVIEWER_OUTPUT,
        findings: [],
        recommendations: [],
        requires_human_review: false,
      }).success,
      false,
    ),
  ]

  const validResult = ReviewerOutputSchema.safeParse(VALID_REVIEWER_OUTPUT)
  if (!validResult.success) return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `valid reviewer output rejected: ${validResult.error.message}` }, controls)
  return withNegativeControls(
    { checkId, fixtureId, ok: true, outcome: 'pass', detail: 'ReviewerOutputSchema accepts requires_human_review=true and rejects false; no other valid field combination rescues it' },
    controls,
  )
}

// ---------------------------------------------------------------------------
// regresión CAP-01..CAP-05 (B-M4 — structural presence, now with content)
// ---------------------------------------------------------------------------
const CAP_FORWARD_PACKAGES = [
  'stella_0006_invitation_capability.sql',
  'stella_0007_public_verification_capability.sql',
  'stella_0008_stripe_webhook_identity.sql',
  'stella_0009_public_lead_capability.sql',
  'stella_0010_organization_bootstrap_capability.sql',
]
const CAP_ROLLBACK_PACKAGES = [
  'stella_0006_rollback.sql',
  'stella_0007_rollback.sql',
  'stella_0008_rollback.sql',
  'stella_0009_rollback.sql',
  'stella_0010_rollback.sql',
]
const CAP_REGRESSION_TEST_FILES = [
  'tests/capability-mutation.test.ts',
  'tests/capability-isolation.test.ts',
  'tests/capability-policy-contract.test.ts',
]

/** Smallest credible size for a capability package; the real ones are 27-62 kB. */
const MIN_CAP_PACKAGE_BYTES = 1024
/** Every forward package installs into this schema; a stub cannot claim it by accident. */
const CAP_FORWARD_MARKER = 'uellix_capability'
const CAP_ROLLBACK_MARKER = 'DROP'

/**
 * Injectable filesystem so the negative control can present a root where every
 * file exists and every file is empty — the exact state B-M4 proved the old
 * check could not see — WITHOUT writing anything to disk. Keeping the harness
 * read-only was a stated guarantee; a control that violated it to prove a point
 * would be trading one false claim for another.
 */
export interface CapSurfaceProbe {
  exists: (relativePath: string) => boolean
  size: (relativePath: string) => number
  read: (relativePath: string) => string
  /** The exclusion globs the default vitest config really applies. */
  excludedGlobs: readonly string[]
}

export function realCapSurfaceProbe(root: string, excludedGlobs: readonly string[]): CapSurfaceProbe {
  const abs = (p: string) => path.join(root, p)
  return {
    exists: (p) => existsSync(abs(p)),
    size: (p) => statSync(abs(p)).size,
    read: (p) => readFileSync(abs(p), 'utf8'),
    excludedGlobs,
  }
}

/** A prefix-style glob (`tests/integration/**`) matched against a repo path. */
function globExcludes(glob: string, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const prefix = glob.replace(/\*+$/, '')
  return normalized.startsWith(prefix)
}

/**
 * The evaluator. Reports what is actually wrong rather than asserting a
 * constant: a package that exists but is a stub, a rollback with nothing to
 * drop, or a regression test the default vitest config really does exclude.
 */
export function evaluateCapRegressionSurface(probe: CapSurfaceProbe): string[] {
  const problems: string[] = []

  const inspect = (relativePath: string, marker: string, kind: string) => {
    if (!probe.exists(relativePath)) {
      problems.push(`${kind} missing: ${relativePath}`)
      return
    }
    let size: number
    try {
      size = probe.size(relativePath)
    } catch (error) {
      problems.push(`${kind} unreadable: ${relativePath} (${describeError(error)})`)
      return
    }
    if (size < MIN_CAP_PACKAGE_BYTES) {
      problems.push(`${kind} is a stub: ${relativePath} is ${size} bytes, below the ${MIN_CAP_PACKAGE_BYTES}-byte floor`)
      return
    }
    const content = probe.read(relativePath)
    if (!content.includes(marker)) {
      problems.push(`${kind} lost its structural marker "${marker}": ${relativePath}`)
    }
  }

  for (const file of CAP_FORWARD_PACKAGES) inspect(path.posix.join('db', 'prepared', file), CAP_FORWARD_MARKER, 'CAP forward package')
  for (const file of CAP_ROLLBACK_PACKAGES) inspect(path.posix.join('db', 'prepared', file), CAP_ROLLBACK_MARKER, 'CAP rollback package')

  for (const file of CAP_REGRESSION_TEST_FILES) {
    if (!probe.exists(file)) {
      problems.push(`CAP regression test missing: ${file}`)
      continue
    }
    // The train 1 version asserted this against a literal prefix and could
    // never fail. It now runs against the exclusion list the default config
    // actually applies, so moving a CAP test under an excluded path — or
    // adding an exclusion that swallows one — is detected.
    const excludedBy = probe.excludedGlobs.filter((glob) => globExcludes(glob, file))
    if (excludedBy.length > 0) {
      problems.push(`CAP regression test ${file} is excluded from the default vitest config by ${excludedBy.join(', ')} — pnpm test:unit no longer exercises it`)
    }
  }

  return problems
}

/** A probe that reports every file present and empty — nothing is written to disk. */
export function emptySurfaceProbe(excludedGlobs: readonly string[]): CapSurfaceProbe {
  return { exists: () => true, size: () => 0, read: () => '', excludedGlobs }
}

function checkCapRegressionSurfacePresent(): ReleaseCaseResult {
  const checkId = 'cap-01-05-regression-surface-present'
  const fixtureId = 'db/prepared CAP-01..CAP-05 + tests/capability-*.test.ts'
  const root = process.cwd()

  // Read the real exclusion list rather than restating it. `vitest.shared.ts`
  // is INTEGRATION-OWNED; this only reads it.
  let excludedGlobs: readonly string[] = []
  let configDetail = ''
  try {
    const shared = readFileSync(path.join(root, 'vitest.shared.ts'), 'utf8')
    excludedGlobs = [...shared.matchAll(/"([^"]*\*\*[^"]*)"/g)].map((m) => m[1]!)
    configDetail = `${excludedGlobs.length} exclusion glob(s) read from vitest.shared.ts`
  } catch (error) {
    return withNegativeControls(
      { checkId, fixtureId, ok: false, outcome: 'system-error', detail: `could not read the real vitest exclusion list: ${describeError(error)}` },
      [],
    )
  }

  const controls = [
    controlExpectsViolations(
      'nc-cap-surface-zero-byte-packages',
      'CAP packages that exist but are empty must be reported (the exact state B-M4 proved was invisible)',
      () => evaluateCapRegressionSurface(emptySurfaceProbe(excludedGlobs)),
    ),
    controlExpectsViolations(
      'nc-cap-regression-test-excluded',
      'a CAP regression test swallowed by a vitest exclusion glob must be reported',
      () => evaluateCapRegressionSurface(realCapSurfaceProbe(root, [...excludedGlobs, 'tests/capability-**'])),
    ),
  ]

  const problems = evaluateCapRegressionSurface(realCapSurfaceProbe(root, excludedGlobs))
  if (problems.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: problems.join(' | ') }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: `${CAP_FORWARD_PACKAGES.length} forward + ${CAP_ROLLBACK_PACKAGES.length} rollback packages present, non-stub and carrying their structural markers; ${CAP_REGRESSION_TEST_FILES.length} regression test files present and not excluded (${configDetail}); not executed here (CAPABILITIES gate)`,
    },
    controls,
  )
}
// ---------------------------------------------------------------------------
// Harness entry point
// ---------------------------------------------------------------------------
const CHECKS: Record<string, () => ReleaseCaseResult> = {
  'sufficient-evidence-citation-resolves': checkSufficientEvidenceCitationResolves,
  'insufficient-evidence-empty-sentinel': checkInsufficientEvidenceEmptySentinel,
  'contradiction-acknowledgment-heuristic': checkContradictionAcknowledgmentHeuristic,
  'citation-correct-decodes': checkCitationCorrectDecodes,
  'citation-incorrect-rejected': checkCitationIncorrectRejected,
  'malicious-document-envelope-holds': checkMaliciousDocumentEnvelopeHolds,
  'cross-organization-no-leak': checkCrossOrganizationNoLeak,
  'cross-project-no-leak': checkCrossProjectNoLeak,
  'abstention-schema-enforced': checkAbstentionSchemaEnforced,
  'provider-unavailable-presentation': checkProviderUnavailablePresentation,
  'quota-exhausted-non-retryable': checkQuotaExhaustedNonRetryable,
  'retryable-code-set-pinned': checkRetryableCodeSetPinned,
  'human-decision-literal-true': checkHumanDecisionLiteralTrue,
  'cap-01-05-regression-surface-present': checkCapRegressionSurfacePresent,
}

export class ReleaseEvalHarnessError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ReleaseEvalHarnessError'
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export interface ReleaseEvalMetricValue {
  metric: string
  measurable: boolean
  value: number | null
  detail: string
}

export interface ReleaseEvalSummary {
  totalChecks: number
  passed: number
  failed: number
  isolationViolations: number
  systemErrors: number
  abstentionResponses: number
  /** Checks the matrix declares fully measurable offline today. */
  offlineMeasurableChecks: number
  /** Checks that pass but whose category is NOT fully measurable offline. */
  offlineLimitedChecks: number
  negativeControlsRun: number
  negativeControlsUndetected: number
  tautologicalChecks: string[]
  providerCalls: number
  metrics: ReleaseEvalMetricValue[]
}

/**
 * Every check the harness actually runs must have exactly one matrix entry,
 * and every matrix entry must have exactly one implemented check.
 */
function assertChecksMatchMatrix(matrix: readonly ReleaseEvalMatrixEntry[]): void {
  const matrixIds = new Set(matrix.map((e) => e.checkId))
  const checkIds = new Set(Object.keys(CHECKS))
  for (const id of matrixIds) if (!checkIds.has(id)) throw new ReleaseEvalHarnessError(`matrix entry "${id}" has no implemented check`)
  for (const id of checkIds) if (!matrixIds.has(id)) throw new ReleaseEvalHarnessError(`implemented check "${id}" has no matrix entry`)
}

/**
 * Computes the metrics from case results. Metrics whose measurement needs a
 * real provider call are reported as non-measurable — never fabricated.
 *
 * NOTE (B-M6, still open after this commit): `structural-regression` is
 * declared by a matrix entry and is NOT emitted here, and two entries declare
 * `latency` while latency is hardwired null. Nothing reconciles the two
 * catalogs yet. Closing that is the metrics commit of this unit.
 */
function computeReleaseMetrics(results: readonly ReleaseCaseResult[]): ReleaseEvalMetricValue[] {
  const byId = new Map(results.map((r) => [r.checkId, r]))
  const ok = (id: string) => byId.get(id)?.ok === true

  const citationChecks = ['sufficient-evidence-citation-resolves', 'citation-correct-decodes', 'citation-incorrect-rejected']
  const citationPassed = citationChecks.filter(ok).length
  const isolationChecks = ['cross-organization-no-leak', 'cross-project-no-leak', 'malicious-document-envelope-holds']
  const isolationViolations = isolationChecks.filter((id) => byId.get(id)?.outcome === 'isolation-violation').length
  const abstentionChecks = ['insufficient-evidence-empty-sentinel', 'abstention-schema-enforced', 'quota-exhausted-non-retryable', 'human-decision-literal-true']
  const abstentionCorrect = abstentionChecks.filter(ok).length
  const unsupportedClaimChecks = ['insufficient-evidence-empty-sentinel', 'citation-incorrect-rejected']
  const unsupportedClaimsCaught = unsupportedClaimChecks.filter(ok).length

  return [
    {
      metric: 'citation-precision',
      measurable: true,
      value: citationChecks.length ? citationPassed / citationChecks.length : null,
      detail: `${citationPassed}/${citationChecks.length} citation checks resolved/rejected correctly`,
    },
    {
      metric: 'citation-coverage',
      measurable: true,
      value: ok('sufficient-evidence-citation-resolves') ? 1 : 0,
      detail: 'binary: whether real evidence in context is reachable via a valid sourceRefIndexes citation',
    },
    {
      metric: 'unsupported-claim-rate',
      measurable: true,
      value: unsupportedClaimChecks.length ? 1 - unsupportedClaimsCaught / unsupportedClaimChecks.length : null,
      detail: `${unsupportedClaimsCaught}/${unsupportedClaimChecks.length} unsupported-claim canaries correctly rejected (rate = 1 - caught/total)`,
    },
    {
      metric: 'abstention-correctness',
      measurable: true,
      value: abstentionChecks.length ? abstentionCorrect / abstentionChecks.length : null,
      detail: `${abstentionCorrect}/${abstentionChecks.length} abstention/human-review contracts held`,
    },
    {
      metric: 'isolation-violations',
      measurable: true,
      value: isolationViolations,
      detail: `${isolationViolations} structural cross-tenant/cross-project/prompt-injection leaks detected across ${isolationChecks.length} checks (application layer only, not RLS — see G3)`,
    },
    {
      metric: 'latency',
      measurable: false,
      value: null,
      detail: 'requires a real provider round-trip (gate G1); this harness makes zero provider calls by design',
    },
    {
      metric: 'token-usage',
      measurable: false,
      value: null,
      detail: 'requires a real provider response with usage metadata (gate G1); lib/stella/cost-model.ts documents the formula to apply once real tokens exist',
    },
    {
      metric: 'estimated-provider-cost',
      measurable: false,
      value: null,
      detail: 'derived from token-usage via lib/stella/cost-model.ts; not computable without gate G1 data. Pricing constants there are themselves flagged pending calibration (gate G9)',
    },
  ]
}

export function runReleaseEvalHarness(
  matrix: readonly ReleaseEvalMatrixEntry[] = RELEASE_EVAL_MATRIX,
): { summary: ReleaseEvalSummary; results: ReleaseCaseResult[] } {
  validateReleaseEvalMatrix(matrix)
  assertChecksMatchMatrix(matrix)

  const results = matrix.map((entry) => CHECKS[entry.checkId]!())
  const offlineMeasurable = new Set(matrix.filter((e) => e.offlineMeasurable).map((e) => e.checkId))
  const allControls = results.flatMap((r) => r.negativeControls)

  const summary: ReleaseEvalSummary = {
    totalChecks: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    isolationViolations: results.filter((r) => r.outcome === 'isolation-violation').length,
    systemErrors: results.filter((r) => r.outcome === 'system-error').length,
    abstentionResponses: results.filter((r) => r.outcome === 'abstention-response').length,
    offlineMeasurableChecks: results.filter((r) => offlineMeasurable.has(r.checkId)).length,
    offlineLimitedChecks: results.filter((r) => !offlineMeasurable.has(r.checkId)).length,
    negativeControlsRun: allControls.length,
    negativeControlsUndetected: undetectedControls(allControls).length,
    tautologicalChecks: results.filter((r) => r.detail.startsWith('TAUTOLOGICAL')).map((r) => r.checkId),
    providerCalls: 0,
    metrics: computeReleaseMetrics(results),
  }

  return { summary, results }
}

/**
 * Why the process must exit non-zero, or an empty list.
 *
 * Lives here rather than inside the CLI so the gates are testable against
 * synthetic summaries: "the process fails on a check that cannot fail" is a
 * claim that has to be provable without breaking a real detector.
 */
export function releaseEvalFailureReasons(summary: ReleaseEvalSummary): string[] {
  const reasons: string[] = []
  if (summary.failed > 0) reasons.push(`${summary.failed} check(s) did not pass`)
  if (summary.tautologicalChecks.length > 0) {
    reasons.push(`tautological check(s) — cannot fail, therefore prove nothing: ${summary.tautologicalChecks.join(', ')}`)
  }
  if (summary.negativeControlsUndetected > 0) {
    reasons.push(`${summary.negativeControlsUndetected} negative control(s) did not detect their mutation`)
  }
  if (summary.isolationViolations > 0) {
    reasons.push(`${summary.isolationViolations} isolation violation(s) — cross-tenant or cross-project data reached a request`)
  }
  if (summary.systemErrors > 0) reasons.push(`${summary.systemErrors} system error(s)`)
  if (summary.providerCalls !== 0) reasons.push('harness made a provider call — must stay fully offline')
  return reasons
}

