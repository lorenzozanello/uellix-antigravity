// lib/grounding/retrieve/repository.ts
// GROUNDING line — the pure boundary between retrieval and storage.
//
// This file defines HOW chunks are asked for, never WHERE they live. It
// imports nothing from db/**, opens no connection, and knows no SQL. The
// reason is not layering hygiene: it is that the persisted implementation does
// not exist yet (GR-001 and GR-002 are still `solicitado`), and a retrieval
// layer written against a schema that has not been agreed would either invent
// that schema or wait for it. Written against this interface, the in-memory
// implementation below and a future pgvector one are interchangeable, and the
// isolation guarantees are proven once, here, for both.
//
// The guard is the load-bearing part. A repository is UNTRUSTED with respect
// to scope: it is the component most likely to leak, because leaking is what a
// dropped WHERE predicate looks like. So every chunk it returns is verified
// against the query that asked for it, and a mismatch throws.

import {
  GroundingScopeViolationError,
  assertValidScope,
  isSameScope,
  scopeContains,
  type ContentHash,
  type GroundingChunk,
  type GroundingScope,
} from '../contracts'

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * What a caller is authorized to read, and what it wants to read about.
 *
 * `evidenceIds` and `versionIds` are AUTHORIZATION filters, not preferences:
 * an empty list means "anything within scope", and a non-empty one means the
 * result may contain nothing else. They are separate from `scope` because
 * authorization can be narrower than the boundary — a reviewer assigned three
 * documents of a project must not retrieve the fourth.
 */
export interface ChunkQuery {
  readonly scope: GroundingScope
  /** The question text, already sanitized by the caller. */
  readonly text: string
  /** Authorized evidence items. Empty means "any within scope". */
  readonly evidenceIds: readonly string[]
  /**
   * Authorized document versions. Empty means "any version within scope".
   * Naming a version pins retrieval to one immutable byte-state of a document,
   * which is what makes a re-run of an old answer reproducible after the
   * document has been re-uploaded.
   */
  readonly versionIds: readonly ContentHash[]
  /**
   * Maximum chunks the repository may return. This is the CANDIDATE cap, not
   * the answer's top-k: ranking, deduplication and diversity all happen after
   * this, and each of them can only remove candidates.
   */
  readonly limit: number
}

/**
 * Deliberately larger than any sane top-k. Ranking quality depends on seeing
 * more candidates than are returned; a cap equal to top-k would make the
 * repository's arbitrary ordering the ranking.
 */
export const DEFAULT_CANDIDATE_LIMIT = 200

