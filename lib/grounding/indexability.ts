// lib/grounding/indexability.ts
// G-01 (product path) — "can this evidence row ever join the grounding corpus?"
// answered from the ROW ALONE.
//
// ---------------------------------------------------------------------------
// WHY A SECOND ANSWER IS NOT A SECOND TRUTH
// ---------------------------------------------------------------------------
// `resolveEvidenceSource` already decides whether an evidence item can be
// ingested, and this module must never become a rival to it. The difference is
// the INPUT, and it is what makes both necessary:
//
//   * the resolver needs the stored BYTES. It downloads the object, re-hashes
//     it and reports on THIS attempt — including failures that are about
//     storage right now rather than about the evidence at all;
//   * this predicate reads METADATA ONLY. No storage, no database, no clock.
//     Cheap enough to run for every row of a project on every render, which is
//     what an evidence list needs before a reviewer clicks anything.
//
// So this is a FORECAST of the resolver's verdict, restricted to the causes
// that are already decided by the row. Where it cannot know — the object may
// have been deleted from the bucket, the stored bytes may no longer reproduce
// the hash — it says `indexable` and lets the real path be the one that
// refuses. Optimism about a runtime condition is honest; optimism about a
// format that has no parser is not, and the second is what this exists to stop.
//
// The agreement is enforced, not asserted: `__tests__/indexability.test.ts`
// runs the REAL resolver and the REAL extractor over the same fixtures and
// fails when the two verdicts diverge.
//
// ---------------------------------------------------------------------------
// THE ORDER IS THE RESOLVER'S ORDER
// ---------------------------------------------------------------------------
// kind -> hash anchor -> (text: content, size, integrity | file: mime, path,
// size) -> format. It matches `resolveEvidenceSource` step for step, because a
// row with two problems must be reported under the same one by both. A screen
// that says "unsupported format" where the pipeline says "no stored bytes"
// sends a reviewer to fix the wrong thing.

import crypto from 'node:crypto'

import { MAX_GROUNDING_INPUT_BYTES, classifyGroundingFormat } from './extract'
import {
  normalizeEvidenceMimeType,
  type EvidenceSourceRecord,
} from './ingest/resolve-evidence-source'

/**
 * Why a row cannot be indexed.
 *
 * The first five names are `EvidenceSourceRefusal`'s, deliberately: a reviewer
 * comparing the screen with the operator trail must not have to translate two
 * vocabularies for one condition. `unsupported_format` is the sixth and has no
 * counterpart there because the resolver does not decide formats — the
 * extractor does, one stage later (see `resolveFileBytes`).
 *
 * `scope_mismatch` is deliberately ABSENT. Being asked for from the wrong
 * project is not a property of the evidence, it is an authorization failure,
 * and answering it here would move a tenancy decision into a render-time
 * helper that takes no scope and could not enforce one.
 */
export type GroundingIndexBlocker =
  | 'unsupported_kind'
  | 'missing_bytes'
  | 'malformed_metadata'
  | 'input_too_large'
  | 'content_hash_mismatch'
  | 'unsupported_format'

export type EvidenceIndexability =
  /** Nothing in the row prevents ingestion. `mimeType` is the normalized form. */
  | { readonly kind: 'indexable'; readonly mimeType: string }
  /**
   * The row can be stored evidence and can never be corpus content.
   *
   * `detail` is rendered to a reviewer AND written to an operator trail, so it
   * names the CONDITION and never the values: no storage path, no content
   * hash, no passage. A hash of a small document is a lookup key for its
   * content, which is why it is absent rather than truncated.
   */
  | {
      readonly kind: 'not_indexable'
      readonly blocker: GroundingIndexBlocker
      readonly detail: string
    }

/** The subset of an evidence row this predicate reads. */
export type EvidenceIndexabilityInput = Pick<
  EvidenceSourceRecord,
  'type' | 'description' | 'filePath' | 'fileSize' | 'mimeType' | 'contentHash'
>

const refuse = (blocker: GroundingIndexBlocker, detail: string): EvidenceIndexability => ({
  kind: 'not_indexable',
  blocker,
  detail,
})

