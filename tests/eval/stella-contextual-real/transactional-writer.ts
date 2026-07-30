import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertCaseStateInvariants, deriveCaseState, type TransactionalCaseState } from './case-state'
import { SAFE_ERROR_CATEGORIES, type DecodedResult, type RawResponse, type RealRunnerScope, type RealRunnerStatus, type SafeRunError } from './types'

export const HASHED_CHECKPOINT_FILES = [
  'run-state.json',
  'summary.json',
  'raw-responses.json',
  'decoded-results.json',
  'errors.json',
] as const
export type HashedCheckpointFile = (typeof HASHED_CHECKPOINT_FILES)[number]
export type CheckpointArtifactFile = HashedCheckpointFile | 'hashes.json'
export type CheckpointCommitStatus = 'PARTIAL_CHECKPOINT' | 'FINAL'
export type AuxiliaryCheckpointFile = Exclude<CheckpointArtifactFile, 'run-state.json'>
export const AUXILIARY_CHECKPOINT_FILES: readonly AuxiliaryCheckpointFile[] = [
  'summary.json',
  'raw-responses.json',
  'decoded-results.json',
  'errors.json',
  'hashes.json',
]

const RENAME_ORDER: readonly CheckpointArtifactFile[] = [
  'raw-responses.json',
  'decoded-results.json',
  'errors.json',
  'summary.json',
  'hashes.json',
  'run-state.json',
]

export interface TransactionalWriterHandle {
  writeFile(contents: string): Promise<void>
  close(): Promise<void>
}

export interface TransactionalWriterFileSystem {
  open(path: string): Promise<TransactionalWriterHandle>
  readFile(path: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface TransactionalWriterHooks {
  beforeRename?: (file: CheckpointArtifactFile) => Promise<void> | void
  beforeCleanup?: (path: string) => Promise<void> | void
}

export interface TransactionalCheckpointInput {
  directory: string
  runId: string
  scope: RealRunnerScope
  selectedCaseIds: readonly string[]
  caseState: TransactionalCaseState
  rawResponses: readonly RawResponse[]
  decodedResults: readonly DecodedResult[]
  errors: readonly SafeRunError[]
  metrics?: Partial<Record<string, number>>
  status: RealRunnerStatus
  checkpointStatus: CheckpointCommitStatus
  startedAt: string
  lastCheckpointAt: string
  fileSystem?: TransactionalWriterFileSystem
  hooks?: TransactionalWriterHooks
}

const defaultFileSystem: TransactionalWriterFileSystem = {
  async open(path) {
    const handle = await open(path, 'wx')
    return {
      writeFile: async (contents) => handle.writeFile(contents, 'utf8'),
      close: async () => handle.close(),
    }
  },
  readFile: async (path) => readFile(path, 'utf8'),
  rename,
  unlink,
}

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const sha256 = (contents: string): string => createHash('sha256').update(contents, 'utf8').digest('hex')
const RAW_PHASES = new Set(['RAW_RECEIVED', 'DECODED', 'SUCCEEDED', 'FAILED'])
const DECODED_PHASES = new Set(['DECODED', 'SUCCEEDED', 'FAILED'])
const SAFE_ERROR_KEYS = new Set(['category', 'caseId', 'location', 'type', 'summary', 'timestamp'])
const FORBIDDEN_ARTIFACT_KEYS = new Set(['GEMINI_API_KEY', 'apiKey', 'systemPrompt', 'userMessage', 'processEnv', 'prompt', 'context', 'stack'])
const SAFE_ERROR_CATEGORY_SET = new Set(SAFE_ERROR_CATEGORIES)

function checkpointError(): Error {
  return new Error('CHECKPOINT_ERROR')
}

function containsKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => containsKey(item, keys))
  return Object.entries(value).some(([key, nested]) => keys.has(key) || containsKey(nested, keys))
}

function hasUniqueKnownCaseIds(
  values: readonly { caseId: string }[],
  selectedCaseIds: ReadonlySet<string>,
): boolean {
  const ids = values.map((value) => value.caseId)
  return ids.every((id) => selectedCaseIds.has(id)) && new Set(ids).size === ids.length
}

