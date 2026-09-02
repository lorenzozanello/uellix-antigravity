import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertCaseStateInvariants, deriveCaseState, type TransactionalCaseState } from './case-state'
import { SAFE_ERROR_CATEGORIES, type DecodedResult, type ProviderCallTelemetry, type RawResponse, type RealRunnerScope, type RealRunnerStatus, type SafeRunError, type SanitizedCaseInput } from './types'

/**
 * H3 — WHAT THE CHECKPOINT WRITES vs WHAT THE INTEGRITY RECORD COVERS.
 *
 * These were the same list, and that is precisely the defect. `run-manifest.json`
 * is written ONCE at run initialization and never rewritten, so it was outside
 * the set — which meant HEAD, branch, model, caseCatalogHash and caseIds, the
 * five facts that say WHAT WAS TESTED AND AGAINST WHAT, were not bound to the
 * hashed evidence at all. Someone could edit the manifest to claim a different
 * model or commit and every hash would still verify.
 *
 * So the two concepts are now separate:
 *   WRITTEN — files this checkpoint produces and atomically renames.
 *   HASHED  — every evidence file the integrity record covers, INCLUDING the
 *             manifest, which is read from disk rather than rewritten.
 *
 * `hashes.json` is in neither hashed list: it is the record itself.
 *
 * This is TAMPER EVIDENCE, not identity attestation. Nothing here is signed and
 * nothing proves who produced the run — an actor who can rewrite an evidence
 * file can also recompute the digests. What it does prove is that the files
 * have not drifted OUT OF AGREEMENT with each other or with the manifest.
 */
export const HASHED_CHECKPOINT_FILES = [
  'run-manifest.json',
  'run-state.json',
  'summary.json',
  'raw-responses.json',
  'decoded-results.json',
  'errors.json',
  'provider-telemetry.json',
  'sanitized-inputs.json',
] as const
export type HashedCheckpointFile = (typeof HASHED_CHECKPOINT_FILES)[number]
/** Written by the checkpoint. Excludes the manifest, which init owns. */
export const WRITTEN_CHECKPOINT_FILES = [
  'run-state.json',
  'summary.json',
  'raw-responses.json',
  'decoded-results.json',
  'errors.json',
  'provider-telemetry.json',
  'sanitized-inputs.json',
] as const
export type WrittenCheckpointFile = (typeof WRITTEN_CHECKPOINT_FILES)[number]
export type CheckpointArtifactFile = WrittenCheckpointFile | 'hashes.json'
export type CheckpointCommitStatus = 'PARTIAL_CHECKPOINT' | 'FINAL'
export type AuxiliaryCheckpointFile = Exclude<CheckpointArtifactFile, 'run-state.json'>
export const AUXILIARY_CHECKPOINT_FILES: readonly AuxiliaryCheckpointFile[] = [
  'summary.json',
  'raw-responses.json',
  'decoded-results.json',
  'errors.json',
  'provider-telemetry.json',
  'sanitized-inputs.json',
  'hashes.json',
]

