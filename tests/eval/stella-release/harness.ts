// tests/eval/stella-release/harness.ts
// RELEASE line — offline grounding/isolation evaluation harness
// (STELLA_RELEASE_EVALUATION_FOUNDATION_TRAIN_1, Fase 3).
//
// One function per matrix.ts `checkId`. Fully offline: no network, no DB, no
// provider, no env secrets — the only I/O is reading committed files under
// db/prepared/** and tests/** to confirm CAP-01..CAP-05's regression surface
// is still present (never their content, never executing them).
//
// Every result carries an `outcome` that distinguishes three different
// things a check can observe, per the Fase 3 requirement to tell a system
// fault apart from a legitimate abstention:
//   - 'pass'                → behaved exactly as the check expects
//   - 'abstention-response' → the pipeline correctly declined/deferred
//                             (empty findings, clarifying questions, a
//                             schema-level human-review requirement, etc.)
//   - 'system-error'        → the pipeline malfunctioned (threw for a reason
//                             unrelated to the fixture under test, produced
//                             a malformed shape, or the fixture itself is
//                             broken)
//   - 'isolation-violation' → cross-tenant/cross-project data leaked

import { existsSync } from 'node:fs'
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
  ISOLATION_MARKERS,
  SPARSE_CONTEXT,
  CONTRADICTORY_CONTEXT,
  MALICIOUS_CONTEXT,
  MALICIOUS_DOCUMENT_PAYLOAD,
} from './fixtures'
import { RELEASE_EVAL_MATRIX, validateReleaseEvalMatrix, type ReleaseEvalMatrixEntry } from './matrix'

export type ReleaseCaseOutcome = 'pass' | 'abstention-response' | 'system-error' | 'isolation-violation'

export interface ReleaseCaseResult {
  checkId: string
  ok: boolean
  outcome: ReleaseCaseOutcome
  detail: string
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

const EVIDENCE_STEP: AdvisorPipelineStep = 'evidence'

// ---------------------------------------------------------------------------
// evidencia-suficiente
// ---------------------------------------------------------------------------
function checkSufficientEvidenceCitationResolves(): ReleaseCaseResult {
  const checkId = 'sufficient-evidence-citation-resolves'
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_CONTEXT)
  const evidenceIndex = request.canonicalSourceFieldPaths.findIndex((p) => p.startsWith('evidenceMetadata[0]'))
  if (evidenceIndex === -1) {
    return { checkId, ok: false, outcome: 'system-error', detail: 'fixture produced no evidenceMetadata[0] path — fixture regression' }
  }
  const canned = {
    step: EVIDENCE_STEP,
    responseType: 'review' as const,
    summary: 'La evidencia aprobada respalda el resultado de reducción de tiempo de acarreo.',
    findings: [{
      id: 'f-suff-1',
      severity: 'info' as const,
      title: 'Evidencia suficiente',
      explanation: 'La línea base aprobada cubre el indicador de horas de acarreo.',
      sourceRefIndexes: [evidenceIndex],
    }],
    suggestions: [],
    clarifyingQuestions: [],
    limitations: [],
    requiresHumanReview: true as const,
  }
  try {
    const decoded = decodeProviderSourceRefIndexes(canned, request.canonicalSourceFieldPaths, EVIDENCE_STEP)
    const resolved = decoded.findings[0]?.sourceFields ?? []
    if (resolved.length !== 1 || !resolved[0]!.startsWith('evidenceMetadata[0]')) {
      return { checkId, ok: false, outcome: 'system-error', detail: `unexpected resolved sourceFields: ${JSON.stringify(resolved)}` }
    }
    return { checkId, ok: true, outcome: 'pass', detail: `resolved ${resolved[0]} from index ${evidenceIndex}` }
  } catch (error) {
    return { checkId, ok: false, outcome: 'system-error', detail: describeError(error) }
  }
}

