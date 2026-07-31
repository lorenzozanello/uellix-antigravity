// tests/eval/stella-roles/harness.ts
// WS6 (Fable Moonshot) U3: offline evaluation harness for the non-advisor
// Stella roles. Pipeline per case, mirroring the production order:
//
//   1. prompt/envelope integrity (system prompt + untrusted-data envelope)
//   2. output schema contract (zod parse, incl. requires_human_review: true)
//   3. text detectors — methodology safety + numeric integrity, over EVERY
//      free-text field (imported from tests/eval/stella-contextual/harness,
//      the advisor's detector helpers — not copied)
//   4. composer-only integrity guards (reference ids ⊆ context ids; numeric
//      tokens traceable to the authorized set)
//
// Zero network, zero DB, zero provider calls.

import {
  detectMethodologySafety,
  detectNumericIntegrity,
} from '../stella-contextual/harness'
import type { ContextualAdvisorContext } from '@/lib/stella/context/types'
import type { StellaProjectContext } from '@/lib/stella/context/types'
import { ValidatorOutputSchema, VALIDATOR_OUTPUT_SCHEMA_VERSION } from '@/lib/stella/schemas/validator-output'
import { ComposerOutputSchema, COMPOSER_OUTPUT_SCHEMA_VERSION, type ComposerOutput } from '@/lib/stella/schemas/composer-output'
import { ReviewerOutputSchema, REVIEWER_OUTPUT_SCHEMA_VERSION } from '@/lib/stella/schemas/reviewer-output'
import {
  validateComposerNumbers,
  validateComposerReferences,
  authorizedNumbersFromSnapshot,
} from '@/lib/stella/schemas/composer-numeric-guard'
import { buildValidatorSystemPrompt, buildValidatorUserMessage } from '@/lib/stella/prompts/validator-system'
import { buildComposerSystemPrompt, buildComposerUserMessage } from '@/lib/stella/prompts/composer-system'
import { buildReviewerSystemPrompt, buildReviewerUserMessage } from '@/lib/stella/prompts/reviewer-system'
import { UNTRUSTED_DATA_MARKER } from '@/lib/stella/context/sanitize'
import {
  OFFICIAL_ROLE_EVAL_CASES,
  type RoleEvalCase,
  type RoleRejectionReason,
} from './cases'

export class RoleEvalHarnessError extends Error {
  constructor(readonly category: string, reason: string) {
    super(`${category}: ${reason}`)
    this.name = 'RoleEvalHarnessError'
  }
}

export interface RoleCaseResult {
  caseId: string
  role: RoleEvalCase['role']
  expectation: 'pass' | 'reject'
  rejection: RoleRejectionReason | null
  rejectionDetail: string | null
  /** Case verdict: did the pipeline behave as the expectation demands? */
  ok: boolean
}

export interface RoleEvalSummary {
  totalCases: number
  processedCases: number
  uniqueCaseIds: number
  casesPassed: number
  casesFailed: number
  passExpectedCases: number
  canaryCases: number
  canariesRejected: number
  byRole: Record<RoleEvalCase['role'], { total: number; passed: number }>
  contractVersions: { validator: string; composer: string; reviewer: string }
  providerCalls: number
  geminiCalls: number
}

// ---------------------------------------------------------------------------
// Catalog validation
// ---------------------------------------------------------------------------

const REQUIRED_MINIMUMS: ReadonlyArray<{ role: RoleEvalCase['role']; min: number }> = [
  { role: 'validator', min: 3 },
  { role: 'composer', min: 3 },
  { role: 'proxy_reviewer', min: 1 },
  { role: 'evidence_reviewer', min: 2 }, // realistic + fixture-grounded (RK-27)
  { role: 'audit_assistant', min: 1 },
]

