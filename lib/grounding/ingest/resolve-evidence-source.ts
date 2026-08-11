// lib/grounding/ingest/resolve-evidence-source.ts
// G-02 — the seam between the PLATFORM's evidence model and GROUNDING's
// ingestion contract.
//
// ---------------------------------------------------------------------------
// WHAT IT TAKES, AND WHY THAT IS THE SECURITY PROPERTY
// ---------------------------------------------------------------------------
// An `EvidenceSourceRecord` — a row the CALLER has already authorized — plus
// the scope the caller derived, plus an object reader the caller wired. It
// takes no storage path from a request, no organization id from a payload, no
// connection string and no client. There is nothing here for a caller to point
// somewhere else:
//
//   * the storage path comes off the ROW, never off an argument;
//   * the scope is COMPARED against the row and then STAMPED onto the result,
//     so a row of another project cannot smuggle its own scope into the
//     SourceDocument that governs where its chunks land;
//   * the reader is an INTERFACE with one method taking one path, so the
//     resolver cannot be handed privileged connection details even by mistake.
//
// The reader is injected for the same reason `EmbeddingProvider` is: it keeps
// `lib/grounding/**` free of `db/**` and of a Supabase client, so every case
// below is provable without a network or a database. The application wires a
// reader backed by the RLS-scoped session client — never a service role.
//
// ---------------------------------------------------------------------------
// IT REFUSES MORE OFTEN THAN IT RESOLVES, ON PURPOSE
// ---------------------------------------------------------------------------
// Ingestion writes into governed tables through SECURITY DEFINER functions.
// Bytes that reach `ingestEvidenceDocument` become chunks a reviewer will later
// be shown as citations, so "resolve something plausible" is the one behaviour
// this module must not have. Every branch that cannot produce the AUTHORIZED
// bytes returns a refusal with a reason, and no branch substitutes.
//
// ---------------------------------------------------------------------------
// WHY THE CONTENT HASH IS VERIFIED HERE
// ---------------------------------------------------------------------------
// `evidence_items.content_hash` is written at creation over the exact content
// the actor submitted. Checking it makes "the bytes I am about to ingest are
// the bytes that were authorized" a measured fact rather than an assumption
// about storage. It is the same comparison `verifyEvidenceIntegrity` performs
// in lib/pipeline/evidence.ts, moved to the point where it can prevent a write
// instead of reporting on one.
//
// It also closes a live defect. `createTextEvidenceForProject` hashes the
// submitted text and stores `description`, which is a DIFFERENT, optional
// column — the text itself is never persisted. So text evidence created today
// refuses here with `content_hash_mismatch` or `missing_bytes` rather than
// silently ingesting a summary in place of the content. See the G-01 design
// note; this resolver becomes correct for text the moment that path stores what
// it hashed, and needs no change to do so.

import crypto from 'node:crypto'

import { MAX_GROUNDING_INPUT_BYTES } from '../extract'
import type { GroundingScope, SourceDocument } from '../contracts'

/**
 * The subset of `evidence_items` this resolver reads.
 *
 * A STRUCTURAL subset, not the Drizzle row type: the resolver must be callable
 * from a test with a literal, and depending on the table's inferred type would
 * drag `db/schema` into `lib/grounding/**`.
 *
 * `type` is `string` rather than a union because that is what the column is —
 * a `varchar(50)` with a CHECK. Narrowing it here would move the "is this a
 * kind we support?" decision to the compiler and leave the runtime, which is
 * where an unexpected value actually arrives, with no branch for it.
 */
export interface EvidenceSourceRecord {
  readonly id: string
  readonly organizationId: string
  readonly projectId: string
  readonly type: string
  readonly title: string
  readonly description: string | null
  readonly filePath: string | null
  readonly fileSize: number | null
  readonly mimeType: string | null
  readonly contentHash: string | null
}

/**
 * Reads one stored object by the path recorded on its evidence row.
 *
 * ONE METHOD, ONE ARGUMENT, and the argument is a path the resolver got from
 * the row. There is deliberately no bucket parameter, no credential, no client
 * and no URL: an implementation decides those once, at the composition root,
 * under the caller's own session.
 *
 * Returns `null` when the object is absent or unreadable. It does not throw for
 * a missing object — absence is an expected outcome here, and a refusal
 * describes it better than an exception the caller would have to classify.
 */