function assertArtifactInvariants(input: TransactionalCheckpointInput): void {
  const selectedCaseIds = new Set(input.selectedCaseIds)
  if (!hasUniqueKnownCaseIds(input.rawResponses, selectedCaseIds)) throw checkpointError()
  if (!hasUniqueKnownCaseIds(input.decodedResults, selectedCaseIds)) throw checkpointError()
  if (!input.errors.every((error) => !error.caseId || selectedCaseIds.has(error.caseId))) throw checkpointError()
  if (input.rawResponses.some((response) => !RAW_PHASES.has(input.caseState.phases[response.caseId]))) throw checkpointError()
  if (input.decodedResults.some((result) => !DECODED_PHASES.has(input.caseState.phases[result.caseId]))) throw checkpointError()
  if (containsKey(input.rawResponses, new Set(['sourceFields']))) throw checkpointError()
  if (containsKey(input.decodedResults, new Set(['sourceRefIndexes']))) throw checkpointError()
  if (containsKey([input.rawResponses, input.decodedResults, input.errors], FORBIDDEN_ARTIFACT_KEYS)) throw checkpointError()
  if (input.errors.some((error) => {
    const keys = Object.keys(error)
    return keys.some((key) => !SAFE_ERROR_KEYS.has(key))
      || !SAFE_ERROR_CATEGORY_SET.has(error.category)
      || typeof error.location !== 'string'
      || typeof error.type !== 'string'
      || typeof error.summary !== 'string'
      || typeof error.timestamp !== 'string'
  })) throw checkpointError()
}

export function inspectCheckpointSequences(
  confirmedCheckpointSequence: number,
  artifactSequences: Partial<Record<AuxiliaryCheckpointFile, number>>,
):
  | { valid: true; confirmedCheckpointSequence: number }
  | {
    valid: false
    error: 'CHECKPOINT_SEQUENCE_MISMATCH'
    confirmedCheckpointSequence: number
    mismatchedFiles: AuxiliaryCheckpointFile[]
  } {
  const mismatchedFiles = AUXILIARY_CHECKPOINT_FILES
    .filter((file) => artifactSequences[file] !== confirmedCheckpointSequence)
  if (mismatchedFiles.length === 0) return { valid: true, confirmedCheckpointSequence }
  return {
    valid: false,
    error: 'CHECKPOINT_SEQUENCE_MISMATCH',
    confirmedCheckpointSequence,
    mismatchedFiles,
  }
}

async function readConfirmedSequence(
  directory: string,
  fileSystem: TransactionalWriterFileSystem,
): Promise<number | undefined> {
  try {
    const value: unknown = JSON.parse(await fileSystem.readFile(join(directory, 'run-state.json')))
    const sequence = (value as { checkpointSequence?: unknown }).checkpointSequence
    if (!Number.isInteger(sequence)) throw checkpointError()
    return sequence as number
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw checkpointError()
  }
}

function buildCheckpointContents(input: TransactionalCheckpointInput): Record<CheckpointArtifactFile, string> {
  const { caseState } = input
  assertCaseStateInvariants(caseState, input.selectedCaseIds)
  assertArtifactInvariants(input)
  const derived = deriveCaseState(caseState)
  const checkpointSequence = caseState.checkpointSequence
  const runState = {
    checkpointSequence,
    runId: input.runId,
    scope: input.scope,
    status: input.status,
    caseStates: caseState.phases,
    providerCalls: caseState.providerCalls,
    expectedCalls: caseState.expectedCalls,
    currentCaseId: caseState.currentCaseId,
    resumeCount: caseState.resumeCount ?? 0,
    processedCaseIds: derived.processedCaseIds,
    failedCaseIds: derived.failedCaseIds,
    pendingCaseIds: derived.pendingCaseIds,
    startedAt: input.startedAt,
    lastCheckpointAt: input.lastCheckpointAt,
  }
  const metrics = input.metrics ?? {}
  const summary = {
    checkpointSequence,
    runId: input.runId,
    scope: input.scope,
    status: input.status,
    totalCases: input.selectedCaseIds.length,
    processedCases: derived.processedCaseIds.length,
    failedCases: derived.failedCaseIds.length,
    pendingCases: derived.pendingCaseIds.length,
    inFlightCases: derived.inFlightCaseIds.length,
    providerCalls: caseState.providerCalls,
    providerResponsesReceived: input.rawResponses.length,
    expectedCalls: caseState.expectedCalls,
    resumeCount: caseState.resumeCount ?? 0,
    successfulResponses: input.decodedResults.length,
    failedResponses: derived.failedCaseIds.length,
    schemaValidCases: input.decodedResults.length,
    schemaInvalidCases: Math.max(0, input.rawResponses.length - input.decodedResults.length),
    invalidSourceFields: metrics.invalidSourceFields ?? 0,
    providerSourceFieldsProperties: metrics.providerSourceFieldsProperties ?? 0,
    providerStringReferenceValues: metrics.providerStringReferenceValues ?? 0,
    providerAliases: metrics.providerAliases ?? 0,
    providerCanonicalPaths: metrics.providerCanonicalPaths ?? 0,
    providerSFReferences: metrics.providerSFReferences ?? 0,
    invalidIndexes: metrics.invalidIndexes ?? 0,
    providerStepMismatches: metrics.providerStepMismatches ?? 0,
    internalCanonicalDecodingCases: input.decodedResults.length,
    requiresHumanReviewCases: input.decodedResults.filter((result) => result.requiresHumanReview).length,
    eligibleForGate: false,
    humanReviewStatus: 'NOT_STARTED',
    startedAt: input.startedAt,
    lastCheckpointAt: input.lastCheckpointAt,
  }
  const serialized: Record<HashedCheckpointFile, string> = {
    'run-state.json': serialize(runState),
    'summary.json': serialize(summary),
    'raw-responses.json': serialize({ checkpointSequence, responses: input.rawResponses }),
    'decoded-results.json': serialize({ checkpointSequence, results: input.decodedResults }),
    'errors.json': serialize({ checkpointSequence, errors: input.errors }),
  }
  const hashes = Object.fromEntries(
    HASHED_CHECKPOINT_FILES.map((file) => [file, sha256(serialized[file])]),
  ) as Record<HashedCheckpointFile, string>
  return {
    ...serialized,
    'hashes.json': serialize({
      checkpointSequence,
      status: input.checkpointStatus,
      includedFiles: HASHED_CHECKPOINT_FILES,
      hashes,
    }),
  }
}