export function buildChunkQuery(
  scope: GroundingScope,
  text: string,
  overrides: Partial<Omit<ChunkQuery, 'scope' | 'text'>> = {},
): ChunkQuery {
  assertValidScope(scope)
  const limit = overrides.limit ?? DEFAULT_CANDIDATE_LIMIT
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`ChunkQuery.limit must be a positive integer, got ${limit}`)
  }
  return {
    scope,
    text,
    evidenceIds: overrides.evidenceIds ?? [],
    versionIds: overrides.versionIds ?? [],
    limit,
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scope attestation (INT-GR-004)
// ---------------------------------------------------------------------------

/**
 * Scope AS STATED BY THE ROW, not restated from the query that asked for it.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS TYPE EXISTS FOR, STATED WITHOUT FLATTERY
 * ---------------------------------------------------------------------------
 * `uellix_grounding.chunks_in_scope` returns thirteen columns and neither
 * `organization_id` nor `project_id` is among them. So the production adapter
 * cannot read a chunk's scope from the row — it stamps `chunk.scope` from the
 * query arguments it just passed in. The consequence is exact, and INT-GR-004
 * records it: {@link isSameScope} / {@link scopeContains} inside
 * {@link assertChunkSatisfiesQuery} compare the query against itself. They are
 * TAUTOLOGICAL against that repository. (Its `evidenceId` / `versionId` checks
 * are not — those fields do come from the row.)
 *
 * The real isolation lives in three independent SQL assertions and in zero
 * lines of TypeScript. That is sufficient. It is not what a reader of
 * `enforceRepositoryScope` would assume.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TYPE DOES, AND WHAT IT CANNOT DO
 * ---------------------------------------------------------------------------
 * It CANNOT prove a scope came from a governed row. No type can: an adapter
 * that fabricated `{ source: 'governed_row', ... }` from its own query
 * arguments would satisfy every check below, because the fabricated values
 * would agree with everything they are compared against. Adding a check that
 * read those fabricated fields and pronounced them correct is precisely the
 * fourth decorative comparison INT-GR-004's resolution forbids.
 *
 * What it DOES is make the gap unrepresentable by silence:
 *
 *   1. `source` is a deliberate, reviewable claim. An adapter that cannot read
 *      the row's scope must write {@link UnattestedChunkScope} and say why; it
 *      cannot reach `'governed_row'` by omission or by a cast.
 *   2. Under `requireScopeAttestation`, an unattested repository FAILS rather
 *      than passing a check that would have been vacuous.
 *   3. The five attested fields are cross-checked against the chunk AND the
 *      query, so an attestation that disagrees with either is loud — which is
 *      the case that becomes reachable the moment the columns are returned.
 *
 * This guard becomes load-bearing when, and only when, `chunks_in_scope`
 * returns `organization_id` and `project_id`. Until then it is a declared
 * boundary with a declared hole, which is the honest state of the thing.
 */
export interface ChunkScopeAttestation {
  readonly source: 'governed_row'
  /** Organization and project AS RETURNED, not as requested. */
  readonly scope: GroundingScope
  readonly evidenceId: string
  readonly versionId: ContentHash
  readonly chunkId: ContentHash
}

/**
 * The repository could not attest scope from the result, and says so.
 *
 * This is the TEMPORARY COMPATIBILITY SHAPE, and it is a type rather than a
 * missing field on purpose: an adapter that omitted attestation entirely would
 * be indistinguishable from one that had not been updated, and a silent cast to
 * {@link ChunkScopeAttestation} would be indistinguishable from a real one.
 * Naming the state costs one field and removes both ambiguities.
 */
export interface UnattestedChunkScope {
  readonly source: 'restated_from_query'
  /** Why not — an open contract id, or the surface that cannot supply it. */
  readonly reason: string
}

export type ChunkScopeProvenance = ChunkScopeAttestation | UnattestedChunkScope

export function isAttestedScope(provenance: ChunkScopeProvenance): provenance is ChunkScopeAttestation {
  return provenance.source === 'governed_row'
}

/**
 * A source of candidate chunks.
 *
 * Async because the implementations that matter are: a database round trip, a
 * vector index. The in-memory one resolves immediately and pays nothing for
 * the shape.
 *
 * The contract an implementation must satisfy is exactly the one
 * {@link enforceRepositoryScope} checks — which is why implementations should
 * be wrapped rather than trusted to have got it right.
 */
export interface GroundingChunkRepository {
  /** Versioned identity, recorded in retrieval provenance. */
  readonly id: string
  fetchCandidates(query: ChunkQuery): Promise<readonly GroundingChunk[]>
  /**
   * What the underlying result says about this chunk's isolation boundary.
   *
   * Optional so every repository written before INT-GR-004 keeps compiling.
   * A repository that omits it is treated exactly like one that returns
   * {@link UnattestedChunkScope}: acceptable by default, rejected under
   * `requireScopeAttestation`.
   */
  attestScope?(chunk: GroundingChunk, query: ChunkQuery): ChunkScopeProvenance
}

export class RepositoryContractViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryContractViolationError'
  }
}

/**
 * Wrap a repository so that every chunk it returns is verified against the
 * query before anything downstream sees it.
 *
 * Verification is not filtering, and the difference is the whole point. A
 * filtering guard produces a correct answer from a broken repository, which
 * means the break is never observed and ships. A throwing guard turns the same
 * break into a failed request with a named boundary in the message — loud,
 * attributable, and impossible to mistake for "no results".
 */
