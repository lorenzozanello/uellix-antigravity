// scripts/eval-offline.ts
// FABLE MOONSHOT WS1 / U10: offline evaluation gate.
// Runs the 28-case mock harness plus the R1-R6 reservation validators.
// Fully offline: no network, no DB, no provider, no env secrets.
// Exits non-zero on any failure.

import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from '../tests/eval/stella-contextual/cases'
import { runContextualMockHarness } from '../tests/eval/stella-contextual/harness'
import { buildContextualAdvisorRequest } from '../lib/stella/context/build-contextual-advisor-request'
import {
  ADVISOR_STEP_ALWAYS_INCLUDED_FIELDS,
  ADVISOR_STEP_CONTEXT_FIELDS,
  buildAdvisorStepContext,
} from '../lib/stella/context/build-advisor-step-context'
import { decodeProviderSourceRefIndexes } from '../lib/stella/context/decode-provider-source-ref-indexes'
import { ContextualIndexTokenLeakError, findBareIndexReferenceTokens } from '../lib/stella/context/validate-no-index-reference-tokens'
import { buildAdvisorContextualSystemPrompt } from '../lib/stella/prompts/advisor-contextual-system'
import { advisorPipelineSteps } from '../lib/stella/advisor/steps'
import type { ContextualAdvisorContext } from '../lib/stella/context/types'

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function check(name: string, run: () => string): void {
  try {
    results.push({ name, ok: true, detail: run() })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

// ---------------------------------------------------------------------------
// Gate 1 — the 28 official mock cases all pass the harness
// ---------------------------------------------------------------------------
check('mock-harness-28-cases', () => {
  const summary = runContextualMockHarness()
  assertCondition(summary.totalCases === 28 && summary.processedCases === 28, 'expected 28 processed cases')
  assertCondition(summary.schemaValidCases === 28 && summary.schemaInvalidCases === 0, 'expected 28 schema-valid cases')
  assertCondition(summary.requiresHumanReviewCases === 28, 'expected requiresHumanReview on all cases')
  assertCondition(summary.safetyScore === 2 && summary.schemaContractScore === 2 && summary.numericIntegrityScore === 2, 'expected detector scores of 2')
  assertCondition(summary.adversarialCasesPassed === 7, 'expected all 7 adversarial cases to pass')
  assertCondition(summary.providerCalls === 0 && summary.geminiCalls === 0, 'expected zero provider calls')
  return `summary=${JSON.stringify(summary)}`
})

// ---------------------------------------------------------------------------
// Gate 2 — R1: empty collections are citable via .empty sentinel leaves
// ---------------------------------------------------------------------------
check('R1-empty-collection-sentinels', () => {
  let sentinelsChecked = 0
  for (const item of OFFICIAL_CONTEXTUAL_MOCK_CASES) {
    const request = buildContextualAdvisorRequest(item.step, item.context)
    const serialized = request.serializedContext as Record<string, unknown>
    for (const [key, value] of Object.entries(serialized)) {
      if (Array.isArray(value) && value.length === 0) {
        assertCondition(
          request.canonicalSourceFieldPaths.includes(`${key}.empty`),
          `${item.caseId}: catalog is missing sentinel ${key}.empty`,
        )
        sentinelsChecked += 1
      }
    }
  }
  return `verified ${sentinelsChecked} sentinel leaves across 28 request catalogs`
})

// ---------------------------------------------------------------------------
// Gate 3 — R3: every step receives exactly its mapped slice
// ---------------------------------------------------------------------------
check('R3-per-step-slicing', () => {
  for (const item of OFFICIAL_CONTEXTUAL_MOCK_CASES) {
    const sliced = buildAdvisorStepContext(item.step, item.context).context
    const allowed = new Set<string>([...ADVISOR_STEP_ALWAYS_INCLUDED_FIELDS, ...ADVISOR_STEP_CONTEXT_FIELDS[item.step]])
    for (const key of Object.keys(sliced)) {
      assertCondition(allowed.has(key), `${item.caseId}: field ${key} leaked into the ${item.step} slice`)
    }
  }
  // Union coverage: every contract field is reachable through some step.
  const union = new Set<string>([...ADVISOR_STEP_ALWAYS_INCLUDED_FIELDS])
  for (const step of advisorPipelineSteps) for (const field of ADVISOR_STEP_CONTEXT_FIELDS[step]) union.add(field)
  const contractFields: (keyof ContextualAdvisorContext)[] = [
    'projectId', 'organizationId', 'projectName', 'narrativeSummary', 'outcomesSnapshot', 'indicatorsSnapshot',
    'stakeholderCount', 'stakeholdersSnapshot', 'activitiesSummary', 'evidenceMetadata', 'evidenceTotal',
    'proxySummary', 'filterSetsSummary', 'calculationSnapshot', 'calculationReadiness', 'reportSections',
    'projectCreatedAt', 'lastUpdatedAt',
  ]
  for (const field of contractFields) {
    assertCondition(union.has(field), `contract field ${field} is unreachable from every step slice`)
  }
  return `28 slices validated; ${union.size} fields covered across 7 steps`
})

// ---------------------------------------------------------------------------
// Gate 4 — R4: bare index tokens in free text are rejected post-decode
// ---------------------------------------------------------------------------
check('R4-index-token-leak-rejection', () => {
  const paths = ['narrativeSummary', 'outcomesSnapshot[0].id']
  const leaky = {
    step: 'outcomes', responseType: 'review', summary: 'La fuente (0) respalda esto.',
    findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'Texto', sourceRefIndexes: [0] }],
    suggestions: [{ id: 's', proposedText: null, rationale: 'Razón', missingInformation: [], sourceRefIndexes: [] }],
    clarifyingQuestions: [], limitations: [], requiresHumanReview: true,
  }
  let rejected = false
  try {
    decodeProviderSourceRefIndexes(leaky, paths, 'outcomes')
  } catch (error) {
    rejected = error instanceof ContextualIndexTokenLeakError
  }
  assertCondition(rejected, 'leak fixture was not rejected with ContextualIndexTokenLeakError')
  assertCondition(findBareIndexReferenceTokens('ver (1) arriba', 2).length === 1, 'token detector missed (1)')
  assertCondition(findBareIndexReferenceTokens('Encuesta (2026)', 2).length === 0, 'token detector false-positive on a year')
  for (const step of advisorPipelineSteps) {
    assertCondition(
      buildAdvisorContextualSystemPrompt(step).includes('Never write bare index tokens'),
      `prompt for ${step} is missing the index-token rule`,
    )
  }
  return 'leak fixture rejected; detector bounds verified; prompt rule present for 7 steps'
})

