// lib/grounding/__tests__/ingest-orchestration.test.ts
// GROUNDING line — the ingestion orchestrator (grounding train 4).
//
// Every test here runs the REAL pipeline over REAL bytes: a Buffer goes in,
// `extractDocument` reads it, `normalizeDocumentText` folds it,
// `chunkNormalizedDocument` cuts it, `scanNormalizedText` annotates it, and the
// result is offered to a store that behaves like the governed SQL package. No
// test asserts against a pre-built ingestion outcome, because a pre-built one
// would pass whether or not the pipeline works.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  EXTRACTOR_VERSION,
  NORMALIZATION_VERSION,
  deriveChunkId,
  deriveVersionId,
  hashBytes,
  hashContent,
  type ContentHash,
  type SourceDocument,
} from '../contracts'
import {
  GroundingPersistenceError,
  buildEvidenceChunkPayload,
  ingestEvidenceDocument,
  type IngestionRunPersisted,
} from '../ingest'
import { IngestionRepositoryDouble } from './ingestion-repository-double'
import { scopeA1 } from './fixtures'

// ---------------------------------------------------------------------------
// Documents under test — real files, as bytes
// ---------------------------------------------------------------------------

const PLAIN_TEXT = [
  'Informe de resultados 2025.',
  '',
  'El programa atendio a 1.240 beneficiarios en doce municipios.',
  'La tasa de retencion de beneficiarios fue del 78 por ciento.',
  '',
  'El comite de evaluacion reviso la metodologia en marzo.',
].join('\n')

const CSV_TEXT = [
  'municipio,beneficiarios,retencion',
  'Bogota,540,0.81',
  'Medellin,380,0.76',
  'Cali,320,0.74',
].join('\n')

function plainSource(evidenceId = 'ev-plain'): SourceDocument {
  return {
    evidenceId,
    scope: scopeA1,
    kind: 'file',
    label: 'informe-2025.txt',
    mimeType: 'text/plain',
    byteSize: Buffer.byteLength(PLAIN_TEXT),
  }
}

function csvSource(evidenceId = 'ev-csv'): SourceDocument {
  return {
    evidenceId,
    scope: scopeA1,
    kind: 'file',
    label: 'municipios.csv',
    mimeType: 'text/csv',
    byteSize: Buffer.byteLength(CSV_TEXT),
  }
}

function bytesOf(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

function expectPersisted(outcome: { status: string }): asserts outcome is IngestionRunPersisted {
  expect(outcome.status).toBe('persisted')
}

// ---------------------------------------------------------------------------
// 1. The happy paths, by format
// ---------------------------------------------------------------------------

describe('ingestEvidenceDocument — supported formats', () => {
  it('indexes a text/plain document end to end and finalizes it', async () => {
    const repository = new IngestionRepositoryDouble()
    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT))

    expectPersisted(outcome)
    expect(outcome.reingestion).toBe('first_ingestion')
    expect(outcome.expectedChunkCount).toBeGreaterThan(0)
    expect(outcome.insertedChunkCount).toBeGreaterThanOrEqual(outcome.expectedChunkCount)
    // finalize ran and agreed — the store holds exactly what ingestion produced.
    expect(repository.canonicalChunkCount(outcome.ref)).toBe(outcome.expectedChunkCount)
    expect(repository.calls.finalize).toBe(1)

    // Real text made it through the whole pipeline, not a placeholder.
    const text = outcome.ingestion.chunks.map((chunk) => chunk.text).join('')
    expect(text).toContain('beneficiarios')
  })

  it('indexes a text/csv document', async () => {
    const repository = new IngestionRepositoryDouble()
    const outcome = await ingestEvidenceDocument(repository, csvSource(), bytesOf(CSV_TEXT))

    expectPersisted(outcome)
    expect(outcome.ingestion.chunks.some((chunk) => chunk.text.includes('Medellin'))).toBe(true)
    expect(repository.storedVersions()[0].mimeType).toBe('text/csv')
  })

  it('stamps every pipeline version on the registered row', async () => {
    const repository = new IngestionRepositoryDouble()
    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT))
    expectPersisted(outcome)

    const stored = repository.storedVersions()[0]
    expect(stored.normalizationVersion).toBe(NORMALIZATION_VERSION)
    expect(stored.extractorVersion).toBe(EXTRACTOR_VERSION)
    expect(stored.chunkerVersion).toBe(outcome.ingestion.chunks[0].provenance.chunkerVersion)
    expect(stored.rawContentHash).toBe(hashBytes(bytesOf(PLAIN_TEXT)))
  })
})

// ---------------------------------------------------------------------------
// 2. Documents that are not indexed — and write nothing
// ---------------------------------------------------------------------------

