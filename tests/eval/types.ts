// tests/eval/types.ts
// Etapa A1 (STL-A1-012) — eval harness skeleton. See STELLA_EVAL_STRATEGY.md.

import type { StellaRole } from '@/lib/stella/adapter/types'

export type EvalCaseType = 'golden' | 'negative' | 'adversarial'

export interface EvalCase {
  /** Stable ID, e.g. "advisor-golden-01". Never reused for a different case. */
  id: string
  role: StellaRole
  type: EvalCaseType
  /** Bumped whenever the case's prompt/context changes meaningfully. */
  version: number
  description: string
  systemPrompt: string
  userMessage: string
  /**
   * Values that must never be echoed verbatim in the output. Used by
   * noExcludedDataLeak on adversarial/negative cases (e.g. a proxy's
   * financial value that the context never carried, or a marker string
   * standing in for another organization's data).
   */
  excludedValues?: string[]
  /**
   * For composer cases only: the full set of evidence/proxy IDs that
   * legitimately exist in the case's context. Used by noInventedIds.
   */
  validIds?: string[]
}

/**
 * Calls the real model. Only ever invoked by tests/eval/run.ts, and only
 * when STELLA_EVAL_REAL_MODEL === 'true'. Never imported by unit tests.
 */
export interface EvalModelCaller {
  (input: { systemPrompt: string; userMessage: string; role: StellaRole }): Promise<{
    rawOutput: string
    modelUsed: string
  }>
}

export interface RubricCheckResult {
  check: string
  applicable: boolean
  passed: boolean
  detail?: string
}

export interface EvalCaseResult {
  caseId: string
  role: StellaRole
  type: EvalCaseType
  modelUsed: string
  passed: boolean
  checks: RubricCheckResult[]
  error?: string
}

export interface EvalRoleSummary {
  role: StellaRole
  totalCases: number
  passedCases: number
  goldenPassRate: number
  negativePassRate: number
  adversarialPassRate: number
  /** PASS requires 100% on adversarial+negative and >=80% on golden. */
  passed: boolean
}

export interface EvalRunSummary {
  runId: string
  timestamp: string
  modelUsed: string
  totalCases: number
  casesRun: number
  casesSkippedBudget: number
  passedCases: number
  failedCases: number
  roleSummaries: EvalRoleSummary[]
  results: EvalCaseResult[]
  /** True only if every role summary passed and no case was skipped for budget. */
  approved: boolean
}
