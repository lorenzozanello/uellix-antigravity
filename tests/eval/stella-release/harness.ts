// tests/eval/stella-release/harness.ts
// RELEASE line — offline grounding/isolation evaluation harness
// (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2, Fases 2-4).
//
// One function per matrix.ts `checkId`. Fully offline: no network, no DB, no
// provider, no env secrets — the only filesystem I/O is reading committed
// files under db/prepared/** and tests/** to confirm CAP-01..CAP-05's
// regression surface is still present (never executing them).
//
// TRAIN 2 — WHAT CHANGED AND WHY
//
// Train 1 shipped 14 green checks. The adversarial review found that three of
// them could not fail: B-M4 stayed green with every CAP package truncated to
// zero bytes, B-M5 matched a regex against literals it had just written, and
// B-M6's declared `structural-regression` metric was never emitted at all. So
// this file no longer treats "the check returned ok" as evidence of anything.
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
import { stellaConfig } from '@/lib/stella/config'
import { StellaDecisionInputSchema } from '@/app/actions/stella/decisions-schema'
import {
  CONTENT_HASH_HEX_LENGTH,
  PIPELINE_VERSIONS,
  citationsOf,
  deriveChunkId,
  hashContent,
  scopeContains,
  toCitableChunkRecord,
  validateAnswerCitations,
} from '@/lib/grounding/contracts'
import type {
  CitableChunkRecord,
  CitationReference,
  ContentHash,
  GroundingAnswerState,
  GroundingChunk,
  GroundingScope,
  RetrievalResult,
} from '@/lib/grounding/contracts'

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
  ALPHA_PROJECT_ONE_CHUNK,
  ALPHA_PROJECT_TWO_CHUNK,
  BETA_PROJECT_ONE_CHUNK,
  CONTRADICTION_SIDE_A_CHUNK,
  CONTRADICTION_SIDE_B_CHUNK,
  ALPHA_PROJECT_ONE_QUERY,
  ALPHA_PROJECT_ONE_RETRIEVAL,
  MISRANKED_RETRIEVAL,
  BELOW_THRESHOLD_ADMITTED_RETRIEVAL,
  GROUNDED_ANSWER,
  CONTRADICTION_ACKNOWLEDGED_ANSWER,
  CONTRADICTION_IGNORED_ANSWER,
  KNOWN_CONTRADICTORY_EVIDENCE_PAIRS,
  NONEXISTENT_CITATION,
  DRIFTED_CITATION,
  CROSS_PROJECT_CITATION,
  CROSS_ORGANIZATION_CITATION,
  citationTo,
  DECISION_ACCEPTED_INPUT,
  DECISION_ACCEPTED_EDITED_INPUT,
  DECISION_REJECTED_INPUT,
  DECISION_UNDONE_INPUT,
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
import {
  PROVIDER_DEPENDENT_METRICS,
  RELEASE_EVAL_MATRIX,
  RELEASE_EVAL_MATRIX_VERSION,
  validateReleaseEvalMatrix,
  type ReleaseEvalMatrixEntry,
  type ReleaseEvalMetric,
} from './matrix'
import { RELEASE_FIXTURES_VERSION } from './fixtures'

/** Bumped whenever check semantics change, independently of the matrix shape. */
export const RELEASE_HARNESS_VERSION = '3.0.0'

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
  const fixtureId = 'CONTRADICTORY_CONTEXT + CONTRADICTION_ACKNOWLEDGED_ANSWER'

  // B-M5 fix, part 1: both probe texts now come from FIXTURES, not from string
  // literals declared inside this function. Editing a fixture changes what this
  // check reads; before, nothing outside these two lines could affect it.
  const acknowledging = CONTRADICTION_ACKNOWLEDGED_ANSWER.abstention!.explanation
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
/**
 * The envelope inspection itself, over an envelope STRING.
 *
 * Extracted by integration (train 2) so the negative control can drive the real
 * inspection with a genuinely multi-line envelope instead of asserting that a
 * literal it just built contains the newline it just put in it. The check and
 * the control now share this function, which is the only arrangement under
 * which deleting a rule here makes the control fail.
 */
function inspectEnvelope(envelope: string, systemPrompt: string, payload: string): string[] {
  const violations: string[] = []
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
  if (systemPrompt.includes(payload)) violations.push('injected payload leaked into the trusted system prompt')
  return violations
}

function evaluateInjectionEnvelope(context: typeof MALICIOUS_CONTEXT, payload: string): string[] {
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, context)
  return inspectEnvelope(wrapUntrustedData(request.serializedContext), request.systemPrompt, payload)
}

/**
 * An envelope whose body genuinely spans two lines.
 *
 * Assembled DIRECTLY rather than through `wrapUntrustedData`, and that is the
 * whole point: `wrapUntrustedData` is `MARKER + "\n" + JSON.stringify(payload)`
 * (lib/stella/context/sanitize.ts:148), so it CANNOT emit a multi-line body —
 * JSON escaping is the protection. Feeding it a string with a raw newline just
 * produces an escaped `\n` inside one line, which is the correct behaviour and
 * therefore useless as a mutation: it produces zero violations and proves
 * nothing.
 *
 * What this control has to falsify is the INSPECTOR, not the serializer: "if a
 * two-line envelope ever did reach the model — a serializer regression, a
 * different wrapper, a hand-built prompt — would `inspectEnvelope` say so?" So
 * the mutation is the shape such a regression would produce, handed to the real
 * inspector.
 */