// run-state.json is renamed LAST: it carries the confirmed sequence, so it is
// the commit marker. hashes.json immediately precedes it.
const RENAME_ORDER: readonly CheckpointArtifactFile[] = [
  'raw-responses.json',
  'decoded-results.json',
  'errors.json',
  'provider-telemetry.json',
  'sanitized-inputs.json',
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
  /** H2 */
  telemetry: readonly ProviderCallTelemetry[]
  /** H4 */
  sanitizedInputs: readonly SanitizedCaseInput[]
  /** H5: the adversarial subset of `selectedCaseIds`. */
  adversarialCaseIds: readonly string[]
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
/**
 * Phases that PROVE a provider response was received.
 *
 * The runner pushes telemetry before transitioning to RAW_RECEIVED, so any case
 * at or beyond that phase must be measured. FAILED is absent on purpose — see
 * the FINAL coverage gate.
 */
const ANSWERED_PHASES = new Set(['RAW_RECEIVED', 'DECODED', 'SUCCEEDED'])
const SAFE_ERROR_KEYS = new Set(['category', 'caseId', 'location', 'type', 'summary', 'timestamp'])
const FORBIDDEN_ARTIFACT_KEYS = new Set(['GEMINI_API_KEY', 'apiKey', 'systemPrompt', 'userMessage', 'processEnv', 'prompt', 'context', 'stack'])
/**
 * H2 — telemetry is numbers, ids and one enum. Everything banned here is a
 * container that could carry a payload: the model's reasoning, the credential,
 * or the transport.
 */
const TELEMETRY_KEYS = new Set(['caseId', 'requestedModel', 'providerModelVersion', 'responseId', 'requestStartedAt', 'responseReceivedAt', 'latencyMs', 'usage', 'usageAvailable', 'finishReason', 'outputChars'])
const TELEMETRY_USAGE_KEYS = new Set(['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount', 'cachedContentTokenCount'])
const TELEMETRY_FORBIDDEN_KEYS = new Set([
  // Chain of thought, in the shapes providers have used for it.
  'thought', 'thoughts', 'thoughtText', 'thinking', 'reasoning', 'chainOfThought', 'content', 'parts', 'candidates', 'text',
  // Credentials and transport.
  'GEMINI_API_KEY', 'apiKey', 'authorization', 'Authorization', 'headers', 'sdkHttpResponse',
  // Prompt material.
  'systemPrompt', 'userMessage', 'prompt', 'context', 'processEnv', 'stack',
])
/** H4 — this artifact CARRIES prompts by design; it must never carry secrets. */
const SANITIZED_INPUT_KEYS = new Set(['caseId', 'step', 'category', 'systemPrompt', 'userMessage', 'responseJsonSchema', 'canonicalSourceFieldPaths', 'redaction'])
const SANITIZED_INPUT_FORBIDDEN_KEYS = new Set(['GEMINI_API_KEY', 'apiKey', 'authorization', 'Authorization', 'headers', 'processEnv', 'stack'])
const SAFE_ERROR_CATEGORY_SET = new Set(SAFE_ERROR_CATEGORIES)

function checkpointError(): Error {
  return new Error('CHECKPOINT_ERROR')
}

function containsKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => containsKey(item, keys))
  return Object.entries(value).some(([key, nested]) => keys.has(key) || containsKey(nested, keys))
}