export function validateRoleEvalCatalog(cases: readonly RoleEvalCase[]): void {
  const ids = new Set<string>()
  for (const item of cases) {
    if (!item.caseId || ids.has(item.caseId)) {
      throw new RoleEvalHarnessError('catalog-case-id', `missing or duplicated caseId "${item.caseId}"`)
    }
    ids.add(item.caseId)
    if (item.expectation === 'reject' && !item.expectedRejection) {
      throw new RoleEvalHarnessError('catalog-expectation', `${item.caseId}: reject cases must declare expectedRejection`)
    }
    if (item.role === 'composer' && !item.sectionType) {
      throw new RoleEvalHarnessError('catalog-section', `${item.caseId}: composer cases must declare sectionType`)
    }
  }
  for (const { role, min } of REQUIRED_MINIMUMS) {
    const count = cases.filter((c) => c.role === role).length
    if (count < min) {
      throw new RoleEvalHarnessError('catalog-coverage', `role ${role} has ${count} cases; needs ≥ ${min}`)
    }
  }
  if (!cases.some((c) => c.caseId === 'roles-evidence_reviewer-fixture-grounded')) {
    throw new RoleEvalHarnessError('catalog-fixture', 'RK-27 fixture-grounded case is missing')
  }
  if (!cases.some((c) => c.expectation === 'reject' && c.expectedRejection === 'schema')) {
    throw new RoleEvalHarnessError('catalog-canaries', 'schema canary (requires_human_review: false) is missing')
  }
  if (!cases.some((c) => c.expectation === 'reject' && c.expectedRejection === 'safety')) {
    throw new RoleEvalHarnessError('catalog-canaries', 'certification-language canary is missing')
  }
  if (!cases.some((c) => c.expectation === 'reject' && c.expectedRejection === 'composer-references')) {
    throw new RoleEvalHarnessError('catalog-canaries', 'hallucinated-id canary is missing')
  }
}

// ---------------------------------------------------------------------------
// Prompt/envelope integrity
// ---------------------------------------------------------------------------

function buildPrompts(item: RoleEvalCase): { systemPrompt: string; userMessage: string } {
  switch (item.role) {
    case 'validator':
      return {
        systemPrompt: buildValidatorSystemPrompt(),
        userMessage: buildValidatorUserMessage(item.context),
      }
    case 'composer':
      return {
        systemPrompt: buildComposerSystemPrompt(item.sectionType!),
        userMessage: buildComposerUserMessage(item.sectionType!, item.context),
      }
    default:
      return {
        systemPrompt: buildReviewerSystemPrompt(item.role),
        userMessage: buildReviewerUserMessage(item.role, item.context),
      }
  }
}

/**
 * The untrusted-data envelope must hold: exactly one marker, followed by a
 * single-line JSON payload (JSON.stringify escapes newlines, so payload
 * content can never break out of the envelope or spoof the marker).
 */
function assertEnvelopeIntegrity(caseId: string, userMessage: string): void {
  const parts = userMessage.split(`${UNTRUSTED_DATA_MARKER}\n`)
  if (parts.length !== 2) {
    throw new RoleEvalHarnessError('envelope', `${caseId}: expected exactly one untrusted-data marker`)
  }
  const payloadText = parts[1]
  if (payloadText.includes('\n')) {
    throw new RoleEvalHarnessError('envelope', `${caseId}: payload broke out of the single-line envelope`)
  }
  try {
    JSON.parse(payloadText)
  } catch {
    throw new RoleEvalHarnessError('envelope', `${caseId}: payload is not valid JSON`)
  }
}

// ---------------------------------------------------------------------------
// Free-text collection per role output
// ---------------------------------------------------------------------------

function collectFreeText(role: RoleEvalCase['role'], parsed: Record<string, unknown>): string[] {
  const texts: string[] = []
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) texts.push(value)
  }
  if (role === 'composer') {
    const output = parsed as unknown as ComposerOutput
    push(output.draft_title)
    push(output.draft_content)
    output.assumptions.forEach(push)
    output.limitations.forEach(push)
    output.evidence_references.forEach((ref) => {
      push(ref.title)
      push(ref.context)
    })
    output.proxy_references.forEach((ref) => {
      push(ref.name)
      push(ref.context)
    })
    return texts
  }
  // Validator + reviewer roles: summary plus every string-array field.
  push(parsed.summary)
  for (const value of Object.values(parsed)) {
    if (Array.isArray(value)) value.forEach(push)
  }
  return texts
}

// ---------------------------------------------------------------------------
// Case pipeline
// ---------------------------------------------------------------------------

function schemaFor(role: RoleEvalCase['role']) {
  if (role === 'validator') return ValidatorOutputSchema
  if (role === 'composer') return ComposerOutputSchema
  return ReviewerOutputSchema
}

interface Rejection {
  reason: RoleRejectionReason
  detail: string
}