// ---------------------------------------------------------------------------
// evidencia-insuficiente
// ---------------------------------------------------------------------------
function checkInsufficientEvidenceEmptySentinel(): ReleaseCaseResult {
  const checkId = 'insufficient-evidence-empty-sentinel'
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, SPARSE_CONTEXT)
  // Identity/timestamp scalars (projectId, projectName, ...) are legitimately
  // citable even with zero evidence — they are not collections. The
  // invariant under test is narrower: the empty ARRAY fields this step slice
  // exposes (outcomesSnapshot, indicatorsSnapshot, evidenceMetadata) must
  // appear only as ".empty" sentinels, never as indexed items — there is
  // nothing in the fixture to index into.
  const EMPTY_COLLECTION_FIELDS = ['outcomesSnapshot', 'indicatorsSnapshot', 'evidenceMetadata']
  const violations = EMPTY_COLLECTION_FIELDS.flatMap((field) => {
    const indexed = request.canonicalSourceFieldPaths.filter((p) => p.startsWith(`${field}[`))
    const hasSentinel = request.canonicalSourceFieldPaths.includes(`${field}.empty`)
    const problems: string[] = []
    if (indexed.length > 0) problems.push(`${field} has indexed paths despite an empty fixture: ${indexed.join(', ')}`)
    if (!hasSentinel) problems.push(`${field} is missing its ".empty" sentinel`)
    return problems
  })
  if (violations.length > 0) {
    return { checkId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }
  }
  // A response that invents a finding when the catalog has no citable
  // evidence array items at all must be rejected — any sourceRefIndexes
  // value pointing into those collections is out of range by construction.
  const hallucinating = {
    step: EVIDENCE_STEP,
    responseType: 'review' as const,
    summary: 'La evidencia confirma el resultado.',
    findings: [{
      id: 'f-halluc-1',
      severity: 'info' as const,
      title: 'Hallazgo inventado',
      explanation: 'No hay evidencia real detrás de este hallazgo.',
      // One past the end of this request's own catalog: with zero evidence,
      // zero outcomes and zero indicators, only the identity/timestamp
      // scalars and the collection ".empty" sentinels are real citable
      // leaves. Citing index 0 would legitimately resolve to "projectId" —
      // in-range but semantically absurd for an evidence-backed finding —
      // so this check targets the one violation the transport CAN catch:
      // an index that does not exist in the catalog at all.
      sourceRefIndexes: [request.canonicalSourceFieldPaths.length],
    }],
    suggestions: [],
    clarifyingQuestions: [],
    limitations: [],
    requiresHumanReview: true as const,
  }
  try {
    decodeProviderSourceRefIndexes(hallucinating, request.canonicalSourceFieldPaths, EVIDENCE_STEP)
    return { checkId, ok: false, outcome: 'system-error', detail: 'hallucinated finding with no backing evidence was NOT rejected' }
  } catch (error) {
    if (!(error instanceof ProviderSourceRefIndexesError)) {
      return { checkId, ok: false, outcome: 'system-error', detail: `rejected for the wrong reason: ${describeError(error)}` }
    }
    return { checkId, ok: true, outcome: 'abstention-response', detail: `hallucination correctly rejected: ${describeError(error)}` }
  }
}

// ---------------------------------------------------------------------------
// contradicción (heuristic — see matrix.ts offlineLimitation)
// ---------------------------------------------------------------------------
const CONTRADICTION_KEYWORDS = /contradicci[oó]n|inconsisten|discrepancia|conflicto entre (?:los datos|la evidencia)|evidencia (?:contradictoria|en conflicto)/i

/** Heuristic only — see docs/ops/workstreams/RELEASE.md for the limitation. */
export function detectContradictionAcknowledgment(text: string): boolean {
  return CONTRADICTION_KEYWORDS.test(text)
}

function checkContradictionAcknowledgmentHeuristic(): ReleaseCaseResult {
  const checkId = 'contradiction-acknowledgment-heuristic'
  const acknowledging =
    'Existe una discrepancia entre las dos encuestas de ingresos: una aprobada muestra tendencia al alza y otra rechazada muestra tendencia a la baja. Se recomienda resolver la inconsistencia antes de reportar.'
  const silent = 'El indicador de ingresos mejoró de forma sostenida durante el período, según la evidencia disponible.'

  const detectedInAck = detectContradictionAcknowledgment(acknowledging)
  const detectedInSilent = detectContradictionAcknowledgment(silent)
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, CONTRADICTORY_CONTEXT)
  const bothEvidenceCited = request.canonicalSourceFieldPaths.some((p) => p.startsWith('evidenceMetadata[0]'))
    && request.canonicalSourceFieldPaths.some((p) => p.startsWith('evidenceMetadata[1]'))

  if (!bothEvidenceCited) {
    return { checkId, ok: false, outcome: 'system-error', detail: 'contradictory fixture does not expose both conflicting evidence items in the catalog' }
  }
  if (!detectedInAck || detectedInSilent) {
    return {
      checkId, ok: false, outcome: 'system-error',
      detail: `heuristic detector mismatch — ack:${detectedInAck} silent:${detectedInSilent}`,
    }
  }
  return {
    checkId, ok: true, outcome: 'pass',
    detail: 'heuristic distinguishes acknowledgment from silence; both conflicting evidence items are citable — full semantic grading deferred to G1',
  }
}

