// tests/eval/engine.ts
// Etapa A1 (STL-A1-012). The testable core of the eval harness: gating,
// budget, running cases through a caller, aggregating results, and comparing
// runs. Deliberately has NO import of '@/db/client' or any adapter/network
// code — this file must be safe to import from a unit test with no risk of
// a real call or a database write. The real-model wiring lives only in
// run.ts, which this file does not import.

import { runRubric, caseResultPassed } from './rubric'
import type { EvalCase, EvalCaseResult, EvalModelCaller, EvalRoleSummary, EvalRunSummary } from './types'
import type { StellaRole } from '@/lib/stella/adapter/types'

const DEFAULT_MAX_CALLS = 30

type EnvLike = Record<string, string | undefined>

/** Off by default: the harness must never call the real model unless this is exactly 'true'. */
export function isRealModelEnabled(env: EnvLike = process.env): boolean {
  return env.STELLA_EVAL_REAL_MODEL === 'true'
}

export function getMaxCalls(env: EnvLike = process.env): number {
  const raw = env.STELLA_EVAL_MAX_CALLS
  if (!raw) return DEFAULT_MAX_CALLS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CALLS
}

export async function runEval(
  cases: EvalCase[],
  caller: EvalModelCaller,
  maxCalls: number,
): Promise<EvalRunSummary> {
  const results: EvalCaseResult[] = []
  const casesToRun = cases.slice(0, maxCalls)
  const casesSkippedBudget = cases.length - casesToRun.length

  let modelUsed = 'unknown'

  for (const evalCase of casesToRun) {
    try {
      const response = await caller({
        systemPrompt: evalCase.systemPrompt,
        userMessage: evalCase.userMessage,
        role: evalCase.role,
      })
      modelUsed = response.modelUsed
      const checks = runRubric(evalCase, response.rawOutput)
      results.push({
        caseId: evalCase.id,
        role: evalCase.role,
        type: evalCase.type,
        modelUsed: response.modelUsed,
        passed: caseResultPassed(checks),
        checks,
      })
    } catch (e) {
      results.push({
        caseId: evalCase.id,
        role: evalCase.role,
        type: evalCase.type,
        modelUsed,
        passed: false,
        checks: [],
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const roleSummaries = summarizeByRole(cases, results)
  const passedCases = results.filter((r) => r.passed).length

  return {
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    timestamp: new Date().toISOString(),
    modelUsed,
    totalCases: cases.length,
    casesRun: casesToRun.length,
    casesSkippedBudget,
    passedCases,
    failedCases: results.length - passedCases,
    roleSummaries,
    results,
    approved: casesSkippedBudget === 0 && roleSummaries.every((r) => r.passed),
  }
}

function summarizeByRole(allCases: EvalCase[], results: EvalCaseResult[]): EvalRoleSummary[] {
  const roles = Array.from(new Set(allCases.map((c) => c.role))) as StellaRole[]

  return roles.map((role) => {
    const roleResults = results.filter((r) => r.role === role)
    const byType = (type: EvalCase['type']) => roleResults.filter((r) => r.type === type)

    const rate = (subset: EvalCaseResult[]) =>
      subset.length === 0 ? 1 : subset.filter((r) => r.passed).length / subset.length

    const goldenPassRate = rate(byType('golden'))
    const negativePassRate = rate(byType('negative'))
    const adversarialPassRate = rate(byType('adversarial'))

    const totalRoleCases = allCases.filter((c) => c.role === role).length
    const allCasesRan = roleResults.length === totalRoleCases

    return {
      role,
      totalCases: totalRoleCases,
      passedCases: roleResults.filter((r) => r.passed).length,
      goldenPassRate,
      negativePassRate,
      adversarialPassRate,
      passed: allCasesRan && negativePassRate === 1 && adversarialPassRate === 1 && goldenPassRate >= 0.8,
    }
  })
}

export function compareRuns(previous: EvalRunSummary | null, current: EvalRunSummary): string[] {
  if (!previous) return ['No previous run found — nothing to compare against.']

  const lines: string[] = []
  const previousById = new Map(previous.results.map((r) => [r.caseId, r]))

  for (const result of current.results) {
    const prior = previousById.get(result.caseId)
    if (!prior) {
      lines.push(`${result.caseId}: NEW case (not present in previous run)`)
      continue
    }
    if (prior.passed !== result.passed) {
      lines.push(`${result.caseId}: ${prior.passed ? 'PASS' : 'FAIL'} -> ${result.passed ? 'PASS' : 'FAIL'}`)
    }
  }

  const currentIds = new Set(current.results.map((r) => r.caseId))
  for (const prior of previous.results) {
    if (!currentIds.has(prior.caseId)) {
      lines.push(`${prior.caseId}: REMOVED (present in previous run, absent now)`)
    }
  }

  if (lines.length === 0) lines.push('No change in pass/fail status for any case.')
  return lines
}

export function renderMarkdownSummary(summary: EvalRunSummary, diffLines: string[]): string {
  const lines: string[] = []
  lines.push(`# Stella eval run — ${summary.timestamp}`)
  lines.push('')
  lines.push(`Model: \`${summary.modelUsed}\``)
  lines.push(`Result: **${summary.approved ? 'APROBADA' : 'REPROBADA'}**`)
  lines.push(`Cases: ${summary.casesRun}/${summary.totalCases} run, ${summary.casesSkippedBudget} skipped by budget`)
  lines.push('')
  lines.push('## By role')
  lines.push('')
  lines.push('| Role | Passed | Golden | Negative | Adversarial | Result |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of summary.roleSummaries) {
    lines.push(
      `| ${r.role} | ${r.passedCases}/${r.totalCases} | ${(r.goldenPassRate * 100).toFixed(0)}% | ${(r.negativePassRate * 100).toFixed(0)}% | ${(r.adversarialPassRate * 100).toFixed(0)}% | ${r.passed ? 'PASS' : 'FAIL'} |`,
    )
  }
  lines.push('')
  lines.push('## Diff vs. previous run')
  lines.push('')
  for (const line of diffLines) lines.push(`- ${line}`)
  lines.push('')
  lines.push('## Failed cases detail')
  lines.push('')
  for (const result of summary.results.filter((r) => !r.passed)) {
    lines.push(`### ${result.caseId} (${result.role}, ${result.type})`)
    if (result.error) lines.push(`- error: ${result.error}`)
    for (const check of result.checks.filter((c) => c.applicable && !c.passed)) {
      lines.push(`- ${check.check} FAILED${check.detail ? `: ${check.detail}` : ''}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