/**
 * Text evidence is ingested as `text/plain` by construction, not by column: a
 * text row has no `mime_type`, and inventing one from the title would be
 * guessing. Mirrors `resolveTextBytes`.
 */
const TEXT_EVIDENCE_MIME_TYPE = 'text/plain'

export function classifyEvidenceIndexability(
  evidence: EvidenceIndexabilityInput,
): EvidenceIndexability {
  // 1. KIND. `url` is named rather than defaulted so its refusal is a decision
  //    a reader can find — and so the UI can say "remote content is never
  //    fetched" instead of the false "unsupported format".
  if (evidence.type === 'url') {
    return refuse('unsupported_kind', 'La evidencia de tipo URL no se indexa: nunca se descarga contenido remoto.')
  }
  if (evidence.type !== 'file' && evidence.type !== 'text') {
    return refuse('unsupported_kind', 'Este tipo de evidencia no tiene una ruta de ingesta.')
  }

  // 2. INTEGRITY ANCHOR. Without it every check below would be decorative.
  if (typeof evidence.contentHash !== 'string' || evidence.contentHash.trim() === '') {
    return refuse('malformed_metadata', 'La fila de evidencia no tiene hash de contenido.')
  }

  return evidence.type === 'text' ? classifyTextEvidence(evidence) : classifyFileEvidence(evidence)
}

function classifyTextEvidence(evidence: EvidenceIndexabilityInput): EvidenceIndexability {
  const stored = typeof evidence.description === 'string' ? evidence.description : ''
  if (stored.trim() === '') {
    return refuse('missing_bytes', 'La evidencia de texto no tiene contenido almacenado.')
  }

  const bytes = Buffer.from(stored, 'utf8')
  if (bytes.length > MAX_GROUNDING_INPUT_BYTES) {
    return refuse('input_too_large', 'El contenido supera el límite de entrada para grounding (25 MB).')
  }

  // The one check this predicate CAN make that the resolver makes over storage:
  // text evidence carries its content in the row, so the integrity comparison
  // needs no round trip.
  //
  // It is also the check that tells the truth about a live product gap:
  // `createTextEvidenceForProject` hashes the submitted TEXT and persists
  // `description`, a different and optional column. Text evidence created
  // through the current form therefore fails here — which is exactly what the
  // reviewer needs to be told, rather than being offered a button that will
  // always come back refused.
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (digest !== evidence.contentHash) {
    return refuse(
      'content_hash_mismatch',
      'El texto almacenado no reproduce el hash registrado al crear la evidencia.',
    )
  }

  return { kind: 'indexable', mimeType: TEXT_EVIDENCE_MIME_TYPE }
}

function classifyFileEvidence(evidence: EvidenceIndexabilityInput): EvidenceIndexability {
  const mimeType = normalizeEvidenceMimeType(evidence.mimeType)
  if (mimeType === null) {
    return refuse('malformed_metadata', 'El archivo no declara un tipo MIME utilizable.')
  }

  if (typeof evidence.filePath !== 'string' || evidence.filePath.trim() === '') {
    return refuse('missing_bytes', 'El archivo no tiene una ruta almacenada.')
  }

  if (typeof evidence.fileSize === 'number' && evidence.fileSize > MAX_GROUNDING_INPUT_BYTES) {
    return refuse('input_too_large', 'El archivo supera el límite de entrada para grounding (25 MB).')
  }

  // LAST, because it is last in the real pipeline: the resolver produces bytes
  // for any MIME type and `extractDocument` is what has no parser.
  const format = classifyGroundingFormat(mimeType)
  if (format.kind === 'gated') {
    return refuse(
      'unsupported_format',
      `La extracción de ${format.label} está pendiente de la decisión de dependencia G5; el formato se almacena pero no se indexa.`,
    )
  }
  if (format.kind === 'unregistered') {
    return refuse(
      'unsupported_format',
      `No hay extractor registrado para «${format.mimeType}»; el archivo queda almacenado como evidencia sin indexar.`,
    )
  }

  return { kind: 'indexable', mimeType: format.mimeType }
}