function brokenOutEnvelope(): string {
  return `${UNTRUSTED_DATA_MARKER}\n{"primera":"linea"}\n{"segunda":"linea"}`
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
    //
    // FIXED BY INTEGRATION (train 2 adversarial review). This control used to
    // build the string `'primera línea\nsegunda línea'` and assert that it
    // `.includes('\n')` — a literal compared against itself, which cannot fail
    // and never called `evaluateInjectionEnvelope` at all. Deleting the
    // envelope check from the evaluator left this control reporting
    // `detected: true`, the parent check green and `tautologicalChecks` empty.
    // That is precisely the B-M5 defect this file's header claims to have
    // removed structurally, surviving in a control instead of in a check.
    //
    // It now drives the REAL inspection with a real envelope whose body spans
    // two lines, so removing the rule makes this control fail.
    controlExpectsViolations(
      'nc-envelope-rejects-multiline-body',
      'the envelope evaluator must reject a body that spans more than one line',
      () => inspectEnvelope(brokenOutEnvelope(), '', MALICIOUS_DOCUMENT_PAYLOAD),
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

/**
 * Does a vitest exclusion glob cover this repo-relative path?
 *
 * REWRITTEN BY INTEGRATION (train 2 adversarial review). The previous version
 * stripped trailing `*` and did `startsWith`, which handles `tests/integration/**`
 * and nothing else. `**` /`capability-*.test.ts` — the shape anyone would reach
 * for to exclude a family of tests — became the prefix `**` + `/capability-`,
 * which no relative path starts with, so the exclusion was invisible and
 * `cap-01-05-regression-surface-present` stayed green while `pnpm test:unit`
 * silently stopped collecting all three CAP regression suites. The check that
 * exists to catch a swallowed regression test could be defeated by the ordinary
 * way of writing the glob that swallows it.
 *
 * Now a real translation: `**` crosses separators, `*` does not, `?` is one
 * character, everything else is literal. A trailing `/**` also matches the
 * directory itself, matching how vitest treats it.
 */
function globExcludes(glob: string, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const source = glob.replace(/\\/g, '/')

  // Single pass, no placeholder substitution. A chained `.replace()` pipeline
  // needs sentinels to keep `**` from being eaten by the `*` rule, and a
  // sentinel is a string that must never occur in the input — a promise this
  // file cannot keep and, in the first version of this function, did not:
  // the sentinels were written with NUL bytes, which made git classify the
  // whole module as binary and skip its line-ending normalization.
  let pattern = ''
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!
    if (char === '*') {
      if (source[i + 1] === '*') {
        // `a/**/b` must also match `a/b`, which is what vitest does.
        if (source[i + 2] === '/') {
          pattern += '(?:.*/)?'
          i += 2
        } else {
          pattern += '.*'
          i += 1
        }
      } else {
        pattern += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      pattern += '[^/]'
      continue
    }
    pattern += char.replace(/[.+^${}()|[\]\\/]/, '\\$&')
  }

  return new RegExp(`^${pattern}$`).test(normalized) || new RegExp(`^${pattern}`).test(normalized)
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

// ===========================================================================
// GROUNDING CONTRACT CHECKS (train 2, Fase 5)
// ===========================================================================
// Built only against the published lib/grounding/contracts barrel. No
// retrieval implementation is assumed; these measure the properties a
// retrieval layer will have to satisfy, so the criteria exist before the
// implementation does rather than being written to fit it afterwards.

/**
 * Built with GROUNDING's own `toCitableChunkRecord`, never by hand.
 *
 * RECONCILED BY INTEGRATION (train 2). RELEASE wrote this map against the
 * pre-merge signature, where `availableChunks` was
 * `{ contentHash, organizationId }` — a shape that could not carry a projectId,
 * which is what finding A-F1 was about. GROUNDING's train-2 unit replaced it
 * with `CitableChunkRecord` (chunkId, contentHash, FULL scope, evidenceId,
 * versionId, location) and published `toCitableChunkRecord` for exactly this
 * reason: every field copied by hand is a field that can be copied from the
 * wrong place, and the fields in question ARE the isolation boundary.
 *
 * Hand-copying the new shape here would have compiled and reproduced the old
 * bug in a new place. Projecting through the published helper cannot.
 */
const AVAILABLE_CHUNKS: ReadonlyMap<ContentHash, CitableChunkRecord> = new Map(
  [ALPHA_PROJECT_ONE_CHUNK, CONTRADICTION_SIDE_A_CHUNK, CONTRADICTION_SIDE_B_CHUNK, ALPHA_PROJECT_TWO_CHUNK, BETA_PROJECT_ONE_CHUNK]
    .map((c) => [c.chunkId, toCitableChunkRecord(c)] as const),
)

const CHUNKS_BY_ID: ReadonlyMap<ContentHash, GroundingChunk> = new Map(
  [ALPHA_PROJECT_ONE_CHUNK, CONTRADICTION_SIDE_A_CHUNK, CONTRADICTION_SIDE_B_CHUNK, ALPHA_PROJECT_TWO_CHUNK, BETA_PROJECT_ONE_CHUNK]
    .map((c) => [c.chunkId, c] as const),
)

/**
 * Project-scope enforcement over a whole answer.
 *
 * Written when `validateAnswerCitations` compared organizationId only and its
 * `availableChunks` map could not even carry a projectId (train 1 finding
 * A-F1). GROUNDING closed A-F1 in train 2, so the contract now enforces project
 * scope on its own — and the check above asserts that it does.
 *
 * This function is KEPT anyway, and deliberately: it measures the same property
 * from the other side, over `GroundingChunk.provenance.scope` rather than over
 * the projected citable record, using the primitive GROUNDING publishes for it
 * (`scopeContains`). Two independent paths to "may this be read?" is the right
 * number when the answer is an isolation boundary — a single implementation
 * regressing takes its own test with it.
 */
export function evaluateProjectScopeEnforcement(
  state: GroundingAnswerState,
  chunks: ReadonlyMap<ContentHash, GroundingChunk>,
  readerScope: GroundingScope,
): string[] {
  const violations: string[] = []
  const assertions = state.status === 'abstained' ? [] : state.assertions
  const allCitations: CitationReference[] = [
    ...assertions.flatMap((a) => citationsOf(a)),
    ...state.contradictions.flatMap((c) => [...c.sideA, ...c.sideB]),
  ]
  for (const citation of allCitations) {
    const chunk = chunks.get(citation.chunkId)
    if (!chunk) {
      violations.push(`citation to ${citation.chunkId.slice(0, 12)}… has no chunk in the retrieved set`)
      continue
    }
    if (!scopeContains(readerScope, chunk.provenance.scope)) {
      violations.push(
        `citation to evidence ${chunk.evidenceId} crosses the reader scope: reader is organization ${readerScope.organizationId} / project ${readerScope.projectId ?? '(org-wide)'}, chunk is organization ${chunk.provenance.scope.organizationId} / project ${chunk.provenance.scope.projectId ?? '(org-wide)'}`,
      )
    }
  }
  return violations
}

function answerCiting(citation: CitationReference): GroundingAnswerState {
  return {
    ...GROUNDED_ANSWER,
    assertions: [{ kind: 'evidence', statement: 'Afirmación con una cita fuera de alcance.', citations: [citation] }],
  }
}

function checkGroundingProjectScopeEnforced(): ReleaseCaseResult {
  const checkId = 'grounding-project-scope-enforced'
  const fixtureId = 'GROUNDED_ANSWER + ALPHA_PROJECT_TWO_CHUNK + BETA_PROJECT_ONE_CHUNK'
  const readerScope = ALPHA_PROJECT_ONE_QUERY.scope

  const controls = [
    controlExpectsViolations(
      'nc-scope-sibling-project-citation',
      'a citation to a SIBLING PROJECT of the same organization must be reported out of scope',
      () => evaluateProjectScopeEnforcement(answerCiting(CROSS_PROJECT_CITATION), CHUNKS_BY_ID, readerScope),
    ),
    controlExpectsViolations(
      'nc-scope-cross-organization-citation',
      'a citation to another organization must be reported out of scope',
      () => evaluateProjectScopeEnforcement(answerCiting(CROSS_ORGANIZATION_CITATION), CHUNKS_BY_ID, readerScope),
    ),
    controlExpectsViolations(
      'nc-scope-citation-without-source',
      'a citation to a chunk that was never retrieved must be reported',
      () => evaluateProjectScopeEnforcement(answerCiting(NONEXISTENT_CITATION), CHUNKS_BY_ID, readerScope),
    ),
  ]

  const violations = evaluateProjectScopeEnforcement(GROUNDED_ANSWER, CHUNKS_BY_ID, readerScope)
  if (violations.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'isolation-violation', detail: violations.join(' | ') }, controls)
  }

  // A-F1 IS CLOSED (GROUNDING train 2, reconciled by integration). Before the
  // merge this block recorded the finding as still open and carried the note
  // forward in `detail`. That reading is now stale, and leaving a closed finding
  // open is not a harmless conservatism: a reader of the eval output would keep
  // treating GROUNDING's validator as unable to see project scope and would keep
  // building the compensating layer this check used to be.
  //
  // So the note becomes an ASSERTION, in the strict direction: the contract must
  // report the sibling-project citation itself. If GROUNDING ever regresses to
  // organization-only comparison, this check fails as an isolation violation
  // instead of quietly reverting to a footnote.
  const contractIssues = validateAnswerCitations(answerCiting(CROSS_PROJECT_CITATION), AVAILABLE_CHUNKS)
  if (!contractIssues.some((i) => i.code === 'citation_out_of_scope')) {
    return withNegativeControls(
      {
        checkId, fixtureId, ok: false, outcome: 'isolation-violation',
        detail: `validateAnswerCitations did not report the sibling-project citation as citation_out_of_scope — A-F1 has regressed (issues: ${contractIssues.map((i) => i.code).join(', ') || 'none'})`,
      },
      controls,
    )
  }

  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: 'in-scope answer clean; sibling-project, cross-organization and phantom citations all reported, by this check AND by validateAnswerCitations itself (A-F1 closed)',
    },
    controls,
  )
}