export interface EnforceRepositoryScopeOptions {
  /**
   * Reject any repository that cannot attest a chunk's scope FROM THE RESULT.
   *
   * Off by default, and that default is a statement about today rather than a
   * preference: the only production repository is backed by
   * `uellix_grounding.chunks_in_scope`, which does not return the two columns
   * (INT-GR-004). Defaulting to `true` would fail every real query while the
   * SQL that would satisfy it belongs to another workstream — turning an open
   * contract request into an outage.
   *
   * Turn it on the moment the columns are returned. See
   * {@link ChunkScopeAttestation} for what this does and does not prove.
   */
  readonly requireScopeAttestation?: boolean
}

export function enforceRepositoryScope(
  repository: GroundingChunkRepository,
  options: EnforceRepositoryScopeOptions = {},
): GroundingChunkRepository {
  const requireAttestation = options.requireScopeAttestation ?? false
  return {
    id: repository.id,
    attestScope: repository.attestScope?.bind(repository),
    async fetchCandidates(query: ChunkQuery): Promise<readonly GroundingChunk[]> {
      const chunks = await repository.fetchCandidates(query)
      for (const chunk of chunks) {
        assertChunkSatisfiesQuery(chunk, query, repository.id)
        const attestation = repository.attestScope?.(chunk, query) ?? MISSING_ATTESTATION
        assertScopeAttestation(chunk, attestation, query, repository.id, requireAttestation)
      }
      return chunks
    },
  }
}

const MISSING_ATTESTATION: UnattestedChunkScope = {
  source: 'restated_from_query',
  reason: 'the repository does not implement attestScope',
}

/**
 * Check what a repository claims about a chunk's provenance.
 *
 * When the claim is `restated_from_query`, there is nothing to verify — the
 * whole point of that variant is that the repository has said so. It is
 * accepted unless the caller demanded attestation, and rejected loudly when it
 * did. NO substitute check is run in its place: comparing the query's scope to
 * a scope copied from the query is the tautology this type exists to stop
 * pretending about.
 *
 * When the claim is `governed_row`, all five fields are cross-checked. Three of
 * them (`chunkId`, `evidenceId`, `versionId`) are already non-tautological
 * today, because they come from real returned columns — so an attestation that
 * disagrees with the chunk it describes is caught NOW, not once the scope
 * columns land.
 */
export function assertScopeAttestation(
  chunk: GroundingChunk,
  attestation: ChunkScopeProvenance,
  query: ChunkQuery,
  repositoryId: string,
  required: boolean,
): void {
  if (!isAttestedScope(attestation)) {
    if (!required) return
    throw new RepositoryContractViolationError(
      `Repository ${repositoryId} cannot attest the scope of chunk ${chunk.chunkId} from its result (${attestation.reason}), and scope attestation was required`,
    )
  }

  if (attestation.chunkId !== chunk.chunkId) {
    throw new RepositoryContractViolationError(
      `Repository ${repositoryId} attested chunk ${attestation.chunkId} while returning chunk ${chunk.chunkId}`,
    )
  }
  if (attestation.evidenceId !== chunk.evidenceId) {
    throw new RepositoryContractViolationError(
      `Repository ${repositoryId} attested evidence item ${attestation.evidenceId} for chunk ${chunk.chunkId}, which reports ${chunk.evidenceId}`,
    )
  }
  if (attestation.versionId !== chunk.versionId) {
    throw new RepositoryContractViolationError(
      `Repository ${repositoryId} attested version ${attestation.versionId} for chunk ${chunk.chunkId}, which reports ${chunk.versionId}`,
    )
  }
  // Against the CHUNK first: a disagreement here means the row and the record
  // built from it describe two different boundaries, and there is no way to
  // tell which is right — the same reasoning as the provenance check above.
  if (!isSameScope(attestation.scope, chunk.scope)) {
    throw new GroundingScopeViolationError(
      attestation.scope,
      chunk.scope,
      `chunk ${chunk.chunkId} from repository ${repositoryId} (attested scope disagrees with the chunk's own)`,
    )
  }
  // Then against the QUERY. This is the comparison INT-GR-004 makes real: once
  // `attestation.scope` is read from `organization_id` / `project_id` columns
  // rather than restated, this line is the first TypeScript that can observe a
  // cross-tenant row.
  if (!scopeContains(query.scope, attestation.scope)) {
    throw new GroundingScopeViolationError(
      query.scope,
      attestation.scope,
      `attested scope of chunk ${chunk.chunkId} returned by repository ${repositoryId}`,
    )
  }
}

