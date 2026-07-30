import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from '../stella-contextual/cases'
import { createRunArtifacts, initializeRunManifest } from './artifacts'
import { parseRealRunnerArgs, selectRealRunnerCases } from './guards'
import { validateRealRunnerAuthorization, validateRuntimeGuards } from './guards'
import { loadResumableArtifacts, validateResumeManifest } from './resume'
import { runGuardedContextualEvaluation } from './runner'
import { writeTransactionalCheckpoint } from './transactional-writer'

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const runtime = () => ({ branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'), originMainSHA: git('rev-parse', 'origin/main'), trackedDirty: git('status', '--porcelain', '--untracked-files=no') !== '', stagingDirty: git('diff', '--cached', '--name-only') !== '', gitOperationInProgress: ['MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((file) => existsSync(git('rev-parse', '--git-path', file))) || existsSync(git('rev-parse', '--git-path', 'rebase-apply')) || existsSync(git('rev-parse', '--git-path', 'rebase-merge')) })

async function main(): Promise<void> {
  const args = parseRealRunnerArgs(process.argv.slice(2))
  if (args.help) { console.log('Usage: pnpm tsx tests/eval/stella-contextual-real/run.ts [--run-label label] [--case-id id] [--resume directory] [--dry-run] [--output-root path]'); return }
  if (args.resume) throw new Error('RESUME_FLOW_NOT_READY')
  const currentRuntime = runtime()
  const resumed = args.resume ? await loadResumableArtifacts(args.resume) : undefined
  const resumedCaseIds = resumed?.manifest.caseIds
  if (resumedCaseIds !== undefined && (!Array.isArray(resumedCaseIds) || !resumedCaseIds.every((id) => typeof id === 'string'))) throw new Error('RESUME_INTEGRITY_ERROR: invalid case ids')
  const activeCaseIds = (resumedCaseIds as string[] | undefined) ?? args.caseIds
  if (resumed) validateResumeManifest(resumed.manifest, { branch: currentRuntime.branch, head: currentRuntime.head, originMainSHA: currentRuntime.originMainSHA, providerMode: String(process.env.STELLA_PROVIDER_MODE ?? ''), model: String(process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'), caseCatalogHash: String(resumed.manifest.caseCatalogHash ?? ''), caseIds: activeCaseIds, scope: resumed.manifest.scope === 'canary' ? 'canary' : 'full', expectedCalls: Number(resumed.manifest.expectedCalls) })
  validateRuntimeGuards(currentRuntime, args.dryRun)
  validateRealRunnerAuthorization(process.env, activeCaseIds, args.dryRun)
  const selection = selectRealRunnerCases(OFFICIAL_CONTEXTUAL_MOCK_CASES, activeCaseIds)
  const selectedCaseIds = selection.cases.map((item) => item.caseId)
  const artifactStartedAt = new Date().toISOString()
  const output = args.dryRun ? undefined : await createRunArtifacts(resolve(args.outputRoot ?? 'artifacts/stella-contextual-real-runs'), args.runLabel)
  if (output) {
    await initializeRunManifest(output.directory, {
      runId: output.runId,
      runLabel: args.runLabel,
      scope: selection.scope,
      eligibleForGate: false,
      branch: currentRuntime.branch,
      head: currentRuntime.head,
      originMainSHA: currentRuntime.originMainSHA,
      dirtyTrackedTree: false,
      providerMode: process.env.STELLA_PROVIDER_MODE,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
      caseIds: selectedCaseIds,
      expectedCalls: selectedCaseIds.length,
      pacingMilliseconds: 10_000,
      startedAt: artifactStartedAt,
      runnerVersion: 'current-contextual-v1',
      acknowledgementNamesPresent: ['STELLA_REAL_EVAL_ACK'],
      schemaProtocol: 'sourceRefIndexes',
      internalProtocol: 'sourceFields',
      status: 'INITIALIZED',
      providerCalls: 0,
    })
  }
  const provider = args.dryRun ? undefined : await (async () => {
    const { getGeminiAdapter } = await import('@/lib/stella/adapter/gemini-client')
    const adapter = getGeminiAdapter({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash', timeoutMs: 60_000 })
    return async (request: { systemPrompt: string; userMessage: string; responseJsonSchema: Record<string, unknown> }) => JSON.parse((await adapter.generate({ role: 'advisor', systemPrompt: request.systemPrompt, userMessage: request.userMessage, responseJsonSchema: request.responseJsonSchema })).rawOutput) as unknown
  })()
  const result = await runGuardedContextualEvaluation({
    cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
    caseIds: activeCaseIds,
    dryRun: args.dryRun,
    env: process.env,
    runtime: currentRuntime,
    provider,
    onCheckpoint: output
      ? async (checkpoint) => {
          await writeTransactionalCheckpoint({
            directory: output.directory,
            runId: output.runId,
            scope: selection.scope,
            selectedCaseIds,
            caseState: checkpoint.caseState,
            rawResponses: checkpoint.rawResponses,
            decodedResults: checkpoint.decodedResults,
            errors: checkpoint.errors,
            status: checkpoint.status,
            checkpointStatus: checkpoint.checkpointStatus,
            startedAt: artifactStartedAt,
            lastCheckpointAt: checkpoint.lastCheckpointAt,
          })
        }
      : undefined,
  })
  if (args.dryRun) { console.log(JSON.stringify(result.summary)); return }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'CONFIGURATION_ERROR'); process.exitCode = 1 })
