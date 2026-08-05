// lib/grounding/__tests__/corpus.ts
// GROUNDING line — real documents, really ingested.
//
// The difference between this file and `fixtures.ts` is the whole point of
// train 4. `fixtures.ts` hand-builds chunks, which is right when the chunk IS
// the fixture (a retrieval test placing a specific passage in a specific
// scope). Here the chunks are NOT the fixture: the DOCUMENT is, and the chunks
// are produced by running `ingestDocument` over its bytes.
//
// That matters because the generator and the query journey are supposed to work
// on whatever ingestion actually produces — including its chunk boundaries, its
// normalization, and its provenance. A hand-built chunk would let those tests
// pass against text no pipeline could produce.

import { ingestDocument, type IngestionIngested } from '../ingest'
import type { GroundingChunk, GroundingScope, SourceDocument } from '../contracts'

export interface TestDocument {
  readonly evidenceId: string
  readonly label: string
  readonly mimeType: string
  readonly text: string
}

/** Ingest one document and return its chunks, or fail loudly. */
export function ingestForTest(
  document: TestDocument,
  scope: GroundingScope,
  options: { targetChars?: number; overlapChars?: number } = {},
): IngestionIngested {
  const bytes = Buffer.from(document.text, 'utf8')
  const source: SourceDocument = {
    evidenceId: document.evidenceId,
    scope,
    kind: 'file',
    label: document.label,
    mimeType: document.mimeType,
    byteSize: bytes.length,
  }
  const outcome = ingestDocument(source, bytes, {
    targetChars: options.targetChars ?? 220,
    overlapChars: options.overlapChars ?? 0,
  })
  if (outcome.status !== 'ingested') {
    throw new Error(`Test corpus document ${document.evidenceId} did not ingest: ${outcome.status}`)
  }
  return outcome
}

export function chunksOf(
  documents: readonly TestDocument[],
  scope: GroundingScope,
  options: { targetChars?: number; overlapChars?: number } = {},
): GroundingChunk[] {
  return documents.flatMap((document) => [...ingestForTest(document, scope, options).chunks])
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

/** A narrative report. Prose, sentence-terminated. */
export const ANNUAL_REPORT: TestDocument = {
  evidenceId: 'ev-report-2025',
  label: 'informe-anual-2025.txt',
  mimeType: 'text/plain',
  text: [
    'Informe anual 2025 del programa de retencion escolar.',
    '',
    'El programa atendio a 1.240 beneficiarios en doce municipios durante el ano.',
    'La tasa de retencion escolar de los beneficiarios fue del 78 por ciento.',
    '',
    'El comite de evaluacion reviso la metodologia en marzo y dejo constancia en acta.',
  ].join('\n'),
}

/** A second, independent source that corroborates the retention figure. */
export const AUDIT_NOTE: TestDocument = {
  evidenceId: 'ev-audit-note',
  label: 'nota-auditoria.txt',
  mimeType: 'text/plain',
  text: [
    'Nota de auditoria externa.',
    '',
    'La tasa de retencion escolar de los beneficiarios fue del 78 por ciento.',
    'La auditoria no formulo observaciones sobre el conteo de beneficiarios.',
  ].join('\n'),
}

/** A third source stating a DIFFERENT retention figure for the same period. */
export const REGIONAL_SUMMARY: TestDocument = {
  evidenceId: 'ev-regional-summary',
  label: 'resumen-regional.txt',
  mimeType: 'text/plain',
  text: [
    'Resumen regional consolidado.',
    '',
    'La tasa de retencion escolar de los beneficiarios fue del 62 por ciento.',
    'El consolidado regional agrega municipios que el informe anual no cubre.',
  ].join('\n'),
}

/** A CSV, where a row is the unit of meaning and no sentence terminator exists. */
export const MUNICIPALITY_CSV: TestDocument = {
  evidenceId: 'ev-municipios',
  label: 'municipios.csv',
  mimeType: 'text/csv',
  text: [
    'municipio,beneficiarios,retencion',
    'Bogota,540,0.81',
    'Medellin,380,0.76',
    'Cali,320,0.74',
  ].join('\n'),
}

/** A document about something else entirely — the evidence-gap case. */
export const UNRELATED_MEMO: TestDocument = {
  evidenceId: 'ev-memo-logistica',
  label: 'memo-logistica.txt',
  mimeType: 'text/plain',
  text: [
    'Memorando de logistica.',
    '',
    'El proveedor de transporte renovo el contrato de flota vehicular.',
    'Las rutas urbanas se reprogramaron para el segundo semestre.',
  ].join('\n'),
}
