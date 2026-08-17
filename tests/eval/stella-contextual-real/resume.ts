import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  assertCaseStateInvariants,
  deriveCaseState,
  type CasePhase,
  type TransactionalCaseState,
} from './case-state'
import type { ContextualMockCase } from '../stella-contextual/cases'
import { AdvisorContextualOutputSchema } from '@/lib/stella/schemas/advisor-contextual-output'
import {
  SAFE_ERROR_CATEGORIES,
  type DecodedResult,
  type ProviderCallTelemetry,
  type RawResponse,
  type RealRunnerScope,
  type SafeRunError,
  type SanitizedCaseInput,
} from './types'
import {
  HASHED_CHECKPOINT_FILES,
  inspectCheckpointSequences,
  type HashedCheckpointFile,
} from './transactional-writer'

export const REAL_RUNNER_VERSION = 'current-contextual-v1'
export const PROVIDER_SCHEMA_PROTOCOL = 'sourceRefIndexes'
export const INTERNAL_SCHEMA_PROTOCOL = 'sourceFields'

export function computeCaseCatalogHash(catalog: readonly ContextualMockCase[]): string {
  return createHash('sha256').update(JSON.stringify(catalog), 'utf8').digest('hex')
}

interface ResumeIdentity {
  branch: string
  head: string
  originMainSHA: string
  providerMode: string
  model: string
  caseCatalogHash: string
  caseIds: string[]
  scope: RealRunnerScope
  expectedCalls: number
}

export interface ResumeCompatibility extends ResumeIdentity {
  knownCaseIds: readonly string[]
  schemaProtocol: 'sourceRefIndexes'
  internalProtocol: 'sourceFields'
  runnerVersion: string
}

export function validateResumeManifest(manifest: Record<string, unknown>, expected: ResumeIdentity): void {
  const keys: Array<keyof ResumeIdentity> = ['branch', 'head', 'originMainSHA', 'providerMode', 'model', 'caseCatalogHash', 'scope', 'expectedCalls']
  for (const key of keys) if (manifest[key] !== expected[key]) throw resumeError('incompatible manifest')
  if (!Array.isArray(manifest.caseIds) || manifest.caseIds.join('|') !== expected.caseIds.join('|')) throw resumeError('case ids changed')
  if (manifest.schemaProtocol !== PROVIDER_SCHEMA_PROTOCOL) throw resumeError('schema protocol changed')
  if (manifest.status === 'COMPLETED_PENDING_HUMAN_REVIEW') throw resumeError('completed run cannot resume')
  if (!Number.isInteger(manifest.providerCalls) || Number(manifest.providerCalls) < 0 || Number(manifest.providerCalls) > expected.expectedCalls) throw resumeError('provider calls invalid')
}

interface HashesArtifact {
  checkpointSequence: number
  status: 'PARTIAL_CHECKPOINT' | 'FINAL'
  includedFiles: HashedCheckpointFile[]
  hashes: Record<HashedCheckpointFile, string>
}

export interface ResumableArtifacts {
  directory: string
  manifest: Record<string, unknown>
  state: Record<string, unknown>
  summary: Record<string, unknown>
  rawResponses: RawResponse[]
  decodedResults: DecodedResult[]
  errors: SafeRunError[]
  telemetry: ProviderCallTelemetry[]
  sanitizedInputs: SanitizedCaseInput[]
  hashes: HashesArtifact
}

export interface ValidatedResume {
  directory: string
  runId: string
  startedAt: string
  resumeCount: number
  caseState: TransactionalCaseState
  rawResponses: RawResponse[]
  decodedResults: DecodedResult[]
  errors: SafeRunError[]
  telemetry: ProviderCallTelemetry[]
}

const resumeError = (detail: string): Error => new Error(`RESUME_INTEGRITY_ERROR: ${detail}`)

function parseObject(contents: string): Record<string, unknown> {
  const value: unknown = JSON.parse(contents)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw resumeError('invalid required artifact')
  return value as Record<string, unknown>
}

function sequenceOf(value: Record<string, unknown>): number {
  if (!Number.isInteger(value.checkpointSequence) || Number(value.checkpointSequence) < 0) throw resumeError('invalid checkpoint sequence')
  return Number(value.checkpointSequence)
}

function readCollection<T>(artifact: Record<string, unknown>, key: string): T[] {
  const value = artifact[key]
  if (!Array.isArray(value)) throw resumeError('invalid required artifact')
  return value as T[]
}

function assertUniqueIds(values: readonly unknown[], label: string): void {
  const ids = values.map((item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as { caseId?: unknown }).caseId
      : undefined
  ))
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw resumeError(`duplicate or invalid ${label} id`)
  }
}