async function removeTemporaryFiles(
  temporaryPaths: ReadonlyMap<CheckpointArtifactFile, string>,
  fileSystem: TransactionalWriterFileSystem,
  hooks: TransactionalWriterHooks | undefined,
  files: readonly CheckpointArtifactFile[] = RENAME_ORDER,
): Promise<void> {
  for (const file of files) {
    const path = temporaryPaths.get(file)!
    try {
      await hooks?.beforeCleanup?.(path)
      await fileSystem.unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw checkpointError()
    }
  }
}

export async function writeTransactionalCheckpoint(input: TransactionalCheckpointInput): Promise<number> {
  const fileSystem = input.fileSystem ?? defaultFileSystem
  const confirmedSequence = await readConfirmedSequence(input.directory, fileSystem)
  const sequence = input.caseState.checkpointSequence
  if (!Number.isInteger(sequence) || sequence < 0 || (confirmedSequence !== undefined && sequence <= confirmedSequence)) {
    throw checkpointError()
  }
  let contents: Record<CheckpointArtifactFile, string>
  try {
    contents = buildCheckpointContents(input)
  } catch {
    throw checkpointError()
  }
  const nonce = randomUUID()
  const temporaryPaths = new Map<CheckpointArtifactFile, string>(
    RENAME_ORDER.map((file) => [file, join(input.directory, `.${file}.checkpoint-${sequence}-${nonce}.tmp`)]),
  )
  try {
    for (const file of RENAME_ORDER) {
      const handle = await fileSystem.open(temporaryPaths.get(file)!)
      try {
        await handle.writeFile(contents[file])
      } finally {
        await handle.close()
      }
    }
    const dataFiles = RENAME_ORDER.filter((file) => file !== 'run-state.json')
    for (const file of dataFiles) {
      await input.hooks?.beforeRename?.(file)
      await fileSystem.rename(temporaryPaths.get(file)!, join(input.directory, file))
    }
    // Confirm cleanup capability before publishing the commit marker. A cleanup
    // failure can therefore never make an unreported sequence look committed.
    await removeTemporaryFiles(temporaryPaths, fileSystem, input.hooks, dataFiles)
    await input.hooks?.beforeRename?.('run-state.json')
    await fileSystem.rename(temporaryPaths.get('run-state.json')!, join(input.directory, 'run-state.json'))
    await removeTemporaryFiles(temporaryPaths, fileSystem, undefined)
    return sequence
  } catch {
    try {
      await removeTemporaryFiles(temporaryPaths, fileSystem, input.hooks)
    } catch {
      // The caller receives only the safe checkpoint category; leftovers aid diagnosis.
    }
    throw checkpointError()
  }
}