export interface EvidenceObjectReader {
  /** Recorded on the ingestion trail so an operator can tell readers apart. */
  readonly id: string
  read(filePath: string): Promise<Buffer | null>
}

export type EvidenceSourceRefusal =
  /** Not `file` or `text` — includes `url`, which is never fetched. */
  | 'unsupported_kind'
  /** The row belongs to another organization or project, or the scope is not project-bound. */
  | 'scope_mismatch'
  /** No stored content: no path, no object, or no text. */
  | 'missing_bytes'
  /** Absent or unparseable MIME type, or no hash to verify against. */
  | 'malformed_metadata'
  /** Declared or actual size above the grounding input cap. */
  | 'input_too_large'
  /** The stored bytes are not the bytes the row was created over. */
  | 'content_hash_mismatch'

export type EvidenceSourceResolution =
  | { readonly kind: 'resolved'; readonly source: SourceDocument; readonly bytes: Buffer }
  | {
      readonly kind: 'refused'
      readonly reason: EvidenceSourceRefusal
      /** For the operator's trail. Names no content and quotes no passage. */
      readonly detail: string
    }

/**
 * The refusal half, named. The helpers below can ONLY refuse or produce bytes —
 * they never build a `SourceDocument` — and saying so in their return type is
 * what lets the caller narrow with `'reason' in resolved` and read `mimeType`
 * off the other branch.
 */
type RefusedResolution = Extract<EvidenceSourceResolution, { kind: 'refused' }>

const refuse = (reason: EvidenceSourceRefusal, detail: string): RefusedResolution => ({
  kind: 'refused',
  reason,
  detail,
})

/**
 * `text/CSV; charset=UTF-8` -> `text/csv`, or `null` when it is not a
 * type/subtype pair. `SourceDocument.mimeType` is specified as normalized with
 * parameters stripped, so this is the contract's own requirement rather than a
 * convenience.
 */
