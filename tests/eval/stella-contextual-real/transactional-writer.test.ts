import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCaseState, transitionCase, type TransactionalCaseState } from './case-state'
import type { DecodedResult, ProviderCallTelemetry, RawResponse, SafeRunError, SanitizedCaseInput } from './types'
import {
  HASHED_CHECKPOINT_FILES,
  inspectCheckpointSequences,
  writeTransactionalCheckpoint,
  type CheckpointArtifactFile,
  type TransactionalCheckpointInput,
  type TransactionalWriterFileSystem,
} from './transactional-writer'

const directories: string[] = []
const timestamp = '2026-07-30T12:00:00.000Z'

/**
 * H3: a run directory now REQUIRES its manifest before any checkpoint can be
 * written — the integrity record binds HEAD/branch/model/caseCatalogHash by
 * value and hashes the manifest file, so a checkpoint without one would be
 * evidence bound to nothing. Every fixture directory therefore gets one, with
 * `runId` matching the `input()` helper below.
 */
export const MANIFEST_FIXTURE = {
  runId: 'run-1',
  head: 'f8969f5d9f1bbde2719866b236d61ad2647fc0e1',
  branch: 'codex/stella-staging',
  model: 'gemini-3.6-flash',
  caseCatalogHash: 'catalog-hash',
  caseIds: ['case-1'],
}

async function createDirectory(manifest: Record<string, unknown> = MANIFEST_FIXTURE): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stella-transactional-writer-'))
  directories.push(directory)
  await writeFile(join(directory, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return directory
}

async function readJson(directory: string, file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(directory, file), 'utf8')) as Record<string, unknown>
}

function input(
  directory: string,
  caseState: TransactionalCaseState = createCaseState(['case-1']),
  patch: Partial<TransactionalCheckpointInput> = {},
): TransactionalCheckpointInput {
  return {
    directory,
    runId: 'run-1',
    scope: 'canary',
    selectedCaseIds: ['case-1'],
    caseState,
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
    ...patch,
  }
}

function succeededState(): TransactionalCaseState {
  let state = transitionCase(createCaseState(['case-1']), 'case-1', 'IN_FLIGHT')
  state = transitionCase(state, 'case-1', 'RAW_RECEIVED')
  state = transitionCase(state, 'case-1', 'DECODED')
  return transitionCase(state, 'case-1', 'SUCCEEDED')
}

const rawResponse: RawResponse = {
  caseId: 'case-1',
  providerResponse: {
    findings: [{ sourceRefIndexes: [0] }],
    suggestions: [{ sourceRefIndexes: [1] }],
  },
  timestamp,
}

/** H2: one fully instrumented provider call. */
const telemetryRecord: ProviderCallTelemetry = {
  caseId: 'case-1',
  requestedModel: 'gemini-3.6-flash',
  providerModelVersion: 'gemini-3.6-flash',
  requestStartedAt: timestamp,
  responseReceivedAt: '2026-07-30T12:00:04.200Z',
  latencyMs: 4200,
  usage: {
    promptTokenCount: 5000,
    candidatesTokenCount: 700,
    thoughtsTokenCount: 900,
    totalTokenCount: 6600,
  },
  usageAvailable: true,
  finishReason: 'STOP',
  outputChars: 2048,
}

/** H4: one post-redaction, provider-safe input. */
const sanitizedInput: SanitizedCaseInput = {
  caseId: 'case-1',
  step: 'stakeholders',
  category: 'complete',
  systemPrompt: 'You are Stella, the contextual methodology advisor for Uellix.',
  userMessage: 'UNTRUSTED_PROJECT_DATA\n{"step":"stakeholders"}',
  responseJsonSchema: { type: 'object' },
  canonicalSourceFieldPaths: ['stakeholders[0].name'],
  redaction: 'post-redaction',
}

const decodedResult = {
  caseId: 'case-1',
  output: {
    findings: [{ sourceFields: ['stakeholders[0].name'] }],
    suggestions: [{ sourceFields: ['outcomes[0].name'] }],
  },
  canonicalValidation: 'passed',
  safety: 'passed',
  schemaContract: 'passed',
  numericIntegrity: 'passed',
  requiresHumanReview: true,
} as unknown as DecodedResult

const safeError: SafeRunError = {
  category: 'PROVIDER_ERROR',
  caseId: 'case-1',
  location: 'guarded-contextual-runner',
  type: 'PROVIDER_ERROR',
  summary: 'PROVIDER_ERROR',
  timestamp,
}

