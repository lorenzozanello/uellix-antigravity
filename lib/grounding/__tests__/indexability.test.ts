// lib/grounding/__tests__/indexability.test.ts
// G-01 (product path) — the PRE-FLIGHT question the evidence UX has to answer
// before anything is written: "can this row ever become part of the grounding
// corpus, and if not, why not?"
//
// ---------------------------------------------------------------------------
// WHY THIS PREDICATE IS ALLOWED TO EXIST AT ALL
// ---------------------------------------------------------------------------
// `resolveEvidenceSource` already answers a very similar question, and a second
// answer that can disagree with the first is exactly the duplication this
// codebase refuses elsewhere. What makes this one legitimate is that it answers
// a DIFFERENT question over a SMALLER input: the resolver needs the stored
// bytes (a storage round trip) and reports on THIS attempt; this one reports on
// the row's METADATA and is cheap enough to run for every row of a project on
// every page render.
//
// The safeguard is the agreement suite at the bottom. It runs the REAL resolver
// and the REAL extractor over the same fixtures and asserts the two verdicts
// match. Drift between them is a test failure rather than a screen that offers
// "Indexar" for a document the pipeline will always refuse.

import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { classifyEvidenceIndexability } from '@/lib/grounding/indexability'
import { extractDocument, MAX_GROUNDING_INPUT_BYTES } from '@/lib/grounding/extract'
import { resolveEvidenceSource, type EvidenceSourceRecord } from '@/lib/grounding/ingest'
import type { GroundingScope } from '@/lib/grounding/contracts'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const EVIDENCE = '55555555-5555-4555-8555-555555555555'

const SCOPE: GroundingScope = { organizationId: ORG, projectId: PROJECT }

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

const TXT = Buffer.from('Encuesta de salida 2026\nParticipantes: 128\n', 'utf8')
const CSV = Buffer.from('nombre,edad\nAna,34\nLuis,29\n', 'utf8')
// Not a real PDF; nothing in this path parses one, which is the point.
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary')

/** A file row, complete in every column the resolver reads. */
function fileRow(overrides: Partial<EvidenceSourceRecord> = {}): EvidenceSourceRecord {
  return {
    id: EVIDENCE,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'file',
    title: 'Encuesta de salida',
    description: null,
    filePath: `${PROJECT}/${EVIDENCE}/encuesta.txt`,
    fileSize: TXT.length,
    mimeType: 'text/plain',
    contentHash: sha256(TXT),
    ...overrides,
  }
}

