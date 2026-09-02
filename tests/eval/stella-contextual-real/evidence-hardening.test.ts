// tests/eval/stella-contextual-real/evidence-hardening.test.ts
//
// G1-A EVIDENCE HARDENING — the twelve adversarial checks, in one file.
//
// G1-A returned G1_A_MODEL_BEHAVIOR = PASS on a CONDITIONAL_PASS certification:
// the model behaved, but the evidence package could not prove the Gemini 3.6
// thinking/latency contract, could not bind its own baseline, and could not be
// audited without rebuilding the repository. Each test below pins one of the
// five findings that produced that condition, adversarially — asserting what
// must be REFUSED, not only what must work.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractProviderMetadata } from '@/lib/stella/adapter/gemini-client'
import { OFFICIAL_CONTEXTUAL_MOCK_CASES, type ContextualMockCase } from '../stella-contextual/cases'
import { createRunArtifacts, initializeRunManifest } from './artifacts'
import { createCaseState, transitionCase, type TransactionalCaseState } from './case-state'
import {
  INTERNAL_SCHEMA_PROTOCOL,
  PROVIDER_SCHEMA_PROTOCOL,
  REAL_RUNNER_VERSION,
  loadResumableArtifacts,
  validateResumableArtifacts,
} from './resume'
import { runGuardedContextualEvaluation } from './runner'
import {
  HASHED_CHECKPOINT_FILES,
  writeTransactionalCheckpoint,
  type TransactionalCheckpointInput,
} from './transactional-writer'
import type { ProviderCallTelemetry, SanitizedCaseInput } from './types'

const directories: string[] = []
const timestamp = '2026-08-17T12:00:00.000Z'

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const env = {
  STELLA_PROVIDER_MODE: 'paid_gemini',
  GEMINI_API_KEY: 'test-key',
  STELLA_REAL_EVAL_ACK: 'B1C_CURRENT_ARCHITECTURE_REAL_EVAL',
  STELLA_REAL_EVAL_SUBSET_ACK: 'B1C_CURRENT_ARCHITECTURE_CANARY',
}
const runtime = {
  branch: 'codex/stella-staging',
  head: 'f8969f5',
  originMainSHA: 'base',
  trackedDirty: false,
  stagingDirty: false,
  gitOperationInProgress: false,
}

/** An instrumented stub: returns the measured shape a live provider returns. */
const instrumented = (response: unknown) => ({
  response,
  telemetry: {
    requestedModel: 'gemini-3.6-flash',
    requestStartedAt: timestamp,
    responseReceivedAt: timestamp,
    latencyMs: 1200,
    usage: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 40, totalTokenCount: 190 },
    usageAvailable: true,
    finishReason: 'STOP',
    outputChars: 512,
  },
})

const telemetryRecord: ProviderCallTelemetry = { caseId: 'case-1', ...instrumented(null).telemetry }
const sanitizedInput: SanitizedCaseInput = {
  caseId: 'case-1',
  step: 'stakeholders',
  category: 'complete',
  systemPrompt: 'You are Stella.',
  userMessage: 'UNTRUSTED_PROJECT_DATA\n{}',
  responseJsonSchema: { type: 'object' },
  canonicalSourceFieldPaths: [],
  redaction: 'post-redaction',
}

const MANIFEST = {
  runId: 'run-1',
  head: 'f8969f5',
  branch: 'codex/stella-staging',
  model: 'gemini-3.6-flash',
  caseCatalogHash: 'catalog-hash',
  caseIds: ['case-1'],
}

async function runDirectory(manifest: Record<string, unknown> = MANIFEST): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stella-evidence-'))
  directories.push(directory)
  await writeFile(join(directory, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return directory
}

function succeededState(): TransactionalCaseState {
  let state = transitionCase(createCaseState(['case-1']), 'case-1', 'IN_FLIGHT')
  state = transitionCase(state, 'case-1', 'RAW_RECEIVED')
  state = transitionCase(state, 'case-1', 'DECODED')
  return transitionCase(state, 'case-1', 'SUCCEEDED')
}

function checkpointInput(directory: string, patch: Partial<TransactionalCheckpointInput> = {}): TransactionalCheckpointInput {
  return {
    directory,
    runId: 'run-1',
    scope: 'canary',
    selectedCaseIds: ['case-1'],
    caseState: createCaseState(['case-1']),
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

/* ========================================================================== */
/* 1 — H1: a fresh tree has no artifacts/ directory at all                    */
/* ========================================================================== */

describe('1 — fresh tree creates the nested artifact directory', () => {
  it('creates a run directory whose parents do not exist yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stella-fresh-'))
    directories.push(root)
    // Exactly the shape of a fresh checkout: artifacts/ has never been created.
    const outputRoot = join(root, 'artifacts', 'stella-contextual-real-runs')

    const { directory, runId } = await createRunArtifacts(outputRoot, 'g1-canary')

    expect((await stat(directory)).isDirectory()).toBe(true)
    expect(runId).toMatch(/^[0-9a-f-]{36}$/)
    await initializeRunManifest(directory, MANIFEST)
    expect(await readdir(directory)).toEqual(['run-manifest.json'])
  })

  it('still refuses to re-initialize a manifest in an existing run directory', async () => {
    // recursive:true must not have weakened collision safety.
    const root = await mkdtemp(join(tmpdir(), 'stella-fresh-'))
    directories.push(root)
    const { directory } = await createRunArtifacts(join(root, 'a', 'b'), 'g1-canary')
    await initializeRunManifest(directory, MANIFEST)

    await expect(initializeRunManifest(directory, MANIFEST)).rejects.toThrow()
  })
})

/* ========================================================================== */
/* 2 — the hard call ceiling survives instrumentation                         */
/* ========================================================================== */