function normalizeMimeType(raw: string | null): string | null {
  if (typeof raw !== 'string') return null
  const base = raw.split(';', 1)[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base) ? base : null
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Resolve one authorized evidence row into the pair `ingestEvidenceDocument`
 * takes.
 *
 * ORDER IS DELIBERATE. Scope and kind are decided before anything is read, so a
 * row of another project costs zero storage round trips to refuse — and the
 * tests assert the reader was never called, because "refused eventually" and
 * "refused before touching the object" are different security properties.
 */
export async function resolveEvidenceSource(
  evidence: EvidenceSourceRecord,
  scope: GroundingScope,
  reader: EvidenceObjectReader,
): Promise<EvidenceSourceResolution> {
  // 1. SCOPE — re-imposed on the row. The caller authorized it; this refuses to
  //    take its word for WHERE it belongs.
  //
  //    An organization-wide scope (`projectId: null`) is representable in
  //    `GroundingScope` and refused here: a chunk is written under exactly one
  //    project, so ingestion has no meaning without one.
  if (scope.projectId === null) {
    return refuse('scope_mismatch', 'ingestion requires a project-bound scope')
  }
  if (evidence.organizationId !== scope.organizationId || evidence.projectId !== scope.projectId) {
    // One reason for both, and no detail naming which half disagreed: telling
    // "another project" apart from "another organization" is the tenancy oracle
    // the governed SQL surface refuses to be.
    return refuse('scope_mismatch', 'evidence row is outside the requested scope')
  }

  // 2. KIND — before any read, and `url` is named rather than defaulted so its
  //    refusal is a decision a reader can find.
  if (evidence.type === 'url') {
    return refuse('unsupported_kind', 'url evidence is not ingested; remote content is never fetched')
  }
  if (evidence.type !== 'file' && evidence.type !== 'text') {
    return refuse('unsupported_kind', `unsupported evidence type: ${evidence.type}`)
  }

  // 3. INTEGRITY ANCHOR — there must be something to verify against, whatever
  //    the kind. Without it the checks below would be decorative.
  if (typeof evidence.contentHash !== 'string' || evidence.contentHash.trim() === '') {
    return refuse('malformed_metadata', 'evidence row carries no content hash')
  }

  const resolved =
    evidence.type === 'text'
      ? resolveTextBytes(evidence)
      : await resolveFileBytes(evidence, reader)

  if ('reason' in resolved) return resolved

  const { bytes, mimeType } = resolved

  // 4. ACTUAL SIZE — the declared size was checked before reading; this is the
  //    one that binds, because `file_size` is a claim and `bytes.length` is not.
  if (bytes.length > MAX_GROUNDING_INPUT_BYTES) {
    return refuse(
      'input_too_large',
      `resolved ${bytes.length} bytes, above the ${MAX_GROUNDING_INPUT_BYTES}-byte grounding input cap`,
    )
  }
  if (bytes.length === 0) {
    return refuse('missing_bytes', 'resolved content is empty')
  }

  // 5. INTEGRITY — the bytes about to be ingested are the bytes the row was
  //    created over, or they are not ingested.
  if (sha256Hex(bytes) !== evidence.contentHash) {
    return refuse(
      'content_hash_mismatch',
      'stored content does not reproduce the hash recorded on the evidence row',
    )
  }

  return {
    kind: 'resolved',
    bytes,
    source: {
      evidenceId: evidence.id,
      // The CALLER's scope, not the row's. They were just proved equal; using
      // the caller's is what keeps that true if this order is ever edited.
      scope: { organizationId: scope.organizationId, projectId: scope.projectId },
      kind: evidence.type,
      // Untrusted, and never used as a path — `SourceDocument.label` says so.
      label: evidence.title,
      mimeType,
      byteSize: bytes.length,
    },
  }
}

type ResolvedBytes = { readonly bytes: Buffer; readonly mimeType: string }

/**
 * Text evidence carries its content in the row itself, so there is no object to
 * read and the reader is deliberately not consulted.
 *
 * The MIME type is `text/plain` by construction rather than by column: a text
 * row has no `mime_type`, and inventing one from the title would be guessing.
 */
function resolveTextBytes(evidence: EvidenceSourceRecord): ResolvedBytes | RefusedResolution {
  const text = typeof evidence.description === 'string' ? evidence.description : ''
  if (text.trim() === '') {
    return refuse('missing_bytes', 'text evidence has no stored content')
  }
  return { bytes: Buffer.from(text, 'utf8'), mimeType: 'text/plain' }
}

/**
 * File evidence lives in storage, and the path is the row's.
 *
 * The declared size is checked BEFORE the read so a row claiming 40 MiB costs
 * nothing to refuse. Format support is deliberately NOT decided here:
 * `extractDocument` owns that table, and duplicating it would create a second
 * answer to "can this be read?" that could disagree with the first.
 */
async function resolveFileBytes(
  evidence: EvidenceSourceRecord,
  reader: EvidenceObjectReader,
): Promise<ResolvedBytes | RefusedResolution> {
  const mimeType = normalizeMimeType(evidence.mimeType)
  if (mimeType === null) {
    return refuse('malformed_metadata', 'file evidence has no usable MIME type')
  }

  if (typeof evidence.filePath !== 'string' || evidence.filePath.trim() === '') {
    return refuse('missing_bytes', 'file evidence has no stored path')
  }

  if (typeof evidence.fileSize === 'number' && evidence.fileSize > MAX_GROUNDING_INPUT_BYTES) {
    return refuse(
      'input_too_large',
      `evidence declares ${evidence.fileSize} bytes, above the ${MAX_GROUNDING_INPUT_BYTES}-byte grounding input cap`,
    )
  }

  let bytes: Buffer | null
  try {
    bytes = await reader.read(evidence.filePath)
  } catch {
    // An unreadable object and a missing one are the same outcome to a caller
    // that must not ingest either. The reason is not carried across, because it
    // comes from a storage client and could name a bucket or a path.
    return refuse('missing_bytes', 'stored object could not be read')
  }

  if (bytes === null || bytes.length === 0) {
    return refuse('missing_bytes', 'stored object is absent or empty')
  }

  return { bytes, mimeType }
}