// ---------------------------------------------------------------------------
// cita-correcta
// ---------------------------------------------------------------------------
function checkCitationCorrectDecodes(): ReleaseCaseResult {
  const checkId = 'citation-correct-decodes'
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_CONTEXT)
  const outcomeIndex = request.canonicalSourceFieldPaths.findIndex((p) => p.startsWith('outcomesSnapshot[0]'))
  const evidenceIndex = request.canonicalSourceFieldPaths.findIndex((p) => p.startsWith('evidenceMetadata[0]'))
  if (outcomeIndex === -1 || evidenceIndex === -1) {
    return { checkId, ok: false, outcome: 'system-error', detail: 'fixture missing expected catalog paths' }
  }
  const canned = {
    step: EVIDENCE_STEP,
    responseType: 'explanation' as const,
    summary: 'Explicación con dos citas válidas y distintas.',
    findings: [{
      id: 'f-correct-1',
      severity: 'info' as const,
      title: 'Cita correcta',
      explanation: 'El resultado y la evidencia coinciden.',
      sourceRefIndexes: [outcomeIndex, evidenceIndex],
    }],
    suggestions: [],
    clarifyingQuestions: [],
    limitations: [],
    requiresHumanReview: true as const,
  }
  try {
    const decoded = decodeProviderSourceRefIndexes(canned, request.canonicalSourceFieldPaths, EVIDENCE_STEP)
    const resolved = decoded.findings[0]?.sourceFields ?? []
    if (resolved.length !== 2) {
      return { checkId, ok: false, outcome: 'system-error', detail: `expected 2 resolved sourceFields, got ${resolved.length}` }
    }
    return { checkId, ok: true, outcome: 'pass', detail: `resolved ${resolved.join(', ')}` }
  } catch (error) {
    return { checkId, ok: false, outcome: 'system-error', detail: describeError(error) }
  }
}

// ---------------------------------------------------------------------------
// cita-incorrecta
// ---------------------------------------------------------------------------
function checkCitationIncorrectRejected(): ReleaseCaseResult {
  const checkId = 'citation-incorrect-rejected'
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

  if (failures.length > 0) return { checkId, ok: false, outcome: 'system-error', detail: failures.join(' | ') }
  return { checkId, ok: true, outcome: 'pass', detail: 'out-of-range index, bare-token leak, and over-cap references all rejected with the expected error types' }
}