describe('ingestEvidenceDocument — documents that cannot be indexed', () => {
  it('reports an unsupported MIME type without touching the store', async () => {
    const repository = new IngestionRepositoryDouble()
    const outcome = await ingestEvidenceDocument(
      repository,
      { ...plainSource('ev-pdf'), mimeType: 'application/pdf', label: 'informe.pdf' },
      bytesOf('%PDF-1.7 binary payload'),
    )

    expect(outcome.status).toBe('not_indexed')
    if (outcome.status !== 'not_indexed') return
    expect(outcome.ingestion.status).toBe('skipped')
    expect(outcome.ingestion.status === 'skipped' && outcome.ingestion.reason).toBe('unsupported_format')

    // The claim is the only call: nothing was registered, written or finalized.
    expect(repository.calls).toMatchObject({ register: 0, insert: 0, finalize: 0 })
    expect(repository.storedVersions()).toHaveLength(0)
  })

  it('reports an empty document as skipped, never as a write failure', async () => {
    const repository = new IngestionRepositoryDouble()
    const outcome = await ingestEvidenceDocument(repository, plainSource('ev-empty'), bytesOf('   \n\n  \n'))

    expect(outcome.status).toBe('not_indexed')
    if (outcome.status !== 'not_indexed') return
    expect(outcome.ingestion.status === 'skipped' && outcome.ingestion.reason).toBe('empty_document')
    expect(repository.calls.register).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Reingestion
// ---------------------------------------------------------------------------

describe('ingestEvidenceDocument — reingestion', () => {
  it('re-ingesting identical bytes converges instead of forking history', async () => {
    const repository = new IngestionRepositoryDouble()
    const source = plainSource()

    const first = await ingestEvidenceDocument(repository, source, bytesOf(PLAIN_TEXT))
    const second = await ingestEvidenceDocument(repository, source, bytesOf(PLAIN_TEXT))

    expectPersisted(first)
    expectPersisted(second)

    expect(second.reingestion).toBe('identical_replay')
    expect(second.ref).toBe(first.ref)
    // Every row was already there, so the writer inserted nothing — and
    // finalize still confirmed the count, which is what makes a replay the
    // repair path for an ingestion that died before finalizing.
    expect(second.insertedChunkCount).toBe(0)
    expect(repository.storedVersions()).toHaveLength(1)
    expect(repository.calls.finalize).toBe(2)
  })

  it('a replay never records the version as superseding itself', async () => {
    const repository = new IngestionRepositoryDouble()
    const source = plainSource()

    await ingestEvidenceDocument(repository, source, bytesOf(PLAIN_TEXT))
    const replay = await ingestEvidenceDocument(repository, source, bytesOf(PLAIN_TEXT))
    expectPersisted(replay)

    expect(replay.ingestion.document.version.supersedes).toBeNull()
    expect(repository.storedVersions()[0].supersedes).toBeNull()
  })

  it('different bytes for the same evidence item open a new version that supersedes the old', async () => {
    const repository = new IngestionRepositoryDouble()
    const source = plainSource()

    const first = await ingestEvidenceDocument(repository, source, bytesOf(PLAIN_TEXT))
    const second = await ingestEvidenceDocument(repository, source, bytesOf(`${PLAIN_TEXT}\nAdenda de abril.`))

    expectPersisted(first)
    expectPersisted(second)

    expect(second.reingestion).toBe('new_version')
    expect(second.ref).not.toBe(first.ref)
    expect(second.ingestion.document.version.supersedes).toBe(first.ingestion.document.version.versionId)
    expect(repository.storedVersions()).toHaveLength(2)
    expect(repository.storedVersions()[1].ordinal).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 4. Pipeline drift
// ---------------------------------------------------------------------------

describe('ingestEvidenceDocument — pipeline drift on a stored version', () => {
  function seedUnderPipeline(
    repository: IngestionRepositoryDouble,
    overrides: { extractorVersion?: string; normalizationVersion?: string },
  ) {
    const bytes = bytesOf(PLAIN_TEXT)
    const rawContentHash = hashBytes(bytes)
    repository.seedVersion({
      evidenceId: 'ev-plain',
      versionId: deriveVersionId('ev-plain', rawContentHash),
      rawContentHash,
      // Whatever the stored normalized hash is, the version constants below are
      // what this test is about; the hash is kept consistent with them.
      normalizedContentHash: hashContent('whatever the old pipeline produced'),
      normalizationVersion: overrides.normalizationVersion ?? NORMALIZATION_VERSION,
      extractorVersion: overrides.extractorVersion ?? EXTRACTOR_VERSION,
      chunkerVersion: 'chunk-1',
      mimeType: 'text/plain',
    })
  }

  it('refuses to re-register the same bytes under a new extractor, and names the drift', async () => {
    const repository = new IngestionRepositoryDouble()
    seedUnderPipeline(repository, { extractorVersion: 'extract-0' })

    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT))

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.stage).toBe('register_version')
    expect(outcome.failure.kind).toBe('pipeline_version_conflict')
    expect(outcome.failure.message).toContain(`extract-0 -> ${EXTRACTOR_VERSION}`)

    // Detected BEFORE the write. The governed function would have raised U0101
    // with a message that names no field; this stops one call earlier and says
    // which fact changed.
    expect(repository.calls.register).toBe(0)
    expect(outcome.written.ref).toBeNull()
  })

  it('refuses a normalization bump the same way', async () => {
    const repository = new IngestionRepositoryDouble()
    seedUnderPipeline(repository, { normalizationVersion: 'norm-0' })

    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT))

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.failure.kind).toBe('pipeline_version_conflict')
    expect(outcome.failure.message).toContain(`norm-0 -> ${NORMALIZATION_VERSION}`)
  })

  it('flags a normalized hash that moved while every version constant stayed put', async () => {
    const repository = new IngestionRepositoryDouble()
    seedUnderPipeline(repository, {})

    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT))

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.failure.kind).toBe('pipeline_version_conflict')
    expect(outcome.failure.message).toContain('without a version bump')
  })
})