// --- provenance canónica ---------------------------------------------------
/** Every field of the verification chain must be present and internally consistent. */
export function evaluateCanonicalProvenance(chunk: GroundingChunk): string[] {
  const violations: string[] = []
  const p = chunk.provenance
  const isHash = (v: string) => new RegExp(`^[0-9a-f]{${CONTENT_HASH_HEX_LENGTH}}$`).test(v)

  if (!p.evidenceId) violations.push('provenance.evidenceId is empty')
  if (!p.sourceLabel) violations.push('provenance.sourceLabel is empty')
  if (!p.mimeType) violations.push('provenance.mimeType is empty')
  if (!isHash(p.rawContentHash)) violations.push('provenance.rawContentHash is not a lowercase-hex SHA-256')
  if (!isHash(p.normalizedContentHash)) violations.push('provenance.normalizedContentHash is not a lowercase-hex SHA-256')
  if (!isHash(p.versionId)) violations.push('provenance.versionId is not a lowercase-hex SHA-256')
  if (p.normalizationVersion !== PIPELINE_VERSIONS.normalization) violations.push(`provenance.normalizationVersion "${p.normalizationVersion}" does not match the pipeline constant`)
  if (p.chunkerVersion !== PIPELINE_VERSIONS.chunker) violations.push(`provenance.chunkerVersion "${p.chunkerVersion}" does not match the pipeline constant`)
  if (p.injectionScannerVersion !== PIPELINE_VERSIONS.injectionScanner) violations.push(`provenance.injectionScannerVersion "${p.injectionScannerVersion}" does not match the pipeline constant`)
  if (p.evidenceId !== chunk.evidenceId) violations.push('provenance.evidenceId disagrees with the chunk it describes')
  if (p.versionId !== chunk.versionId) violations.push('provenance.versionId disagrees with the chunk it describes')
  if (chunk.location.coordinateSpace !== p.normalizedContentHash) violations.push('location.coordinateSpace is not the normalized text this provenance names')

  // The chain has to actually close: re-hash the text, re-derive the id.
  if (hashContent(chunk.text) !== chunk.contentHash) violations.push('contentHash is not the hash of the chunk text — the citation could not be falsified')
  if (deriveChunkId(chunk.versionId, chunk.chunkIndex, chunk.contentHash) !== chunk.chunkId) violations.push('chunkId does not re-derive from (versionId, chunkIndex, contentHash)')

  return violations
}

function checkGroundingProvenanceCanonical(): ReleaseCaseResult {
  const checkId = 'grounding-provenance-canonical'
  const fixtureId = 'ALPHA_PROJECT_ONE_CHUNK'

  const controls = [
    controlExpectsViolations(
      'nc-provenance-tampered-text',
      'a chunk whose text was edited after hashing must be reported',
      () => evaluateCanonicalProvenance({ ...ALPHA_PROJECT_ONE_CHUNK, text: `${ALPHA_PROJECT_ONE_CHUNK.text} (texto alterado)` }),
    ),
    controlExpectsViolations(
      'nc-provenance-stale-pipeline-version',
      'a chunk carrying a pipeline version other than the current constants must be reported',
      () => evaluateCanonicalProvenance({
        ...ALPHA_PROJECT_ONE_CHUNK,
        provenance: { ...ALPHA_PROJECT_ONE_CHUNK.provenance, normalizationVersion: 'norm-0' },
      }),
    ),
    controlExpectsViolations(
      'nc-provenance-missing-source-label',
      'a chunk with no source label must be reported — an unlabelled citation is unverifiable by a human',
      () => evaluateCanonicalProvenance({
        ...ALPHA_PROJECT_ONE_CHUNK,
        provenance: { ...ALPHA_PROJECT_ONE_CHUNK.provenance, sourceLabel: '' },
      }),
    ),
  ]

  const violations = [
    ...evaluateCanonicalProvenance(ALPHA_PROJECT_ONE_CHUNK),
    ...evaluateCanonicalProvenance(CONTRADICTION_SIDE_A_CHUNK),
  ]
  if (violations.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  }
  return withNegativeControls(
    { checkId, fixtureId, ok: true, outcome: 'pass', detail: 'verification chain closes: text re-hashes to contentHash, chunkId re-derives, coordinate space matches provenance, pipeline versions current' },
    controls,
  )
}

// --- score numérico --------------------------------------------------------
/** A ranking must be a ranking: finite scores, monotone order, threshold honoured. */
export function evaluateRetrievalScoring(result: RetrievalResult): string[] {
  const violations: string[] = []
  const { candidates, query } = result
  candidates.forEach((candidate, i) => {
    if (!Number.isFinite(candidate.score)) violations.push(`candidate ${i} score is not a finite number`)
    if (candidate.rank !== i) violations.push(`candidate ${i} declares rank ${candidate.rank} but sits at position ${i}`)
    if (candidate.score < query.minScore) violations.push(`candidate ${i} scores ${candidate.score}, below the query minScore ${query.minScore}, and was returned anyway`)
    if (i > 0 && candidate.score > candidates[i - 1]!.score) {
      violations.push(`ranking is not monotone: candidate ${i} scores ${candidate.score} above candidate ${i - 1} at ${candidates[i - 1]!.score}`)
    }
  })
  if (result.belowThresholdCount < 0) violations.push('belowThresholdCount is negative')
  if (result.quarantinedCount < 0) violations.push('quarantinedCount is negative')
  return violations
}

function checkGroundingRetrievalScoreOrdering(): ReleaseCaseResult {
  const checkId = 'grounding-retrieval-score-ordering'
  const fixtureId = 'ALPHA_PROJECT_ONE_RETRIEVAL'

  const controls = [
    controlExpectsViolations(
      'nc-score-ranking-inverted',
      'a ranking that contradicts its own scores must be reported',
      () => evaluateRetrievalScoring(MISRANKED_RETRIEVAL),
    ),
    controlExpectsViolations(
      'nc-score-below-threshold-admitted',
      'a candidate below the query minScore must not be returned silently',
      () => evaluateRetrievalScoring(BELOW_THRESHOLD_ADMITTED_RETRIEVAL),
    ),
    controlExpectsViolations(
      'nc-score-not-a-number',
      'a non-finite score must be reported rather than compared',
      () => evaluateRetrievalScoring({
        ...ALPHA_PROJECT_ONE_RETRIEVAL,
        candidates: [{ ...ALPHA_PROJECT_ONE_RETRIEVAL.candidates[0]!, score: Number.NaN }],
      }),
    ),
  ]

  const violations = evaluateRetrievalScoring(ALPHA_PROJECT_ONE_RETRIEVAL)
  if (violations.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  }
  return withNegativeControls(
    { checkId, fixtureId, ok: true, outcome: 'pass', detail: `${ALPHA_PROJECT_ONE_RETRIEVAL.candidates.length} candidates: finite scores, monotone ranking, none below minScore ${ALPHA_PROJECT_ONE_RETRIEVAL.query.minScore}` },
    controls,
  )
}