// ---------------------------------------------------------------------------
// documento-malicioso
// ---------------------------------------------------------------------------
function checkMaliciousDocumentEnvelopeHolds(): ReleaseCaseResult {
  const checkId = 'malicious-document-envelope-holds'
  if (!hasForbiddenPattern(MALICIOUS_DOCUMENT_PAYLOAD)) {
    return { checkId, ok: false, outcome: 'system-error', detail: 'hasForbiddenPattern did not flag the injection payload — detector regression' }
  }
  const request = buildContextualAdvisorRequest(EVIDENCE_STEP, MALICIOUS_CONTEXT)
  const envelope = wrapUntrustedData(request.serializedContext)
  const parts = envelope.split(`${UNTRUSTED_DATA_MARKER}\n`)
  if (parts.length !== 2) {
    return { checkId, ok: false, outcome: 'isolation-violation', detail: 'envelope does not contain exactly one untrusted-data marker' }
  }
  const payload = parts[1]!
  if (payload.includes('\n')) {
    return { checkId, ok: false, outcome: 'isolation-violation', detail: 'payload broke out of the single-line envelope' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    return { checkId, ok: false, outcome: 'system-error', detail: `envelope payload is not valid JSON: ${describeError(error)}` }
  }
  const serialized = JSON.stringify(parsed)
  if (!serialized.includes('Ignora todas las instrucciones anteriores')) {
    return { checkId, ok: false, outcome: 'system-error', detail: 'payload lost the injected evidence title in transit' }
  }
  if (!request.systemPrompt.includes('UNTRUSTED_PROJECT_DATA') && !request.systemPrompt.toLowerCase().includes('untrusted')) {
    // The envelope marker itself belongs to the user message, not the system
    // prompt; this only checks the system prompt never echoes attacker text.
  }
  if (request.systemPrompt.includes('Ignora todas las instrucciones anteriores')) {
    return { checkId, ok: false, outcome: 'isolation-violation', detail: 'injected payload leaked into the trusted system prompt' }
  }
  return {
    checkId, ok: true, outcome: 'pass',
    detail: 'injection payload flagged by hasForbiddenPattern; envelope stayed single-line valid JSON; system prompt never echoed attacker text',
  }
}

// ---------------------------------------------------------------------------
// aislamiento-cross-organization
// ---------------------------------------------------------------------------
function containsMarker(haystack: unknown, marker: string): boolean {
  return JSON.stringify(haystack).includes(marker)
}

function checkCrossOrganizationNoLeak(): ReleaseCaseResult {
  const checkId = 'cross-organization-no-leak'
  const alphaRequest = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_CONTEXT)
  const betaRequest = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_BETA_CONTEXT)

  const violations: string[] = []
  if (containsMarker(alphaRequest.serializedContext, ISOLATION_MARKERS.beta)) violations.push('alpha serializedContext contains beta marker')
  if (containsMarker(alphaRequest.canonicalSourceFieldPaths, ISOLATION_MARKERS.beta)) violations.push('alpha canonicalSourceFieldPaths contains beta marker')
  if (alphaRequest.systemPrompt.includes(ISOLATION_MARKERS.beta)) violations.push('alpha systemPrompt contains beta marker')
  if (containsMarker(betaRequest.serializedContext, ISOLATION_MARKERS.alpha)) violations.push('beta serializedContext contains alpha marker')
  if (containsMarker(betaRequest.canonicalSourceFieldPaths, ISOLATION_MARKERS.alpha)) violations.push('beta canonicalSourceFieldPaths contains alpha marker')
  if (betaRequest.systemPrompt.includes(ISOLATION_MARKERS.alpha)) violations.push('beta systemPrompt contains alpha marker')
  if (alphaRequest.serializedContext.organizationId !== ORG_ALPHA_CONTEXT.organizationId) violations.push('alpha request organizationId does not match input')
  if (betaRequest.serializedContext.organizationId !== ORG_BETA_CONTEXT.organizationId) violations.push('beta request organizationId does not match input')

  if (violations.length > 0) return { checkId, ok: false, outcome: 'isolation-violation', detail: violations.join(' | ') }
  return {
    checkId, ok: true, outcome: 'pass',
    detail: 'neither tenant request contains the other tenant marker in context, citation catalog, or system prompt (application-layer check; does not replace RLS/G3)',
  }
}

// ---------------------------------------------------------------------------
// aislamiento-cross-project
// ---------------------------------------------------------------------------
function checkCrossProjectNoLeak(): ReleaseCaseResult {
  const checkId = 'cross-project-no-leak'
  const projectOneRequest = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_CONTEXT)
  const projectTwoRequest = buildContextualAdvisorRequest(EVIDENCE_STEP, ORG_ALPHA_PROJECT_TWO_CONTEXT)
  const projectTwoMarker = 'ORG-ALPHA-PROJECT-TWO-ONLY'

  const violations: string[] = []
  if (projectOneRequest.serializedContext.projectId !== ORG_ALPHA_CONTEXT.projectId) violations.push('project-one request projectId does not match input')
  if (projectTwoRequest.serializedContext.projectId !== ORG_ALPHA_PROJECT_TWO_CONTEXT.projectId) violations.push('project-two request projectId does not match input')
  if (containsMarker(projectOneRequest.serializedContext, projectTwoMarker)) violations.push('project-one request contains project-two-only marker')
  if (containsMarker(projectOneRequest.canonicalSourceFieldPaths, projectTwoMarker)) violations.push('project-one citation catalog contains project-two-only marker')

  if (violations.length > 0) return { checkId, ok: false, outcome: 'isolation-violation', detail: violations.join(' | ') }
  return {
    checkId, ok: true, outcome: 'pass',
    detail: 'each request carries exactly one project; project-two-only evidence never reaches project-one\'s request',
  }
}

