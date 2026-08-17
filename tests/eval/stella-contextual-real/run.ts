import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
// G1-M0 — PARITY. The model target is READ FROM PRODUCTION CONFIG, never
// re-stated here. This file used to fall back to its own hardcoded copy of the
// default model id in three separate places (the run manifest, resume
// validation, and the adapter construction), so a production model bump could
// leave the harness certifying the previous model — silently, since all three
// copies agreed with each other.
//
// The regression is pinned by lib/stella/__tests__/model-target.test.ts, which
// asserts no model-id literal appears anywhere in this file — comments included.
// That is why the old id is described here rather than quoted.
//
// Safe for --dry-run: lib/stella/config.ts imports nothing and only reads
// environment variables, so importing it here does NOT pull in @google/genai.
// The dry run's zero-network guarantee is unchanged.
import { stellaConfig } from '@/lib/stella/config'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from '../stella-contextual/cases'
import { createRunArtifacts, initializeRunManifest } from './artifacts'
import { parseRealRunnerArgs, selectRealRunnerCases } from './guards'
import { validateRealRunnerAuthorization, validateRuntimeGuards } from './guards'
import {
  computeCaseCatalogHash,
  INTERNAL_SCHEMA_PROTOCOL,
  loadResumableArtifacts,
  PROVIDER_SCHEMA_PROTOCOL,
  REAL_RUNNER_VERSION,
  validateResumableArtifacts,
} from './resume'
import { runGuardedContextualEvaluation } from './runner'
import { writeTransactionalCheckpoint } from './transactional-writer'

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const runtime = () => ({ branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'), originMainSHA: git('rev-parse', 'origin/main'), trackedDirty: git('status', '--porcelain', '--untracked-files=no') !== '', stagingDirty: git('diff', '--cached', '--name-only') !== '', gitOperationInProgress: ['MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((file) => existsSync(git('rev-parse', '--git-path', file))) || existsSync(git('rev-parse', '--git-path', 'rebase-apply')) || existsSync(git('rev-parse', '--git-path', 'rebase-merge')) })

async function main(): Promise<void> {
  const args = parseRealRunnerArgs(process.argv.slice(2))
  if (args.help) { console.log('Usage: pnpm tsx tests/eval/stella-contextual-real/run.ts [--run-label label] [--case-id id] [--resume directory] [--dry-run] [--output-root path]'); return }
  const currentRuntime = runtime()
  const resumed = args.resume ? await loadResumableArtifacts(args.resume) : undefined
  const resumedCaseIds = resumed?.manifest.caseIds
  if (resumedCaseIds !== undefined && (!Array.isArray(resumedCaseIds) || !resumedCaseIds.every((id) => typeof id === 'string'))) throw new Error('RESUME_INTEGRITY_ERROR: invalid case ids')
  const activeCaseIds = (resumedCaseIds as string[] | undefined) ?? args.caseIds
  validateRuntimeGuards(currentRuntime, args.dryRun)
  const selection = selectRealRunnerCases(OFFICIAL_CONTEXTUAL_MOCK_CASES, activeCaseIds)
  const selectedCaseIds = selection.cases.map((item) => item.caseId)
  const catalogHash = computeCaseCatalogHash(OFFICIAL_CONTEXTUAL_MOCK_CASES)
  const validatedResume = resumed
    ? validateResumableArtifacts(resumed, {
        branch: currentRuntime.branch,
        head: currentRuntime.head,
        originMainSHA: currentRuntime.originMainSHA,
        providerMode: String(process.env.STELLA_PROVIDER_MODE ?? ''),
        model: stellaConfig.geminiModel,
        caseCatalogHash: catalogHash,
        caseIds: selectedCaseIds,
        knownCaseIds: OFFICIAL_CONTEXTUAL_MOCK_CASES.map((item) => item.caseId),
        scope: selection.scope,
        expectedCalls: selectedCaseIds.length,
        schemaProtocol: PROVIDER_SCHEMA_PROTOCOL,
        internalProtocol: INTERNAL_SCHEMA_PROTOCOL,
        runnerVersion: REAL_RUNNER_VERSION,
      })
    : undefined
  validateRealRunnerAuthorization(process.env, selection.scope === 'full' ? [] : activeCaseIds, args.dryRun)
  const artifactStartedAt = validatedResume?.startedAt ?? new Date().toISOString()
  const output = args.dryRun
    ? undefined
    : validatedResume
      ? { directory: validatedResume.directory, runId: validatedResume.runId }
      : await createRunArtifacts(resolve(args.outputRoot ?? 'artifacts/stella-contextual-real-runs'), args.runLabel)
  if (output) {
    if (!validatedResume) await initializeRunManifest(output.directory, {
      runId: output.runId,
      runLabel: args.runLabel,
      scope: selection.scope,
      eligibleForGate: false,
      branch: currentRuntime.branch,
      head: currentRuntime.head,
      originMainSHA: currentRuntime.originMainSHA,
      dirtyTrackedTree: false,
      providerMode: process.env.STELLA_PROVIDER_MODE,
      model: stellaConfig.geminiModel,
      caseCatalogHash: catalogHash,
      caseIds: selectedCaseIds,
      expectedCalls: selectedCaseIds.length,
      pacingMilliseconds: 10_000,
      startedAt: artifactStartedAt,
      runnerVersion: REAL_RUNNER_VERSION,
      acknowledgementNamesPresent: ['STELLA_REAL_EVAL_ACK'],
      schemaProtocol: PROVIDER_SCHEMA_PROTOCOL,
      internalProtocol: INTERNAL_SCHEMA_PROTOCOL,
      status: 'INITIALIZED',
      providerCalls: 0,
      resumeCount: 0,
    })
  }
  const provider = args.dryRun ? undefined : await (async () => {
    const { getGeminiAdapter } = await import('@/lib/stella/adapter/gemini-client')
    // G1-M0: same model as production, and NO sampling overrides — the adapter
    // sends none, and `StellaAdapterConfig` no longer has a `temperature` field
    // to pass one through. `timeoutMs: 60_000` is the ONE deliberate divergence
    // that survives: G1-A measures model behaviour, not production latency; the
    // real 15 s budget is exercised in G1-B.
    const adapter = getGeminiAdapter({ apiKey: process.env.GEMINI_API_KEY, model: stellaConfig.geminiModel, timeoutMs: 60_000 })
    return async (request: { systemPrompt: string; userMessage: string; responseJsonSchema: Record<string, unknown> }) => JSON.parse((await adapter.generate({ role: 'advisor', systemPrompt: request.systemPrompt, userMessage: request.userMessage, responseJsonSchema: request.responseJsonSchema })).rawOutput) as unknown
  })()
  const result = await runGuardedContextualEvaluation({
    cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
    caseIds: activeCaseIds,
    dryRun: args.dryRun,
    env: process.env,
    runtime: currentRuntime,
    provider,
    runId: output?.runId,
    startedAt: artifactStartedAt,
    isResume: Boolean(validatedResume),
    initialCaseState: validatedResume?.caseState,
    initialRawResponses: validatedResume?.rawResponses,
    initialDecodedResults: validatedResume?.decodedResults,
    initialErrors: validatedResume?.errors,
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
            metrics: checkpoint.metrics,
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