function nodeFileSystem(events: string[] = []): TransactionalWriterFileSystem {
  return {
    async open(path) {
      events.push(`open-directory:${dirname(path)}`)
      events.push(`open:${basename(path)}`)
      const handle = await open(path, 'wx')
      return {
        async writeFile(contents) {
          events.push(`write:${basename(path)}`)
          await handle.writeFile(contents, 'utf8')
        },
        async close() {
          await handle.close()
          JSON.parse(await readFile(path, 'utf8'))
          events.push(`close:${basename(path)}`)
        },
      }
    },
    readFile: async (path) => readFile(path, 'utf8'),
    async rename(from, to) {
      events.push(`rename:${basename(to)}`)
      await rename(from, to)
    },
    unlink,
  }
}

type FailurePoint =
  | 'write-temporary'
  | 'close-temporary'
  | `rename-${CheckpointArtifactFile}`
  | 'before-run-state'
  | 'cleanup'

function fileFromTemporaryPath(path: string): CheckpointArtifactFile | undefined {
  return [
    'raw-responses.json',
    'decoded-results.json',
    'errors.json',
    'summary.json',
    'hashes.json',
    'run-state.json',
  ].find((file) => basename(path).startsWith(`.${file}.`)) as CheckpointArtifactFile | undefined
}