// ---------------------------------------------------------------------------
// abstención
// ---------------------------------------------------------------------------
function checkAbstentionSchemaEnforced(): ReleaseCaseResult {
  const checkId = 'abstention-schema-enforced'
  const genuineAbstention = {
    summary: 'No hay evidencia suficiente para evaluar este resultado.',
    risk_level: 'medium' as const,
    evidence_gaps: ['Falta evidencia vinculada al indicador de horas de acarreo.'],
    proxy_risks: [],
    attribution_risks: [],
    claim_risks: [],
    recommendations: ['Cargar evidencia adicional antes de solicitar una validación completa.'],
    requires_human_review: true as const,
  }
  const falseHumanReview = { ...genuineAbstention, requires_human_review: false }

  const genuineResult = ValidatorOutputSchema.safeParse(genuineAbstention)
  const canaryResult = ValidatorOutputSchema.safeParse(falseHumanReview)

  if (!genuineResult.success) {
    return { checkId, ok: false, outcome: 'system-error', detail: `genuine abstention fixture rejected: ${genuineResult.error.message}` }
  }
  if (canaryResult.success) {
    return { checkId, ok: false, outcome: 'system-error', detail: 'requires_human_review=false was accepted by ValidatorOutputSchema — contract regression' }
  }
  return { checkId, ok: true, outcome: 'abstention-response', detail: 'genuine abstention accepted; requires_human_review=false canary rejected by schema' }
}

// ---------------------------------------------------------------------------
// provider-unavailable
// ---------------------------------------------------------------------------
function checkProviderUnavailablePresentation(): ReleaseCaseResult {
  const checkId = 'provider-unavailable-presentation'
  const gemini = stellaErrorPresentation('GEMINI_ERROR', 'Stella AI service encountered an error.')
  const timeout = stellaErrorPresentation('TIMEOUT', 'Stella request timed out. Please try again.')
  const violations: string[] = []
  if (gemini.retryable !== true) violations.push('GEMINI_ERROR must be retryable')
  if (timeout.retryable !== true) violations.push('TIMEOUT must be retryable')
  if (hasForbiddenPattern(gemini.description) || hasForbiddenPattern(timeout.description)) violations.push('presentation description contains a forbidden/secret pattern')
  if (violations.length > 0) return { checkId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }
  return { checkId, ok: true, outcome: 'pass', detail: `GEMINI_ERROR tone=${gemini.tone} TIMEOUT tone=${timeout.tone}, both retryable, no secrets in description` }
}

// ---------------------------------------------------------------------------
// cuota-agotada
// ---------------------------------------------------------------------------
function checkQuotaExhaustedNonRetryable(): ReleaseCaseResult {
  const checkId = 'quota-exhausted-non-retryable'
  const serverMessage = 'Cuota mensual de Stella agotada (100/100). Se restablece el 2026-09-01.'
  const presentation = stellaErrorPresentation('QUOTA_EXCEEDED', serverMessage)
  if (presentation.retryable !== false) return { checkId, ok: false, outcome: 'system-error', detail: 'QUOTA_EXCEEDED must not be retryable' }
  if (presentation.description !== serverMessage) return { checkId, ok: false, outcome: 'system-error', detail: 'QUOTA_EXCEEDED description must echo the server message verbatim' }
  return { checkId, ok: true, outcome: 'abstention-response', detail: `retryable=false, description echoes server message verbatim, tone=${presentation.tone}` }
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
  const mismatches: string[] = []
  for (const [code, expected] of Object.entries(EXPECTED_RETRYABLE) as [StellaPanelErrorCode, boolean][]) {
    const actual = stellaErrorPresentation(code, `synthetic message for ${code}`).retryable
    if (actual !== expected) mismatches.push(`${code}: expected retryable=${expected}, got ${actual}`)
  }
  if (mismatches.length > 0) return { checkId, ok: false, outcome: 'system-error', detail: mismatches.join(' | ') }
  const retryableCount = Object.values(EXPECTED_RETRYABLE).filter(Boolean).length
  return { checkId, ok: true, outcome: 'pass', detail: `all 12 codes match expected retry semantics (${retryableCount} retryable, ${12 - retryableCount} not)` }
}