/**
 * The full admission check for one chunk. Exported so an implementation can
 * apply it while building its result set rather than only being caught by the
 * wrapper afterwards — cheaper, and the same rule either way.
 */
export function assertChunkSatisfiesQuery(
  chunk: GroundingChunk,
  query: ChunkQuery,
  repositoryId: string,
): void {
  // Two copies of the boundary travel with every chunk: the chunk's own scope
  // and its provenance record's. They are written at different points of
  // ingestion, so a disagreement means one write was wrong — and there is no
  // way to tell which. Trusting either would be a coin flip on an isolation
  // boundary.
  if (!isSameScope(chunk.scope, chunk.provenance.scope)) {
    throw new GroundingScopeViolationError(
      chunk.scope,
      chunk.provenance.scope,
      `chunk ${chunk.chunkId} from repository ${repositoryId} (scope disagrees with its own provenance)`,
    )
  }

  if (!scopeContains(query.scope, chunk.scope)) {
    throw new GroundingScopeViolationError(
      query.scope,
      chunk.scope,
      `chunk ${chunk.chunkId} returned by repository ${repositoryId}`,
    )
  }

  if (query.evidenceIds.length > 0 && !query.evidenceIds.includes(chunk.evidenceId)) {
    throw new RepositoryContractViolationError(
      `Repository ${repositoryId} returned chunk ${chunk.chunkId} from evidence item ${chunk.evidenceId}, which the query did not authorize (authorized: ${query.evidenceIds.join(', ')})`,
    )
  }

  if (query.versionIds.length > 0 && !query.versionIds.includes(chunk.versionId)) {
    throw new RepositoryContractViolationError(
      `Repository ${repositoryId} returned chunk ${chunk.chunkId} from document version ${chunk.versionId}, which the query did not authorize`,
    )
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * A repository backed by an array, for tests and for the offline path.
 *
 * It applies the same admission rule it would be judged by, which is what a
 * correct implementation looks like: the guard catches implementations that
 * forgot, it does not do their filtering for them.
 */
export class InMemoryChunkRepository implements GroundingChunkRepository {
  readonly id: string

  constructor(
    private readonly chunks: readonly GroundingChunk[],
    id = 'in-memory-chunk-repository-v1',
  ) {
    this.id = id
  }

  async fetchCandidates(query: ChunkQuery): Promise<readonly GroundingChunk[]> {
    const admitted: GroundingChunk[] = []
    for (const chunk of this.chunks) {
      if (!isSameScope(chunk.scope, chunk.provenance.scope)) continue
      if (!scopeContains(query.scope, chunk.scope)) continue
      if (query.evidenceIds.length > 0 && !query.evidenceIds.includes(chunk.evidenceId)) continue
      if (query.versionIds.length > 0 && !query.versionIds.includes(chunk.versionId)) continue
      admitted.push(chunk)
      if (admitted.length >= query.limit) break
    }
    return admitted
  }

  /**
   * This repository CAN attest, and the attestation is not a restatement.
   *
   * Its rows are `GroundingChunk` values produced by ingestion, each carrying
   * the scope stamped at chunking time — a different origin from the query. So
   * `attestation.scope` here is genuinely "what the row says", and
   * {@link assertScopeAttestation} comparing it to `query.scope` is a real
   * comparison of two independently-derived values.
   *
   * That is what the persisted repository will look like once
   * `chunks_in_scope` returns the two columns (INT-GR-004), which is why this
   * implementation is worth having before then: it exercises the guard on the
   * path where it is already load-bearing.
   */
  attestScope(chunk: GroundingChunk): ChunkScopeProvenance {
    return {
      source: 'governed_row',
      scope: chunk.scope,
      evidenceId: chunk.evidenceId,
      versionId: chunk.versionId,
      chunkId: chunk.chunkId,
    }
  }
}