describe('2 — five selected cases means at most five provider calls', () => {
  it('makes exactly five calls and records exactly five telemetry rows', async () => {
    const ids = OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, 5).map((item) => item.caseId)
    let calls = 0

    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      sleep: async () => {},
      provider: async (request) => { calls += 1; return instrumented(request.providerTemplate) },
    })

    expect(calls).toBe(5)
    expect(result.caseState.providerCalls).toBe(5)
    expect(result.telemetry).toHaveLength(5)
    expect(result.telemetry.map((entry) => entry.caseId)).toEqual(ids)
    expect(result.summary.providerCalls).toBe(5)
    expect(result.summary.expectedCalls).toBe(5)
  })
})

/* ========================================================================== */
/* 3 — telemetry may describe a call, never carry one                         */
/* ========================================================================== */

describe('3 — telemetry cannot carry secrets or raw thought', () => {
  it.each([
    ['chain of thought', { thought: 'first I considered the SROI ratio...' }],
    ['thought text', { thoughtText: 'reasoning trace' }],
    ['reasoning', { reasoning: 'because the proxy was 350 USD' }],
    ['raw candidates', { candidates: [{ content: 'x' }] }],
    ['response text', { text: '{"step":"stakeholders"}' }],
    ['api key', { apiKey: 'AIza-not-a-real-key' }],
    ['authorization header', { authorization: 'Bearer abc' }],
    ['http headers', { headers: { 'x-goog-api-key': 'abc' } }],
    ['prompt material', { systemPrompt: 'You are Stella.' }],
  ])('refuses a FINAL checkpoint whose telemetry carries %s', async (_name, poison) => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [{ ...telemetryRecord, ...poison } as ProviderCallTelemetry],
      sanitizedInputs: [sanitizedInput],
    }))).rejects.toThrow('CHECKPOINT_ERROR')

    expect((await readdir(directory)).filter((file) => file !== 'run-manifest.json')).toEqual([])
  })

  it('accepts telemetry that is only counts, ids, an enum and timestamps', async () => {
    const directory = await runDirectory()
    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [sanitizedInput],
    }))).resolves.toBeGreaterThanOrEqual(0)
  })

  // T-3: the ALLOWLIST, isolated from the denylist. Every case above uses a key
  // that is also explicitly forbidden, so they would still pass if the
  // allowlist were removed. `foo` is harmless and on no denylist — only the
  // allowlist can reject it.
  it('refuses an unknown but harmless top-level key', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [{ ...telemetryRecord, foo: 1 } as never],
      sanitizedInputs: [sanitizedInput],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('refuses an unknown but harmless key inside usage', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [{ ...telemetryRecord, usage: { ...telemetryRecord.usage, foo: 1 } } as never],
      sanitizedInputs: [sanitizedInput],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  // Optional STRING metadata: a name allowlist alone would admit a nested
  // object under a permitted key.
  it.each([
    ['providerModelVersion', { providerModelVersion: { nested: 'payload' } }],
    ['responseId', { responseId: 42 }],
    ['finishReason', { finishReason: { reason: 'STOP' } }],
  ])('refuses a non-string %s', async (_name, poison) => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [{ ...telemetryRecord, ...poison } as never],
      sanitizedInputs: [sanitizedInput],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a negative count', -1],
    ['a string', '900'],
  ])('refuses %s as a token counter in a hand-built artifact', async (_name, value) => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [{ ...telemetryRecord, usage: { thoughtsTokenCount: value } } as never],
      sanitizedInputs: [sanitizedInput],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('refuses a negative latency', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [{ ...telemetryRecord, latencyMs: -1 }],
      sanitizedInputs: [sanitizedInput],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })
})

/* ========================================================================== */
/* 4 — absent usage is reported as absent, never as zero                      */
/* ========================================================================== */

describe('4 — missing usageMetadata is handled explicitly', () => {
  it('reports usageAvailable=false and an empty usage object when the provider omits it', () => {
    const metadata = extractProviderMetadata({ modelVersion: 'gemini-3.6-flash' })

    expect(metadata.usageAvailable).toBe(false)
    expect(metadata.usage).toEqual({})
    // The distinction that matters: no field was invented as 0.
    expect(metadata.usage.thoughtsTokenCount).toBeUndefined()
    expect(metadata.usage.totalTokenCount).toBeUndefined()
  })

  it('distinguishes "reported zero thinking" from "did not report"', () => {
    const reported = extractProviderMetadata({ usageMetadata: { thoughtsTokenCount: 0, totalTokenCount: 10 } })

    expect(reported.usageAvailable).toBe(true)
    expect(reported.usage.thoughtsTokenCount).toBe(0)
  })

  it('projects only the allowlisted numeric fields, dropping anything else the SDK returns', () => {
    const metadata = extractProviderMetadata({
      modelVersion: 'gemini-3.6-flash',
      responseId: 'resp-1',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 3,
        totalTokenCount: 6,
        // A field the projection does not know about must not survive.
        ...({ thoughtsText: 'secret reasoning' } as unknown as Record<string, number>),
      },
    })

    expect(metadata.finishReason).toBe('MAX_TOKENS')
    expect(Object.keys(metadata.usage).sort()).toEqual(
      ['candidatesTokenCount', 'promptTokenCount', 'thoughtsTokenCount', 'totalTokenCount'].sort()
    )
    expect(JSON.stringify(metadata)).not.toContain('secret reasoning')
  })

  it('drops a non-string finishReason rather than coercing it', () => {
    expect(extractProviderMetadata({ candidates: [{ finishReason: 7 }] }).finishReason).toBeUndefined()
  })

  // T-4 — NON-NUMBERS ARE DROPPED AT THE SOURCE, not carried forward to kill
  // the checkpoint. Dropping loses a metric the provider never meaningfully
  // reported; carrying forward would abort the whole evidence commit for a run
  // whose model behaviour was fine.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a negative count', -5],
    ['a numeric string', '900'],
    ['null', null],
    ['an object', { value: 900 }],
  ])('drops %s from the usage counters', (_name, value) => {
    const metadata = extractProviderMetadata({
      usageMetadata: { thoughtsTokenCount: value, totalTokenCount: 10 },
    })

    expect(metadata.usage.thoughtsTokenCount).toBeUndefined()
    // The valid sibling survives — dropping is per-field, not all-or-nothing.
    expect(metadata.usage.totalTokenCount).toBe(10)
    // Usage WAS reported; one field of it was unusable.
    expect(metadata.usageAvailable).toBe(true)
  })

  it('keeps a legitimate zero, which is a measurement', () => {
    expect(extractProviderMetadata({ usageMetadata: { thoughtsTokenCount: 0 } }).usage.thoughtsTokenCount).toBe(0)
  })

  it.each([
    ['a string', 'usage'],
    ['a number', 42],
    ['an array', [{ totalTokenCount: 5 }]],
    ['null', null],
    ['undefined', undefined],
  ])('reports usageAvailable=false when usageMetadata is %s', (_name, value) => {
    const metadata = extractProviderMetadata({ usageMetadata: value })

    expect(metadata.usageAvailable).toBe(false)
    expect(metadata.usage).toEqual({})
  })

  it('never coerces a non-object usageMetadata into counters', () => {
    // An array has numeric-ish indices; none of them may become a token count.
    expect(extractProviderMetadata({ usageMetadata: [1, 2, 3] }).usage).toEqual({})
  })
})

