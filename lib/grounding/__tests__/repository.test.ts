// lib/grounding/__tests__/repository.test.ts
// GROUNDING line — the repository contract and its scope guard.
//
// The guard exists because of a specific, realistic failure: a persisted
// implementation (GR-001/GR-002, pgvector) whose WHERE clause loses its
// project predicate — a refactor, a query builder default, an RLS policy that
// grants at organization level. Every such bug produces plausible chunks from
// the right organization and the wrong project. The guard turns that from a
// leak into an exception at the seam, before a single chunk reaches ranking.

import { describe, it, expect } from 'vitest'
import { GroundingScopeViolationError, type GroundingChunk } from '../contracts'
import {
  buildChunkQuery,
  enforceRepositoryScope,
  type ChunkQuery,
  type GroundingChunkRepository,
} from '../retrieve'
import {
  chunkFixture,
  scopeA1,
  scopeA2,
  scopeAOrgWide,
  scopeB1,
  versionIdOf,
} from './fixtures'

/** A repository that returns exactly what it is told to, honest or not. */
function fakeRepository(chunks: readonly GroundingChunk[]): GroundingChunkRepository {
  return {
    id: 'fake-repository-v1',
    async fetchCandidates(): Promise<readonly GroundingChunk[]> {
      return chunks
    },
  }
}

const inScope = chunkFixture('El informe registra 120 beneficiarios.', { scope: scopeA1 })
const otherProject = chunkFixture('Presupuesto ejecutado del proyecto público.', {
  scope: scopeA2,
  evidenceId: 'ev-2',
})
const otherOrg = chunkFixture('Datos de otra organización.', {
  scope: scopeB1,
  evidenceId: 'ev-3',
})

describe('buildChunkQuery', () => {
  it('defaults to no evidence restriction and no version restriction', () => {
    const query = buildChunkQuery(scopeA1, 'beneficiarios')
    expect(query.evidenceIds).toEqual([])
    expect(query.versionIds).toEqual([])
    expect(query.limit).toBeGreaterThan(0)
  })

  it('rejects a malformed scope rather than querying with it', () => {
    expect(() => buildChunkQuery({ organizationId: '', projectId: null }, 'x')).toThrow(
      /organizationId/,
    )
  })

  it('rejects a non-positive limit', () => {
    expect(() => buildChunkQuery(scopeA1, 'x', { limit: 0 })).toThrow(/limit/)
  })
})

describe('enforceRepositoryScope', () => {
  it('passes through chunks that sit inside the queried scope', async () => {
    const guarded = enforceRepositoryScope(fakeRepository([inScope]))
    const result = await guarded.fetchCandidates(buildChunkQuery(scopeA1, 'beneficiarios'))
    expect(result).toEqual([inScope])
  })

  it('throws when the repository returns a chunk from another project', async () => {
    const guarded = enforceRepositoryScope(fakeRepository([inScope, otherProject]))
    await expect(
      guarded.fetchCandidates(buildChunkQuery(scopeA1, 'beneficiarios')),
    ).rejects.toThrow(GroundingScopeViolationError)
  })

  it('throws when the repository returns a chunk from another organization', async () => {
    const guarded = enforceRepositoryScope(fakeRepository([otherOrg]))
    await expect(
      guarded.fetchCandidates(buildChunkQuery(scopeA1, 'beneficiarios')),
    ).rejects.toThrow(GroundingScopeViolationError)
  })

  it('does not silently drop the offending chunk and return the rest', async () => {
    // Filtering would leave a working system with an invisible bug: the query
    // that leaks is indistinguishable from the query that does not.
    const guarded = enforceRepositoryScope(fakeRepository([inScope, otherProject]))
    await expect(
      guarded.fetchCandidates(buildChunkQuery(scopeA1, 'beneficiarios')),
    ).rejects.toThrow(/proj-2222/)
  })

  it('lets an organization-wide query read project-scoped chunks', async () => {
    const guarded = enforceRepositoryScope(fakeRepository([inScope, otherProject]))
    const result = await guarded.fetchCandidates(buildChunkQuery(scopeAOrgWide, 'beneficiarios'))
    expect(result).toHaveLength(2)
  })

  it('throws when a chunk carries an evidence item the query did not authorize', async () => {
    const guarded = enforceRepositoryScope(fakeRepository([inScope]))
    const query = buildChunkQuery(scopeA1, 'beneficiarios', { evidenceIds: ['ev-99'] })
    await expect(guarded.fetchCandidates(query)).rejects.toThrow(/ev-1/)
  })

  it('throws when a chunk belongs to a version the query did not ask for', async () => {
    const guarded = enforceRepositoryScope(fakeRepository([inScope]))
    const query = buildChunkQuery(scopeA1, 'beneficiarios', {
      versionIds: [versionIdOf('ev-1', 'otros bytes')],
    })
    await expect(guarded.fetchCandidates(query)).rejects.toThrow(/version/i)
  })

  it("throws when a chunk's provenance scope disagrees with its own scope field", async () => {
    // Two copies of the boundary travel with every chunk. If they ever
    // disagree, one of them is wrong and neither can be trusted.
    const tampered: GroundingChunk = {
      ...inScope,
      provenance: { ...inScope.provenance, scope: scopeA2 },
    }
    const guarded = enforceRepositoryScope(fakeRepository([tampered]))
    await expect(
      guarded.fetchCandidates(buildChunkQuery(scopeA1, 'beneficiarios')),
    ).rejects.toThrow(GroundingScopeViolationError)
  })

  it('keeps the repository identity visible for provenance', () => {
    const guarded = enforceRepositoryScope(fakeRepository([]))
    expect(guarded.id).toBe('fake-repository-v1')
  })

  it('accepts a chunk whose evidence item is one of several authorized', async () => {
    const query: ChunkQuery = buildChunkQuery(scopeA1, 'beneficiarios', {
      evidenceIds: ['ev-0', 'ev-1'],
    })
    const guarded = enforceRepositoryScope(fakeRepository([inScope]))
    await expect(guarded.fetchCandidates(query)).resolves.toEqual([inScope])
  })
})
