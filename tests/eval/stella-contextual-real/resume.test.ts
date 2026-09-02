import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES } from '../stella-contextual/cases'
import { createCaseState } from './case-state'
import {
  loadResumableArtifacts,
  validateResumableArtifacts,
  type ResumeCompatibility,
} from './resume'
import { runGuardedContextualEvaluation } from './runner'
import { HASHED_CHECKPOINT_FILES, writeTransactionalCheckpoint } from './transactional-writer'

const directories: string[] = []
const timestamp = '2026-07-30T12:00:00.000Z'
const caseId = 'b1c-stakeholders-complete'
const secondCaseId = OFFICIAL_CONTEXTUAL_MOCK_CASES[1].caseId
const compatibility: ResumeCompatibility = {
  branch: 'branch',
  head: 'head',
  originMainSHA: 'base',
  providerMode: 'paid_gemini',
  model: 'gemini-2.5-flash',
  caseCatalogHash: 'catalog-hash',
  caseIds: [caseId],
  knownCaseIds: [caseId],
  scope: 'canary',
  expectedCalls: 1,
  schemaProtocol: 'sourceRefIndexes',
  internalProtocol: 'sourceFields',
  runnerVersion: 'current-contextual-v1',
}

async function createResumeFixture(selectedCaseIds: string[] = [caseId]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stella-resume-'))
  directories.push(directory)
  await writeFile(join(directory, 'run-manifest.json'), `${JSON.stringify({
    runId: 'run-1',
    branch: 'branch',
    head: 'head',
    originMainSHA: 'base',
    providerMode: 'paid_gemini',
    model: 'gemini-2.5-flash',
    caseCatalogHash: 'catalog-hash',
    caseIds: selectedCaseIds,
    scope: 'canary',
    expectedCalls: selectedCaseIds.length,
    schemaProtocol: 'sourceRefIndexes',
    internalProtocol: 'sourceFields',
    runnerVersion: 'current-contextual-v1',
    startedAt: timestamp,
    status: 'INITIALIZED',
    providerCalls: 0,
  }, null, 2)}\n`, 'utf8')
  await writeTransactionalCheckpoint({
    directory,
    runId: 'run-1',
    scope: 'canary',
    selectedCaseIds,
    caseState: createCaseState(selectedCaseIds),
    rawResponses: [],
    decodedResults: [],
    errors: [],
    telemetry: [],
    sanitizedInputs: [],
    adversarialCaseIds: [],
    status: 'INITIALIZED',
    checkpointStatus: 'PARTIAL_CHECKPOINT',
    startedAt: timestamp,
    lastCheckpointAt: timestamp,
  })
  return directory
}

function setPersistedCaseState(
  artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>,
  phases: Record<string, 'PENDING' | 'IN_FLIGHT' | 'RAW_RECEIVED' | 'DECODED' | 'SUCCEEDED' | 'FAILED'>,
  currentCaseId: string | null,
): void {
  const ids = Object.keys(phases)
  const pendingCaseIds = ids.filter((id) => phases[id] === 'PENDING')
  const processedCaseIds = ids.filter((id) => phases[id] === 'SUCCEEDED')
  const failedCaseIds = ids.filter((id) => phases[id] === 'FAILED')
  const providerCalls = ids.length - pendingCaseIds.length
  artifacts.state.caseStates = phases
  artifacts.state.currentCaseId = currentCaseId
  artifacts.state.providerCalls = providerCalls
  artifacts.state.pendingCaseIds = pendingCaseIds
  artifacts.state.processedCaseIds = processedCaseIds
  artifacts.state.failedCaseIds = failedCaseIds
  artifacts.summary.providerCalls = providerCalls
  artifacts.summary.pendingCases = pendingCaseIds.length
  artifacts.summary.processedCases = processedCaseIds.length
  artifacts.summary.failedCases = failedCaseIds.length
  artifacts.summary.inFlightCases = ids.filter((id) => phases[id] === 'IN_FLIGHT').length
}