/* ========================================================================== */
/* 5 + 6 — H3: the manifest is inside the integrity set, and it recomputes    */
/* ========================================================================== */

describe('5 — the manifest is bound to the hashed evidence set', () => {
  it('includes run-manifest.json in the integrity record and binds its facts by value', async () => {
    const directory = await runDirectory()
    await writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [sanitizedInput],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    }))

    const hashes = JSON.parse(await readFile(join(directory, 'hashes.json'), 'utf8')) as {
      includedFiles: string[]
      binding: Record<string, unknown>
      integrity: string
      hashes: Record<string, string>
    }

    expect(hashes.includedFiles).toContain('run-manifest.json')
    expect(hashes.includedFiles).toEqual([...HASHED_CHECKPOINT_FILES])
    expect(hashes.includedFiles).toHaveLength(8)
    expect(hashes.binding).toEqual({
      runId: 'run-1',
      head: 'f8969f5',
      branch: 'codex/stella-staging',
      model: 'gemini-3.6-flash',
      caseCatalogHash: 'catalog-hash',
      caseIds: ['case-1'],
    })
    // Tamper evidence, explicitly NOT an authenticity or identity claim.
    expect(hashes.integrity).toBe('sha256-tamper-evidence')
    expect(JSON.stringify(hashes)).not.toMatch(/signature|signed|attest/i)
  })

  it('refuses to checkpoint when the manifest is missing entirely', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stella-evidence-'))
    directories.push(directory)

    await expect(writeTransactionalCheckpoint(checkpointInput(directory))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('refuses to checkpoint when the manifest describes a different run', async () => {
    const directory = await runDirectory({ ...MANIFEST, runId: 'someone-elses-run' })

    await expect(writeTransactionalCheckpoint(checkpointInput(directory))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it.each(['head', 'branch', 'model', 'caseCatalogHash'])(
    'refuses to checkpoint when the manifest has no %s to bind',
    async (field) => {
      const manifest: Record<string, unknown> = { ...MANIFEST }
      delete manifest[field]
      const directory = await runDirectory(manifest)

      await expect(writeTransactionalCheckpoint(checkpointInput(directory))).rejects.toThrow('CHECKPOINT_ERROR')
    }
  )
})

describe('6 — every declared hash recomputes exactly from the file on disk', () => {
  it('recomputes all eight digests, manifest included', async () => {
    const directory = await runDirectory()
    await writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [sanitizedInput],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    }))
    const record = JSON.parse(await readFile(join(directory, 'hashes.json'), 'utf8')) as { hashes: Record<string, string> }

    for (const file of HASHED_CHECKPOINT_FILES) {
      const contents = await readFile(join(directory, file), 'utf8')
      expect(record.hashes[file], `digest mismatch for ${file}`).toBe(
        createHash('sha256').update(contents, 'utf8').digest('hex')
      )
    }
    // The record never covers itself.
    expect(record.hashes['hashes.json']).toBeUndefined()
  })

  it('detects a manifest edited after the fact — the exact gap H3 closed', async () => {
    const directory = await runDirectory()
    await writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [sanitizedInput],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    }))
    const record = JSON.parse(await readFile(join(directory, 'hashes.json'), 'utf8')) as { hashes: Record<string, string> }

    // Someone rewrites the manifest to claim a different model.
    await writeFile(
      join(directory, 'run-manifest.json'),
      `${JSON.stringify({ ...MANIFEST, model: 'gemini-2.5-flash' }, null, 2)}\n`,
      'utf8'
    )

    const tampered = createHash('sha256')
      .update(await readFile(join(directory, 'run-manifest.json'), 'utf8'), 'utf8')
      .digest('hex')
    expect(tampered).not.toBe(record.hashes['run-manifest.json'])
  })
})

/* ========================================================================== */
/* 7 + 8 — H4: sanitized inputs are post-redaction, and provably so           */
/* ========================================================================== */

describe('7 — sanitized-inputs is post-redaction only', () => {
  it('writes the redaction marker on the artifact and on every entry', async () => {
    const directory = await runDirectory()
    await writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [sanitizedInput],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    }))

    const artifact = JSON.parse(await readFile(join(directory, 'sanitized-inputs.json'), 'utf8')) as {
      redaction: string
      inputs: SanitizedCaseInput[]
    }
    expect(artifact.redaction).toBe('post-redaction')
    expect(artifact.inputs).toHaveLength(1)
    expect(artifact.inputs[0].redaction).toBe('post-redaction')
  })

  it('refuses an input that does not declare itself post-redaction', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [{ ...sanitizedInput, redaction: 'raw' as never }],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('refuses an input carrying a credential field', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [{ ...sanitizedInput, apiKey: 'AIza-not-real' } as never],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })
})