// --- contradiction marker --------------------------------------------------
function contradictoryPairPresent(evidenceIds: readonly string[]): readonly [string, string] | null {
  for (const [a, b] of KNOWN_CONTRADICTORY_EVIDENCE_PAIRS) {
    if (evidenceIds.includes(a) && evidenceIds.includes(b)) return [a, b]
  }
  return null
}

/**
 * The structural rule: when both sides of a known contradiction are cited, the
 * answer must either carry a ContradictionMarker or abstain with
 * `contradictory_evidence`. Presenting one side as settled fact is the failure.
 */
export function evaluateContradictionHandling(
  state: GroundingAnswerState,
  chunks: ReadonlyMap<ContentHash, GroundingChunk>,
): string[] {
  const assertions = state.status === 'abstained' ? [] : state.assertions
  const citedEvidenceIds = assertions
    .flatMap((a) => citationsOf(a))
    .map((c) => chunks.get(c.chunkId)?.evidenceId)
    .filter((id): id is string => Boolean(id))

  const pair = contradictoryPairPresent(citedEvidenceIds)
  if (!pair) return []

  const violations: string[] = []
  const marked = state.contradictions.length > 0
  const abstainedOnContradiction = state.status !== 'grounded' && state.abstention?.code === 'contradictory_evidence'
  if (!marked && !abstainedOnContradiction) {
    violations.push(`evidence ${pair[0]} and ${pair[1]} contradict each other and are both cited, but the answer carries no ContradictionMarker and does not abstain on contradictory_evidence`)
  }
  for (const marker of state.contradictions) {
    if (marker.resolution !== 'requires_human_resolution') violations.push(`contradiction ${marker.id} claims resolution "${marker.resolution}" — Stella never resolves a contradiction itself`)
    if (marker.sideA.length === 0 || marker.sideB.length === 0) violations.push(`contradiction ${marker.id} does not anchor both sides`)
  }
  return violations
}

function checkGroundingContradictionMarked(): ReleaseCaseResult {
  const checkId = 'grounding-contradiction-marked'
  const fixtureId = 'CONTRADICTION_ACKNOWLEDGED_ANSWER vs CONTRADICTION_IGNORED_ANSWER'

  const controls = [
    controlExpectsViolations(
      'nc-contradiction-ignored',
      'citing both sides of a contradiction while presenting it as settled must be reported',
      () => evaluateContradictionHandling(CONTRADICTION_IGNORED_ANSWER, CHUNKS_BY_ID),
    ),
    controlExpectsViolations(
      'nc-contradiction-auto-resolved',
      'a contradiction marker claiming automatic resolution must be reported',
      () => evaluateContradictionHandling(
        {
          ...CONTRADICTION_IGNORED_ANSWER,
          contradictions: [{ ...CONTRADICTION_ACKNOWLEDGED_ANSWER.contradictions[0]!, resolution: 'resolved_automatically' as never }],
        },
        CHUNKS_BY_ID,
      ),
    ),
  ]

  const violations = [
    ...evaluateContradictionHandling(CONTRADICTION_ACKNOWLEDGED_ANSWER, CHUNKS_BY_ID),
    // A non-contradictory answer must not be flagged: the rule has to be about
    // contradiction, not about "any answer with more than one citation".
    ...evaluateContradictionHandling(GROUNDED_ANSWER, CHUNKS_BY_ID),
  ]
  if (violations.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'abstention-response',
      detail: 'the acknowledged answer marks both sides and defers to a human; the clean answer is not falsely flagged; an ignored contradiction and a self-resolved marker are both reported',
    },
    controls,
  )
}

// --- adaptador de PRODUCT --------------------------------------------------
/**
 * What PRODUCT's citation adapter needs in order to render a citation as an
 * EvidenceReference.
 *
 * RECONCILED BY INTEGRATION (train 2): the adapter now EXISTS
 * (`components/stella/grounding-adapter.ts`) and INTEGRATION-001 is `aceptado`.
 * This projection is kept as-is and still imports nothing from PRODUCT, because
 * what it measures is the INPUT side — whether a citation carries everything a
 * renderer would need. That criterion does not become redundant once a renderer
 * exists; it is what tells you whether a failure is the adapter's fault or the
 * data's.
 */
export interface AdapterInputProjection {
  sourceField: string
  label: string
}

export function projectCitationForProduct(
  citation: CitationReference,
  chunks: ReadonlyMap<ContentHash, GroundingChunk>,
): { projection: AdapterInputProjection | null; violations: string[] } {
  const violations: string[] = []
  const chunk = chunks.get(citation.chunkId)
  if (!chunk) {
    return { projection: null, violations: [`no retrieved chunk for citation ${citation.chunkId.slice(0, 12)}…`] }
  }
  if (!citation.evidenceId) violations.push('citation carries no evidenceId — PRODUCT cannot link the reference to an evidence item')
  if (!chunk.provenance.sourceLabel) violations.push('chunk carries no sourceLabel — the reference would render without a human-readable source')
  if (citation.quotedTextHash !== chunk.contentHash) violations.push('quotedTextHash does not match the chunk — PRODUCT would render a verified badge over an unverified quote')
  if (citation.location.lineEnd < citation.location.lineStart) violations.push('citation line range is inverted')
  if (violations.length > 0) return { projection: null, violations }
  return {
    projection: {
      sourceField: `evidence/${citation.evidenceId}/chunk/${chunk.chunkIndex}`,
      label: `${chunk.provenance.sourceLabel} (líneas ${citation.location.lineStart}–${citation.location.lineEnd})`,
    },
    violations: [],
  }
}

function checkGroundingProductAdapterInputComplete(): ReleaseCaseResult {
  const checkId = 'grounding-product-adapter-input-complete'
  const fixtureId = 'citationTo(ALPHA_PROJECT_ONE_CHUNK)'

  const controls = [
    controlExpectsViolations(
      'nc-adapter-drifted-quote',
      'a citation whose quoted hash drifted off its passage must not project into a PRODUCT reference',
      () => projectCitationForProduct(DRIFTED_CITATION, CHUNKS_BY_ID).violations,
    ),
    controlExpectsViolations(
      'nc-adapter-phantom-chunk',
      'a citation with no retrieved chunk must not project',
      () => projectCitationForProduct(NONEXISTENT_CITATION, CHUNKS_BY_ID).violations,
    ),
    controlExpectsViolations(
      'nc-adapter-missing-source-label',
      'a chunk with no source label must not project into a rendered reference',
      () => {
        const stripped = { ...ALPHA_PROJECT_ONE_CHUNK, provenance: { ...ALPHA_PROJECT_ONE_CHUNK.provenance, sourceLabel: '' } }
        return projectCitationForProduct(citationTo(ALPHA_PROJECT_ONE_CHUNK), new Map([[stripped.chunkId, stripped]])).violations
      },
    ),
  ]

  const { projection, violations } = projectCitationForProduct(citationTo(ALPHA_PROJECT_ONE_CHUNK), CHUNKS_BY_ID)
  if (violations.length > 0 || !projection) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: violations.join(' | ') || 'projection was null with no reported violation' }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: `every field PRODUCT's adapter needs is present: sourceField="${projection.sourceField}", label="${projection.label}" (measures the INPUT; the adapter's own behaviour is covered by components/stella tests — nothing from another line is imported here)`,
    },
    controls,
  )
}

