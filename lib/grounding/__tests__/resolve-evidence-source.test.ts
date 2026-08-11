// lib/grounding/__tests__/resolve-evidence-source.test.ts
// G-02 — the resolver that turns an ALREADY AUTHORIZED evidence row into the
// (SourceDocument, bytes) pair `ingestEvidenceDocument` takes.
//
// Every case below is a REFUSAL except two, and that is the shape of the
// contract: the resolver's job is to say no precisely, and to hand back bytes
// only when the row, the scope, the kind, the size and the integrity of the
// content all agree.

import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { MAX_GROUNDING_INPUT_BYTES } from '@/lib/grounding/extract'
import {
  resolveEvidenceSource,
  type EvidenceObjectReader,
  type EvidenceSourceRecord,
} from '@/lib/grounding/ingest/resolve-evidence-source'
import type { GroundingScope } from '@/lib/grounding/contracts'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333'
const OTHER_ORG = '44444444-4444-4444-8444-444444444444'
const EVIDENCE = '55555555-5555-4555-8555-555555555555'

const scope: GroundingScope = { organizationId: ORG, projectId: PROJECT }

const sha256 = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex')

/** A reader that returns fixed bytes and records that it was consulted. */
function readerReturning(bytes: Buffer | null): EvidenceObjectReader & { calls: string[] } {
  const calls: string[] = []
  return {
    id: 'test-reader',
    calls,
    async read(filePath: string) {
      calls.push(filePath)
      return bytes
    },
  }
}

const neverReader: EvidenceObjectReader & { calls: string[] } = readerReturning(null)

function textRecord(overrides: Partial<EvidenceSourceRecord> = {}): EvidenceSourceRecord {
  const text = 'Encuesta de salida, marzo. 84 participantes completaron el programa.'
  return {
    id: EVIDENCE,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'text',
    title: 'Encuesta de salida',
    description: text,
    filePath: null,
    fileSize: null,
    mimeType: null,
    contentHash: sha256(text),
    ...overrides,
  }
}

function fileRecord(
  bytes: Buffer,
  overrides: Partial<EvidenceSourceRecord> = {},
): EvidenceSourceRecord {
  return {
    id: EVIDENCE,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'file',
    title: 'padron.csv',
    description: 'Padrón de participantes',
    filePath: `${PROJECT}/${EVIDENCE}/padron.csv`,
    fileSize: bytes.length,
    mimeType: 'text/csv',
    contentHash: sha256(bytes),
    ...overrides,
  }
}

describe('valid text evidence', () => {
  it('resolves to the stored text and the SourceDocument shape ingestion expects', async () => {
    const record = textRecord()

    const result = await resolveEvidenceSource(record, scope, neverReader)

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.bytes.toString('utf8')).toBe(record.description)
    expect(result.source).toEqual({
      evidenceId: EVIDENCE,
      scope,
      kind: 'text',
      label: 'Encuesta de salida',
      mimeType: 'text/plain',
      byteSize: Buffer.byteLength(record.description!, 'utf8'),
    })
  })

  it('does not consult the object reader — text never lives in storage', async () => {
    const reader = readerReturning(Buffer.from('should not be read'))

    await resolveEvidenceSource(textRecord(), scope, reader)

    expect(reader.calls).toEqual([])
  })
})

describe('valid file evidence', () => {
  it('resolves through the injected reader and reports the real byte size', async () => {
    const bytes = Buffer.from('nombre,edad\nAna,34\nLuis,29\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(fileRecord(bytes), scope, reader)

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.bytes).toEqual(bytes)
    expect(result.source.kind).toBe('file')
    expect(result.source.mimeType).toBe('text/csv')
    expect(result.source.byteSize).toBe(bytes.length)
    expect(reader.calls).toEqual([`${PROJECT}/${EVIDENCE}/padron.csv`])
  })

  it('strips MIME parameters, because SourceDocument requires a normalized type', async () => {
    const bytes = Buffer.from('a,b\n1,2\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { mimeType: 'text/CSV; charset=UTF-8' }),
      scope,
      reader,
    )

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.source.mimeType).toBe('text/csv')
  })
})