describe('8 — a PII/secret corpus cannot reach sanitized-inputs', () => {
  // Planted in the fields the CONTEXTUAL slice actually serializes. The values
  // are synthetic, and each targets a different redaction rule.
  const CORPUS = {
    email: 'ana.perez@example.com',
    phone: '+57 300 123 4567',
    cedula: '1.020.304.050',
    // Correctly SHAPED synthetic Google key: `AIza` + 35 chars = 39 total. The
    // redactor's rule is `\bAIza[0-9A-Za-z_-]{35,}`, so a shorter lookalike is
    // deliberately NOT redacted — it is not a key. Getting this wrong once here
    // is what proved the fixture, rather than the rule, had been weak.
    apiKey: 'AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY000',
    // The credential itself announces that it is a fixture — per
    // docs/ops/CREDENTIAL_HYGIENE.md, a synthetic-looking HOST does not excuse a
    // real-looking SECRET, and scripts/scan-secrets.ts enforces exactly that.
    dsn: 'postgresql://user:not-a-real-password@db.example.com:5432/app',
    bearer: 'Bearer sk_live_not_a_real_token_0123456789',
  }

  function poisonedCatalog(): readonly ContextualMockCase[] {
    // A full 28-case catalog — the runner refuses anything else — with ONE case
    // poisoned, so the real pipeline (slice -> catalog -> envelope -> redaction)
    // runs end to end rather than being stubbed out.
    return OFFICIAL_CONTEXTUAL_MOCK_CASES.map((item, index) => index !== 0 ? item : {
      ...item,
      context: {
        ...item.context,
        projectName: `Proyecto ${CORPUS.email}`,
        narrativeSummary: `Contacto ${CORPUS.phone} cedula ${CORPUS.cedula} dsn ${CORPUS.dsn}`,
        stakeholdersSnapshot: [{ id: 'stakeholder-1', name: `Actor ${CORPUS.email}`, type: 'beneficiary' }],
        outcomesSnapshot: [{ id: 'outcome-1', name: `Resultado ${CORPUS.apiKey}`, description: CORPUS.bearer, stakeholderGroups: [] }],
      },
    })
  }

  it('emits no corpus value anywhere in the sanitized inputs', async () => {
    const catalog = poisonedCatalog()
    const target = catalog[0].caseId

    const result = await runGuardedContextualEvaluation({
      cases: catalog,
      caseIds: [target],
      env,
      runtime,
      sleep: async () => {},
      provider: async (request) => instrumented(request.providerTemplate),
    })

    const serialized = JSON.stringify(result.sanitizedInputs)
    for (const [rule, value] of Object.entries(CORPUS)) {
      expect(serialized, `${rule} survived into sanitized-inputs`).not.toContain(value)
    }
    // It is a real artifact, not an empty one that trivially contains nothing.
    expect(result.sanitizedInputs).toHaveLength(1)
    expect(result.sanitizedInputs[0].caseId).toBe(target)
    expect(result.sanitizedInputs[0].userMessage).toContain('UNTRUSTED_PROJECT_DATA')
    expect(result.sanitizedInputs[0].redaction).toBe('post-redaction')
  })

  it('leaves a redaction marker where each value was, so the removal is visible', async () => {
    const catalog = poisonedCatalog()
    const result = await runGuardedContextualEvaluation({
      cases: catalog,
      caseIds: [catalog[0].caseId],
      env,
      runtime,
      sleep: async () => {},
      provider: async (request) => instrumented(request.providerTemplate),
    })

    expect(result.sanitizedInputs[0].userMessage).toContain('[REDACTED:')
  })

  it('keeps the citation catalog intact while removing the values', async () => {
    // Redaction must touch values, never keys — the catalog the system prompt
    // advertises has to survive it or every citation becomes unresolvable.
    const catalog = poisonedCatalog()
    const result = await runGuardedContextualEvaluation({
      cases: catalog,
      caseIds: [catalog[0].caseId],
      env,
      runtime,
      sleep: async () => {},
      provider: async (request) => instrumented(request.providerTemplate),
    })

    expect(result.sanitizedInputs[0].canonicalSourceFieldPaths.length).toBeGreaterThan(0)
    expect(JSON.stringify(result.sanitizedInputs[0].canonicalSourceFieldPaths)).not.toContain('@example.com')
  })
})

/* ========================================================================== */
/* 9 — telemetry and case state cannot drift across a crash                   */
/* ========================================================================== */

