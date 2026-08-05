// lib/grounding/__tests__/grounded-query.test.ts
// GROUNDING line — the whole query journey, end to end (train 4).
//
// This is the suite that answers "does a local run actually work?". Every case
// starts from a document's BYTES, ingests them with the real pipeline, hands
// the resulting chunks to a repository, and asks a question. Nothing is
// pre-built: no canned retrieval result, no canned draft, no canned answer.
//
// What it does NOT re-test is the policies the journey composes — ranking has
// retrieve.test.ts, citation construction has grounded-answer.test.ts, the
// classification has orchestrate.test.ts. What belongs here is what only exists
// once ingestion, retrieval and generation are wired together.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { GroundingScopeViolationError, citationsOf, type GroundingChunk } from '../contracts'
import {
  EXTRACTIVE_GENERATOR_ID,
  InMemoryChunkRepository,
  RepositoryContractViolationError,
  runGroundedQuery,
  unwrapExtractiveStatement,
  type GroundingChunkRepository,
} from '../retrieve'
import {
  ANNUAL_REPORT,
  AUDIT_NOTE,
  MUNICIPALITY_CSV,
  REGIONAL_SUMMARY,
  UNRELATED_MEMO,
  chunksOf,
} from './corpus'
import { scopeA1, scopeA2, scopeB1 } from './fixtures'

const QUESTION = 'tasa de retencion escolar de los beneficiarios'

function repositoryFor(documents: Parameters<typeof chunksOf>[0], scope = scopeA1): InMemoryChunkRepository {
  return new InMemoryChunkRepository(chunksOf(documents, scope))
}

/** A repository whose backing store is unreachable — an operational failure. */
class UnreachableRepository implements GroundingChunkRepository {
  readonly id = 'unreachable-repository'
  async fetchCandidates(): Promise<readonly GroundingChunk[]> {
    // Already sanitized, as the persisted adapter is contractually required to
    // do before rejecting. No SQLSTATE, no table name, no connection string.
    throw new Error('the grounding chunk store did not respond')
  }
}

/** A repository that ignores its authorization filters — a programming defect. */
class LeakyRepository implements GroundingChunkRepository {
  readonly id = 'leaky-repository'
  constructor(private readonly chunks: readonly GroundingChunk[]) {}
  /** Takes no query on purpose: it applies none of its filters. */
  async fetchCandidates(): Promise<readonly GroundingChunk[]> {
    return this.chunks
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. A real local run
// ---------------------------------------------------------------------------

describe('runGroundedQuery — a real local run', () => {
  it('answers from ingested bytes with validated citations and no configuration', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT, AUDIT_NOTE, MUNICIPALITY_CSV]),
      scope: scopeA1,
      text: QUESTION,
    })

    expect(run.classification === 'grounded' || run.classification === 'partially_grounded').toBe(true)
    expect(run.outcome.issues).toEqual([])
    expect(run.outcome.answer.status).not.toBe('abstained')
    expect(run.outcome.answer.requiresHumanReview).toBe(true)

    const assertions = run.outcome.answer.status === 'abstained' ? [] : run.outcome.answer.assertions
    expect(assertions.length).toBeGreaterThan(0)

    // Every citation resolves to a chunk that was really retrieved, and its
    // hash and location were read off that chunk rather than supplied.
    const retrieved = new Map(run.outcome.retrieval!.candidates.map((c) => [c.chunk.chunkId, c.chunk]))
    for (const assertion of assertions) {
      for (const citation of citationsOf(assertion)) {
        const chunk = retrieved.get(citation.chunkId)
        expect(chunk).toBeDefined()
        expect(citation.quotedTextHash).toBe(chunk!.contentHash)
        expect(citation.versionId).toBe(chunk!.versionId)
        expect(citation.location).toEqual(chunk!.location)
      }
      expect(chunkTextFor(assertion, retrieved)).toContain(unwrapExtractiveStatement(assertion.statement))
    }
  })

  it('reports which components produced the answer', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT]),
      scope: scopeA1,
      text: QUESTION,
    })

    expect(run.provenance.generatorId).toBe(EXTRACTIVE_GENERATOR_ID)
    expect(run.provenance.repositoryId).toBe('in-memory-chunk-repository-v1')
    expect(run.provenance.scorerId).toBe('lexical-idf-tf-v1')
    expect(run.provenance.strategy).toBe('lexical')
    // R7: the floor is provisional, still two, and reported rather than assumed.
    expect(run.provenance.minDistinctSources).toBe(2)
  })

  it('honours the R7 source floor when the corpus allows it', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT, AUDIT_NOTE, REGIONAL_SUMMARY]),
      scope: scopeA1,
      text: QUESTION,
      retrieval: { topK: 3 },
    })
    expect(run.outcome.retrieval!.distinctSources).toBeGreaterThanOrEqual(2)
  })

  it('abandons the floor rather than faking it on a single-source corpus', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT]),
      scope: scopeA1,
      text: QUESTION,
    })
    expect(run.outcome.retrieval!.distinctSources).toBe(1)
    expect(run.classification === 'grounded' || run.classification === 'partially_grounded').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Isolation
