// lib/grounding/__tests__/scope-attestation.test.ts
// GROUNDING line — the scope-attestation contract (INT-GR-004, train 4).
//
// What this suite must NOT do is assert that attestation proves provenance. It
// cannot: an adapter that fabricated `{ source: 'governed_row', ... }` from its
// own query arguments would satisfy every check, and a test asserting otherwise
// would be the fourth decorative comparison the contract request forbids.
//
// What it DOES pin is the three things the type actually buys:
//   1. a repository that cannot attest must SAY so, and is rejected when the
//      caller demanded attestation;
//   2. an attestation that disagrees with the chunk it describes is loud TODAY,
//      because chunkId / evidenceId / versionId already come from real columns;
//   3. an attested scope outside the query is loud — the check that becomes
//      load-bearing the moment `chunks_in_scope` returns the two columns.

import { describe, it, expect } from 'vitest'
import {
  GroundingScopeViolationError,
  type ContentHash,
  type GroundingChunk,
} from '../contracts'
import {
  InMemoryChunkRepository,
  RepositoryContractViolationError,
  buildChunkQuery,
  enforceRepositoryScope,
  isAttestedScope,
  retrieveGroundedChunks,
  type ChunkQuery,
  type ChunkScopeProvenance,
  type GroundingChunkRepository,
} from '../retrieve'
import { ANNUAL_REPORT, AUDIT_NOTE, chunksOf } from './corpus'
import { scopeA1, scopeA2, scopeAOrgWide, scopeB1 } from './fixtures'

// ---------------------------------------------------------------------------
// Repositories that behave like the real ones
// ---------------------------------------------------------------------------

/**
 * A repository that returns rows it cannot describe — the production adapter's
 * situation today, stated rather than hidden.
 */
class UnattestingRepository implements GroundingChunkRepository {
  readonly id = 'unattesting-repository'
  constructor(private readonly chunks: readonly GroundingChunk[]) {}
  async fetchCandidates(): Promise<readonly GroundingChunk[]> {
    return this.chunks
  }
  attestScope(): ChunkScopeProvenance {
    return { source: 'restated_from_query', reason: 'INT-GR-004: chunks_in_scope returns no scope columns' }
  }
}

/** A repository with no `attestScope` at all — every pre-train-4 implementation. */
class SilentRepository implements GroundingChunkRepository {
  readonly id = 'silent-repository'
  constructor(private readonly chunks: readonly GroundingChunk[]) {}
  async fetchCandidates(): Promise<readonly GroundingChunk[]> {
    return this.chunks
  }
}

/** A repository whose attestation is wrong in exactly one field. */
class MisattestingRepository implements GroundingChunkRepository {
  readonly id = 'misattesting-repository'
  constructor(
    private readonly chunks: readonly GroundingChunk[],
    private readonly corrupt: (chunk: GroundingChunk) => ChunkScopeProvenance,
  ) {}
  async fetchCandidates(): Promise<readonly GroundingChunk[]> {
    return this.chunks
  }
  attestScope(chunk: GroundingChunk): ChunkScopeProvenance {
    return this.corrupt(chunk)
  }
}

const corpus = chunksOf([ANNUAL_REPORT, AUDIT_NOTE], scopeA1)
const query: ChunkQuery = buildChunkQuery(scopeA1, 'beneficiarios')

// ---------------------------------------------------------------------------
// 1. The temporary compatibility shape
// ---------------------------------------------------------------------------

describe('unattested repositories', () => {
  it('are accepted by default, because the SQL that would satisfy them is another workstream', async () => {
    const guarded = enforceRepositoryScope(new UnattestingRepository(corpus))
    await expect(guarded.fetchCandidates(query)).resolves.toHaveLength(corpus.length)
  })

  it('are rejected, by name and reason, when attestation is required', async () => {
    const guarded = enforceRepositoryScope(new UnattestingRepository(corpus), { requireScopeAttestation: true })
    await expect(guarded.fetchCandidates(query)).rejects.toThrow(RepositoryContractViolationError)
    await expect(guarded.fetchCandidates(query)).rejects.toThrow(/INT-GR-004/)
  })

  it('a repository that simply omits attestScope is treated as unattested, never as attested', async () => {
    const permissive = enforceRepositoryScope(new SilentRepository(corpus))
    await expect(permissive.fetchCandidates(query)).resolves.toHaveLength(corpus.length)

    const strict = enforceRepositoryScope(new SilentRepository(corpus), { requireScopeAttestation: true })
    await expect(strict.fetchCandidates(query)).rejects.toThrow(/does not implement attestScope/)
  })

  it('runs no substitute check in place of a missing attestation', async () => {
    // The point of `restated_from_query` is that there is nothing to verify.
    // If the guard quietly compared query.scope to a scope copied FROM the
    // query, this cross-project chunk would pass a check that proved nothing.
    // It is caught — by assertChunkSatisfiesQuery reading the CHUNK's scope,
    // which is a different value. Naming which check caught it is the point.
    const foreign = chunksOf([ANNUAL_REPORT], scopeA2)
    const guarded = enforceRepositoryScope(new UnattestingRepository(foreign))
    await expect(guarded.fetchCandidates(query)).rejects.toThrow(GroundingScopeViolationError)
  })
})

// ---------------------------------------------------------------------------
// 2. Attestations that disagree — loud today
// ---------------------------------------------------------------------------