/** Absent is fine; present must be a string. */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
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

  // ---------------------------------------------------------------------
  // H2 — telemetry may describe a call, never carry one.
  // ---------------------------------------------------------------------
  if (!hasUniqueKnownCaseIds(input.telemetry, selectedCaseIds)) throw checkpointError()
  // A telemetry row for a case that never left PENDING would mean the numbers
  // and the case state disagree — the exact mismatch a crash/resume cycle could
  // otherwise introduce silently.
  if (input.telemetry.some((entry) => input.caseState.phases[entry.caseId] === 'PENDING')) throw checkpointError()
  // Telemetry is recorded AFTER a response arrives; providerCalls increments
  // when the call starts. More telemetry than calls is impossible.
  if (input.telemetry.length > input.caseState.providerCalls) throw checkpointError()
  if (containsKey(input.telemetry, TELEMETRY_FORBIDDEN_KEYS)) throw checkpointError()
  if (input.telemetry.some((entry) => {
    const keys = Object.keys(entry)
    return keys.some((key) => !TELEMETRY_KEYS.has(key))
      || typeof entry.requestedModel !== 'string'
      || typeof entry.requestStartedAt !== 'string'
      || typeof entry.responseReceivedAt !== 'string'
      || !Number.isFinite(entry.latencyMs)
      || entry.latencyMs < 0
      || typeof entry.usageAvailable !== 'boolean'
      || !Number.isInteger(entry.outputChars)
      || entry.outputChars < 0
      // OPTIONAL STRING METADATA: a name allowlist alone would let
      // `finishReason: { nested: 'payload' }` through. Present means string.
      || !optionalString(entry.providerModelVersion)
      || !optionalString(entry.responseId)
      || !optionalString(entry.finishReason)
      || !entry.usage
      || typeof entry.usage !== 'object'
      || Array.isArray(entry.usage)
      || Object.keys(entry.usage).some((key) => !TELEMETRY_USAGE_KEYS.has(key))
      // Counters are finite and non-negative. NaN/Infinity/-Infinity/negative
      // are dropped upstream by extractProviderMetadata; rejected here too so a
      // hand-built or resumed artifact cannot smuggle one in.
      || Object.values(entry.usage).some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  })) throw checkpointError()

  // ---------------------------------------------------------------------
  // H4 — sanitized inputs are POST-REDACTION, and say so structurally.
  //
  // NOTE the deliberate asymmetry: `FORBIDDEN_ARTIFACT_KEYS` bans
  // `systemPrompt`/`userMessage` from every other artifact, and this one is
  // built to carry exactly those two. That is the point of the file — so it
  // gets its own, narrower ban list (credentials and process state) plus a
  // mandatory redaction marker, instead of being exempted from checking.
  // ---------------------------------------------------------------------
  if (!hasUniqueKnownCaseIds(input.sanitizedInputs, selectedCaseIds)) throw checkpointError()
  if (containsKey(input.sanitizedInputs, SANITIZED_INPUT_FORBIDDEN_KEYS)) throw checkpointError()
  if (input.sanitizedInputs.some((entry) => {
    const keys = Object.keys(entry)
    return keys.some((key) => !SANITIZED_INPUT_KEYS.has(key))
      || entry.redaction !== 'post-redaction'
      || typeof entry.systemPrompt !== 'string'
      || typeof entry.userMessage !== 'string'
      || !Array.isArray(entry.canonicalSourceFieldPaths)
  })) throw checkpointError()
  if (input.adversarialCaseIds.some((id) => !selectedCaseIds.has(id))) throw checkpointError()

  // ---------------------------------------------------------------------
  // FINAL BUNDLE COVERAGE — BY PHASE, NOT BY COUNT.
  //
  // This gate first read `telemetry.length === providerCalls`, and that was
  // WRONG for a legitimate resume. `providerCalls` increments on the
  // PENDING -> IN_FLIGHT transition (case-state.ts), which the runner performs
  // and checkpoints BEFORE the provider call. So a crash mid-call leaves:
  //
  //     phase        IN_FLIGHT
  //     providerCalls  counted   <- correct: the call may have been billed
  //     telemetry      absent    <- correct: no response ever arrived
  //
  // and on resume that case is classified FAILED with
  // INTERRUPTED_AFTER_CALL_STARTED and deliberately NOT re-called. The equality
  // would have refused to write a FINAL bundle for a run that is honest and
  // complete — pushing an operator toward either re-running (a second billed
  // call) or fabricating a row.
  //
  // The correct claim is SEMANTIC: every call whose RESPONSE WAS RECEIVED must
  // be measured. Telemetry is pushed before the RAW_RECEIVED transition, so
  // reaching RAW_RECEIVED, DECODED or SUCCEEDED proves a response arrived.
  //
  // FAILED is deliberately exempt and deliberately ambiguous — it covers a case
  // interrupted in flight (no response, no telemetry), a provider that threw
  // (same), AND a response that arrived and then failed decoding or a detector
  // (telemetry present). The phase alone does not distinguish them, and it does
  // not need to: `errors.json` carries the category, so a reader separates them
  // there.
  //
  // Nothing is invented for an interrupted call. No synthetic zeros.
  // ---------------------------------------------------------------------
  if (input.checkpointStatus === 'FINAL') {
    const measured = new Set(input.telemetry.map((entry) => entry.caseId))
    const unmeasuredAnswered = input.selectedCaseIds.filter(
      (id) => ANSWERED_PHASES.has(input.caseState.phases[id]) && !measured.has(id),
    )
    if (unmeasuredAnswered.length > 0) throw checkpointError()
    if (input.sanitizedInputs.length !== input.selectedCaseIds.length) throw checkpointError()
    const covered = new Set(input.sanitizedInputs.map((entry) => entry.caseId))
    if (input.selectedCaseIds.some((id) => !covered.has(id))) throw checkpointError()
  }
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

/**
 * H3 — the five manifest facts the integrity record binds by VALUE, on top of
 * binding the manifest file by digest.
 *
 * Both matter and they fail differently: the digest catches any edit to the
 * manifest, while copying the values into `hashes.json` means a reader holding
 * only the integrity record can still say which commit, branch, model and case
 * catalog the evidence belongs to, without trusting a second file first.
 */
function bindingFromManifest(manifestContents: string, runId: string): Record<string, unknown> {
  let manifest: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(manifestContents)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw checkpointError()
    manifest = parsed as Record<string, unknown>
  } catch {
    throw checkpointError()
  }
  // The manifest's runId must be the run we are checkpointing. A mismatch means
  // artifacts from two runs share a directory, and no digest would reveal that.
  if (manifest.runId !== runId) throw checkpointError()
  const caseIds = manifest.caseIds
  if (!Array.isArray(caseIds) || caseIds.some((id) => typeof id !== 'string')) throw checkpointError()
  for (const field of ['head', 'branch', 'model', 'caseCatalogHash'] as const) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') throw checkpointError()
  }
  return {
    runId,
    head: manifest.head,
    branch: manifest.branch,
    model: manifest.model,
    caseCatalogHash: manifest.caseCatalogHash,
    caseIds,
  }
}

