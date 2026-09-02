// lib/grounding/__tests__/r6.test.ts
// GROUNDING line — R6: what `no_matching_evidence` actually covers (train 3).
//
// R6 (docs/ops/workstreams/GROUNDING.md, tren 2): the code is emitted for two
// materially different situations —
//
//   (a) NOTHING WAS THERE.      No indexed passage within scope matched at all.
//                               The user should upload something.
//   (b) SOMETHING WAS THERE.    Passages were retrieved and reached the answer
//                               stage, but no claim came to rest on one. The
//                               user's evidence may well cover the question;
//                               the ANSWER failed, not the corpus.
//
// Reading only the code, (b) looks like (a) — "your evidence contains nothing
// about this" — which is the wrong thing to tell a reviewer whose documents do
// contain it.
//
// PROVISIONAL DECISION (this train; not final, not claimed optimal):
//   KEEP ONE CODE. Do not widen AbstentionReasonCode.
//
//   The two situations are already distinguishable from data published on the
//   same object: within `no_matching_evidence`, `inspected.total === 0` is
//   exactly (a) and `inspected.total > 0` is exactly (b). The tests below pin
//   that partition down as a property, so it is a contract rather than an
//   accident of the current branch order.
//
//   Widening the union has a real cost and no demonstrated benefit: the union
//   is consumed outside this workstream (INTEGRATION-001 / the PRODUCT
//   citation adapter), so a new variant forces every consumer to handle a
//   distinction it can already make — and per the train's instruction, the
//   union is not widened without demonstrated need.
//
//   What the investigation DID demonstrate is a defect in the explanation, not
//   in the code: when a draft produced no claims at all, the abstention said
//   "No indexed passage within scope addresses the question" while
//   `inspected.total` said passages had been retrieved. Metadata and prose
//   disagreed, and prose is what a human reads. That is fixed in
//   grounded-answer.ts's `abstentionFor`, which is a string change, not a
//   contract change.
//
// If real use later shows consumers branching on the explanation text or on
// `inspected.total` to recover (a) vs (b), THAT is the demonstrated need, and
// the split becomes the right call. It is not demonstrated yet.

import { describe, it, expect } from 'vitest'
import type { AbstentionReason, AbstentionReasonCode } from '../contracts'
import {
  InMemoryChunkRepository,
  buildGroundedAnswer,
  enforceRepositoryScope,
  retrieveGroundedChunks,
} from '../retrieve'
import { chunkFixture, scopeA1 } from './fixtures'

const relevant = chunkFixture('El informe registra 120 beneficiarios del programa de agua.', {
  evidenceId: 'ev-1',
  chunkIndex: 0,
})

const retrieve = (chunks: readonly ReturnType<typeof chunkFixture>[], text: string) =>
  retrieveGroundedChunks(enforceRepositoryScope(new InMemoryChunkRepository(chunks)), scopeA1, text)

function abstentionOf(outcome: ReturnType<typeof buildGroundedAnswer>): AbstentionReason {
  if (outcome.answer.status !== 'abstained') {
    throw new Error(`expected an abstained answer, got ${outcome.answer.status}`)
  }
  return outcome.answer.abstention
}

// ---------------------------------------------------------------------------
// (a) nothing was there
// ---------------------------------------------------------------------------

describe('R6 (a) — zero candidates', () => {
  it('abstains with no_matching_evidence and an inspected total of zero', async () => {
    const retrieval = await retrieve([], 'beneficiarios de agua')
    const outcome = buildGroundedAnswer(retrieval, { claims: [] })
    const abstention = abstentionOf(outcome)

    expect(abstention.code).toBe('no_matching_evidence')
    expect(abstention.inspected.total).toBe(0)
    expect(retrieval.candidates).toHaveLength(0)
  })

  it('says the corpus does not address the question — which is true here', async () => {
    const retrieval = await retrieve([], 'beneficiarios de agua')
    const abstention = abstentionOf(buildGroundedAnswer(retrieval, { claims: [] }))
    expect(abstention.explanation).toMatch(/no indexed passage/i)
  })
})

// ---------------------------------------------------------------------------
// (b) something was there, nothing got grounded
// ---------------------------------------------------------------------------