// ---------------------------------------------------------------------------
// Gate 5 — R5: complete fixtures are genuinely complete and differ from incomplete
// ---------------------------------------------------------------------------
check('R5-complete-fixtures-genuinely-complete', () => {
  for (const step of advisorPipelineSteps) {
    const complete = OFFICIAL_CONTEXTUAL_MOCK_CASES.find((item) => item.caseId === `b1c-${step}-complete`)
    const incomplete = OFFICIAL_CONTEXTUAL_MOCK_CASES.find((item) => item.caseId === `b1c-${step}-incomplete`)
    assertCondition(Boolean(complete && incomplete), `missing complete/incomplete pair for ${step}`)
    const request = buildContextualAdvisorRequest(step, complete!.context)
    const sentinels = request.canonicalSourceFieldPaths.filter((path) => path.endsWith('.empty'))
    assertCondition(
      sentinels.every((path) => path.startsWith('calculationReadiness.')),
      `${step}: complete slice still contains empty collections: ${sentinels.join(', ')}`,
    )
    const completeSlice = JSON.stringify(buildAdvisorStepContext(step, complete!.context).context)
    const incompleteSlice = JSON.stringify(buildAdvisorStepContext(step, incomplete!.context).context)
    assertCondition(completeSlice !== incompleteSlice, `${step}: complete and incomplete slices are identical`)
  }
  const calculationComplete = OFFICIAL_CONTEXTUAL_MOCK_CASES.find((item) => item.caseId === 'b1c-calculation-complete')
  assertCondition(calculationComplete?.context.calculationSnapshot !== null, 'complete calculation fixture has no snapshot')
  assertCondition(calculationComplete?.context.calculationReadiness?.ready === true, 'complete calculation fixture is not ready')
  return 'complete ≠ incomplete on all 7 steps; complete slices fully populated'
})

// ---------------------------------------------------------------------------
// Gate 6 — R6: categorical certification refusal in the system prompt
// ---------------------------------------------------------------------------
check('R6-categorical-certification-refusal', () => {
  for (const step of advisorPipelineSteps) {
    const prompt = buildAdvisorContextualSystemPrompt(step)
    assertCondition(
      prompt.includes('Certification, approval, validation, and sign-off are categorically outside your role'),
      `prompt for ${step} is missing the categorical refusal`,
    )
    assertCondition(
      prompt.includes('data completeness never changes this refusal'),
      `prompt for ${step} does not decouple refusal from data completeness`,
    )
  }
  return 'categorical refusal present for all 7 steps'
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let failed = 0
for (const result of results) {
  const status = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  console.log(`[eval:offline] ${status} ${result.name} — ${result.detail}`)
}
console.log(`[eval:offline] ${results.length - failed}/${results.length} gates passed`)
if (failed > 0) {
  console.error(`[eval:offline] FAILED: ${failed} gate(s) did not pass`)
  process.exit(1)
}
console.log('[eval:offline] OK — 28/28 mock cases pass with zero R1-R6 violations')
