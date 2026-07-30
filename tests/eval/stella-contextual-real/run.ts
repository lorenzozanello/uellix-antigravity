import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from '../stella-contextual/cases'
import { createRunArtifacts, writeRunArtifacts } from './artifacts'
import { parseRealRunnerArgs } from './guards'
import { validateRealRunnerAuthorization, validateRuntimeGuards } from './guards'
import { runGuardedContextualEvaluation } from './runner'

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const runtime = () => ({ branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'), originMainSHA: git('rev-parse', 'origin/main'), trackedDirty: git('status', '--porcelain', '--untracked-files=no') !== '', stagingDirty: git('diff', '--cached', '--name-only') !== '', gitOperationInProgress: ['MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((file) => existsSync(git('rev-parse', '--git-path', file))) || existsSync(git('rev-parse', '--git-path', 'rebase-apply')) || existsSync(git('rev-parse', '--git-path', 'rebase-merge')) })

async function main(): Promise<void> {
  const args = parseRealRunnerArgs(process.argv.slice(2))
  if (args.help) { console.log('Usage: pnpm tsx tests/eval/stella-contextual-real/run.ts [--run-label label] [--case-id id] [--resume directory] [--dry-run] [--output-root path]'); return }
  const currentRuntime = runtime()
  validateRuntimeGuards(currentRuntime, args.dryRun)
  validateRealRunnerAuthorization(process.env, args.caseIds, args.dryRun)
  const provider = args.dryRun ? undefined : await (async () => {
    const { getGeminiAdapter } = await import('@/lib/stella/adapter/gemini-client')
    const adapter = getGeminiAdapter({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash', timeoutMs: 60_000 })
    return async (request: { systemPrompt: string; userMessage: string; responseJsonSchema: Record<string, unknown> }) => JSON.parse((await adapter.generate({ role: 'advisor', systemPrompt: request.systemPrompt, userMessage: request.userMessage, responseJsonSchema: request.responseJsonSchema })).rawOutput) as unknown
  })()
  const result = await runGuardedContextualEvaluation({ cases: OFFICIAL_CONTEXTUAL_MOCK_CASES, caseIds: args.caseIds, dryRun: args.dryRun, env: process.env, runtime: currentRuntime, provider })
  if (args.dryRun) { console.log(JSON.stringify(result.summary)); return }
  const output = await createRunArtifacts(resolve(args.outputRoot ?? 'artifacts/stella-contextual-real-runs'), args.runLabel)
  await writeRunArtifacts(output.directory, { runId: output.runId, runLabel: args.runLabel, scope: result.summary.scope, eligibleForGate: false, branch: runtime().branch, HEAD: runtime().head, originMainSHA: runtime().originMainSHA, dirtyTrackedTree: false, providerMode: process.env.STELLA_PROVIDER_MODE, model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash', caseIds: args.caseIds, expectedCalls: result.summary.expectedCalls, pacingMilliseconds: 10_000, startedAt: result.summary.startedAt, runnerVersion: 'current-contextual-v1', acknowledgementNamesPresent: ['STELLA_REAL_EVAL_ACK'], schemaProtocol: 'sourceRefIndexes', internalProtocol: 'sourceFields' }, { status: result.summary.status, processedCaseIds: [], pendingCaseIds: [], failedCaseIds: [], providerCalls: result.summary.providerCalls, successfulResponses: 0, failedResponses: 0, currentCaseId: null, lastCheckpointAt: result.summary.completedAt, startedAt: result.summary.startedAt, completedAt: result.summary.completedAt, interruptionReason: null, resumeCount: 0 }, result.summary, result.rawResponses, result.decodedResults, [])
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'CONFIGURATION_ERROR'); process.exitCode = 1 })