function textRow(overrides: Partial<EvidenceSourceRecord> = {}): EvidenceSourceRecord {
  const body = 'Testimonio de la participante, transcrito.'
  return {
    id: EVIDENCE,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'text',
    title: 'Testimonio',
    description: body,
    filePath: null,
    fileSize: null,
    mimeType: null,
    contentHash: sha256(Buffer.from(body, 'utf8')),
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* The verdict table — literal expectations, hand-derived                     */
/* -------------------------------------------------------------------------- */

describe('classifyEvidenceIndexability', () => {
  it('accepts a text/plain file whose row is complete', () => {
    expect(classifyEvidenceIndexability(fileRow())).toEqual({
      kind: 'indexable',
      mimeType: 'text/plain',
    })
  })

  it('normalizes MIME parameters before deciding', () => {
    // "text/plain; charset=utf-8" is what a browser actually sends. A predicate
    // that compared the raw string would call the commonest upload unsupported.
    expect(classifyEvidenceIndexability(fileRow({ mimeType: 'text/PLAIN; charset=UTF-8' }))).toEqual({
      kind: 'indexable',
      mimeType: 'text/plain',
    })
  })

  it('accepts CSV, which the extractor parses into table rows', () => {
    const row = fileRow({ mimeType: 'text/csv', fileSize: CSV.length, contentHash: sha256(CSV) })
    expect(classifyEvidenceIndexability(row)).toEqual({ kind: 'indexable', mimeType: 'text/csv' })
  })

  it('refuses PDF — the extractor has no parser for it and never claims one', () => {
    const row = fileRow({ mimeType: 'application/pdf', contentHash: sha256(PDF), fileSize: PDF.length })
    const verdict = classifyEvidenceIndexability(row)
    expect(verdict.kind).toBe('not_indexable')
    expect(verdict).toMatchObject({ blocker: 'unsupported_format' })
  })

  it.each([
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['application/vnd.ms-excel'],
    ['application/msword'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['image/png'],
    ['image/jpeg'],
    ['image/webp'],
    ['image/gif'],
  ])('refuses %s as an unsupported format', (mimeType) => {
    expect(classifyEvidenceIndexability(fileRow({ mimeType }))).toMatchObject({
      kind: 'not_indexable',
      blocker: 'unsupported_format',
    })
  })

  it('refuses url evidence as a KIND, not as a format', () => {
    // The distinction matters in the UI: "we do not fetch remote content" is a
    // policy a reviewer can act on; "unsupported format" would be a lie about a
    // URL that has no format at all.
    const row = fileRow({ type: 'url', filePath: null, mimeType: null })
    expect(classifyEvidenceIndexability(row)).toMatchObject({
      kind: 'not_indexable',
      blocker: 'unsupported_kind',
    })
  })

  it('refuses a file row with no stored path', () => {
    expect(classifyEvidenceIndexability(fileRow({ filePath: null }))).toMatchObject({
      kind: 'not_indexable',
      blocker: 'missing_bytes',
    })
  })

  it('refuses a file row with no usable MIME type', () => {
    expect(classifyEvidenceIndexability(fileRow({ mimeType: 'not-a-mime-type' }))).toMatchObject({
      kind: 'not_indexable',
      blocker: 'malformed_metadata',
    })
  })

  it('refuses a row carrying no content hash — there would be nothing to verify against', () => {
    expect(classifyEvidenceIndexability(fileRow({ contentHash: null }))).toMatchObject({
      kind: 'not_indexable',
      blocker: 'malformed_metadata',
    })
  })

  it('refuses a file that declares more bytes than the grounding cap', () => {
    const row = fileRow({ fileSize: MAX_GROUNDING_INPUT_BYTES + 1 })
    expect(classifyEvidenceIndexability(row)).toMatchObject({
      kind: 'not_indexable',
      blocker: 'input_too_large',
    })
  })

  it('accepts text evidence ONLY when the stored text reproduces the row hash', () => {
    expect(classifyEvidenceIndexability(textRow())).toEqual({
      kind: 'indexable',
      mimeType: 'text/plain',
    })
  })

  it('refuses text evidence whose stored description is not the text that was hashed', () => {
    // This is the live product gap G-02 names: `createTextEvidenceForProject`
    // hashes the submitted TEXT and persists `description`, a different and
    // optional column. Text evidence created through the current form is
    // therefore unindexable, and the UI must say so instead of offering a
    // button that will always fail.
    const row = textRow({ description: 'Una descripción corta, no el testimonio.' })
    expect(classifyEvidenceIndexability(row)).toMatchObject({
      kind: 'not_indexable',
      blocker: 'content_hash_mismatch',
    })
  })

  it('refuses text evidence with no stored content at all', () => {
    expect(classifyEvidenceIndexability(textRow({ description: null }))).toMatchObject({
      kind: 'not_indexable',
      blocker: 'missing_bytes',
    })
  })

  it('carries a detail that names no path, no hash and no content', () => {
    // The detail is rendered to a reviewer and written to an operator trail.
    // A storage key or a content hash in it would make both an index of things
    // the row exists to keep out of them.
    const row = fileRow({ mimeType: 'application/pdf' })
    const verdict = classifyEvidenceIndexability(row)
    if (verdict.kind !== 'not_indexable') throw new Error('expected a refusal')
    expect(verdict.detail).not.toContain(row.filePath)
    expect(verdict.detail).not.toContain(row.contentHash)
  })
})

/* -------------------------------------------------------------------------- */
/* Agreement with the real ingestion path                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the REAL path decides for a row whose bytes are present and intact.
 *
 * Runs `resolveEvidenceSource` (G-02) and, when it resolves, the real
 * `extractDocument` — the two production components whose combined verdict the
 * predicate above is a cheap forecast of.
 */
async function realVerdict(
  row: EvidenceSourceRecord,
  bytes: Buffer,
): Promise<'indexable' | 'not_indexable'> {
  const reader = { id: 'test-reader', read: async () => bytes }
  const resolution = await resolveEvidenceSource(row, SCOPE, reader)
  if (resolution.kind === 'refused') return 'not_indexable'
  return extractDocument(resolution.bytes, resolution.source.mimeType).status === 'extracted'
    ? 'indexable'
    : 'not_indexable'
}

describe('the predicate agrees with the resolver and the extractor it forecasts', () => {
  const CASES: Array<[string, EvidenceSourceRecord, Buffer]> = [
    ['text/plain file', fileRow(), TXT],
    [
      'text/csv file',
      fileRow({ mimeType: 'text/csv', fileSize: CSV.length, contentHash: sha256(CSV) }),
      CSV,
    ],
    [
      'pdf file',
      fileRow({ mimeType: 'application/pdf', fileSize: PDF.length, contentHash: sha256(PDF) }),
      PDF,
    ],
    [
      'xlsx file',
      fileRow({
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSize: PDF.length,
        contentHash: sha256(PDF),
      }),
      PDF,
    ],
    ['png file', fileRow({ mimeType: 'image/png', fileSize: PDF.length, contentHash: sha256(PDF) }), PDF],
    ['url evidence', fileRow({ type: 'url', filePath: null, mimeType: null }), TXT],
    ['file with no path', fileRow({ filePath: null }), TXT],
    ['file with no hash', fileRow({ contentHash: null }), TXT],
    ['file with a broken MIME type', fileRow({ mimeType: 'not-a-mime-type' }), TXT],
    ['oversized declaration', fileRow({ fileSize: MAX_GROUNDING_INPUT_BYTES + 1 }), TXT],
    ['text evidence that stored what it hashed', textRow(), TXT],
    ['text evidence that stored a description instead', textRow({ description: 'otra cosa' }), TXT],
    ['text evidence with nothing stored', textRow({ description: null }), TXT],
  ]

  it.each(CASES)('%s', async (_label, row, bytes) => {
    const predicted = classifyEvidenceIndexability(row).kind
    await expect(realVerdict(row, bytes)).resolves.toBe(predicted)
  })

  it('NEGATIVE CONTROL: the agreement check can fail', async () => {
    // A row the predicate calls indexable and the real path refuses, because
    // the STORED object is missing. The predicate reads metadata and cannot see
    // storage, so this disagreement is by design — and asserting it proves the
    // comparison above is a real comparison rather than two constants.
    const row = fileRow()
    expect(classifyEvidenceIndexability(row).kind).toBe('indexable')

    const resolution = await resolveEvidenceSource(row, SCOPE, {
      id: 'empty-reader',
      read: async () => null,
    })
    expect(resolution.kind).toBe('refused')
  })

  it('a row outside the requested scope is the RESOLVER\'s refusal, never the predicate\'s', async () => {
    // The predicate takes no scope: an evidence row is not "unindexable"
    // because someone asked for it from the wrong project — it is unauthorized,
    // and conflating the two would let a cheap render-time helper become the
    // place tenancy is decided.
    const foreign = fileRow({ projectId: '33333333-3333-4333-8333-333333333333' })
    expect(classifyEvidenceIndexability(foreign).kind).toBe('indexable')
    await expect(realVerdict(foreign, TXT)).resolves.toBe('not_indexable')
  })
})