/** Steps 2–4 of the pipeline: first rejection wins (schema → detectors → guards). */
function evaluateOutput(item: RoleEvalCase): Rejection | null {
  // 2. Output schema contract (requires_human_review: literal true included).
  const parsedResult = schemaFor(item.role).safeParse(item.output)
  if (!parsedResult.success) {
    return {
      reason: 'schema',
      detail: parsedResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }
  }
  const parsed = parsedResult.data as Record<string, unknown>

  // 3. Detectors over EVERY free-text field (advisor's helpers, imported).
  //    StellaProjectContext is structurally a ContextualAdvisorContext.
  const detectorContext = item.context as unknown as ContextualAdvisorContext
  for (const text of collectFreeText(item.role, parsed)) {
    try {
      detectMethodologySafety(text, detectorContext)
    } catch (error) {
      return { reason: 'safety', detail: error instanceof Error ? error.message : String(error) }
    }
  }
  for (const text of collectFreeText(item.role, parsed)) {
    try {
      detectNumericIntegrity(text, detectorContext)
    } catch (error) {
      return { reason: 'numeric-integrity', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  // 4. Composer-only integrity guards.
  if (item.role === 'composer') {
    const output = parsed as unknown as ComposerOutput
    const context = item.context as StellaProjectContext
    const referenceCheck = validateComposerReferences(output, context)
    if (!referenceCheck.ok) {
      return {
        reason: 'composer-references',
        detail: referenceCheck.violations.map((v) => `${v.field}=${v.id}`).join('; '),
      }
    }
    if (context.calculationSnapshot) {
      const additional = [
        ...context.filterSetsSummary.flatMap((f) => [
          f.deadweightPct, f.attributionPct, f.displacementPct, f.dropoffPct, f.durationYears,
        ]).filter((v): v is number => v !== undefined),
        context.stakeholderCount,
        context.evidenceTotal,
        ...(context.readinessScore !== undefined ? [context.readinessScore] : []),
      ]
      const numberCheck = validateComposerNumbers(
        output,
        authorizedNumbersFromSnapshot(context.calculationSnapshot, additional)
      )
      if (!numberCheck.ok) {
        return {
          reason: 'composer-figures',
          detail: numberCheck.violations.map((v) => `${v.field}:${v.token}`).join('; '),
        }
      }
    }
  }

  return null
}

export function runRoleEvalCase(item: RoleEvalCase): RoleCaseResult {
  // 1. Prompt + envelope integrity — a failure here is a harness error, not a
  //    model rejection: the pipeline itself must always produce a safe prompt.
  const { systemPrompt, userMessage } = buildPrompts(item)
  if (!systemPrompt.includes('ABSOLUTE PROHIBITIONS')) {
    throw new RoleEvalHarnessError('guardrails', `${item.caseId}: SHARED_GUARDRAILS missing from system prompt`)
  }
  assertEnvelopeIntegrity(item.caseId, userMessage)

  const rejection = evaluateOutput(item)

  const behavedAsExpected =
    item.expectation === 'pass'
      ? rejection === null
      : rejection !== null && rejection.reason === item.expectedRejection

  return {
    caseId: item.caseId,
    role: item.role,
    expectation: item.expectation,
    rejection: rejection?.reason ?? null,
    rejectionDetail: rejection?.detail ?? null,
    ok: behavedAsExpected,
  }
}

// ---------------------------------------------------------------------------
// Harness entry point
// ---------------------------------------------------------------------------

export function runRoleEvalHarness(
  cases: readonly RoleEvalCase[] = OFFICIAL_ROLE_EVAL_CASES
): { summary: RoleEvalSummary; results: RoleCaseResult[] } {
  validateRoleEvalCatalog(cases)

  const results = cases.map(runRoleEvalCase)
  const byRole = {
    validator: { total: 0, passed: 0 },
    composer: { total: 0, passed: 0 },
    proxy_reviewer: { total: 0, passed: 0 },
    evidence_reviewer: { total: 0, passed: 0 },
    audit_assistant: { total: 0, passed: 0 },
  } satisfies RoleEvalSummary['byRole']

  let casesPassed = 0
  let canariesRejected = 0
  for (const result of results) {
    byRole[result.role].total += 1
    if (result.ok) {
      byRole[result.role].passed += 1
      casesPassed += 1
      if (result.expectation === 'reject') canariesRejected += 1
    }
  }

  const summary: RoleEvalSummary = {
    totalCases: cases.length,
    processedCases: results.length,
    uniqueCaseIds: new Set(results.map((r) => r.caseId)).size,
    casesPassed,
    casesFailed: results.length - casesPassed,
    passExpectedCases: cases.filter((c) => c.expectation === 'pass').length,
    canaryCases: cases.filter((c) => c.expectation === 'reject').length,
    canariesRejected,
    byRole,
    contractVersions: {
      validator: VALIDATOR_OUTPUT_SCHEMA_VERSION,
      composer: COMPOSER_OUTPUT_SCHEMA_VERSION,
      reviewer: REVIEWER_OUTPUT_SCHEMA_VERSION,
    },
    providerCalls: 0,
    geminiCalls: 0,
  }
  return { summary, results }
}