describe('9 — a crash/resume cycle cannot mismatch telemetry and case', () => {
  it('refuses telemetry for a case that never started', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      // case-1 is PENDING: no call was ever made for it.
      telemetry: [telemetryRecord],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  // T-1 — REACH THE COUNT GUARD, not an earlier one.
  //
  // The original version offered two rows for two cases where one was PENDING,
  // so the "never started" guard rejected it and the count branch was never
  // exercised. Reaching it needs every row to be known, unique and started
  // while still outnumbering providerCalls — which `transitionCase` alone
  // cannot produce, since it increments providerCalls on every start. So the
  // state is hand-built: a corrupted or hand-edited artifact is exactly the
  // input this guard exists for.
  it('refuses more telemetry rows than provider calls', async () => {
    const directory = await runDirectory()
    const state: TransactionalCaseState = {
      phases: { 'case-1': 'SUCCEEDED', 'case-2': 'SUCCEEDED' },
      providerCalls: 1,
      expectedCalls: 2,
      currentCaseId: null,
      checkpointSequence: 0,
      resumeCount: 0,
    }
    const telemetry = [telemetryRecord, { ...telemetryRecord, caseId: 'case-2' }]
    // Every earlier guard passes: both ids known, unique, and neither PENDING.
    expect(new Set(telemetry.map((entry) => entry.caseId)).size).toBe(2)
    expect(Object.values(state.phases)).not.toContain('PENDING')
    expect(telemetry.length).toBeGreaterThan(state.providerCalls)

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      selectedCaseIds: ['case-1', 'case-2'],
      caseState: state,
      telemetry,
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('refuses a telemetry row for a case outside the selection', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [{ ...telemetryRecord, caseId: 'case-from-another-run' }],
      sanitizedInputs: [sanitizedInput],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('refuses duplicate telemetry rows for one case', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord, telemetryRecord],
      sanitizedInputs: [sanitizedInput],
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('stamps the caseId from the runner loop, never from the provider', async () => {
    const ids = OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, 2).map((item) => item.caseId)

    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      sleep: async () => {},
      // A provider that tries to claim a different case id.
      provider: async (request) => ({
        ...instrumented(request.providerTemplate),
        telemetry: { ...instrumented(null).telemetry, caseId: 'attacker-chosen' } as never,
      }),
    })

    expect(result.telemetry.map((entry) => entry.caseId)).toEqual(ids)
  })
})

/* ========================================================================== */
/* 10 — a FINAL bundle cannot claim completion on partial evidence            */
/* ========================================================================== */

describe('10 — FINAL requires complete evidence', () => {
  it('refuses FINAL when a provider call has no telemetry row', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(), // providerCalls = 1
      telemetry: [],               // ...and nothing measured it
      sanitizedInputs: [sanitizedInput],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('refuses FINAL when a selected case has no sanitized input', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('still allows a PARTIAL checkpoint to be partial', async () => {
    const directory = await runDirectory()

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [],
      sanitizedInputs: [],
      checkpointStatus: 'PARTIAL_CHECKPOINT',
    }))).resolves.toBeGreaterThanOrEqual(0)
  })

  // T-2: the assertion names CHECKPOINT_ERROR specifically. `rejects.toThrow()`
  // would have been satisfied by any failure — including one unrelated to the
  // rule under test.
  it('an uninstrumented provider cannot produce a FINAL bundle', async () => {
    // End-to-end statement of the coverage rule: a stub returning a bare
    // response answers the case (it reaches SUCCEEDED) while recording no
    // telemetry, so FINAL refuses it. Note this is the ANSWERED case, which is
    // exactly what the phase-based gate requires to be measured — unlike an
    // interrupted call, which is legitimately unmeasured.
    const ids = [OFFICIAL_CONTEXTUAL_MOCK_CASES[0].caseId]
    const directory = await runDirectory({ ...MANIFEST, caseIds: ids })

    await expect(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      sleep: async () => {},
      provider: async (request) => request.providerTemplate,
      onCheckpoint: async (checkpoint) => {
        await writeTransactionalCheckpoint({
          directory,
          runId: 'run-1',
          scope: 'canary',
          selectedCaseIds: ids,
          caseState: checkpoint.caseState,
          rawResponses: checkpoint.rawResponses,
          decodedResults: checkpoint.decodedResults,
          errors: checkpoint.errors,
          telemetry: checkpoint.telemetry,
          sanitizedInputs: checkpoint.sanitizedInputs,
          adversarialCaseIds: checkpoint.adversarialCaseIds,
          status: checkpoint.status,
          checkpointStatus: checkpoint.checkpointStatus,
          startedAt: timestamp,
          lastCheckpointAt: checkpoint.lastCheckpointAt,
        })
      },
    })).rejects.toThrow('CHECKPOINT_ERROR')
  })
})

/* ========================================================================== */
/* 11 — H5: the acceptance aggregates are back, and deterministic             */
/* ========================================================================== */

describe('11 — summary aggregates are deterministic', () => {
  const finalInput = (directory: string, patch: Partial<TransactionalCheckpointInput> = {}) =>
    checkpointInput(directory, {
      caseState: succeededState(),
      telemetry: [telemetryRecord],
      sanitizedInputs: [sanitizedInput],
      adversarialCaseIds: ['case-1'],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
      ...patch,
    })

  const readSummary = async (directory: string) =>
    JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as Record<string, number | string | boolean>

  it('emits the four G1-A acceptance aggregates', async () => {
    const directory = await runDirectory()
    await writeTransactionalCheckpoint(finalInput(directory))
    const summary = await readSummary(directory)

    expect(summary.safetyScore).toBe(2)
    expect(summary.schemaContractScore).toBe(2)
    expect(summary.numericIntegrityScore).toBe(2)
    expect(summary.adversarialCasesPassed).toBe(1)
    expect(summary.adversarialCasesSelected).toBe(1)
    // Unchanged fail-closed semantics: a run never self-approves.
    expect(summary.eligibleForGate).toBe(false)
    expect(summary.humanReviewStatus).toBe('NOT_STARTED')
  })

  it('produces byte-identical summaries for identical inputs', async () => {
    const first = await runDirectory()
    const second = await runDirectory()
    await writeTransactionalCheckpoint(finalInput(first))
    await writeTransactionalCheckpoint(finalInput(second))

    expect(await readFile(join(first, 'summary.json'), 'utf8')).toBe(
      await readFile(join(second, 'summary.json'), 'utf8')
    )
  })

  it('drops safetyScore to 0 on a SAFETY_ERROR', async () => {
    const directory = await runDirectory()
    await writeTransactionalCheckpoint(finalInput(directory, {
      errors: [{ category: 'SAFETY_ERROR', caseId: 'case-1', location: 'runner', type: 'SAFETY_ERROR', summary: 'SAFETY_ERROR', timestamp }],
    }))
    const summary = await readSummary(directory)

    expect(summary.safetyScore).toBe(0)
    expect(summary.numericIntegrityScore).toBe(2)
  })

  it('drops numericIntegrityScore to 0 on a NUMERIC_INTEGRITY_ERROR', async () => {
    const directory = await runDirectory()
    await writeTransactionalCheckpoint(finalInput(directory, {
      errors: [{ category: 'NUMERIC_INTEGRITY_ERROR', caseId: 'case-1', location: 'runner', type: 'NUMERIC_INTEGRITY_ERROR', summary: 'NUMERIC_INTEGRITY_ERROR', timestamp }],
    }))
    const summary = await readSummary(directory)

    expect(summary.numericIntegrityScore).toBe(0)
    expect(summary.safetyScore).toBe(2)
  })

  it('counts adversarial passes from case state, not from case-id spelling', async () => {
    const directory = await runDirectory()
    let state = transitionCase(createCaseState(['case-1']), 'case-1', 'IN_FLIGHT')
    state = transitionCase(state, 'case-1', 'FAILED')

    await writeTransactionalCheckpoint(finalInput(directory, {
      caseState: state,
      checkpointStatus: 'PARTIAL_CHECKPOINT',
      sanitizedInputs: [sanitizedInput],
    }))
    const summary = await readSummary(directory)

    expect(summary.adversarialCasesPassed).toBe(0)
    expect(summary.adversarialCasesSelected).toBe(1)
  })

  it('reports instrumentation coverage so a package cannot look complete while empty', async () => {
    const directory = await runDirectory()
    await writeTransactionalCheckpoint(finalInput(directory))
    const summary = await readSummary(directory)

    expect(summary.telemetryRecords).toBe(1)
    expect(summary.telemetryUsageAvailableRecords).toBe(1)
    expect(summary.sanitizedInputRecords).toBe(1)
  })
})