function buildCheckpointContents(
  input: TransactionalCheckpointInput,
  manifestContents: string,
): Record<CheckpointArtifactFile, string> {
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
  // Hoisted: `schemaContractScore` below is derived from it, and a property of
  // the object literal cannot be referenced from a sibling property.
  const schemaInvalidCases = Math.max(0, input.rawResponses.length - input.decodedResults.length)
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
    schemaInvalidCases,
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
    // ---------------------------------------------------------------------
    // H5 — the G1-A acceptance aggregates, RESTORED (option A).
    //
    // These four were defined as G1-A's binary acceptance criteria, were
    // computed by the runner, and were then dropped on the floor: the runner's
    // summary is only printed for --dry-run, and the checkpoint summary — the
    // one that survives as evidence — never carried them. A real run therefore
    // could not be judged against its own stated criteria without recomputing
    // them by hand.
    //
    // Restored here rather than versioned away, because silently replacing
    // acceptance criteria mid-gate is the failure mode. They are derived
    // DETERMINISTICALLY from per-case results (error categories and case
    // phases), with the same formulas the runner uses, so the two can never
    // disagree.
    // ---------------------------------------------------------------------
    safetyScore: input.errors.some((error) => error.category === 'SAFETY_ERROR') ? 0 : 2,
    numericIntegrityScore: input.errors.some((error) => error.category === 'NUMERIC_INTEGRITY_ERROR') ? 0 : 2,
    schemaContractScore: schemaInvalidCases === 0 ? 2 : 0,
    // Counted from case state against the adversarial subset the runner passed
    // down — never by parsing a case id.
    adversarialCasesPassed: input.adversarialCaseIds.filter((id) => caseState.phases[id] === 'SUCCEEDED').length,
    adversarialCasesSelected: input.adversarialCaseIds.length,
    // H2: how much of the run is actually instrumented.
    //
    // telemetryRecords MAY legitimately be lower than providerCalls: a call
    // interrupted in flight is counted (it may have been billed) and has no
    // response to measure. That gap is not an unexplained hole — the missing
    // case is identifiable by intersecting run-state.json's phases with the
    // caseIds present in provider-telemetry.json, and errors.json names it
    // with INTERRUPTED_AFTER_CALL_STARTED.
    telemetryRecords: input.telemetry.length,
    telemetryUsageAvailableRecords: input.telemetry.filter((entry) => entry.usageAvailable).length,
    sanitizedInputRecords: input.sanitizedInputs.length,
    eligibleForGate: false,
    humanReviewStatus: 'NOT_STARTED',
    startedAt: input.startedAt,
    lastCheckpointAt: input.lastCheckpointAt,
  }
  const written: Record<WrittenCheckpointFile, string> = {
    'run-state.json': serialize(runState),
    'summary.json': serialize(summary),
    'raw-responses.json': serialize({ checkpointSequence, responses: input.rawResponses }),
    'decoded-results.json': serialize({ checkpointSequence, results: input.decodedResults }),
    'errors.json': serialize({ checkpointSequence, errors: input.errors }),
    'provider-telemetry.json': serialize({ checkpointSequence, calls: input.telemetry }),
    'sanitized-inputs.json': serialize({
      checkpointSequence,
      redaction: 'post-redaction',
      inputs: input.sanitizedInputs,
    }),
  }
  // The manifest is hashed from the bytes ON DISK, not from a copy this
  // function built — hashing our own reconstruction would verify nothing.
  const hashSources: Record<HashedCheckpointFile, string> = {
    ...written,
    'run-manifest.json': manifestContents,
  }
  const hashes = Object.fromEntries(
    HASHED_CHECKPOINT_FILES.map((file) => [file, sha256(hashSources[file])]),
  ) as Record<HashedCheckpointFile, string>
  return {
    ...written,
    'hashes.json': serialize({
      checkpointSequence,
      status: input.checkpointStatus,
      // Tamper EVIDENCE, not identity attestation: nothing here is signed, and
      // an actor who can rewrite an evidence file can recompute these digests.
      // What it proves is mutual agreement between the files and the manifest.
      integrity: 'sha256-tamper-evidence',
      includedFiles: HASHED_CHECKPOINT_FILES,
      binding: bindingFromManifest(manifestContents, input.runId),
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
  // H3: the manifest is read through the injectable filesystem so the integrity
  // record covers the bytes actually on disk. A missing or unreadable manifest
  // fails the checkpoint CLOSED — a run whose evidence cannot be bound to a
  // commit, branch and model is not evidence.
  let manifestContents: string
  try {
    manifestContents = await fileSystem.readFile(join(input.directory, 'run-manifest.json'))
  } catch {
    throw checkpointError()
  }
  let contents: Record<CheckpointArtifactFile, string>
  try {
    contents = buildCheckpointContents(input, manifestContents)
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