// ---------------------------------------------------------------------------

describe('runGroundedQuery — isolation', () => {
  it('returns nothing for another project of the same organization', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT, AUDIT_NOTE], scopeA2),
      scope: scopeA1,
      text: QUESTION,
    })

    expect(run.outcome.answer.status).toBe('abstained')
    expect(run.classification).toBe('insufficient_evidence')
    expect(run.outcome.retrieval!.candidates).toEqual([])
  })

  it('returns nothing for another organization', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT], scopeB1),
      scope: scopeA1,
      text: QUESTION,
    })
    expect(run.outcome.answer.status).toBe('abstained')
    expect(run.outcome.retrieval!.candidates).toEqual([])
  })

  it('THROWS rather than answering when a repository leaks across projects', async () => {
    await expect(
      runGroundedQuery({
        repository: new LeakyRepository(chunksOf([ANNUAL_REPORT], scopeA2)),
        scope: scopeA1,
        text: QUESTION,
      }),
    ).rejects.toThrow(GroundingScopeViolationError)
  })

  it('THROWS rather than answering when a repository leaks across organizations', async () => {
    await expect(
      runGroundedQuery({
        repository: new LeakyRepository(chunksOf([ANNUAL_REPORT], scopeB1)),
        scope: scopeA1,
        text: QUESTION,
      }),
    ).rejects.toThrow(GroundingScopeViolationError)
  })

  it('THROWS when a repository ignores its evidence-item authorization filter', async () => {
    await expect(
      runGroundedQuery({
        repository: new LeakyRepository(chunksOf([ANNUAL_REPORT, AUDIT_NOTE], scopeA1)),
        scope: scopeA1,
        text: QUESTION,
        retrieval: { evidenceIds: [ANNUAL_REPORT.evidenceId] },
      }),
    ).rejects.toThrow(RepositoryContractViolationError)
  })

  it('rejects a malformed scope before touching the repository', async () => {
    const repository = repositoryFor([ANNUAL_REPORT])
    const spy = vi.spyOn(repository, 'fetchCandidates')
    await expect(
      runGroundedQuery({ repository, scope: { organizationId: '', projectId: null }, text: QUESTION }),
    ).rejects.toThrow(/organizationId is required/)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. "We could not look" is never "your evidence does not say"
// ---------------------------------------------------------------------------

describe('runGroundedQuery — failure surfaces', () => {
  it('reports an unreachable store as provider_unavailable, not as an evidence gap', async () => {
    const run = await runGroundedQuery({
      repository: new UnreachableRepository(),
      scope: scopeA1,
      text: QUESTION,
    })

    expect(run.classification).toBe('provider_unavailable')
    expect(run.outcome.kind).toBe('provider_unavailable')
    expect(run.outcome.answer.abstention!.code).toBe('retrieval_unavailable')
    // Nothing was inspected, and the metadata says so — an evidence gap would
    // report a count and a query.
    expect(run.outcome.answer.abstention!.inspected).toEqual({ total: 0, belowThreshold: 0, quarantined: 0 })
    expect(run.outcome.retrieval).toBeNull()
    // No scorer id is invented for a pipeline that never ran.
    expect(run.provenance.scorerId).toBeNull()
  })

  it('reports a silent corpus as an evidence gap, not as unavailability', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([UNRELATED_MEMO]),
      scope: scopeA1,
      text: 'cual fue el retorno social de la inversion en salud materna',
    })

    expect(run.classification).toBe('insufficient_evidence')
    expect(run.outcome.answer.abstention!.code).not.toBe('retrieval_unavailable')
    expect(run.outcome.retrieval).not.toBeNull()
  })

  it('reports a generator that rejects as provider_unavailable', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT]),
      scope: scopeA1,
      text: QUESTION,
      generator: {
        id: 'a-model-that-timed-out',
        draftAnswer() {
          return Promise.reject(new Error('upstream timeout'))
        },
      },
    })
    expect(run.classification).toBe('provider_unavailable')
    expect(run.provenance.generatorId).toBe('a-model-that-timed-out')
  })

  it('RETHROWS a scope violation raised by the generator instead of degrading it', async () => {
    await expect(
      runGroundedQuery({
        repository: repositoryFor([ANNUAL_REPORT]),
        scope: scopeA1,
        text: QUESTION,
        generator: {
          id: 'a-generator-with-a-composition-bug',
          draftAnswer() {
            return Promise.reject(new GroundingScopeViolationError(scopeA1, scopeA2, 'its own retrieval'))
          },
        },
      }),
    ).rejects.toThrow(GroundingScopeViolationError)
  })
})