/* ========================================================================== */
/* T-5 — the new RESUME validators, each rejected on its own                  */
/* ========================================================================== */

describe('T-5 — resume-side validators', () => {
  const caseId = OFFICIAL_CONTEXTUAL_MOCK_CASES[0].caseId

  /**
   * Build a real, loadable run directory, then corrupt exactly one artifact.
   * Rewriting a file also invalidates its digest, so each case asserts the
   * REASON it is rejected rather than only that it is.
   */
  async function corruptedRun(
    file: 'provider-telemetry.json' | 'sanitized-inputs.json',
    mutate: (artifact: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<{ directory: string; reload: () => Promise<unknown> }> {
    const directory = await runDirectory({ ...MANIFEST, caseIds: [caseId] })
    await writeTransactionalCheckpoint(checkpointInput(directory, {
      selectedCaseIds: [caseId],
      caseState: (() => {
        let state = transitionCase(createCaseState([caseId]), caseId, 'IN_FLIGHT')
        state = transitionCase(state, caseId, 'RAW_RECEIVED')
        state = transitionCase(state, caseId, 'DECODED')
        return transitionCase(state, caseId, 'SUCCEEDED')
      })(),
      telemetry: [{ ...telemetryRecord, caseId }],
      sanitizedInputs: [{ ...sanitizedInput, caseId }],
    }))
    const path = join(directory, file)
    const artifact = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, `${JSON.stringify(mutate(artifact), null, 2)}\n`, 'utf8')
    return { directory, reload: () => loadResumableArtifacts(directory) }
  }

  it('refuses telemetry whose caseId is not in the run', async () => {
    const { reload } = await corruptedRun('provider-telemetry.json', (artifact) => ({
      ...artifact,
      calls: [{ ...telemetryRecord, caseId: 'case-from-another-run' }],
    }))

    await expect(reload()).rejects.toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('refuses duplicate telemetry rows', async () => {
    const { reload } = await corruptedRun('provider-telemetry.json', (artifact) => ({
      ...artifact,
      calls: [{ ...telemetryRecord, caseId }, { ...telemetryRecord, caseId }],
    }))

    await expect(reload()).rejects.toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('refuses a sanitized-inputs artifact missing the post-redaction marker', async () => {
    const { reload } = await corruptedRun('sanitized-inputs.json', (artifact) => {
      const { redaction: _dropped, ...rest } = artifact
      void _dropped
      return rest
    })

    await expect(reload()).rejects.toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('refuses a sanitized input entry that does not declare post-redaction', async () => {
    const { reload } = await corruptedRun('sanitized-inputs.json', (artifact) => ({
      ...artifact,
      inputs: [{ ...sanitizedInput, caseId, redaction: 'raw' }],
    }))

    await expect(reload()).rejects.toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('refuses duplicate sanitized inputs for one case', async () => {
    const { reload } = await corruptedRun('sanitized-inputs.json', (artifact) => ({
      ...artifact,
      inputs: [{ ...sanitizedInput, caseId }, { ...sanitizedInput, caseId }],
    }))

    await expect(reload()).rejects.toThrow('RESUME_INTEGRITY_ERROR')
  })

  it('detects the tampering itself through the hash chain', async () => {
    // Whatever the semantic guard says, rewriting an artifact must also break
    // its digest — the two defences are independent on purpose.
    const { directory } = await corruptedRun('provider-telemetry.json', (artifact) => ({
      ...artifact,
      calls: [{ ...telemetryRecord, caseId }],
      injected: true,
    }))
    const record = JSON.parse(await readFile(join(directory, 'hashes.json'), 'utf8')) as { hashes: Record<string, string> }
    const actual = createHash('sha256')
      .update(await readFile(join(directory, 'provider-telemetry.json'), 'utf8'), 'utf8')
      .digest('hex')

    expect(actual).not.toBe(record.hashes['provider-telemetry.json'])
  })
})

/* ========================================================================== */
/* T-6 — BLOCKER-1: crash in flight -> resume -> FINAL, end to end            */
/* ========================================================================== */

describe('T-6 — an interrupted call yields honest, complete FINAL evidence', () => {
  it('writes FINAL with one fewer telemetry row than provider calls', async () => {
    const ids = OFFICIAL_CONTEXTUAL_MOCK_CASES.slice(0, 3).map((item) => item.caseId)
    const [first, crashed, last] = ids
    // A FULL manifest: `validateResumeManifest` compares branch, head,
    // originMainSHA, providerMode, model, caseCatalogHash, scope, expectedCalls
    // and the protocol/runner versions, so the abbreviated fixture the other
    // blocks use cannot drive a real resume.
    const directory = await runDirectory({
      ...MANIFEST,
      caseIds: ids,
      originMainSHA: runtime.originMainSHA,
      providerMode: 'paid_gemini',
      scope: 'canary',
      expectedCalls: ids.length,
      schemaProtocol: PROVIDER_SCHEMA_PROTOCOL,
      internalProtocol: INTERNAL_SCHEMA_PROTOCOL,
      runnerVersion: REAL_RUNNER_VERSION,
      startedAt: timestamp,
      status: 'RUNNING',
      providerCalls: 0,
    })
    const attempted: string[] = []

    // ---- Execution 1: case 1 completes, the process dies mid-call ---------
    //
    // SIMULATING A CRASH, NOT AN ERROR. A provider that merely throws is CAUGHT
    // by the runner, which records PROVIDER_ERROR and checkpoints the case as
    // FAILED — so disk would never hold IN_FLIGHT and the scenario under test
    // would not exist. A real crash is the process disappearing: the IN_FLIGHT
    // checkpoint has landed and NOTHING after it reaches disk.
    //
    // `frozen` models exactly that. Once the IN_FLIGHT checkpoint for `crashed`
    // is committed, every later write is dropped on the floor.
    let frozen = false
    const persist = async (checkpoint: { caseState: TransactionalCaseState; rawResponses: unknown; decodedResults: unknown; errors: unknown; telemetry: unknown; sanitizedInputs: unknown; adversarialCaseIds: unknown; status: unknown; checkpointStatus: unknown; lastCheckpointAt: string }) => {
      if (frozen) return
      await writeTransactionalCheckpoint(checkpointInput(directory, {
        selectedCaseIds: ids,
        caseState: checkpoint.caseState,
        rawResponses: checkpoint.rawResponses,
        decodedResults: checkpoint.decodedResults,
        errors: checkpoint.errors,
        telemetry: checkpoint.telemetry,
        sanitizedInputs: checkpoint.sanitizedInputs,
        adversarialCaseIds: checkpoint.adversarialCaseIds,
        status: checkpoint.status,
        checkpointStatus: checkpoint.checkpointStatus,
        lastCheckpointAt: checkpoint.lastCheckpointAt,
      } as never))
      if (checkpoint.caseState.phases[crashed] === 'IN_FLIGHT') frozen = true
    }

    await expect(runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      sleep: async () => {},
      provider: async (request) => {
        attempted.push(request.case.caseId)
        // Reached only AFTER the IN_FLIGHT transition and its checkpoint, so
        // providerCalls already counts this call and no response will arrive.
        if (request.case.caseId === crashed) throw new Error('SIMULATED_CRASH_IN_FLIGHT')
        return instrumented(request.providerTemplate)
      },
      onCheckpoint: persist,
    })).rejects.toThrow()

    expect(attempted).toEqual([first, crashed])
    // The persisted state is IN_FLIGHT, not FAILED — the crash shape.
    const persistedState = JSON.parse(await readFile(join(directory, 'run-state.json'), 'utf8')) as { caseStates: Record<string, string>; providerCalls: number }
    expect(persistedState.caseStates[crashed]).toBe('IN_FLIGHT')
    expect(persistedState.providerCalls).toBe(2)

    // ---- Resume -----------------------------------------------------------
    const artifacts = await loadResumableArtifacts(directory)
    const validated = validateResumableArtifacts(artifacts, {
      branch: runtime.branch,
      head: runtime.head,
      originMainSHA: runtime.originMainSHA,
      providerMode: 'paid_gemini',
      model: 'gemini-3.6-flash',
      caseCatalogHash: 'catalog-hash',
      caseIds: ids,
      knownCaseIds: OFFICIAL_CONTEXTUAL_MOCK_CASES.map((item) => item.caseId),
      scope: 'canary',
      expectedCalls: ids.length,
      schemaProtocol: PROVIDER_SCHEMA_PROTOCOL,
      internalProtocol: INTERNAL_SCHEMA_PROTOCOL,
      runnerVersion: REAL_RUNNER_VERSION,
    })

    // The interrupted call survived the crash as a counted call with no
    // measurement — the state BLOCKER-1's equality gate would have rejected.
    expect(validated.caseState.providerCalls).toBe(2)
    expect(validated.telemetry).toHaveLength(1)
    expect(validated.telemetry[0].caseId).toBe(first)

    // ---- Execution 2: resume finishes the run -----------------------------
    const attemptedOnResume: string[] = []
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      caseIds: ids,
      env,
      runtime,
      sleep: async () => {},
      isResume: true,
      runId: validated.runId,
      startedAt: validated.startedAt,
      initialCaseState: validated.caseState,
      initialRawResponses: validated.rawResponses,
      initialDecodedResults: validated.decodedResults,
      initialErrors: validated.errors,
      initialTelemetry: validated.telemetry,
      provider: async (request) => {
        attemptedOnResume.push(request.case.caseId)
        return instrumented(request.providerTemplate)
      },
      onCheckpoint: async (checkpoint) => {
        await writeTransactionalCheckpoint(checkpointInput(directory, {
          selectedCaseIds: ids,
          caseState: checkpoint.caseState,
          rawResponses: checkpoint.rawResponses,
          decodedResults: checkpoint.decodedResults,
          errors: checkpoint.errors,
          telemetry: checkpoint.telemetry,
          sanitizedInputs: checkpoint.sanitizedInputs,
          adversarialCaseIds: checkpoint.adversarialCaseIds,
          status: checkpoint.status,
          checkpointStatus: checkpoint.checkpointStatus,
          lastCheckpointAt: checkpoint.lastCheckpointAt,
        }))
      },
    })

    // 6 — the interrupted case is NOT re-called.
    expect(attemptedOnResume).toEqual([last])
    // 5 — it is classified, not silently dropped.
    expect(result.caseState.phases[crashed]).toBe('FAILED')
    expect(result.errors.some((error) =>
      error.caseId === crashed && error.category === 'INTERRUPTED_AFTER_CALL_STARTED'
    )).toBe(true)
    // 7 — the remaining case completes.
    expect(result.caseState.phases[last]).toBe('SUCCEEDED')
    // 8 — every started call is still counted.
    expect(result.caseState.providerCalls).toBe(3)
    // 9 — exactly one row fewer, for the interrupted call.
    expect(result.telemetry).toHaveLength(2)
    expect(result.telemetry.map((entry) => entry.caseId).sort()).toEqual([first, last].sort())
    // 12 — the hard ceiling is never exceeded.
    expect(attempted.length + attemptedOnResume.length).toBe(3)
    expect(result.caseState.providerCalls).toBeLessThanOrEqual(ids.length)

    // 10 — FINAL was written, which is the whole point of the fix.
    const hashes = JSON.parse(await readFile(join(directory, 'hashes.json'), 'utf8')) as { status: string; hashes: Record<string, string> }
    expect(hashes.status).toBe('FINAL')
    for (const file of HASHED_CHECKPOINT_FILES) {
      expect(hashes.hashes[file]).toBe(
        createHash('sha256').update(await readFile(join(directory, file), 'utf8'), 'utf8').digest('hex')
      )
    }

    // 11 — the summary states the gap rather than hiding it.
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as Record<string, number>
    expect(summary.providerCalls).toBe(3)
    expect(summary.telemetryRecords).toBe(2)
    expect(summary.failedCases).toBe(1)
    expect(summary.sanitizedInputRecords).toBe(3)

    // And the missing call is IDENTIFIABLE — the claim the old comment denied.
    const state = JSON.parse(await readFile(join(directory, 'run-state.json'), 'utf8')) as { caseStates: Record<string, string> }
    const telemetryArtifact = JSON.parse(await readFile(join(directory, 'provider-telemetry.json'), 'utf8')) as { calls: Array<{ caseId: string }> }
    const measured = new Set(telemetryArtifact.calls.map((entry) => entry.caseId))
    const startedButUnmeasured = Object.entries(state.caseStates)
      .filter(([id, phase]) => phase !== 'PENDING' && !measured.has(id))
      .map(([id]) => id)
    expect(startedButUnmeasured).toEqual([crashed])
  })

  it('still refuses FINAL when an ANSWERED case has no telemetry', async () => {
    // The relaxed gate must not have become permissive: a case that reached
    // RAW_RECEIVED demonstrably got a response, so it must be measured.
    const directory = await runDirectory()
    let state = transitionCase(createCaseState(['case-1']), 'case-1', 'IN_FLIGHT')
    state = transitionCase(state, 'case-1', 'RAW_RECEIVED')

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      caseState: state,
      telemetry: [],
      sanitizedInputs: [sanitizedInput],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    }))).rejects.toThrow('CHECKPOINT_ERROR')
  })

  it('allows FINAL when the only unmeasured case was interrupted in flight', async () => {
    const directory = await runDirectory()
    // case-1 answered and measured; case-2 started and never answered.
    let state = transitionCase(createCaseState(['case-1', 'case-2']), 'case-1', 'IN_FLIGHT')
    state = transitionCase(state, 'case-1', 'RAW_RECEIVED')
    state = transitionCase(state, 'case-1', 'DECODED')
    state = transitionCase(state, 'case-1', 'SUCCEEDED')
    state = transitionCase(state, 'case-2', 'IN_FLIGHT')
    state = transitionCase(state, 'case-2', 'FAILED')

    await expect(writeTransactionalCheckpoint(checkpointInput(directory, {
      selectedCaseIds: ['case-1', 'case-2'],
      caseState: state,
      telemetry: [telemetryRecord],
      sanitizedInputs: [sanitizedInput, { ...sanitizedInput, caseId: 'case-2' }],
      errors: [{ category: 'INTERRUPTED_AFTER_CALL_STARTED', caseId: 'case-2', location: 'guarded-contextual-runner', type: 'INTERRUPTED_AFTER_CALL_STARTED', summary: 'INTERRUPTED_AFTER_CALL_STARTED', timestamp }],
      checkpointStatus: 'FINAL',
      status: 'COMPLETED_PENDING_HUMAN_REVIEW',
    }))).resolves.toBeGreaterThanOrEqual(0)
  })
})

/* ========================================================================== */
/* 12 — the dry run still makes no provider call                              */
/* ========================================================================== */

describe('12 — dry-run remains offline', () => {
  it('processes the whole catalog with providerCalls = 0 and no provider at all', async () => {
    const result = await runGuardedContextualEvaluation({
      cases: OFFICIAL_CONTEXTUAL_MOCK_CASES,
      dryRun: true,
      env: {},
      runtime,
      // No provider is supplied: a dry run that reached for one would throw.
    })

    expect(result.summary.providerCalls).toBe(0)
    expect(result.summary.processedCases).toBe(28)
    expect(result.telemetry).toEqual([])
    expect(result.sanitizedInputs).toEqual([])
    expect(result.summary.eligibleForGate).toBe(false)
  })
})