describe('missing bytes fail closed', () => {
  it('refuses text evidence whose content was never stored', async () => {
    const result = await resolveEvidenceSource(
      textRecord({ description: null, contentHash: sha256('anything') }),
      scope,
      neverReader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'missing_bytes' })
  })

  it('refuses text evidence whose stored text does not reproduce the content hash', async () => {
    // The row's hash was taken over the submitted text; `description` is a
    // DIFFERENT column. Handing the description over as if it were the content
    // would ingest bytes nobody authorized.
    const result = await resolveEvidenceSource(
      textRecord({ description: 'un resumen, no el texto', contentHash: sha256('el texto') }),
      scope,
      neverReader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'content_hash_mismatch' })
  })

  it('refuses file evidence with no stored path', async () => {
    const bytes = Buffer.from('x', 'utf8')
    const result = await resolveEvidenceSource(
      fileRecord(bytes, { filePath: null }),
      scope,
      readerReturning(bytes),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'missing_bytes' })
  })

  it('refuses file evidence the reader cannot produce', async () => {
    const bytes = Buffer.from('x', 'utf8')
    const reader = readerReturning(null)

    const result = await resolveEvidenceSource(fileRecord(bytes), scope, reader)

    expect(result).toMatchObject({ kind: 'refused', reason: 'missing_bytes' })
    expect(reader.calls).toHaveLength(1)
  })

  it('refuses file evidence whose stored bytes do not reproduce the content hash', async () => {
    const declared = Buffer.from('lo que se autorizó', 'utf8')
    const actual = Buffer.from('otra cosa', 'utf8')

    const result = await resolveEvidenceSource(
      fileRecord(declared),
      scope,
      readerReturning(actual),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'content_hash_mismatch' })
  })
})

describe('unsupported kinds fail closed', () => {
  it('refuses URL evidence and never fetches the remote address', async () => {
    const reader = readerReturning(Buffer.from('remote', 'utf8'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await resolveEvidenceSource(
      textRecord({ type: 'url', description: null, contentHash: sha256('https://example.org') }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'unsupported_kind' })
    expect(reader.calls).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('refuses a type the evidence model does not define', async () => {
    const result = await resolveEvidenceSource(
      textRecord({ type: 'video' }),
      scope,
      neverReader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'unsupported_kind' })
  })
})

describe('size limits', () => {
  it('refuses a file above the grounding input cap without reading it twice', async () => {
    const oversize = Buffer.alloc(MAX_GROUNDING_INPUT_BYTES + 1, 0x61)
    const reader = readerReturning(oversize)

    const result = await resolveEvidenceSource(
      fileRecord(oversize, { fileSize: oversize.length }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'input_too_large' })
  })

  it('refuses on the DECLARED size before the reader is consulted', async () => {
    // A row claiming 40 MiB must not cost a 40 MiB download to refuse.
    const reader = readerReturning(Buffer.from('small', 'utf8'))

    const result = await resolveEvidenceSource(
      fileRecord(Buffer.from('small', 'utf8'), { fileSize: MAX_GROUNDING_INPUT_BYTES + 1 }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'input_too_large' })
    expect(reader.calls).toEqual([])
  })
})

describe('malformed metadata', () => {
  it('refuses file evidence with no MIME type', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { mimeType: null }),
      scope,
      readerReturning(bytes),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'malformed_metadata' })
  })

  it('refuses a MIME type that is not a type/subtype pair', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { mimeType: 'not-a-mime' }),
      scope,
      readerReturning(bytes),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'malformed_metadata' })
  })

  it('refuses evidence with no content hash to verify against', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { contentHash: null }),
      scope,
      readerReturning(bytes),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'malformed_metadata' })
  })
})

describe('scope is re-imposed on the record, not taken from it', () => {
  it('refuses a row belonging to another project and never reads its object', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes, {
        projectId: OTHER_PROJECT,
        filePath: `${OTHER_PROJECT}/${EVIDENCE}/padron.csv`,
      }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'scope_mismatch' })
    expect(reader.calls).toEqual([])
  })

  it('refuses a row belonging to another organization', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { organizationId: OTHER_ORG }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'scope_mismatch' })
    expect(reader.calls).toEqual([])
  })

  it('stamps the CALLER scope onto the SourceDocument, never the row fields', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')

    const result = await resolveEvidenceSource(fileRecord(bytes), scope, readerReturning(bytes))

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    // Same object identity is not required; same values are.
    expect(result.source.scope).toEqual(scope)
  })

  it('refuses an organization-wide scope — ingestion is always project-bound', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes),
      { organizationId: ORG, projectId: null },
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'scope_mismatch' })
    expect(reader.calls).toEqual([])
  })
})