async function validCaseArtifacts(): Promise<{
  raw: Awaited<ReturnType<typeof loadResumableArtifacts>>['rawResponses'][number]
  decoded: Awaited<ReturnType<typeof loadResumableArtifacts>>['decodedResults'][number]
}> {
  const result = await runGuardedContextualEvaluation({
    cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
    caseIds: [caseId],
    env: {
      STELLA_PROVIDER_MODE: 'paid_gemini',
      GEMINI_API_KEY: 'test-key',
      STELLA_REAL_EVAL_ACK: 'B1C_CURRENT_ARCHITECTURE_REAL_EVAL',
      STELLA_REAL_EVAL_SUBSET_ACK: 'B1C_CURRENT_ARCHITECTURE_CANARY',
    },
    runtime: {
      branch: 'branch',
      head: 'head',
      originMainSHA: 'base',
      trackedDirty: false,
      stagingDirty: false,
      gitOperationInProgress: false,
    },
    provider: async (request) => request.providerTemplate,
  })
  return { raw: result.rawResponses[0], decoded: result.decodedResults[0] }
}

function validSafeError() {
  return {
    category: 'PROVIDER_ERROR' as const,
    caseId,
    location: 'guarded-contextual-runner',
    type: 'PROVIDER_ERROR',
    summary: 'PROVIDER_ERROR',
    timestamp,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('guarded resume artifacts', () => {
  it('loads the complete checkpoint format produced by the transactional writer', async () => {
    const directory = await createResumeFixture()

    await expect(loadResumableArtifacts(directory)).resolves.toMatchObject({
      directory,
      manifest: { runId: 'run-1', caseIds: [caseId] },
      state: { checkpointSequence: 0, providerCalls: 0, caseStates: { [caseId]: 'PENDING' } },
      summary: { checkpointSequence: 0, runId: 'run-1' },
      rawResponses: [],
      decodedResults: [],
      errors: [],
      hashes: {
        checkpointSequence: 0,
        includedFiles: HASHED_CHECKPOINT_FILES,
      },
    })
  })

  it('rejects a changed checkpoint artifact whose hash no longer matches', async () => {
    const directory = await createResumeFixture()
    const summaryPath = join(directory, 'summary.json')
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as Record<string, unknown>
    await writeFile(summaryPath, `${JSON.stringify({ ...summary, providerCalls: 1 }, null, 2)}\n`, 'utf8')

    await expect(loadResumableArtifacts(directory)).rejects.toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('accepts only hashes of the exact serialized checkpoint files', async () => {
    const directory = await createResumeFixture()
    const artifacts = await loadResumableArtifacts(directory)

    for (const file of HASHED_CHECKPOINT_FILES) {
      const contents = await readFile(join(directory, file), 'utf8')
      expect(artifacts.hashes.hashes[file]).toBe(createHash('sha256').update(contents, 'utf8').digest('hex'))
    }
  })

  it('rehydrates a coherent pending case state without changing the persisted files', async () => {
    const directory = await createResumeFixture()
    const before = await Promise.all([
      'run-manifest.json',
      'run-state.json',
      'summary.json',
      'raw-responses.json',
      'decoded-results.json',
      'errors.json',
      'hashes.json',
    ].map((file) => readFile(join(directory, file), 'utf8')))

    const validated = validateResumableArtifacts(await loadResumableArtifacts(directory), compatibility)

    expect(validated).toMatchObject({
      directory,
      runId: 'run-1',
      startedAt: timestamp,
      resumeCount: 0,
      caseState: {
        phases: { [caseId]: 'PENDING' },
        providerCalls: 0,
        expectedCalls: 1,
        currentCaseId: null,
        checkpointSequence: 0,
      },
    })
    const after = await Promise.all([
      'run-manifest.json',
      'run-state.json',
      'summary.json',
      'raw-responses.json',
      'decoded-results.json',
      'errors.json',
      'hashes.json',
    ].map((file) => readFile(join(directory, file), 'utf8')))
    expect(after).toEqual(before)
  })

  it.each([
    ['branch', { branch: 'other' }],
    ['HEAD', { head: 'other' }],
    ['origin main', { originMainSHA: 'other' }],
    ['provider mode', { providerMode: 'other' }],
    ['model', { model: 'other' }],
    ['catalog', { caseCatalogHash: 'other' }],
    ['case order', { caseIds: ['other'] }],
    ['scope', { scope: 'full' }],
    ['expected calls', { expectedCalls: 2 }],
    ['schema protocol', { schemaProtocol: 'other' }],
    ['internal protocol', { internalProtocol: 'other' }],
    ['runner version', { runnerVersion: 'other' }],
  ] as Array<[string, Partial<ResumeCompatibility>]>)('rejects incompatible %s before execution', async (_name, patch) => {
    const directory = await createResumeFixture()
    const artifacts = await loadResumableArtifacts(directory)

    expect(() => validateResumableArtifacts(artifacts, { ...compatibility, ...patch })).toThrow('RESUME_INTEGRITY_ERROR')
  })

  it.each([
    ['completed state', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.state.status = 'COMPLETED_PENDING_HUMAN_REVIEW'
    }],
    ['provider calls above expected', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.state.providerCalls = 2
    }],
    ['provider calls below started cases', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.state.caseStates = { [caseId]: 'IN_FLIGHT' }
      artifacts.state.currentCaseId = caseId
    }],
    ['duplicate manifest IDs', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.manifest.caseIds = [caseId, caseId]
    }],
    ['duplicate state IDs', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.state.caseStates = { [caseId]: 'PENDING', duplicate: 'PENDING' }
    }],
    ['unknown raw ID', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.rawResponses = [{ caseId: 'unknown', providerResponse: {}, timestamp }]
    }],
    ['raw response for pending case', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.rawResponses = [{ caseId, providerResponse: {}, timestamp }]
    }],
    ['succeeded case without raw and decoded artifacts', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.state.caseStates = { [caseId]: 'SUCCEEDED' }
      artifacts.state.providerCalls = 1
      artifacts.summary.providerCalls = 1
    }],
    ['derived pending IDs disagree with case states', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.state.pendingCaseIds = []
    }],
    ['summary counts disagree with case states', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.summary.pendingCases = 0
    }],
    ['final hash marker without completed state', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.hashes.status = 'FINAL'
    }],
  ])('rejects incoherent artifacts: %s', async (_name, mutate) => {
    const directory = await createResumeFixture()
    const artifacts = await loadResumableArtifacts(directory)
    mutate(artifacts)

    expect(() => validateResumableArtifacts(artifacts, compatibility)).toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('rejects a checkpoint sequence disagreement', async () => {
    const directory = await createResumeFixture()
    const summaryPath = join(directory, 'summary.json')
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as Record<string, unknown>
    await writeFile(summaryPath, `${JSON.stringify({ ...summary, checkpointSequence: 1 }, null, 2)}\n`, 'utf8')

    await expect(loadResumableArtifacts(directory)).rejects.toThrow('checkpoint sequence mismatch')
  })

  it.each([
    ['missing artifact', async (directory: string) => rm(join(directory, 'errors.json'))],
    ['corrupt manifest', async (directory: string) => writeFile(join(directory, 'run-manifest.json'), '{', 'utf8')],
    ['corrupt state', async (directory: string) => writeFile(join(directory, 'run-state.json'), '{', 'utf8')],
  ])('rejects %s', async (_name, corrupt) => {
    const directory = await createResumeFixture()
    await corrupt(directory)

    await expect(loadResumableArtifacts(directory)).rejects.toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('persists a resumed run in the same directory with its runId, calls, and incremented resumeCount', async () => {
    const directory = await createResumeFixture()
    const manifestBefore = await readFile(join(directory, 'run-manifest.json'), 'utf8')
    const validated = validateResumableArtifacts(await loadResumableArtifacts(directory), compatibility)
    const calls: string[] = []

    await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: [caseId],
      env: {
        STELLA_PROVIDER_MODE: 'paid_gemini',
        GEMINI_API_KEY: 'test-key',
        STELLA_REAL_EVAL_ACK: 'B1C_CURRENT_ARCHITECTURE_REAL_EVAL',
        STELLA_REAL_EVAL_SUBSET_ACK: 'B1C_CURRENT_ARCHITECTURE_CANARY',
      },
      runtime: {
        branch: 'branch',
        head: 'head',
        originMainSHA: 'base',
        trackedDirty: false,
        stagingDirty: false,
        gitOperationInProgress: false,
      },
      isResume: true,
      runId: validated.runId,
      startedAt: validated.startedAt,
      initialCaseState: validated.caseState,
      initialRawResponses: validated.rawResponses,
      initialDecodedResults: validated.decodedResults,
      initialErrors: validated.errors,
      initialTelemetry: validated.telemetry,
      // INSTRUMENTED on purpose: this run reaches a FINAL commit, and a FINAL
      // bundle must carry one telemetry row per provider call. An
      // uninstrumented stub is rejected by the writer — which is the point of
      // that gate, and is why this provider returns the measured shape.
      provider: async (request) => {
        calls.push(request.case.caseId)
        return {
          response: request.providerTemplate,
          telemetry: {
            requestedModel: 'gemini-3.6-flash',
            requestStartedAt: timestamp,
            responseReceivedAt: timestamp,
            latencyMs: 1234,
            usage: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 22 },
            usageAvailable: true,
            finishReason: 'STOP',
            outputChars: 128,
          },
        }
      },
      onCheckpoint: async (checkpoint) => {
        await writeTransactionalCheckpoint({
          directory: validated.directory,
          runId: validated.runId,
          scope: 'canary',
          selectedCaseIds: [caseId],
          caseState: checkpoint.caseState,
          telemetry: checkpoint.telemetry,
          sanitizedInputs: checkpoint.sanitizedInputs,
          adversarialCaseIds: checkpoint.adversarialCaseIds,
          rawResponses: checkpoint.rawResponses,
          decodedResults: checkpoint.decodedResults,
          errors: checkpoint.errors,
          status: checkpoint.status,
          checkpointStatus: checkpoint.checkpointStatus,
          startedAt: validated.startedAt,
          lastCheckpointAt: checkpoint.lastCheckpointAt,
        })
      },
    })

    expect(calls).toEqual([caseId])
    expect(await readFile(join(directory, 'run-manifest.json'), 'utf8')).toBe(manifestBefore)
    expect(JSON.parse(await readFile(join(directory, 'run-state.json'), 'utf8'))).toMatchObject({
      runId: 'run-1',
      providerCalls: 1,
      expectedCalls: 1,
      resumeCount: 1,
      caseStates: { [caseId]: 'SUCCEEDED' },
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    })
    expect(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))).toMatchObject({
      runId: 'run-1',
      providerCalls: 1,
      resumeCount: 1,
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    })
  })

  it.each([
    ['started case after a pending gap', { [caseId]: 'PENDING', [secondCaseId]: 'IN_FLIGHT' }, secondCaseId],
    ['multiple active cases', { [caseId]: 'RAW_RECEIVED', [secondCaseId]: 'IN_FLIGHT' }, secondCaseId],
    ['active case without currentCaseId', { [caseId]: 'IN_FLIGHT', [secondCaseId]: 'PENDING' }, null],
  ] as Array<[string, Record<string, 'PENDING' | 'IN_FLIGHT' | 'RAW_RECEIVED'>, string | null]>)('rejects unreachable case sequence: %s', async (_name, phases, currentCaseId) => {
    const directory = await createResumeFixture([caseId, secondCaseId])
    const artifacts = await loadResumableArtifacts(directory)
    setPersistedCaseState(artifacts, phases, currentCaseId)

    expect(() => validateResumableArtifacts(artifacts, {
      ...compatibility,
      caseIds: [caseId, secondCaseId],
      knownCaseIds: [caseId, secondCaseId],
      expectedCalls: 2,
    })).toThrow('RESUME_INTEGRITY_ERROR')
  })

  it.each([
    ['null error record', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.errors = [null as unknown as typeof artifacts.errors[number]]
    }],
    ['malformed decoded output', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      setPersistedCaseState(artifacts, { [caseId]: 'DECODED' }, caseId)
      artifacts.decodedResults = [{
        caseId,
        output: { summary: 42 },
        canonicalValidation: 'passed',
        safety: 'pending',
        schemaContract: 'passed',
        numericIntegrity: 'pending',
        requiresHumanReview: true,
      } as unknown as typeof artifacts.decodedResults[number]]
    }],
    ['incoherent startedAt', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.summary.startedAt = '2026-07-30T13:00:00.000Z'
    }],
    ['incoherent running status', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.summary.status = 'RUNNING'
      artifacts.state.status = 'INITIALIZED'
    }],
  ])('rejects malformed runtime artifact: %s', async (_name, mutate) => {
    const directory = await createResumeFixture()
    const artifacts = await loadResumableArtifacts(directory)
    mutate(artifacts)

    expect(() => validateResumableArtifacts(artifacts, compatibility)).toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('rejects a succeeded case whose decoded safety checks remain pending', async () => {
    const directory = await createResumeFixture()
    const artifacts = await loadResumableArtifacts(directory)
    const completed = await validCaseArtifacts()
    setPersistedCaseState(artifacts, { [caseId]: 'SUCCEEDED' }, null)
    artifacts.state.status = 'RUNNING'
    artifacts.summary.status = 'RUNNING'
    artifacts.rawResponses = [completed.raw]
    artifacts.decodedResults = [{ ...completed.decoded, safety: 'pending', numericIntegrity: 'pending' }]
    Object.assign(artifacts.summary, {
      successfulResponses: 1,
      failedResponses: 0,
      schemaValidCases: 1,
      schemaInvalidCases: 0,
      internalCanonicalDecodingCases: 1,
      requiresHumanReviewCases: 1,
    })

    expect(() => validateResumableArtifacts(artifacts, compatibility)).toThrow('RESUME_INTEGRITY_ERROR')
  })

  it.each([
    ['total case count', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.summary.totalCases = 2
    }],
    ['eligible gate', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.summary.eligibleForGate = true
    }],
    ['human review status', (artifacts: Awaited<ReturnType<typeof loadResumableArtifacts>>) => {
      artifacts.summary.humanReviewStatus = 'COMPLETED'
    }],
  ])('rejects incoherent summary field: %s', async (_name, mutate) => {
    const directory = await createResumeFixture()
    const artifacts = await loadResumableArtifacts(directory)
    mutate(artifacts)

    expect(() => validateResumableArtifacts(artifacts, compatibility)).toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('rejects a case-scoped error for a non-failed case', async () => {
    const directory = await createResumeFixture()
    const artifacts = await loadResumableArtifacts(directory)
    artifacts.errors = [validSafeError()]

    expect(() => validateResumableArtifacts(artifacts, compatibility)).toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('rejects a failed case without its safe error', async () => {
    const directory = await createResumeFixture()
    const artifacts = await loadResumableArtifacts(directory)
    setPersistedCaseState(artifacts, { [caseId]: 'FAILED' }, null)
    artifacts.state.status = 'FAILED'
    artifacts.summary.status = 'FAILED'
    artifacts.summary.failedResponses = 1

    expect(() => validateResumableArtifacts(artifacts, compatibility)).toThrow('RESUME_INTEGRITY_ERROR')
  })
})