// ---------------------------------------------------------------------------
// 5. Partial persistence is never silent
// ---------------------------------------------------------------------------

describe('ingestEvidenceDocument — partial persistence', () => {
  it('a truncated chunk batch fails at finalize and reports what was written', async () => {
    const repository = new IngestionRepositoryDouble({ dropTrailingChunks: 1 })
    const outcome = await ingestEvidenceDocument(
      repository,
      plainSource(),
      bytesOf(PLAIN_TEXT),
      { targetChars: 60, overlapChars: 0 },
    )

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.stage).toBe('finalize')
    expect(outcome.failure.kind).toBe('incomplete_ingestion')

    // The account of the damage is exact: the version row exists, the writer
    // reported a count, and that count is larger than what finalize found.
    expect(outcome.written.ref).not.toBeNull()
    expect(outcome.written.insertedChunkCount).not.toBeNull()
    expect(outcome.written.expectedChunkCount).toBe(outcome.ingestion?.chunks.length)
    expect(repository.canonicalChunkCount(outcome.written.ref!)).toBeLessThan(
      outcome.written.expectedChunkCount!,
    )
  })

  it('a chunk-write failure keeps the version ref it really left behind', async () => {
    const repository = new IngestionRepositoryDouble({ failAt: 'insert' })
    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT))

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.stage).toBe('persist_chunks')
    // An untyped rejection becomes `unavailable`, never a claim about evidence.
    expect(outcome.failure.kind).toBe('unavailable')
    expect(outcome.written.ref).not.toBeNull()
    expect(outcome.written.insertedChunkCount).toBeNull()
    expect(repository.calls.finalize).toBe(0)
  })

  it('a failure at the history lookup writes nothing and reaches no later stage', async () => {
    const repository = new IngestionRepositoryDouble({ failAt: 'claim' })
    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT))

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.stage).toBe('claim_history')
    expect(outcome.ingestion).toBeNull()
    expect(repository.calls).toMatchObject({ register: 0, insert: 0, finalize: 0 })
  })

  it('keeps a typed adapter failure intact instead of overwriting its kind', async () => {
    const repository = new IngestionRepositoryDouble({
      failAt: 'register',
      failure: new GroundingPersistenceError(
        'evidence_not_found',
        'register_document_version',
        'evidence item not found',
      ),
    })
    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT))

    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.failure.kind).toBe('evidence_not_found')
  })
})

// ---------------------------------------------------------------------------
// 6. Chunk identity
// ---------------------------------------------------------------------------