// ===========================================================================
// DECISION-JOURNEY CHECKS (train 3, STELLA_RELEASE_RUNTIME_GATE_FOUNDATION_TRAIN_3)
// ===========================================================================
// Built against the REAL exported contract of app/actions/stella/decisions.ts
// + decisions-schema.ts — pre-parallel-split foundation code, consumed here
// read-only exactly like stellaErrorPresentation/ReviewerOutputSchema above.
// The persisted table (stella_suggestion_decisions) exists only as prepared
// SQL guarded by STELLA_DECISIONS_PERSISTENCE_ENABLED=false; nothing below
// EXECUTES recordStellaDecision() (a 'use server' action with real DB/auth
// I/O — the harness stays 100% synchronous and makes zero async calls) or
// simulates that table. Each check is either a real schema/config call, or
// structural source inspection — never execution — the same discipline
// checkCapRegressionSurfacePresent already applies above.

function checkStellaDecisionFeatureFlagBlocksPersistence(): ReleaseCaseResult {
  const checkId = 'stella-decision-feature-flag-blocks-persistence'
  const fixtureId = 'stellaConfig.isDecisionsPersistenceEnabled + app/actions/stella/decisions.ts (source inspection)'

  // The real, live-computed flag — not a recreated constant. If this
  // environment contaminated it to true, calling the real action would touch
  // auth/DB, which this harness never does; fail closed instead of assuming.
  if (stellaConfig.isDecisionsPersistenceEnabled) {
    return withNegativeControls(
      {
        checkId, fixtureId, ok: false, outcome: 'system-error',
        detail: 'environment contamination: STELLA_DECISIONS_PERSISTENCE_ENABLED=true in the process running this harness — cannot verify the flag-off path offline',
      },
      [],
    )
  }

  const root = process.cwd()
  const relativePath = path.posix.join('app', 'actions', 'stella', 'decisions.ts')
  let source: string
  try {
    // Normalized to LF: this worktree checks the file out as CRLF, and a
    // literal/marker search must not depend on line-ending policy.
    source = readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
  } catch (error) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `could not read ${relativePath}: ${describeError(error)}` }, [])
  }

  const FLAG_GATE_MARKER = 'if (!stellaConfig.isDecisionsPersistenceEnabled)'
  const SCHEMA_VALIDATION_MARKER = 'StellaDecisionInputSchema.safeParse'
  const AUTH_MARKER = 'requireOrganizationAccess()'

  const evaluateGateOrder = (text: string): string[] => {
    const problems: string[] = []
    const flagIndex = text.indexOf(FLAG_GATE_MARKER)
    const schemaIndex = text.indexOf(SCHEMA_VALIDATION_MARKER)
    const authIndex = text.indexOf(AUTH_MARKER)
    if (flagIndex === -1) problems.push('flag gate marker not found — recordStellaDecision may no longer check the flag at all')
    if (schemaIndex === -1) problems.push('schema validation marker not found')
    if (authIndex === -1) problems.push('auth marker not found')
    if (flagIndex !== -1 && schemaIndex !== -1 && flagIndex > schemaIndex) {
      problems.push('flag gate appears AFTER schema validation — a disabled feature would still parse untrusted input')
    }
    if (flagIndex !== -1 && authIndex !== -1 && flagIndex > authIndex) {
      problems.push('flag gate appears AFTER the auth check — a disabled feature would still authenticate the caller')
    }
    return problems
  }

  const controls = [
    // Synthetic mutated text run through the SAME evaluator — same pattern as
    // emptySurfaceProbe() for the CAP check above: the probe is not a real
    // file, but the function judging it is identical to the one judging the
    // real source.
    controlExpectsViolations(
      'nc-decision-flag-gate-after-schema',
      'a flag gate written after schema validation must be reported',
      () => evaluateGateOrder(`${SCHEMA_VALIDATION_MARKER}(input)\n${FLAG_GATE_MARKER} { return DISABLED }\n${AUTH_MARKER}`),
    ),
    controlExpectsViolations(
      'nc-decision-flag-gate-after-auth',
      'a flag gate written after the auth check must be reported',
      () => evaluateGateOrder(`${AUTH_MARKER}\n${FLAG_GATE_MARKER} { return DISABLED }\n${SCHEMA_VALIDATION_MARKER}(input)`),
    ),
  ]

  const problems = evaluateGateOrder(source)
  if (problems.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: problems.join(' | ') }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'abstention-response',
      detail: 'isDecisionsPersistenceEnabled=false (real, live config); the flag gate is textually first in recordStellaDecision, before schema validation and before the auth check',
    },
    controls,
  )
}

function checkStellaDecisionAcceptedContractValid(): ReleaseCaseResult {
  const checkId = 'stella-decision-accepted-contract-valid'
  const fixtureId = 'DECISION_ACCEPTED_INPUT / DECISION_ACCEPTED_EDITED_INPUT (StellaDecisionInputSchema)'

  const acceptedResult = StellaDecisionInputSchema.safeParse(DECISION_ACCEPTED_INPUT)
  const acceptedEditedResult = StellaDecisionInputSchema.safeParse(DECISION_ACCEPTED_EDITED_INPUT)

  const controls = [
    controlExpectsVerdict(
      'nc-decision-accepted-edited-text-over-limit',
      '"accepted_edited" with editedText over the 20000-char limit must be rejected',
      () => StellaDecisionInputSchema.safeParse({ ...DECISION_ACCEPTED_EDITED_INPUT, editedText: 'x'.repeat(20001) }).success,
      false,
    ),
    controlExpectsVerdict(
      'nc-decision-accepted-client-supplied-decider',
      'a client-supplied decider identity field must be rejected by the strict schema — decidedBy always comes from the session, never the payload',
      () => StellaDecisionInputSchema.safeParse({ ...DECISION_ACCEPTED_INPUT, decidedBy: 'attacker-user-id' }).success,
      false,
    ),
  ]

  if (!acceptedResult.success) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `"accepted" rejected by the real schema: ${acceptedResult.error.message}` }, controls)
  }
  if (!acceptedEditedResult.success) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `"accepted_edited" rejected by the real schema: ${acceptedEditedResult.error.message}` }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: '"accepted" and "accepted_edited" (with editedText) both accepted by the real schema; oversized editedText and a client-supplied decider identity are both rejected',
    },
    controls,
  )
}

function checkStellaDecisionRejectedContractValid(): ReleaseCaseResult {
  const checkId = 'stella-decision-rejected-contract-valid'
  const fixtureId = 'DECISION_REJECTED_INPUT (StellaDecisionInputSchema)'

  const rejectedResult = StellaDecisionInputSchema.safeParse(DECISION_REJECTED_INPUT)

  const controls = [
    controlExpectsVerdict(
      'nc-decision-rejected-reason-over-limit',
      'rejectionReason over the 2000-char limit must be rejected',
      () => StellaDecisionInputSchema.safeParse({ ...DECISION_REJECTED_INPUT, rejectionReason: 'x'.repeat(2001) }).success,
      false,
    ),
  ]

  if (!rejectedResult.success) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `"rejected" rejected by the real schema: ${rejectedResult.error.message}` }, controls)
  }
  return withNegativeControls(
    { checkId, fixtureId, ok: true, outcome: 'pass', detail: '"rejected" accepted with rejectionReason within the 2000-char limit; an over-limit reason is correctly rejected' },
    controls,
  )
}

