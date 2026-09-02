// app/app/projects/[projectId]/pipeline/evidence/__tests__/createFileEvidence.action.test.ts
// G-01 (product path) — the ONE sequencing rule of automatic indexing:
//
//   createFileEvidenceForProject  ->  committed evidence identity  ->  ingest
//
// ---------------------------------------------------------------------------
// WHY THE SEAM IS HERE AND NOT IN lib/pipeline/evidence.ts
// ---------------------------------------------------------------------------
// `createFileEvidenceForProject` is three phases around a storage upload:
// reserve the row, upload with NO transaction open, finalize or compensate. An
// ingestion call inside it would have to pick one of those phases, and every
// choice is wrong:
//
//   * inside phase 1 there is a row but no object, so the resolver refuses;
//   * inside phase 3 the ingestion joins the finalize transaction, and a
//     grounding failure would roll back the evidence row — an upload destroyed
//     by an index that is derived and regenerable;
//   * before phase 1 there is no evidence identity at all.
//
// So the ingestion belongs one level up, AFTER the service returns — where the
// row is committed, the object is uploaded, and a failure can be reported
// without taking the evidence with it. These tests pin exactly that.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const PROJECT = '22222222-2222-4222-8222-222222222222'
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333'
const EVIDENCE = '55555555-5555-4555-8555-555555555555'

/** Every boundary call, in the order it happened. */
const calls: string[] = []

const mockCreateFileEvidence = vi.fn()
vi.mock('@/lib/pipeline/evidence', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/pipeline/evidence')>()
  return {
    ...original,
    createFileEvidenceForProject: (...args: unknown[]) => {
      calls.push('create')
      return mockCreateFileEvidence(...args)
    },
  }
})

const mockIngest = vi.fn()
vi.mock('@/app/actions/grounding/ingest-evidence', () => ({
  ingestProjectEvidenceForProject: (...args: unknown[]) => {
    calls.push('ingest')
    return mockIngest(...args)
  },
}))

import { createFileEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action'

const VALID_INPUT = {
  title: 'Encuesta de salida',
  file: {
    name: 'encuesta.txt',
    mimeType: 'text/plain',
    size: 12,
    buffer: Buffer.from('hola mundo\n\n', 'utf8'),
  },
}

/** The row the service returns: phase 1's row, so `filePath` is still null. */
const CREATED_ROW = { id: EVIDENCE, projectId: PROJECT, filePath: null }

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  mockCreateFileEvidence.mockResolvedValue(CREATED_ROW)
  mockIngest.mockResolvedValue({ status: 'indexed', versionId: 'v1', chunkCount: 3, reingestion: 'first_ingestion' })
})

/* -------------------------------------------------------------------------- */
/* The sequence                                                               */
/* -------------------------------------------------------------------------- */

describe('indexing happens after the evidence row exists, and only then', () => {
  it('creates the evidence row before it asks for indexing', async () => {
    await createFileEvidenceAction(PROJECT, VALID_INPUT)
    expect(calls).toEqual(['create', 'ingest'])
  })

  it('never asks for indexing when evidence creation fails', async () => {
    // A failed upload is compensated inside `createFileEvidenceForProject`:
    // the row is withdrawn to `archived` with no `file_path` (M2-COMP-01) and
    // the call throws. There is no object and no usable identity, so indexing
    // here would be indexing evidence that does not exist — and the resolver
    // would refuse it as `missing_bytes` while writing that refusal to the
    // operator trail for a failure nobody caused.
    mockCreateFileEvidence.mockRejectedValue(new Error('Storage upload failed'))

    await expect(createFileEvidenceAction(PROJECT, VALID_INPUT)).rejects.toThrow('Storage upload failed')
    expect(calls).toEqual(['create'])
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('never asks for indexing when the input is rejected', async () => {
    await expect(createFileEvidenceAction(PROJECT, { title: '' })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('indexes THAT row, named by the identity the service returned', async () => {
    await createFileEvidenceAction(PROJECT, VALID_INPUT)
    expect(mockIngest).toHaveBeenCalledWith(PROJECT, { evidenceId: EVIDENCE })
  })

  it('uses the project of the COMMITTED row, not the project from the request', async () => {
    // The row's own `project_id` is what the governed surface will derive scope
    // from. Passing the argument instead would let a request and a row disagree
    // about which project is being indexed — and the ingestion action would
    // then refuse a legitimate write, or worse, be handed a pair to reconcile.
    mockCreateFileEvidence.mockResolvedValue({ ...CREATED_ROW, projectId: OTHER_PROJECT })

    await createFileEvidenceAction(PROJECT, VALID_INPUT)
    expect(mockIngest).toHaveBeenCalledWith(OTHER_PROJECT, { evidenceId: EVIDENCE })
  })
})

/* -------------------------------------------------------------------------- */
/* Failure never travels backwards                                            */
/* -------------------------------------------------------------------------- */

describe('an indexing failure does not falsify the upload', () => {
  it.each([
    ['a refused resolution', { status: 'refused', reason: 'missing_bytes' }],
    ['an unindexable document', { status: 'not_indexed', reason: 'unsupported_format' }],
    ['a rolled-back write', { status: 'error', stage: 'persist_chunks' }],
    ['the capability being off', { status: 'disabled' }],
    ['an unauthorized ingestion', { status: 'unauthorized' }],
  ])('returns the created evidence when indexing reports %s', async (_label, outcome) => {
    mockIngest.mockResolvedValue(outcome)

    const result = await createFileEvidenceAction(PROJECT, VALID_INPUT)

    expect(result.evidence).toEqual(CREATED_ROW)
    expect(result.indexing).toEqual(outcome)
  })

  it('survives an ingestion that throws instead of returning a status', async () => {
    // The ingestion action is written to return statuses, but it is one
    // `await` away from a driver and a storage client. If it ever throws, the
    // evidence is still uploaded and the caller must be told so — the file and
    // its SHA-256 are the chain of custody; the index is derived and
    // regenerable.
    mockIngest.mockRejectedValue(new Error('boom'))

    const result = await createFileEvidenceAction(PROJECT, VALID_INPUT)

    expect(result.evidence).toEqual(CREATED_ROW)
    expect(result.indexing).toEqual({ status: 'error', stage: 'ingest_invocation' })
  })

  it('reports the indexed outcome when it succeeds', async () => {
    const result = await createFileEvidenceAction(PROJECT, VALID_INPUT)
    expect(result.indexing).toMatchObject({ status: 'indexed', chunkCount: 3 })
  })
})