describe('R6 (b) — candidates inspected, no claim grounded', () => {
  it('abstains with no_matching_evidence but a non-zero inspected total', async () => {
    const retrieval = await retrieve([relevant], 'beneficiarios de agua')
    // The claim cites a chunk that was never retrieved, so it is rejected and
    // nothing survives — but real, relevant passages WERE retrieved.
    const outcome = buildGroundedAnswer(retrieval, {
      claims: [
        { kind: 'evidence', statement: 'Cifra sin respaldo.', chunkIds: [chunkFixture('ajeno').chunkId] },
      ],
    })
    const abstention = abstentionOf(outcome)

    expect(abstention.code).toBe('no_matching_evidence')
    expect(abstention.inspected.total).toBeGreaterThan(0)
    expect(retrieval.candidates.length).toBeGreaterThan(0)
  })

  it('states that passages were retrieved, so the code is never read as "your evidence is empty"', async () => {
    const retrieval = await retrieve([relevant], 'beneficiarios de agua')
    const outcome = buildGroundedAnswer(retrieval, {
      claims: [
        { kind: 'evidence', statement: 'Cifra sin respaldo.', chunkIds: [chunkFixture('ajeno').chunkId] },
      ],
    })
    expect(abstentionOf(outcome).explanation).toMatch(/retrieved/i)
  })

  it('an EMPTY draft over retrieved passages must not claim the corpus is silent', async () => {
    // The defect R6 surfaced. A draft with zero claims used to fall through to
    // "No indexed passage within scope addresses the question" even though
    // inspected.total said otherwise — prose contradicting metadata, and prose
    // is what the human reads.
    const retrieval = await retrieve([relevant], 'beneficiarios de agua')
    expect(retrieval.candidates.length).toBeGreaterThan(0)

    const abstention = abstentionOf(buildGroundedAnswer(retrieval, { claims: [] }))
    expect(abstention.inspected.total).toBeGreaterThan(0)
    expect(abstention.explanation).not.toMatch(/no indexed passage/i)
    expect(abstention.explanation).toMatch(/retrieved/i)
  })
})

// ---------------------------------------------------------------------------
// The decision itself, pinned down
// ---------------------------------------------------------------------------

describe('R6 — the single code stays discriminable without widening the union', () => {
  it('inspected.total partitions (a) from (b) within one code', async () => {
    const nothingThere = abstentionOf(
      buildGroundedAnswer(await retrieve([], 'beneficiarios de agua'), { claims: [] }),
    )
    const somethingThere = abstentionOf(
      buildGroundedAnswer(await retrieve([relevant], 'beneficiarios de agua'), { claims: [] }),
    )

    expect(nothingThere.code).toBe(somethingThere.code)
    expect(nothingThere.inspected.total).toBe(0)
    expect(somethingThere.inspected.total).toBeGreaterThan(0)
    // Same code, different situation, and the difference is machine-readable
    // without any consumer parsing prose.
    expect(nothingThere.explanation).not.toBe(somethingThere.explanation)
  })

  it('AbstentionReasonCode was NOT widened by this train', () => {
    // A compile-time census. If a code is ever added or removed, this
    // exhaustive map stops type-checking, which is the signal to revisit the
    // R6 decision deliberately rather than discover the change in a diff.
    const census: Record<AbstentionReasonCode, true> = {
      no_matching_evidence: true,
      below_relevance_threshold: true,
      out_of_scope: true,
      evidence_unreadable: true,
      contradictory_evidence: true,
      content_quarantined: true,
      retrieval_unavailable: true,
    }
    expect(Object.keys(census)).toHaveLength(7)
  })

  it('keeps below_relevance_threshold distinct — "irrelevant" is not "absent"', async () => {
    // The neighbouring distinction R6 must not blur: passages that matched but
    // scored too low already have their own code, and it is not this one.
    const retrieval = await retrieveGroundedChunks(
      enforceRepositoryScope(new InMemoryChunkRepository([relevant])),
      scopeA1,
      'beneficiarios de agua',
      { minScore: 0.99 },
    )
    const abstention = abstentionOf(buildGroundedAnswer(retrieval, { claims: [] }))

    expect(abstention.code).toBe('below_relevance_threshold')
    expect(abstention.inspected.belowThreshold).toBeGreaterThan(0)
  })
})