function checkStellaDecisionRollbackAppendOnly(): ReleaseCaseResult {
  const checkId = 'stella-decision-rollback-append-only'
  const fixtureId = 'DECISION_UNDONE_INPUT (StellaDecisionInputSchema)'

  const undoneResult = StellaDecisionInputSchema.safeParse(DECISION_UNDONE_INPUT)

  const controls = [
    // "Append-only" is a property of the CONTRACT only if nothing in it can
    // target an existing row for mutation. A client-supplied reference to an
    // existing decision row must be rejected by the real .strict() schema —
    // otherwise this would be a comment in decisions.ts, not an enforced rule.
    controlExpectsVerdict(
      'nc-decision-rollback-mutation-field-rejected',
      'a client-supplied decisionId (a reference to an existing row) must be rejected by the strict schema',
      () => StellaDecisionInputSchema.safeParse({ ...DECISION_UNDONE_INPUT, decisionId: 'some-existing-row-id' }).success,
      false,
    ),
  ]

  if (!undoneResult.success) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `"undone" rejected by the real schema: ${undoneResult.error.message}` }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: '"undone" is accepted as a forward-referencing decision value (a new row), and the real strict schema rejects any client-supplied field that could target an existing decision row for mutation — rollback is append-only by construction, not by convention',
    },
    controls,
  )
}

function checkStellaDecisionPersistenceErrorNonLeaking(): ReleaseCaseResult {
  const checkId = 'stella-decision-persistence-error-non-leaking'
  const fixtureId = 'app/actions/stella/decisions.ts (source inspection)'

  const root = process.cwd()
  const relativePath = path.posix.join('app', 'actions', 'stella', 'decisions.ts')
  let source: string
  try {
    source = readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
  } catch (error) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: `could not read ${relativePath}: ${describeError(error)}` }, [])
  }

  const DB_ERROR_RETURN_LITERAL = "return { ok: false, error: 'DB_ERROR', message: 'Failed to record decision. Please try again.' }"
  const SERVER_LOG_NARROWED = "console.error('[stella] recordStellaDecision insert failed:', error instanceof Error ? error.name : 'unknown')"
  const AUDIT_CATCH_SWALLOWED = "} catch (error) {\n    console.error('[stella-audit] audit write failed:', error instanceof Error ? error.name : 'unknown')\n  }"

  const evaluate = (text: string): string[] => {
    const problems: string[] = []
    if (!text.includes(DB_ERROR_RETURN_LITERAL)) {
      problems.push('DB_ERROR does not return the fixed, non-interpolated message literal — a caught error could leak into the user-facing message')
    }
    if (!text.includes(SERVER_LOG_NARROWED)) {
      problems.push('server log does not narrow the caught error down to error.name — a raw error could leak query/connection detail to logs')
    }
    if (!text.includes(AUDIT_CATCH_SWALLOWED)) {
      problems.push('logStellaAudit does not swallow its own failure without rethrowing — an audit-write failure could change the user-facing result')
    }
    return problems
  }

  const controls = [
    controlExpectsViolations(
      'nc-decision-db-error-message-interpolates-error',
      'a DB_ERROR return that interpolates the caught error into its message must be reported',
      () => evaluate(source.replace(
        DB_ERROR_RETURN_LITERAL,
        "return { ok: false, error: 'DB_ERROR', message: `Failed: ${error instanceof Error ? error.message : String(error)}` }",
      )),
    ),
    controlExpectsViolations(
      'nc-decision-audit-failure-rethrown',
      'an audit-log catch block that rethrows must be reported',
      () => evaluate(source.replace(
        AUDIT_CATCH_SWALLOWED,
        "} catch (error) {\n    console.error('[stella-audit] audit write failed:', error instanceof Error ? error.name : 'unknown')\n    throw error\n  }",
      )),
    ),
  ]

  const problems = evaluate(source)
  if (problems.length > 0) {
    return withNegativeControls({ checkId, fixtureId, ok: false, outcome: 'system-error', detail: problems.join(' | ') }, controls)
  }
  return withNegativeControls(
    {
      checkId, fixtureId, ok: true, outcome: 'pass',
      detail: 'DB_ERROR returns a fixed literal message, the server log narrows the caught error to error.name, and logStellaAudit swallows its own failure without rethrowing',
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
  'grounding-project-scope-enforced': checkGroundingProjectScopeEnforced,
  'grounding-provenance-canonical': checkGroundingProvenanceCanonical,
  'grounding-retrieval-score-ordering': checkGroundingRetrievalScoreOrdering,
  'grounding-contradiction-marked': checkGroundingContradictionMarked,
  'grounding-product-adapter-input-complete': checkGroundingProductAdapterInputComplete,
  'stella-decision-feature-flag-blocks-persistence': checkStellaDecisionFeatureFlagBlocksPersistence,
  'stella-decision-accepted-contract-valid': checkStellaDecisionAcceptedContractValid,
  'stella-decision-rejected-contract-valid': checkStellaDecisionRejectedContractValid,
  'stella-decision-rollback-append-only': checkStellaDecisionRollbackAppendOnly,
  'stella-decision-persistence-error-non-leaking': checkStellaDecisionPersistenceErrorNonLeaking,
}

export class ReleaseEvalHarnessError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ReleaseEvalHarnessError'
  }
}

// ---------------------------------------------------------------------------
// Metrics (B-M6)
// ---------------------------------------------------------------------------

/**
 * Why a metric has no value. A bare `null` is indistinguishable from "zero" in
 * a log and from "not computed" in a dashboard, so every null carries a code, a
 * gate when one exists, and a sentence.
 */
export type MetricNullReasonCode =
  | 'requires-provider-call'
  | 'requires-provider-usage-metadata'
  | 'requires-token-usage-and-calibration'
  | 'no-contributing-checks'

export interface MetricNullReason {
  code: MetricNullReasonCode
  /** The external gate that would unblock it, when one is defined. */
  gate: 'G1' | 'G9' | null
  detail: string
}

export interface ReleaseEvalMetricValue {
  metric: ReleaseEvalMetric
  measurable: boolean
  value: number | null
  /** Required whenever `value` is null; absent otherwise. */
  nullReason: MetricNullReason | null
  detail: string
}

