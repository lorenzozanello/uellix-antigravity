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
export function enforceRepositoryScope(
  repository: GroundingChunkRepository,
): GroundingChunkRepository {
  return {
    id: repository.id,
    async fetchCandidates(query: ChunkQuery): Promise<readonly GroundingChunk[]> {
      const chunks = await repository.fetchCandidates(query)
      for (const chunk of chunks) {
        assertChunkSatisfiesQuery(chunk, query, repository.id)
      }
      return chunks
    },
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
}
