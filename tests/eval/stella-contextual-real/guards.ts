import type { ContextualMockCase } from '../stella-contextual/cases'
import type { RealRunnerScope, RunnerRuntime } from './types'

const GENERAL_ACK = 'B1C_CURRENT_ARCHITECTURE_REAL_EVAL'
const SUBSET_ACK = 'B1C_CURRENT_ARCHITECTURE_CANARY'
const FULL_ACK = 'B1C_CURRENT_ARCHITECTURE_FULL_28'
export const MINIMUM_PACING_MS = 10_000

export class RealRunnerGuardError extends Error { constructor(readonly category: string, message: string) { super(message); this.name = 'RealRunnerGuardError' } }
export interface RealRunnerArgs { runLabel: string; caseIds: string[]; resume?: string; dryRun: boolean; outputRoot?: string; help: boolean }

export function parseRealRunnerArgs(args: readonly string[]): RealRunnerArgs {
  const parsed: RealRunnerArgs = { runLabel: 'stella-contextual-real', caseIds: [], dryRun: false, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help') parsed.help = true
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--run-label' || arg === '--case-id' || arg === '--resume' || arg === '--output-root') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new RealRunnerGuardError('CONFIGURATION_ERROR', `${arg} requires a value`)
      index += 1
      if (arg === '--run-label') parsed.runLabel = value
      if (arg === '--case-id') parsed.caseIds.push(value)
      if (arg === '--resume') parsed.resume = value
      if (arg === '--output-root') parsed.outputRoot = value
    } else throw new RealRunnerGuardError('CONFIGURATION_ERROR', `unknown argument: ${arg}`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(parsed.runLabel)) throw new RealRunnerGuardError('CONFIGURATION_ERROR', 'run label is unsafe')
  if (parsed.resume && parsed.caseIds.length) throw new RealRunnerGuardError('CONFIGURATION_ERROR', 'resume cannot change case ids')
  return parsed
}

export function selectRealRunnerCases(catalog: readonly ContextualMockCase[], caseIds: readonly string[]): { cases: readonly ContextualMockCase[]; scope: RealRunnerScope } {
  if (new Set(catalog.map((item) => item.caseId)).size !== 28 || catalog.length !== 28) throw new RealRunnerGuardError('CASE_SELECTION_ERROR', 'official catalog is not complete and unique')
  if (caseIds.length === 0) return { cases: catalog, scope: 'full' }
  if (caseIds.length > 7 || new Set(caseIds).size !== caseIds.length) throw new RealRunnerGuardError('CASE_SELECTION_ERROR', 'canary ids must be unique and between one and seven')
  const selected = caseIds.map((id) => catalog.find((item) => item.caseId === id))
  if (selected.some((item) => !item)) throw new RealRunnerGuardError('CASE_SELECTION_ERROR', 'unknown case id')
  return { cases: selected as ContextualMockCase[], scope: 'canary' }
}

export function validateRuntimeGuards(runtime: RunnerRuntime, dryRun: boolean): void {
  if (dryRun) return
  if (runtime.trackedDirty || runtime.stagingDirty || runtime.gitOperationInProgress) throw new RealRunnerGuardError('DIRTY_TREE_ERROR', 'tracked tree, staging, or git operation is unsafe')
}

export function validateRealRunnerAuthorization(env: Record<string, string | undefined>, caseIds: readonly string[], dryRun: boolean): void {
  if (dryRun) return
  if (env.STELLA_REAL_EVAL_ACK !== GENERAL_ACK) throw new RealRunnerGuardError('AUTHORIZATION_ERROR', 'general acknowledgement is required')
  if (env.STELLA_PROVIDER_MODE !== 'paid_gemini') throw new RealRunnerGuardError('CONFIGURATION_ERROR', 'STELLA_PROVIDER_MODE=paid_gemini is required')
  if (!env.GEMINI_API_KEY) throw new RealRunnerGuardError('CONFIGURATION_ERROR', 'GEMINI_API_KEY is required')
  const isCanary = caseIds.length > 0
  if (isCanary && env.STELLA_REAL_EVAL_SUBSET_ACK !== SUBSET_ACK) throw new RealRunnerGuardError('AUTHORIZATION_ERROR', 'canary acknowledgement is required')
  if (!isCanary && env.STELLA_REAL_EVAL_FULL_ACK !== FULL_ACK) throw new RealRunnerGuardError('AUTHORIZATION_ERROR', 'full acknowledgement is required')
}

export function resolvePacingMilliseconds(env: Record<string, string | undefined>): number {
  const raw = env.STELLA_REAL_EVAL_INTER_CALL_DELAY_MS
  if (raw === undefined) return MINIMUM_PACING_MS
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) < MINIMUM_PACING_MS) throw new RealRunnerGuardError('CONFIGURATION_ERROR', 'pacing cannot be below the minimum')
  return Number(raw)
}
