// lib/grounding/contracts/core.ts
// GROUNDING line — shared primitives every grounding contract builds on.
//
// Three ideas carry the whole module:
//
//   1. ContentHash is a BRANDED string. A plain string can never be passed
//      where a hash is expected, so "hash of what?" is answered by the type
//      system instead of by convention. Hashes are produced only by the
//      helpers below, which fix the algorithm (SHA-256) and the encoding
//      (lowercase hex) once.
//   2. GroundingScope travels with every record. Organization + project
//      isolation is not a filter applied at query time — it is a field of
//      each contract, so a chunk that escaped its scope is a type-level and
//      runtime-checkable defect rather than a silent leak.
//   3. Pipeline versions are constants, not implicit behaviour. Any change to
//      normalization or chunking changes a version string that is recorded in
//      every chunk's provenance, which is what makes "does this index need a
//      reindex?" answerable without re-reading the code.

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

declare const contentHashBrand: unique symbol

/**
 * Lowercase-hex SHA-256 digest. Branded so it cannot be confused with any
 * other string; construct it only via {@link hashContent} / {@link hashBytes}.
 */
export type ContentHash = string & { readonly [contentHashBrand]: 'sha256' }

export const CONTENT_HASH_ALGORITHM = 'sha256' as const
export const CONTENT_HASH_HEX_LENGTH = 64

/** SHA-256 of a UTF-8 string. Stable across runtimes and process restarts. */
export function hashContent(text: string): ContentHash {
  return createHash(CONTENT_HASH_ALGORITHM).update(text, 'utf8').digest('hex') as ContentHash
}

/** SHA-256 of raw bytes — the same digest `lib/pipeline/evidence.ts` seals uploads with. */
export function hashBytes(bytes: Buffer | Uint8Array): ContentHash {
  return createHash(CONTENT_HASH_ALGORITHM).update(bytes).digest('hex') as ContentHash
}

/**
 * Re-admit a hash that came from outside the process (a database row, a JSON
 * payload) into the branded type, validating its shape first. Never use this
 * to "cast away" a hash you did not verify.
 */
export function parseContentHash(value: string): ContentHash {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `Not a lowercase-hex SHA-256 digest: expected ${CONTENT_HASH_HEX_LENGTH} hex chars, got ${JSON.stringify(value).slice(0, 80)}`,
    )
  }
  return value as ContentHash
}

/** Constant-time-ish equality for hashes; both operands are already branded. */
export function contentHashEquals(a: ContentHash, b: ContentHash): boolean {
  return a === b
}

// ---------------------------------------------------------------------------
// Scope (organization / project isolation)
// ---------------------------------------------------------------------------

/**
 * The isolation boundary carried by every grounding record.
 *
 * `projectId` is nullable because evidence can be organization-scoped without
 * belonging to a project, but `organizationId` never is: there is no such
 * thing as an org-less grounding record.
 */
export interface GroundingScope {
  readonly organizationId: string
  readonly projectId: string | null
}

export function isSameScope(a: GroundingScope, b: GroundingScope): boolean {
  return a.organizationId === b.organizationId && a.projectId === b.projectId
}

/** True when `inner` may be read by a consumer authorised for `outer`. */
export function scopeContains(outer: GroundingScope, inner: GroundingScope): boolean {
  if (outer.organizationId !== inner.organizationId) return false
  // An org-wide reader (projectId: null) may read project-scoped records; a
  // project-scoped reader may not read another project's, nor org-wide ones.
  return outer.projectId === null || outer.projectId === inner.projectId
}

/**
 * Fail loudly when a record crosses its isolation boundary. Called at every
 * seam of the ingestion pipeline: a mismatch is a bug, never a filtered-out
 * result, so it must throw rather than return empty.
 */
export function assertSameScope(expected: GroundingScope, actual: GroundingScope, what: string): void {
  if (!isSameScope(expected, actual)) {
    throw new GroundingScopeViolationError(expected, actual, what)
  }
}

export class GroundingScopeViolationError extends Error {
  constructor(
    readonly expected: GroundingScope,
    readonly actual: GroundingScope,
    what: string,
  ) {
    // The message names the boundary but never the content that crossed it.
    super(
      `Grounding scope violation on ${what}: expected organization ${expected.organizationId} / project ${expected.projectId ?? '(org-wide)'}, got organization ${actual.organizationId} / project ${actual.projectId ?? '(org-wide)'}`,
    )
    this.name = 'GroundingScopeViolationError'
  }
}

export function assertValidScope(scope: GroundingScope): void {
  if (!scope.organizationId) throw new Error('GroundingScope.organizationId is required')
  if (scope.projectId === '') throw new Error('GroundingScope.projectId must be a non-empty id or null')
}

// ---------------------------------------------------------------------------
// Pipeline versioning
// ---------------------------------------------------------------------------

/**
 * Version of the text normalization contract (see ingest/normalize.ts).
 * Bumping it invalidates every stored anchor, because offsets are expressed in
 * the coordinate space this version defines.
 */
export const NORMALIZATION_VERSION = 'norm-1' as const

/**
 * Version of the chunking contract (see ingest/chunk-document.ts). Bumping it
 * invalidates stored chunk boundaries but not the anchors' coordinate space.
 */
export const CHUNKER_VERSION = 'chunk-1' as const

/**
 * Version of the structural injection scanner (see ingest/injection-scan.ts).
 * Recorded so a document ingested under an older scanner can be identified and
 * rescanned without re-extracting it.
 */
export const INJECTION_SCANNER_VERSION = 'inj-1' as const

export interface PipelineVersions {
  readonly normalization: typeof NORMALIZATION_VERSION
  readonly chunker: typeof CHUNKER_VERSION
  readonly injectionScanner: typeof INJECTION_SCANNER_VERSION
}

export const PIPELINE_VERSIONS: PipelineVersions = {
  normalization: NORMALIZATION_VERSION,
  chunker: CHUNKER_VERSION,
  injectionScanner: INJECTION_SCANNER_VERSION,
}

// ---------------------------------------------------------------------------
// Small shared types
// ---------------------------------------------------------------------------

/**
 * A half-open character range `[start, end)` in the NORMALIZED coordinate
 * space of a document (or of a single page, where the extractor supplies
 * pages). Every offset in this module lives in that space and only that
 * space — see `unit`, which is a literal so a raw-text offset can never be
 * assigned to a normalized-text field by accident.
 */
export interface TextSpan {
  readonly unit: 'normalized-char'
  readonly start: number
  readonly end: number
}

export function textSpan(start: number, end: number): TextSpan {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error(`TextSpan offsets must be integers, got [${start}, ${end})`)
  }
  if (start < 0 || end < start) {
    throw new Error(`Invalid TextSpan [${start}, ${end}): must satisfy 0 <= start <= end`)
  }
  return { unit: 'normalized-char', start, end }
}

export function spanLength(span: TextSpan): number {
  return span.end - span.start
}

/**
 * A readonly array guaranteed by the type system to hold at least one element.
 * Used for citation lists so "an evidence-backed claim with zero sources" is
 * unrepresentable rather than merely discouraged.
 */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]]

export function isNonEmpty<T>(values: readonly T[]): values is NonEmptyReadonlyArray<T> {
  return values.length > 0
}

/**
 * Narrow a plain array into the non-empty type, or throw. Used at the
 * boundaries where a list is built dynamically but the contract downstream
 * requires at least one entry.
 */
export function requireNonEmpty<T>(values: readonly T[], what: string): NonEmptyReadonlyArray<T> {
  if (!isNonEmpty(values)) throw new Error(`${what} must contain at least one entry`)
  return values
}