export interface ReleaseEvalSummary {
  harnessVersion: string
  matrixVersion: string
  fixturesVersion: string
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
  citationValidationFailures: number
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
 * B-M6: the matrix declared `structural-regression` and nothing emitted it,
 * while two checks declared `latency` that nothing read. Neither drift was
 * detectable, because nothing compared the two catalogs. This does.
 */
function assertMetricsMatchMatrix(
  matrix: readonly ReleaseEvalMatrixEntry[],
  emitted: readonly ReleaseEvalMetricValue[],
): void {
  const declared = new Set<ReleaseEvalMetric>([...matrix.flatMap((e) => e.metrics), ...PROVIDER_DEPENDENT_METRICS])
  const produced = new Set(emitted.map((m) => m.metric))
  for (const metric of declared) {
    if (!produced.has(metric)) throw new ReleaseEvalHarnessError(`matrix declares metric "${metric}" but computeReleaseMetrics never emits it`)
  }
  for (const metric of produced) {
    if (!declared.has(metric)) throw new ReleaseEvalHarnessError(`metric "${metric}" is emitted but no matrix entry declares it`)
  }
  // Every null must say why. A metric reported as a bare null is
  // indistinguishable from zero in a log and from "not computed" in a report.
  for (const metric of emitted) {
    if (metric.value === null && metric.nullReason === null) {
      throw new ReleaseEvalHarnessError(`metric "${metric.metric}" is null with no structured reason`)
    }
    if (metric.value !== null && metric.nullReason !== null) {
      throw new ReleaseEvalHarnessError(`metric "${metric.metric}" carries both a value and a null reason`)
    }
  }
  for (const metric of PROVIDER_DEPENDENT_METRICS) {
    const value = emitted.find((m) => m.metric === metric)
    if (value && (value.measurable || value.value !== null)) {
      throw new ReleaseEvalHarnessError(`provider-dependent metric "${metric}" was reported as measurable offline — this harness makes zero provider calls`)
    }
  }

  assertContributorsMatchMatrix(matrix)
}

/**
 * The metric a `METRIC_CONTRIBUTORS` key feeds. Explicit, because the key names
 * are camelCase abbreviations of the kebab-case metric ids and nothing else in
 * the file relates the two.
 */
const CONTRIBUTOR_METRIC: Record<keyof typeof METRIC_CONTRIBUTORS, ReleaseEvalMetric> = {
  citationPrecision: 'citation-precision',
  citationCoverage: 'citation-coverage',
  isolation: 'isolation-violations',
  abstention: 'abstention-correctness',
  unsupportedClaim: 'unsupported-claim-rate',
  structural: 'structural-regression',
}

/**
 * Per-CHECK reconciliation between the matrix and `METRIC_CONTRIBUTORS`.
 *
 * ADDED BY INTEGRATION (train 2 adversarial review). `assertMetricsMatchMatrix`
 * reconciled only the metric NAME sets, so the two declarations of "which check
 * feeds which metric" — `matrix.ts`'s per-entry `metrics` and this file's
 * `METRIC_CONTRIBUTORS` — could disagree completely while every existing gate
 * passed. Add a 20th matrix entry declaring `metrics: ['citation-precision']`
 * and forget the contributor list, and the check can fail forever without ever
 * moving the metric it claims to feed. That is B-M6 — "a metric declared and
 * nothing reads it" — in its inverse form, in the file written to eliminate it.
 *
 * Both directions are checked, because each catches a different mistake: a
 * matrix entry claiming a metric it does not feed, and a contributor list
 * feeding a metric the matrix entry never declared.
 */
function assertContributorsMatchMatrix(matrix: readonly ReleaseEvalMatrixEntry[]): void {
  const declaredBy = new Map<string, ReadonlySet<ReleaseEvalMetric>>(
    matrix.map((e) => [e.checkId, new Set(e.metrics)]),
  )

  for (const [key, checkIds] of Object.entries(METRIC_CONTRIBUTORS)) {
    const metric = CONTRIBUTOR_METRIC[key as keyof typeof METRIC_CONTRIBUTORS]
    for (const checkId of checkIds) {
      const declared = declaredBy.get(checkId)
      if (!declared) throw new ReleaseEvalHarnessError(`METRIC_CONTRIBUTORS.${key} names "${checkId}", which has no matrix entry`)
      if (!declared.has(metric)) {
        throw new ReleaseEvalHarnessError(
          `check "${checkId}" feeds metric "${metric}" via METRIC_CONTRIBUTORS.${key}, but its matrix entry does not declare it`,
        )
      }
    }
  }

  const fedBy = new Map<ReleaseEvalMetric, ReadonlySet<string>>(
    Object.entries(METRIC_CONTRIBUTORS).map(([key, ids]) => [
      CONTRIBUTOR_METRIC[key as keyof typeof METRIC_CONTRIBUTORS],
      new Set<string>(ids),
    ]),
  )
  for (const entry of matrix) {
    for (const metric of entry.metrics) {
      // Provider-dependent metrics have no contributors by design: no offline
      // check can feed them, which is why they are always null with a reason.
      if (PROVIDER_DEPENDENT_METRICS.includes(metric)) continue
      const contributors = fedBy.get(metric)
      if (!contributors || !contributors.has(entry.checkId)) {
        throw new ReleaseEvalHarnessError(
          `matrix entry "${entry.checkId}" declares metric "${metric}", but METRIC_CONTRIBUTORS does not list it — the check could fail forever without moving the metric`,
        )
      }
    }
  }
}

/**
 * Checks whose failure means a citation itself was wrong — resolved when it
 * should not have, drifted off its passage, crossed a scope, or projected into
 * a PRODUCT reference it cannot support. Listed explicitly rather than matched
 * by substring on the checkId: a rename would silently shrink the gate, and a
 * failure gate that quietly stops covering something is the failure mode this
 * whole unit exists to remove.
 */
const CITATION_VALIDATION_CHECKS: readonly string[] = [
  'sufficient-evidence-citation-resolves',
  'citation-correct-decodes',
  'citation-incorrect-rejected',
  'insufficient-evidence-empty-sentinel',
  'grounding-project-scope-enforced',
  'grounding-provenance-canonical',
  'grounding-product-adapter-input-complete',
]

/** The checks that feed each computed metric, kept beside the matrix declaration. */
const METRIC_CONTRIBUTORS = {
  citationPrecision: ['sufficient-evidence-citation-resolves', 'citation-correct-decodes', 'citation-incorrect-rejected', 'grounding-product-adapter-input-complete'],
  citationCoverage: ['sufficient-evidence-citation-resolves', 'grounding-provenance-canonical'],
  isolation: ['cross-organization-no-leak', 'cross-project-no-leak', 'malicious-document-envelope-holds', 'grounding-project-scope-enforced'],
  // A-F10: quota presentation and reviewer human-review are NOT abstention
  // decisions. They pin a retry/human-review contract and now feed
  // structural-regression instead of inflating abstention correctness.
  abstention: ['insufficient-evidence-empty-sentinel', 'abstention-schema-enforced', 'grounding-contradiction-marked'],
  unsupportedClaim: ['insufficient-evidence-empty-sentinel', 'citation-incorrect-rejected', 'grounding-project-scope-enforced', 'contradiction-acknowledgment-heuristic'],
  structural: [
    'cap-01-05-regression-surface-present', 'retryable-code-set-pinned', 'provider-unavailable-presentation',
    'quota-exhausted-non-retryable', 'human-decision-literal-true', 'grounding-retrieval-score-ordering',
    'stella-decision-feature-flag-blocks-persistence', 'stella-decision-accepted-contract-valid',
    'stella-decision-rejected-contract-valid', 'stella-decision-rollback-append-only',
    'stella-decision-persistence-error-non-leaking',
  ],
} as const

function ratio(passed: number, total: number): number | null {
  return total === 0 ? null : passed / total
}

const NO_CONTRIBUTORS: MetricNullReason = {
  code: 'no-contributing-checks',
  gate: null,
  detail: 'no check in the current matrix feeds this metric; a ratio over zero samples is not zero',
}

export function computeReleaseMetrics(results: readonly ReleaseCaseResult[]): ReleaseEvalMetricValue[] {
  const byId = new Map(results.map((r) => [r.checkId, r]))
  const ok = (id: string) => byId.get(id)?.ok === true
  const present = (ids: readonly string[]) => ids.filter((id) => byId.has(id))
  const score = (ids: readonly string[]) => {
    const live = present(ids)
    return { passed: live.filter(ok).length, total: live.length }
  }

  const citation = score(METRIC_CONTRIBUTORS.citationPrecision)
  const coverage = score(METRIC_CONTRIBUTORS.citationCoverage)
  const abstention = score(METRIC_CONTRIBUTORS.abstention)
  const unsupported = score(METRIC_CONTRIBUTORS.unsupportedClaim)
  const structural = score(METRIC_CONTRIBUTORS.structural)
  const isolationViolations = present(METRIC_CONTRIBUTORS.isolation)
    .filter((id) => byId.get(id)?.outcome === 'isolation-violation').length

  const metrics: ReleaseEvalMetricValue[] = [
    {
      metric: 'citation-precision',
      measurable: true,
      value: ratio(citation.passed, citation.total),
      nullReason: citation.total === 0 ? NO_CONTRIBUTORS : null,
      detail: `${citation.passed}/${citation.total} citation checks resolved/rejected/projected correctly`,
    },
    {
      metric: 'citation-coverage',
      measurable: true,
      value: ratio(coverage.passed, coverage.total),
      nullReason: coverage.total === 0 ? NO_CONTRIBUTORS : null,
      detail: `${coverage.passed}/${coverage.total}: real evidence in context is reachable via a valid citation AND that citation's provenance chain closes`,
    },
    {
      metric: 'unsupported-claim-rate',
      measurable: true,
      value: unsupported.total === 0 ? null : 1 - unsupported.passed / unsupported.total,
      nullReason: unsupported.total === 0 ? NO_CONTRIBUTORS : null,
      detail: `${unsupported.passed}/${unsupported.total} unsupported-claim canaries correctly rejected (rate = 1 - caught/total)`,
    },
    {
      metric: 'abstention-correctness',
      measurable: true,
      value: ratio(abstention.passed, abstention.total),
      nullReason: abstention.total === 0 ? NO_CONTRIBUTORS : null,
      detail: `${abstention.passed}/${abstention.total} genuine abstention contracts held (A-F10: quota presentation and reviewer human-review moved to structural-regression — neither is an abstention decision)`,
    },
    {
      metric: 'isolation-violations',
      measurable: true,
      value: isolationViolations,
      nullReason: null,
      detail: `${isolationViolations} structural cross-tenant/cross-project/prompt-injection leaks across ${present(METRIC_CONTRIBUTORS.isolation).length} checks (application + grounding-contract layer only, not RLS — see G3)`,
    },
    {
      metric: 'structural-regression',
      measurable: true,
      value: ratio(structural.passed, structural.total),
      nullReason: structural.total === 0 ? NO_CONTRIBUTORS : null,
      detail: `${structural.passed}/${structural.total} pinned structural contracts held (CAP-01..05 surface, retry semantics, quota/provider presentation, reviewer human-review literal, retrieval score ordering)`,
    },
    {
      metric: 'latency',
      measurable: false,
      value: null,
      nullReason: {
        code: 'requires-provider-call',
        gate: 'G1',
        detail: 'this harness makes zero provider calls by design, so there is no round-trip to time. Harness wall-clock is reported separately under summary observations and is NOT provider latency — it measures module transformation cost on the host that ran it.',
      },
      detail: 'provider round-trip latency — requires gate G1',
    },
    {
      metric: 'token-usage',
      measurable: false,
      value: null,
      nullReason: {
        code: 'requires-provider-usage-metadata',
        gate: 'G1',
        detail: 'requires a real provider response carrying usage metadata; no offline substitute exists and estimating it would fabricate the baseline this harness refuses to invent',
      },
      detail: 'prompt + completion tokens per interaction — requires gate G1',
    },
    {
      metric: 'estimated-provider-cost',
      measurable: false,
      value: null,
      nullReason: {
        code: 'requires-token-usage-and-calibration',
        gate: 'G9',
        detail: 'derived from token-usage via lib/stella/cost-model.ts, which is blocked on G1; the pricing constants there are themselves flagged as uncalibrated pending G9, so even with tokens the number would carry two unquantified errors',
      },
      detail: 'estimated cost per interaction — requires gate G1 for tokens and gate G9 for calibration',
    },
  ]

  return metrics
}

export interface ReleaseEvalRun {
  summary: ReleaseEvalSummary
  results: ReleaseCaseResult[]
  /**
   * Measurements that are real but NOT deterministic, kept out of `summary` so
   * two runs of the same matrix produce byte-identical structured output.
   */
  observations: { harnessWallClockMs: number }
}

export function runReleaseEvalHarness(
  matrix: readonly ReleaseEvalMatrixEntry[] = RELEASE_EVAL_MATRIX,
): ReleaseEvalRun {
  validateReleaseEvalMatrix(matrix)
  assertChecksMatchMatrix(matrix)
  // A renamed check must not silently drop out of the citation failure gate.
  for (const id of CITATION_VALIDATION_CHECKS) {
    if (!(id in CHECKS)) throw new ReleaseEvalHarnessError(`CITATION_VALIDATION_CHECKS names "${id}", which is not an implemented check`)
  }
  for (const ids of Object.values(METRIC_CONTRIBUTORS)) {
    for (const id of ids) {
      if (!(id in CHECKS)) throw new ReleaseEvalHarnessError(`METRIC_CONTRIBUTORS names "${id}", which is not an implemented check`)
    }
  }

  const startedAt = Date.now()
  const results = matrix.map((entry) => CHECKS[entry.checkId]!())
  const harnessWallClockMs = Date.now() - startedAt

  const metrics = computeReleaseMetrics(results)
  assertMetricsMatchMatrix(matrix, metrics)

  const offlineMeasurable = new Set(matrix.filter((e) => e.offlineMeasurable).map((e) => e.checkId))
  const allControls = results.flatMap((r) => r.negativeControls)

  const summary: ReleaseEvalSummary = {
    harnessVersion: RELEASE_HARNESS_VERSION,
    matrixVersion: RELEASE_EVAL_MATRIX_VERSION,
    fixturesVersion: RELEASE_FIXTURES_VERSION,
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
    citationValidationFailures: results.filter((r) => !r.ok && CITATION_VALIDATION_CHECKS.includes(r.checkId)).length,
    providerCalls: 0,
    metrics,
  }

  return { summary, results, observations: { harnessWallClockMs } }
}

/**
 * Why the process must exit non-zero, or an empty list.
 *
 * Lives here rather than inside the CLI so the gates are testable against
 * synthetic summaries: "the process fails on an isolation violation" is a
 * claim that has to be provable without engineering a real tenant leak.
 * Every gate is evaluated — a run that both leaked across tenants AND
 * fabricated a citation reports both, because collapsing them into the first
 * failure is how the second one gets fixed a release later.
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
  if (summary.citationValidationFailures > 0) {
    reasons.push(`${summary.citationValidationFailures} citation validation failure(s) — a citation resolved, drifted or projected incorrectly`)
  }
  if (summary.systemErrors > 0) reasons.push(`${summary.systemErrors} system error(s)`)
  if (summary.providerCalls !== 0) reasons.push('harness made a provider call — must stay fully offline')
  return reasons
}