const SAFE_ERROR_CATEGORY_SET = new Set<string>(SAFE_ERROR_CATEGORIES)
const REAL_RUNNER_STATUSES = new Set(['INITIALIZED', 'RUNNING', 'INTERRUPTED', 'FAILED', 'COMPLETED_PENDING_HUMAN_REVIEW'])
const SAFE_ERROR_KEYS = new Set(['category', 'caseId', 'location', 'type', 'summary', 'timestamp'])

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function isSafeError(value: unknown): value is SafeRunError {
  if (!isObject(value) || Object.keys(value).some((key) => !SAFE_ERROR_KEYS.has(key))) return false
  return SAFE_ERROR_CATEGORY_SET.has(String(value.category))
    && (value.caseId === undefined || typeof value.caseId === 'string')
    && typeof value.location === 'string'
    && typeof value.type === 'string'
    && typeof value.summary === 'string'
    && isIsoTimestamp(value.timestamp)
}

function assertRuntimeCollections(rawResponses: readonly unknown[], decodedResults: readonly unknown[], errors: readonly unknown[]): void {
  if (rawResponses.some((value) => (
    !isObject(value)
    || typeof value.caseId !== 'string'
    || !isObject(value.providerResponse)
    || !isIsoTimestamp(value.timestamp)
    || (value.error !== undefined && !isSafeError(value.error))
  ))) throw resumeError('invalid raw response')
  if (decodedResults.some((value) => (
    !isObject(value)
    || typeof value.caseId !== 'string'
    || !AdvisorContextualOutputSchema.safeParse(value.output).success
    || value.canonicalValidation !== 'passed'
    || !['pending', 'passed'].includes(String(value.safety))
    || value.schemaContract !== 'passed'
    || !['pending', 'passed'].includes(String(value.numericIntegrity))
    || value.requiresHumanReview !== true
  ))) throw resumeError('invalid decoded result')
  if (errors.some((value) => !isSafeError(value))) throw resumeError('invalid safe error')
}

export async function loadResumableArtifacts(directory: string): Promise<ResumableArtifacts> {
  const root = resolve(directory)
  // H3: every file the integrity record covers must be present and readable,
  // plus the record itself. A resume that skipped one would recompute a hash
  // set the record does not describe.
  const requiredFiles = [
    'run-manifest.json',
    'run-state.json',
    'summary.json',
    'raw-responses.json',
    'decoded-results.json',
    'errors.json',
    'provider-telemetry.json',
    'sanitized-inputs.json',
    'hashes.json',
  ] as const
  let contents: Record<(typeof requiredFiles)[number], string>
  try {
    contents = Object.fromEntries(await Promise.all(requiredFiles.map(async (file) => [
      file,
      await readFile(join(root, file), 'utf8'),
    ]))) as Record<(typeof requiredFiles)[number], string>
  } catch {
    throw resumeError('missing or unreadable required artifact')
  }

  let parsed: Record<(typeof requiredFiles)[number], Record<string, unknown>>
  try {
    parsed = Object.fromEntries(requiredFiles.map((file) => [file, parseObject(contents[file])])) as Record<
      (typeof requiredFiles)[number],
      Record<string, unknown>
    >
  } catch {
    throw resumeError('invalid required artifact')
  }

  const manifest = parsed['run-manifest.json']
  const state = parsed['run-state.json']
  const summary = parsed['summary.json']
  const rawArtifact = parsed['raw-responses.json']
  const decodedArtifact = parsed['decoded-results.json']
  const errorsArtifact = parsed['errors.json']
  const telemetryArtifact = parsed['provider-telemetry.json']
  const sanitizedInputsArtifact = parsed['sanitized-inputs.json']
  const hashesArtifact = parsed['hashes.json']
  const confirmedSequence = sequenceOf(state)
  const sequenceInspection = inspectCheckpointSequences(confirmedSequence, {
    'summary.json': sequenceOf(summary),
    'raw-responses.json': sequenceOf(rawArtifact),
    'decoded-results.json': sequenceOf(decodedArtifact),
    'errors.json': sequenceOf(errorsArtifact),
    'provider-telemetry.json': sequenceOf(telemetryArtifact),
    'sanitized-inputs.json': sequenceOf(sanitizedInputsArtifact),
    'hashes.json': sequenceOf(hashesArtifact),
  })
  if (!sequenceInspection.valid) throw resumeError('checkpoint sequence mismatch')

  if (
    !Array.isArray(hashesArtifact.includedFiles)
    || hashesArtifact.includedFiles.join('|') !== HASHED_CHECKPOINT_FILES.join('|')
    || !hashesArtifact.hashes
    || typeof hashesArtifact.hashes !== 'object'
    || Array.isArray(hashesArtifact.hashes)
  ) throw resumeError('invalid hashes artifact')
  const hashes = hashesArtifact.hashes as Record<string, unknown>
  for (const file of HASHED_CHECKPOINT_FILES) {
    const expectedHash = createHash('sha256').update(contents[file], 'utf8').digest('hex')
    if (hashes[file] !== expectedHash) throw resumeError('checkpoint hash mismatch')
  }

  const rawResponses = readCollection<RawResponse>(rawArtifact, 'responses')
  const decodedResults = readCollection<DecodedResult>(decodedArtifact, 'results')
  const errors = readCollection<SafeRunError>(errorsArtifact, 'errors')
  assertRuntimeCollections(rawResponses, decodedResults, errors)
  assertUniqueIds(rawResponses, 'raw response')
  assertUniqueIds(decodedResults, 'decoded result')
  const errorCaseIds = errors.map((error) => error.caseId).filter((id): id is string => typeof id === 'string')
  if (new Set(errorCaseIds).size !== errorCaseIds.length) throw resumeError('duplicate error id')

  const telemetry = readCollection<ProviderCallTelemetry>(telemetryArtifact, 'calls')
  assertUniqueIds(telemetry, 'telemetry record')
  // H4: the marker is checked on the way IN as well as on the way out. A
  // resumed run must not inherit an input set that does not declare itself
  // post-redaction.
  if (sanitizedInputsArtifact.redaction !== 'post-redaction') throw resumeError('sanitized inputs are not marked post-redaction')
  const sanitizedInputs = readCollection<SanitizedCaseInput>(sanitizedInputsArtifact, 'inputs')
  assertUniqueIds(sanitizedInputs, 'sanitized input')
  if (sanitizedInputs.some((entry) => entry.redaction !== 'post-redaction')) throw resumeError('sanitized input is not marked post-redaction')

  return {
    directory: root,
    manifest,
    state,
    summary,
    rawResponses,
    decodedResults,
    errors,
    telemetry,
    sanitizedInputs,
    hashes: hashesArtifact as unknown as HashesArtifact,
  }
}