describe('attestations that disagree with the chunk they describe', () => {
  it('rejects a mismatched chunkId', async () => {
    const repository = new MisattestingRepository(corpus, (chunk) => ({
      source: 'governed_row',
      scope: chunk.scope,
      evidenceId: chunk.evidenceId,
      versionId: chunk.versionId,
      chunkId: 'a'.repeat(64) as ContentHash,
    }))
    await expect(enforceRepositoryScope(repository).fetchCandidates(query)).rejects.toThrow(
      /attested chunk a{64} while returning chunk/,
    )
  })

  it('rejects a mismatched evidence item', async () => {
    const repository = new MisattestingRepository(corpus, (chunk) => ({
      source: 'governed_row',
      scope: chunk.scope,
      evidenceId: 'ev-somewhere-else',
      versionId: chunk.versionId,
      chunkId: chunk.chunkId,
    }))
    await expect(enforceRepositoryScope(repository).fetchCandidates(query)).rejects.toThrow(
      /attested evidence item ev-somewhere-else/,
    )
  })

  it('rejects a mismatched version', async () => {
    const repository = new MisattestingRepository(corpus, (chunk) => ({
      source: 'governed_row',
      scope: chunk.scope,
      evidenceId: chunk.evidenceId,
      versionId: 'b'.repeat(64) as ContentHash,
      chunkId: chunk.chunkId,
    }))
    await expect(enforceRepositoryScope(repository).fetchCandidates(query)).rejects.toThrow(
      RepositoryContractViolationError,
    )
  })

  it('rejects an attested scope that disagrees with the chunk itself', async () => {
    const repository = new MisattestingRepository(corpus, (chunk) => ({
      source: 'governed_row',
      scope: scopeA2,
      evidenceId: chunk.evidenceId,
      versionId: chunk.versionId,
      chunkId: chunk.chunkId,
    }))
    await expect(enforceRepositoryScope(repository).fetchCandidates(query)).rejects.toThrow(
      /attested scope disagrees with the chunk's own/,
    )
  })
})

// ---------------------------------------------------------------------------
// 3. The check that becomes load-bearing
// ---------------------------------------------------------------------------

describe('attested scope against the query', () => {
  it('accepts a row whose attested scope the query contains', async () => {
    const guarded = enforceRepositoryScope(new InMemoryChunkRepository(corpus), {
      requireScopeAttestation: true,
    })
    await expect(guarded.fetchCandidates(query)).resolves.toHaveLength(corpus.length)
  })

  it('an org-wide reader may read a project-scoped row', async () => {
    const guarded = enforceRepositoryScope(new InMemoryChunkRepository(corpus), {
      requireScopeAttestation: true,
    })
    const orgWide = buildChunkQuery(scopeAOrgWide, 'beneficiarios')
    await expect(guarded.fetchCandidates(orgWide)).resolves.toHaveLength(corpus.length)
  })

  it('rejects a cross-project row whose attestation is honest about where it came from', async () => {
    // The attestation is truthful — it reports project 2 — and the query asked
    // for project 1. This is the comparison INT-GR-004 asks the SQL to make
    // possible, and it is the first TypeScript that can observe the leak.
    const repository = new MisattestingRepository(chunksOf([ANNUAL_REPORT], scopeA2), (chunk) => ({
      source: 'governed_row',
      scope: chunk.scope,
      evidenceId: chunk.evidenceId,
      versionId: chunk.versionId,
      chunkId: chunk.chunkId,
    }))
    await expect(enforceRepositoryScope(repository).fetchCandidates(query)).rejects.toThrow(
      GroundingScopeViolationError,
    )
  })

  it('rejects a cross-organization row', async () => {
    const repository = new MisattestingRepository(chunksOf([ANNUAL_REPORT], scopeB1), (chunk) => ({
      source: 'governed_row',
      scope: chunk.scope,
      evidenceId: chunk.evidenceId,
      versionId: chunk.versionId,
      chunkId: chunk.chunkId,
    }))
    await expect(enforceRepositoryScope(repository).fetchCandidates(query)).rejects.toThrow(
      GroundingScopeViolationError,
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Composition
// ---------------------------------------------------------------------------

describe('composition', () => {
  it('the guard forwards attestation, so wrapping twice does not lose it', async () => {
    const once = enforceRepositoryScope(new InMemoryChunkRepository(corpus))
    const twice = enforceRepositoryScope(once, { requireScopeAttestation: true })
    await expect(twice.fetchCandidates(query)).resolves.toHaveLength(corpus.length)
    expect(typeof once.attestScope).toBe('function')
  })

  it('the in-memory repository attests from the row, not from the query', () => {
    const repository = new InMemoryChunkRepository(corpus)
    const attestation = repository.attestScope(corpus[0])
    expect(isAttestedScope(attestation)).toBe(true)
    if (!isAttestedScope(attestation)) return
    // Independently derived: the chunk carries the scope stamped at chunking
    // time, which is a different origin from the query's arguments.
    expect(attestation.scope).toBe(corpus[0].scope)
    expect(attestation.chunkId).toBe(corpus[0].chunkId)
  })

  it('retrieval carries the requirement through to the repository', async () => {
    await expect(
      retrieveGroundedChunks(
        enforceRepositoryScope(new UnattestingRepository(corpus), { requireScopeAttestation: true }),
        scopeA1,
        'beneficiarios',
      ),
    ).rejects.toThrow(RepositoryContractViolationError)
  })
})