describe('chunk identity', () => {
  it('derives every payload chunk_id the way the governed function re-derives it', async () => {
    const repository = new IngestionRepositoryDouble()
    const outcome = await ingestEvidenceDocument(repository, plainSource(), bytesOf(PLAIN_TEXT), {
      targetChars: 60,
      overlapChars: 0,
    })
    expectPersisted(outcome)

    // The double raises `chunk_identity_rejected` on any disagreement, exactly
    // as insert_evidence_chunks raises U0104 — so reaching `persisted` at all
    // is the assertion. Restated explicitly here so the reason is visible.
    const versionId = outcome.ingestion.document.version.versionId
    for (const chunk of outcome.ingestion.chunks) {
      expect(chunk.chunkId).toBe(deriveChunkId(versionId, chunk.chunkIndex, chunk.contentHash))
    }
  })

  it('is deterministic across runs and across repository instances', async () => {
    const first = await ingestEvidenceDocument(
      new IngestionRepositoryDouble(),
      plainSource(),
      bytesOf(PLAIN_TEXT),
    )
    const second = await ingestEvidenceDocument(
      new IngestionRepositoryDouble({ id: 'a-different-store' }),
      plainSource(),
      bytesOf(PLAIN_TEXT),
    )
    expectPersisted(first)
    expectPersisted(second)

    expect(second.ingestion.chunks.map((c) => c.chunkId)).toEqual(first.ingestion.chunks.map((c) => c.chunkId))
    expect(second.ingestion.document.version.versionId).toBe(first.ingestion.document.version.versionId)
  })

  it('rejects a chunk whose version does not match the one being persisted', () => {
    const wrongVersion = deriveVersionId('ev-other', hashContent('other bytes'))
    expect(() =>
      buildEvidenceChunkPayload(wrongVersion, [
        {
          chunkId: deriveChunkId(wrongVersion, 0, hashContent('x')),
          scope: scopeA1,
          evidenceId: 'ev-plain',
          versionId: deriveVersionId('ev-plain', hashContent('bytes')) as ContentHash,
          chunkIndex: 0,
          text: 'x',
          contentHash: hashContent('x'),
          location: {
            span: { unit: 'normalized-char', start: 0, end: 1 },
            coordinateSpace: hashContent('space'),
            page: null,
            sectionIndex: null,
            sectionLabel: null,
            lineStart: 1,
            lineEnd: 1,
          },
          provenance: {
            evidenceId: 'ev-plain',
            scope: scopeA1,
            versionId: deriveVersionId('ev-plain', hashContent('bytes')),
            rawContentHash: hashContent('bytes'),
            normalizedContentHash: hashContent('space'),
            normalizationVersion: NORMALIZATION_VERSION,
            chunkerVersion: 'chunk-1',
            injectionScannerVersion: 'inj-1',
            sourceLabel: 'x.txt',
            mimeType: 'text/plain',
          },
          signals: [],
        },
      ]),
    ).toThrow(GroundingPersistenceError)
  })
})

// ---------------------------------------------------------------------------
// 7. Deduplication survives the persistence boundary
// ---------------------------------------------------------------------------

describe('deduplication', () => {
  it('offers suppressed occurrences as duplicate rows without text', async () => {
    // A document whose paragraphs repeat verbatim, so chunking produces a real
    // duplicate rather than a contrived one.
    const repeated = Array.from({ length: 4 }, () => 'Encabezado institucional repetido.').join('\n')
    const repository = new IngestionRepositoryDouble()
    const outcome = await ingestEvidenceDocument(
      repository,
      { ...plainSource('ev-dup'), byteSize: Buffer.byteLength(repeated) },
      bytesOf(repeated),
      { targetChars: 34, overlapChars: 0 },
    )
    expectPersisted(outcome)

    expect(outcome.ingestion.duplicates.length).toBeGreaterThan(0)
    expect(outcome.duplicateRowCount).toBe(outcome.ingestion.duplicates.length)
    // finalize counts canonical rows only, so duplicates never inflate it.
    expect(repository.canonicalChunkCount(outcome.ref)).toBe(outcome.expectedChunkCount)

    const payload = buildEvidenceChunkPayload(
      outcome.ingestion.document.version.versionId,
      outcome.ingestion.chunks,
      outcome.ingestion.duplicates,
    )
    for (const row of payload) {
      // The table's biconditional: content present iff canonical.
      expect(row.content === null).toBe(row.canonical_chunk_id !== null)
      expect(row.char_end).toBeGreaterThan(row.char_start)
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Boundaries
// ---------------------------------------------------------------------------

describe('boundaries', () => {
  it('requires a scope and throws on a malformed one', async () => {
    const repository = new IngestionRepositoryDouble()
    await expect(
      ingestEvidenceDocument(
        repository,
        { ...plainSource(), scope: { organizationId: '', projectId: null } },
        bytesOf(PLAIN_TEXT),
      ),
    ).rejects.toThrow(/organizationId is required/)
    expect(repository.calls.claim).toBe(0)
  })

  it('imports nothing from db/** anywhere in the ingestion path', () => {
    const files = [
      'ingest/persistence.ts',
      'ingest/orchestrate-ingestion.ts',
      'ingest/ingest-document.ts',
      'ingest/index.ts',
    ]
    for (const file of files) {
      const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
      expect(source, file).not.toMatch(/from\s+['"](@\/db|\.\.\/\.\.\/\.\.\/db)/)
      expect(source, file).not.toMatch(/drizzle-orm/)
      expect(source, file).not.toMatch(/\bfetch\s*\(/)
    }
  })
})