const CASE_PHASES = new Set<CasePhase>(['PENDING', 'IN_FLIGHT', 'RAW_RECEIVED', 'DECODED', 'SUCCEEDED', 'FAILED'])

function exactOrderedIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index])
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw resumeError('invalid numeric state')
  return Number(value)
}

export function validateResumableArtifacts(
  artifacts: ResumableArtifacts,
  expected: ResumeCompatibility,
): ValidatedResume {
  assertRuntimeCollections(artifacts.rawResponses, artifacts.decodedResults, artifacts.errors)
  assertUniqueIds(artifacts.rawResponses, 'raw response')
  assertUniqueIds(artifacts.decodedResults, 'decoded result')
  const validatedErrorCaseIds = artifacts.errors.map((error) => error.caseId).filter((id): id is string => typeof id === 'string')
  if (new Set(validatedErrorCaseIds).size !== validatedErrorCaseIds.length) throw resumeError('duplicate error id')
  validateResumeManifest(artifacts.manifest, expected)
  if (
    artifacts.manifest.schemaProtocol !== expected.schemaProtocol
    || artifacts.manifest.internalProtocol !== expected.internalProtocol
    || artifacts.manifest.runnerVersion !== expected.runnerVersion
  ) throw resumeError('incompatible protocol or runner version')

  const manifestIds = artifacts.manifest.caseIds
  if (
    !Array.isArray(manifestIds)
    || !manifestIds.every((id) => typeof id === 'string')
    || new Set(manifestIds).size !== manifestIds.length
    || !exactOrderedIds(manifestIds as string[], expected.caseIds)
    || manifestIds.some((id) => !expected.knownCaseIds.includes(id as string))
  ) throw resumeError('duplicate or unknown case ids')
  if (expected.expectedCalls !== expected.caseIds.length) throw resumeError('expected calls changed')

  const runId = artifacts.manifest.runId
  const startedAt = artifacts.state.startedAt
  if (
    typeof runId !== 'string'
    || runId.length === 0
    || !isIsoTimestamp(startedAt)
    || artifacts.manifest.startedAt !== startedAt
    || artifacts.summary.startedAt !== startedAt
    || !isIsoTimestamp(artifacts.state.lastCheckpointAt)
    || artifacts.summary.lastCheckpointAt !== artifacts.state.lastCheckpointAt
  ) {
    throw resumeError('invalid run identity')
  }
  if (
    artifacts.state.status === 'COMPLETED_PENDING_HUMAN_REVIEW'
    || artifacts.summary.status === 'COMPLETED_PENDING_HUMAN_REVIEW'
  ) throw resumeError('completed run cannot resume')
  if (
    artifacts.state.runId !== runId
    || artifacts.summary.runId !== runId
    || artifacts.state.scope !== expected.scope
    || artifacts.summary.scope !== expected.scope
    || artifacts.state.expectedCalls !== expected.expectedCalls
    || artifacts.summary.expectedCalls !== expected.expectedCalls
    || !REAL_RUNNER_STATUSES.has(String(artifacts.manifest.status))
    || !REAL_RUNNER_STATUSES.has(String(artifacts.state.status))
    || artifacts.summary.status !== artifacts.state.status
  ) throw resumeError('incoherent checkpoint identity')

  const providerCalls = integer(artifacts.state.providerCalls)
  if (
    providerCalls > expected.expectedCalls
    || artifacts.summary.providerCalls !== providerCalls
  ) throw resumeError('provider calls invalid')
  const checkpointSequence = integer(artifacts.state.checkpointSequence)
  if (checkpointSequence !== artifacts.hashes.checkpointSequence) throw resumeError('checkpoint sequence mismatch')

  const caseStates = artifacts.state.caseStates
  if (!caseStates || typeof caseStates !== 'object' || Array.isArray(caseStates)) throw resumeError('invalid case states')
  const phaseEntries = Object.entries(caseStates)
  const stateIds = phaseEntries.map(([id]) => id)
  if (
    !exactOrderedIds(stateIds, expected.caseIds)
    || phaseEntries.some(([, phase]) => typeof phase !== 'string' || !CASE_PHASES.has(phase as CasePhase))
  ) throw resumeError('duplicate or unknown case state ids')
  if (phaseEntries.filter(([, phase]) => phase !== 'PENDING').length !== providerCalls) {
    throw resumeError('provider calls do not match started cases')
  }
  const currentCaseId = artifacts.state.currentCaseId
  if (currentCaseId !== null && typeof currentCaseId !== 'string') throw resumeError('invalid current case')
  const firstPendingIndex = phaseEntries.findIndex(([, phase]) => phase === 'PENDING')
  if (firstPendingIndex >= 0 && phaseEntries.slice(firstPendingIndex).some(([, phase]) => phase !== 'PENDING')) {
    throw resumeError('started cases are not an ordered prefix')
  }
  const activeEntries = phaseEntries.filter(([, phase]) => ['IN_FLIGHT', 'RAW_RECEIVED', 'DECODED'].includes(String(phase)))
  const lastStartedId = phaseEntries.filter(([, phase]) => phase !== 'PENDING').at(-1)?.[0]
  if (
    activeEntries.length > 1
    || (activeEntries.length === 1 && (activeEntries[0][0] !== lastStartedId || currentCaseId !== activeEntries[0][0]))
    || (activeEntries.length === 0 && currentCaseId !== null)
  ) throw resumeError('active case marker is incoherent')
  const resumeCount = artifacts.state.resumeCount === undefined ? 0 : integer(artifacts.state.resumeCount)
  if (artifacts.summary.resumeCount !== undefined && artifacts.summary.resumeCount !== resumeCount) {
    throw resumeError('resume count mismatch')
  }
  const caseState: TransactionalCaseState = {
    phases: Object.fromEntries(phaseEntries) as Record<string, CasePhase>,
    providerCalls,
    expectedCalls: expected.expectedCalls,
    currentCaseId,
    checkpointSequence,
    resumeCount,
  }
  try {
    assertCaseStateInvariants(caseState, expected.caseIds)
  } catch {
    throw resumeError('invalid case state')
  }
  // H2 — TELEMETRY MUST AGREE WITH CASE STATE ACROSS THE CRASH.
  //
  // A resume is the one moment a telemetry row and the case it describes can
  // drift apart: the rows are restored from a file while the phases are
  // restored from another, and nothing else compares them. Three facts have to
  // hold, and each catches a different corruption — an unknown id (rows from
  // another run), a PENDING id (a measurement for a call that never happened),
  // and more rows than calls (a duplicated or replayed row).
  if (artifacts.telemetry.some((entry) => !expected.caseIds.includes(entry.caseId))) {
    throw resumeError('telemetry references an unknown case')
  }
  if (artifacts.telemetry.some((entry) => caseState.phases[entry.caseId] === 'PENDING')) {
    throw resumeError('telemetry references a case that never started')
  }
  if (artifacts.telemetry.length > providerCalls) throw resumeError('more telemetry records than provider calls')
  if (artifacts.sanitizedInputs.some((entry) => !expected.caseIds.includes(entry.caseId))) {
    throw resumeError('sanitized inputs reference an unknown case')
  }

  const derived = deriveCaseState(caseState)
  const sameIds = (value: unknown, expectedIds: readonly string[]): boolean => (
    Array.isArray(value)
    && value.every((id) => typeof id === 'string')
    && exactOrderedIds(value as string[], expectedIds)
  )
  if (
    !sameIds(artifacts.state.processedCaseIds, derived.processedCaseIds)
    || !sameIds(artifacts.state.failedCaseIds, derived.failedCaseIds)
    || !sameIds(artifacts.state.pendingCaseIds, derived.pendingCaseIds)
    || artifacts.summary.processedCases !== derived.processedCaseIds.length
    || artifacts.summary.failedCases !== derived.failedCaseIds.length
    || artifacts.summary.pendingCases !== derived.pendingCaseIds.length
    || artifacts.summary.inFlightCases !== derived.inFlightCaseIds.length
    || artifacts.hashes.status !== 'PARTIAL_CHECKPOINT'
  ) throw resumeError('derived checkpoint state mismatch')
  if (
    artifacts.summary.checkpointSequence !== checkpointSequence
    || artifacts.summary.totalCases !== expected.caseIds.length
    || artifacts.summary.successfulResponses !== artifacts.rawResponses.length
    || artifacts.summary.failedResponses !== derived.failedCaseIds.length
    || artifacts.summary.schemaValidCases !== artifacts.decodedResults.length
    || artifacts.summary.schemaInvalidCases !== Math.max(0, artifacts.rawResponses.length - artifacts.decodedResults.length)
    || artifacts.summary.internalCanonicalDecodingCases !== artifacts.decodedResults.length
    || artifacts.summary.requiresHumanReviewCases !== artifacts.decodedResults.filter((result) => result.requiresHumanReview).length
    || artifacts.summary.eligibleForGate !== false
    || artifacts.summary.humanReviewStatus !== 'NOT_STARTED'
  ) throw resumeError('summary does not match checkpoint artifacts')

  const selectedIds = new Set(expected.caseIds)
  if (
    artifacts.rawResponses.some((item) => !selectedIds.has(item.caseId))
    || artifacts.decodedResults.some((item) => !selectedIds.has(item.caseId))
    || artifacts.errors.some((item) => item.caseId !== undefined && !selectedIds.has(item.caseId))
  ) throw resumeError('unknown artifact id')
  const rawIds = new Set(artifacts.rawResponses.map((item) => item.caseId))
  const decodedIds = new Set(artifacts.decodedResults.map((item) => item.caseId))
  const rawCompatiblePhases = new Set<CasePhase>(['RAW_RECEIVED', 'DECODED', 'SUCCEEDED', 'FAILED'])
  const decodedCompatiblePhases = new Set<CasePhase>(['DECODED', 'SUCCEEDED', 'FAILED'])
  if (
    artifacts.rawResponses.some((item) => !rawCompatiblePhases.has(caseState.phases[item.caseId]))
    || artifacts.decodedResults.some((item) => !decodedCompatiblePhases.has(caseState.phases[item.caseId]))
    || expected.caseIds.some((id) => caseState.phases[id] === 'SUCCEEDED' && (!rawIds.has(id) || !decodedIds.has(id)))
  ) throw resumeError('artifacts do not match case phases')
  if (artifacts.decodedResults.some((result) => (
    caseState.phases[result.caseId] === 'SUCCEEDED'
    && (result.safety !== 'passed' || result.numericIntegrity !== 'passed')
  ))) throw resumeError('succeeded result is not fully validated')
  const failedIds = new Set(derived.failedCaseIds)
  if (
    validatedErrorCaseIds.some((id) => !failedIds.has(id))
    || derived.failedCaseIds.some((id) => !validatedErrorCaseIds.includes(id))
  ) throw resumeError('safe errors do not match failed cases')

  return {
    directory: artifacts.directory,
    runId,
    startedAt,
    resumeCount,
    caseState,
    rawResponses: structuredClone(artifacts.rawResponses),
    decodedResults: structuredClone(artifacts.decodedResults),
    errors: structuredClone(artifacts.errors),
    telemetry: structuredClone(artifacts.telemetry),
  }
}