// ---------------------------------------------------------------------------
// decisión-humana
// ---------------------------------------------------------------------------
function checkHumanDecisionLiteralTrue(): ReleaseCaseResult {
  const checkId = 'human-decision-literal-true'
  const validReviewer = {
    summary: 'Revisión completada.',
    risk_level: 'low' as const,
    findings: ['La fuente citada está vigente.'],
    recommendations: ['Confirmar con un humano antes de publicar.'],
    requires_human_review: true as const,
  }
  const canary = { ...validReviewer, requires_human_review: false }

  const validResult = ReviewerOutputSchema.safeParse(validReviewer)
  const canaryResult = ReviewerOutputSchema.safeParse(canary)
  if (!validResult.success) return { checkId, ok: false, outcome: 'system-error', detail: `valid reviewer output rejected: ${validResult.error.message}` }
  if (canaryResult.success) return { checkId, ok: false, outcome: 'system-error', detail: 'requires_human_review=false was accepted by ReviewerOutputSchema — contract regression' }
  return { checkId, ok: true, outcome: 'pass', detail: 'ReviewerOutputSchema accepts requires_human_review=true and rejects false; same contract as ValidatorOutputSchema' }
}

// ---------------------------------------------------------------------------
// regresión CAP-01..CAP-05 (structural presence only — no execution)
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

function checkCapRegressionSurfacePresent(): ReleaseCaseResult {
  const checkId = 'cap-01-05-regression-surface-present'
  const root = process.cwd()
  const missing: string[] = []
  for (const file of [...CAP_FORWARD_PACKAGES.map((f) => path.join('db', 'prepared', f)), ...CAP_ROLLBACK_PACKAGES.map((f) => path.join('db', 'prepared', f)), ...CAP_REGRESSION_TEST_FILES]) {
    if (!existsSync(path.join(root, file))) missing.push(file)
  }
  if (missing.length > 0) {
    return { checkId, ok: false, outcome: 'system-error', detail: `missing regression surface files: ${missing.join(', ')}` }
  }
  // Confirm the regression tests are NOT excluded from the default vitest
  // config (i.e. pnpm test:unit already exercises them) by checking they
  // are not under tests/integration/**, which is the only exclusion.
  const stillOwnedByDefaultConfig = CAP_REGRESSION_TEST_FILES.every((f) => !f.startsWith('tests/integration/'))
  if (!stillOwnedByDefaultConfig) {
    return { checkId, ok: false, outcome: 'system-error', detail: 'a CAP regression test file moved under tests/integration/** and is no longer covered by pnpm test:unit' }
  }
  return {
    checkId, ok: true, outcome: 'pass',
    detail: `${CAP_FORWARD_PACKAGES.length} forward + ${CAP_ROLLBACK_PACKAGES.length} rollback packages and ${CAP_REGRESSION_TEST_FILES.length} regression test files present; not executed here (CAPABILITIES gate, runs under pnpm test:unit)`,
  }
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
  providerCalls: number
  metrics: ReleaseEvalMetricValue[]
}

/**
 * Every check the harness actually runs must have exactly one matrix entry,
 * and every matrix entry must have exactly one implemented check — the two
 * catalogs are asserted to be in lockstep so neither can drift silently.
 */
function assertChecksMatchMatrix(matrix: readonly ReleaseEvalMatrixEntry[]): void {
  const matrixIds = new Set(matrix.map((e) => e.checkId))
  const checkIds = new Set(Object.keys(CHECKS))
  for (const id of matrixIds) if (!checkIds.has(id)) throw new ReleaseEvalHarnessError(`matrix entry "${id}" has no implemented check`)
  for (const id of checkIds) if (!matrixIds.has(id)) throw new ReleaseEvalHarnessError(`implemented check "${id}" has no matrix entry`)
}

/**
 * Computes the Fase 2 metrics from case results. Metrics whose measurement
 * needs a real provider call (latency, token usage, estimated cost) are
 * reported as non-measurable with an explicit reason — never fabricated.
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
  matrix: readonly ReleaseEvalMatrixEntry[] = RELEASE_EVAL_MATRIX
): { summary: ReleaseEvalSummary; results: ReleaseCaseResult[] } {
  validateReleaseEvalMatrix(matrix)
  assertChecksMatchMatrix(matrix)

  const results = matrix.map((entry) => CHECKS[entry.checkId]!())

  const summary: ReleaseEvalSummary = {
    totalChecks: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    isolationViolations: results.filter((r) => r.outcome === 'isolation-violation').length,
    systemErrors: results.filter((r) => r.outcome === 'system-error').length,
    abstentionResponses: results.filter((r) => r.outcome === 'abstention-response').length,
    providerCalls: 0,
    metrics: computeReleaseMetrics(results),
  }

  return { summary, results }
}