// ---------------------------------------------------------------------------
// 4. Contradictions and the canonical vocabulary
// ---------------------------------------------------------------------------

describe('runGroundedQuery — classification', () => {
  it('classifies a declared contradiction as contradictory, attributed to both claims', async () => {
    const repository = repositoryFor([ANNUAL_REPORT, REGIONAL_SUMMARY])
    // The marker names chunks by the id ingestion derived — established by a
    // first run, exactly as a reviewer would after reading the answer.
    const scouting = await runGroundedQuery({ repository, scope: scopeA1, text: QUESTION })
    const sideA = scouting.outcome.retrieval!.candidates.find(
      (c) => c.chunk.evidenceId === ANNUAL_REPORT.evidenceId,
    )!.chunk.chunkId
    const sideB = scouting.outcome.retrieval!.candidates.find(
      (c) => c.chunk.evidenceId === REGIONAL_SUMMARY.evidenceId,
    )!.chunk.chunkId

    const run = await runGroundedQuery({
      repository,
      scope: scopeA1,
      text: QUESTION,
      extractive: {
        contradictions: [{ summary: 'Dos fuentes reportan tasas distintas.', sideAChunkId: sideA, sideBChunkId: sideB }],
      },
    })

    expect(run.classification).toBe('contradictory')
    const marker = run.outcome.answer.contradictions[0]
    expect(marker.resolution).toBe('requires_human_resolution')
    expect(marker.severity).toBe('warning')
    expect(marker.sideAClaim!.claimId).not.toBe(marker.sideBClaim!.claimId)
  })

  it('adds no vocabulary of its own — the result is the orchestration result', async () => {
    const run = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT]),
      scope: scopeA1,
      text: QUESTION,
    })
    // Exactly the orchestration shape plus provenance, and nothing else.
    expect(Object.keys(run).sort()).toEqual(['classification', 'outcome', 'provenance'])
    expect([
      'grounded',
      'partially_grounded',
      'contradictory',
      'insufficient_evidence',
      'abstention',
      'provider_unavailable',
    ]).toContain(run.classification)
  })
})

// ---------------------------------------------------------------------------
// 5. Determinism and zero simulated data
// ---------------------------------------------------------------------------

describe('runGroundedQuery — determinism and isolation from simulation', () => {
  it('produces an identical answer on repeated runs', async () => {
    const first = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT, AUDIT_NOTE, REGIONAL_SUMMARY, MUNICIPALITY_CSV]),
      scope: scopeA1,
      text: QUESTION,
    })
    const second = await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT, AUDIT_NOTE, REGIONAL_SUMMARY, MUNICIPALITY_CSV]),
      scope: scopeA1,
      text: QUESTION,
    })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('calls no network provider anywhere in the journey', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await runGroundedQuery({
      repository: repositoryFor([ANNUAL_REPORT, AUDIT_NOTE]),
      scope: scopeA1,
      text: QUESTION,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no runtime module under lib/grounding imports a test fixture or a database', () => {
    const root = path.join(__dirname, '..')
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry === '__tests__') continue
          walk(full)
          continue
        }
        if (!entry.endsWith('.ts')) continue
        const source = readFileSync(full, 'utf8')
        if (/from\s+['"][^'"]*__tests__/.test(source)) offenders.push(`${full}: imports a test fixture`)
        if (/from\s+['"](@\/db|drizzle-orm)/.test(source)) offenders.push(`${full}: imports the database layer`)
        if (/@\/supabase|createClient\s*\(/.test(source)) offenders.push(`${full}: reaches supabase`)
      }
    }
    walk(root)

    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------

function chunkTextFor(
  assertion: Parameters<typeof citationsOf>[0],
  retrieved: ReadonlyMap<string, GroundingChunk>,
): string {
  return citationsOf(assertion)
    .map((citation) => retrieved.get(citation.chunkId)?.text ?? '')
    .join('\n')
}