function failingFileSystem(point: FailurePoint): TransactionalWriterFileSystem {
  return {
    async open(path) {
      const handle = await open(path, 'wx')
      const file = fileFromTemporaryPath(path)
      return {
        async writeFile(contents) {
          if (point === 'write-temporary' && file === 'raw-responses.json') {
            await handle.writeFile('{', 'utf8')
            throw new Error('simulated temporary write failure')
          }
          await handle.writeFile(contents, 'utf8')
        },
        async close() {
          await handle.close()
          if (point === 'close-temporary' && file === 'raw-responses.json') {
            throw new Error('simulated temporary close failure')
          }
        },
      }
    },
    readFile: async (path) => readFile(path, 'utf8'),
    async rename(from, to) {
      if (point === `rename-${basename(to)}`) throw new Error(`simulated rename failure: ${basename(to)}`)
      await rename(from, to)
    },
    unlink,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('transactional multi-artifact checkpoint writer', () => {
  it('writes one parseable checkpoint sequence across all controlled artifacts', async () => {
    const directory = await createDirectory()
    const sequence = await writeTransactionalCheckpoint(input(directory))

    expect(sequence).toBe(0)
    for (const file of [
      'run-state.json',
      'summary.json',
      'raw-responses.json',
      'decoded-results.json',
      'errors.json',
      'provider-telemetry.json',
      'sanitized-inputs.json',
      'hashes.json',
    ]) {
      await expect(readJson(directory, file)).resolves.toMatchObject({ checkpointSequence: 0 })
    }
  })

  it('closes complete JSON temporaries and renames run-state last in the required order', async () => {
    const directory = await createDirectory()
    const events: string[] = []
    await writeTransactionalCheckpoint(input(directory, createCaseState(['case-1']), { fileSystem: nodeFileSystem(events) }))

    expect(events.filter((event) => event.startsWith('close:'))).toHaveLength(8)
    expect(events.filter((event) => event.startsWith('rename:'))).toEqual([
      'rename:raw-responses.json',
      'rename:decoded-results.json',
      'rename:errors.json',
      'rename:provider-telemetry.json',
      'rename:sanitized-inputs.json',
      'rename:summary.json',
      'rename:hashes.json',
      // run-state.json stays LAST: it is the commit marker.
      'rename:run-state.json',
    ])
    expect((await readdir(directory)).filter((file) => file.endsWith('.tmp'))).toEqual([])
    expect([...new Set(events.filter((event) => event.startsWith('open-directory:')).map((event) => event.slice('open-directory:'.length)))]).toEqual([directory])
  })

  it('hashes the exact serialized final contents without hashing hashes.json itself', async () => {
    const directory = await createDirectory()
    await writeTransactionalCheckpoint(input(directory))
    const hashesArtifact = await readJson(directory, 'hashes.json') as {
      includedFiles: string[]
      hashes: Record<string, string>
    }

    expect(hashesArtifact.includedFiles).toEqual(HASHED_CHECKPOINT_FILES)
    expect(hashesArtifact.includedFiles).not.toContain('hashes.json')
    for (const file of HASHED_CHECKPOINT_FILES) {
      const contents = await readFile(join(directory, file), 'utf8')
      expect(hashesArtifact.hashes[file]).toBe(createHash('sha256').update(contents, 'utf8').digest('hex'))
    }
  })

  it('preserves the immutable manifest, raw indexes, canonical fields, and caller-owned raw data', async () => {
    const directory = await createDirectory()
    // H3: the manifest is now READ by the checkpoint (to bind and hash it) and
    // must still never be rewritten by it. Captured before the write and
    // compared byte for byte after.
    const manifest = await readFile(join(directory, 'run-manifest.json'), 'utf8')
    const originalRaw = structuredClone(rawResponse)
    await writeTransactionalCheckpoint(input(directory, succeededState(), {
      rawResponses: [rawResponse],
      decodedResults: [decodedResult],
      // FINAL now demands full instrumentation: one telemetry row per provider
      // call, one sanitized input per selected case.
      telemetry: [telemetryRecord],
      sanitizedInputs: [sanitizedInput],
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
      checkpointStatus: 'FINAL',
    }))

    expect(await readFile(join(directory, 'run-manifest.json'), 'utf8')).toBe(manifest)
    expect(await readJson(directory, 'raw-responses.json')).toMatchObject({
      responses: [{ providerResponse: { findings: [{ sourceRefIndexes: [0] }] } }],
    })
    expect(await readJson(directory, 'decoded-results.json')).toMatchObject({
      results: [{ output: { findings: [{ sourceFields: ['stakeholders[0].name'] }] } }],
    })
    expect(rawResponse).toEqual(originalRaw)
    expect(await readJson(directory, 'hashes.json')).toMatchObject({ status: 'FINAL' })
  })

  it('accepts only a strictly newer second checkpoint and produces stable hashes for equivalent contents', async () => {
    const directory = await createDirectory()
    const equivalentDirectory = await createDirectory()
    const initial = createCaseState(['case-1'])
    await writeTransactionalCheckpoint(input(directory, initial))
    const inFlight = transitionCase(initial, 'case-1', 'IN_FLIGHT')
    expect(await writeTransactionalCheckpoint(input(directory, inFlight, { status: 'RUNNING' }))).toBe(1)
    await expect(writeTransactionalCheckpoint(input(directory, inFlight, { status: 'RUNNING' }))).rejects.toThrow('CHECKPOINT_ERROR')

    await writeTransactionalCheckpoint(input(equivalentDirectory, inFlight, { status: 'RUNNING' }))
    expect(await readJson(directory, 'hashes.json')).toEqual(await readJson(equivalentDirectory, 'hashes.json'))
  })

  it.each([
    ['duplicate selected IDs', (value: TransactionalCheckpointInput) => ({ ...value, selectedCaseIds: ['case-1', 'case-1'] })],
    ['provider call lower bound', (value: TransactionalCheckpointInput) => ({ ...value, caseState: { ...value.caseState, providerCalls: -1 } })],
    ['current case is not active', (value: TransactionalCheckpointInput) => ({ ...value, caseState: { ...value.caseState, currentCaseId: 'case-1' } })],
    ['unknown raw ID', (value: TransactionalCheckpointInput) => ({ ...value, caseState: succeededState(), rawResponses: [{ ...rawResponse, caseId: 'unknown' }] })],
    ['duplicate raw ID', (value: TransactionalCheckpointInput) => ({ ...value, caseState: succeededState(), rawResponses: [rawResponse, rawResponse] })],
    ['duplicate decoded ID', (value: TransactionalCheckpointInput) => ({ ...value, caseState: succeededState(), decodedResults: [decodedResult, decodedResult] })],
    ['unknown error ID', (value: TransactionalCheckpointInput) => ({ ...value, errors: [{ ...safeError, caseId: 'unknown' }] })],
    ['unsafe error stack', (value: TransactionalCheckpointInput) => ({ ...value, errors: [{ ...safeError, stack: 'private stack trace' }] })],
    ['raw before RAW_RECEIVED', (value: TransactionalCheckpointInput) => ({ ...value, rawResponses: [rawResponse] })],
    ['decoded before DECODED', (value: TransactionalCheckpointInput) => ({ ...value, decodedResults: [decodedResult] })],
    ['sourceFields in raw', (value: TransactionalCheckpointInput) => ({ ...value, caseState: succeededState(), rawResponses: [{ ...rawResponse, providerResponse: { sourceFields: ['secret'] } }] })],
    ['sourceRefIndexes in decoded', (value: TransactionalCheckpointInput) => ({ ...value, caseState: succeededState(), decodedResults: [{ ...decodedResult, output: { sourceRefIndexes: [0] } as never }] })],
    ['provider API key', (value: TransactionalCheckpointInput) => ({ ...value, caseState: succeededState(), rawResponses: [{ ...rawResponse, providerResponse: { apiKey: 'secret' } }] })],
  ])('blocks the complete write for invariant violation: %s', async (_name, mutate) => {
    const directory = await createDirectory()
    await expect(writeTransactionalCheckpoint(mutate(input(directory)))).rejects.toThrow('CHECKPOINT_ERROR')
    // The manifest is a PRECONDITION of the run directory, not an output of the
    // checkpoint, so it is excluded: what must be empty is everything the
    // blocked write could have produced.
    expect((await readdir(directory)).filter((file) => file !== 'run-manifest.json')).toEqual([])
  })

  it('detects auxiliary artifacts whose sequence disagrees with the confirmed run-state', () => {
    expect(inspectCheckpointSequences(4, {
      'summary.json': 5,
      'raw-responses.json': 5,
      'decoded-results.json': 5,
      'errors.json': 5,
      'provider-telemetry.json': 5,
      'sanitized-inputs.json': 5,
      'hashes.json': 5,
    })).toEqual({
      valid: false,
      error: 'CHECKPOINT_SEQUENCE_MISMATCH',
      confirmedCheckpointSequence: 4,
      mismatchedFiles: ['summary.json', 'raw-responses.json', 'decoded-results.json', 'errors.json', 'provider-telemetry.json', 'sanitized-inputs.json', 'hashes.json'],
    })
  })

  it('treats a missing auxiliary sequence as a mismatch', () => {
    expect(inspectCheckpointSequences(4, {
      'summary.json': 4,
      'raw-responses.json': 4,
      'decoded-results.json': 4,
      'errors.json': 4,
      'provider-telemetry.json': 4,
      'sanitized-inputs.json': 4,
    })).toMatchObject({
      valid: false,
      error: 'CHECKPOINT_SEQUENCE_MISMATCH',
      mismatchedFiles: ['hashes.json'],
    })
  })

  it.each([
    'write-temporary',
    'close-temporary',
    'rename-raw-responses.json',
    'rename-decoded-results.json',
    'rename-errors.json',
    'rename-summary.json',
    'rename-hashes.json',
    'before-run-state',
    'rename-run-state.json',
    'cleanup',
  ] as FailurePoint[])('preserves the previous confirmed marker after injected failure: %s', async (point) => {
    const directory = await createDirectory()
    const initial = createCaseState(['case-1'])
    await writeTransactionalCheckpoint(input(directory, initial))
    const confirmedRunState = await readFile(join(directory, 'run-state.json'), 'utf8')
    const inFlight = transitionCase(initial, 'case-1', 'IN_FLIGHT')
    let cleanupFailureInjected = false

    await expect(writeTransactionalCheckpoint(input(directory, inFlight, {
      status: 'RUNNING',
      fileSystem: failingFileSystem(point),
      hooks: {
        beforeRename(file) {
          if (point === 'before-run-state' && file === 'run-state.json') {
            throw new Error('simulated failure immediately before run-state rename')
          }
        },
        beforeCleanup() {
          if (point === 'cleanup' && !cleanupFailureInjected) {
            cleanupFailureInjected = true
            throw new Error('simulated temporary cleanup failure')
          }
        },
      },
    }))).rejects.toThrow('CHECKPOINT_ERROR')

    expect(await readFile(join(directory, 'run-state.json'), 'utf8')).toBe(confirmedRunState)
    expect(await readJson(directory, 'run-state.json')).toMatchObject({ checkpointSequence: 0 })
  })

  it.each([
    'write-temporary',
    'close-temporary',
    'rename-raw-responses.json',
    'rename-decoded-results.json',
    'rename-errors.json',
    'rename-summary.json',
    'rename-hashes.json',
    'before-run-state',
    'rename-run-state.json',
    'cleanup',
  ] as FailurePoint[])('does not leave an apparently valid run when the first checkpoint fails: %s', async (point) => {
    const directory = await createDirectory()
    let cleanupFailureInjected = false
    await expect(writeTransactionalCheckpoint(input(directory, createCaseState(['case-1']), {
      fileSystem: failingFileSystem(point),
      hooks: {
        beforeRename(file) {
          if (point === 'before-run-state' && file === 'run-state.json') {
            throw new Error('simulated failure immediately before run-state rename')
          }
        },
        beforeCleanup() {
          if (point === 'cleanup' && !cleanupFailureInjected) {
            cleanupFailureInjected = true
            throw new Error('simulated temporary cleanup failure')
          }
        },
      },
    }))).rejects.toThrow('CHECKPOINT_ERROR')
    await expect(readFile(join(directory, 'run-state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never promotes a corrupt temporary over a previously confirmed artifact', async () => {
    const directory = await createDirectory()
    const initial = createCaseState(['case-1'])
    await writeTransactionalCheckpoint(input(directory, initial))
    const confirmedRaw = await readFile(join(directory, 'raw-responses.json'), 'utf8')
    await expect(writeTransactionalCheckpoint(input(
      directory,
      transitionCase(initial, 'case-1', 'IN_FLIGHT'),
      { status: 'RUNNING', fileSystem: failingFileSystem('write-temporary') },
    ))).rejects.toThrow('CHECKPOINT_ERROR')
    expect(await readFile(join(directory, 'raw-responses.json'), 'utf8')).toBe(confirmedRaw)
    expect(() => JSON.parse(confirmedRaw)).not.toThrow()
  })

  it('exposes partial auxiliary promotion as a sequence mismatch while preserving the marker', async () => {
    const directory = await createDirectory()
    const initial = createCaseState(['case-1'])
    await writeTransactionalCheckpoint(input(directory, initial))
    await expect(writeTransactionalCheckpoint(input(
      directory,
      transitionCase(initial, 'case-1', 'IN_FLIGHT'),
      {
        status: 'RUNNING',
        hooks: {
          beforeRename(file) {
            if (file === 'run-state.json') throw new Error('stop before commit marker')
          },
        },
      },
    ))).rejects.toThrow('CHECKPOINT_ERROR')

    const artifactSequences = Object.fromEntries(await Promise.all([
      'summary.json',
      'raw-responses.json',
      'decoded-results.json',
      'errors.json',
      'hashes.json',
    ].map(async (file) => [file, Number((await readJson(directory, file)).checkpointSequence)])))
    expect(inspectCheckpointSequences(
      Number((await readJson(directory, 'run-state.json')).checkpointSequence),
      artifactSequences,
    )).toMatchObject({
      valid: false,
      error: 'CHECKPOINT_SEQUENCE_MISMATCH',
      confirmedCheckpointSequence: 0,
    })
  })

  // Case G (spec section 12): checkpoint metrics must never be null, even with zero incidents.
  it('never writes a null metric in a partial checkpoint summary', async () => {
    const directory = await createDirectory()
    await writeTransactionalCheckpoint(input(directory))
    const summary = await readJson(directory, 'summary.json')
    for (const key of [
      'invalidSourceFields', 'providerSourceFieldsProperties', 'providerStringReferenceValues',
      'providerAliases', 'providerCanonicalPaths', 'providerSFReferences', 'invalidIndexes', 'providerStepMismatches',
    ]) {
      expect(summary[key]).not.toBeNull()
      expect(summary[key]).not.toBeUndefined()
      expect(summary[key]).toBe(0)
    }
  })

  // Case H (spec section 12): 10 calls, 10 raw responses, 9 valid decodes, 1 failure.
  it('reports coherent counter semantics for a mixed batch of successes and one failure', async () => {
    const directory = await createDirectory()
    const caseIds = Array.from({ length: 10 }, (_, index) => `case-${index + 1}`)
    const successIds = caseIds.slice(0, 9)
    const failedId = caseIds[9]

    let state = createCaseState(caseIds)
    for (const id of successIds) {
      state = transitionCase(state, id, 'IN_FLIGHT')
      state = transitionCase(state, id, 'RAW_RECEIVED')
      state = transitionCase(state, id, 'DECODED')
      state = transitionCase(state, id, 'SUCCEEDED')
    }
    state = transitionCase(state, failedId, 'IN_FLIGHT')
    state = transitionCase(state, failedId, 'RAW_RECEIVED')
    state = transitionCase(state, failedId, 'FAILED')

    const rawResponses = caseIds.map((caseId) => ({ ...rawResponse, caseId }))
    const decodedResults = successIds.map((caseId) => ({ ...decodedResult, caseId }))
    const errors = [{ ...safeError, category: 'SOURCE_REFERENCE_ERROR' as const, caseId: failedId }]

    await writeTransactionalCheckpoint(input(directory, state, {
      selectedCaseIds: caseIds,
      rawResponses,
      decodedResults,
      errors,
      status: 'FAILED',
      metrics: { providerStepMismatches: 1 },
    }))

    expect(await readJson(directory, 'summary.json')).toMatchObject({
      providerCalls: 10,
      providerResponsesReceived: 10,
      successfulResponses: 9,
      failedResponses: 1,
      schemaValidCases: 9,
      schemaInvalidCases: 1,
      providerStepMismatches: 1,
    })
  })
})
