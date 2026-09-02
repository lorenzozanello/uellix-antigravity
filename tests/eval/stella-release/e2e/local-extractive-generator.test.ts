// tests/eval/stella-release/e2e/local-extractive-generator.test.ts
// RELEASE line — Train 4. Offline tests for the local, provider-free
// extractive generator. No DB, no docker, no network — this file is part of
// the "focused harness tests" this train is allowed to run (Fase 7).

import { describe, expect, it } from 'vitest'
import { buildRetrievalQuery, hashContent, validateAnswerCitations, type CitableChunkRecord, type ContentHash } from '@/lib/grounding/contracts'
import { generateExtractiveAnswer, type RetrievedChunkForGeneration } from './local-extractive-generator'

const SCOPE = { organizationId: 'org-e2e-1', projectId: 'project-e2e-1' }
const QUERY = buildRetrievalQuery(SCOPE, 'How many saplings were planted?')

function chunk(overrides: Partial<RetrievedChunkForGeneration> & { text: string; evidenceId: string }): RetrievedChunkForGeneration {
  const { text, evidenceId, ...rest } = overrides
  const contentHash = hashContent(text) as ContentHash
  return {
    chunkId: hashContent(`chunk/${evidenceId}/${text}`) as ContentHash,
    evidenceId,
    versionId: hashContent(`version/${evidenceId}`) as ContentHash,
    scope: SCOPE,
    text,
    contentHash,
    location: {
      span: { unit: 'normalized-char', start: 0, end: text.length },
      coordinateSpace: hashContent(text) as ContentHash,
      page: null,
      sectionIndex: null,
      sectionLabel: null,
      lineStart: 0,
      lineEnd: 0,
    },
    ...rest,
  }
}

function asCitable(entries: readonly RetrievedChunkForGeneration[]): ReadonlyMap<ContentHash, CitableChunkRecord> {
  return new Map(entries.map((c) => [c.chunkId, { chunkId: c.chunkId, contentHash: c.contentHash, scope: c.scope, evidenceId: c.evidenceId, versionId: c.versionId, location: c.location }]))
}

describe('generateExtractiveAnswer — no LLM, no provider, pure pattern extraction over retrieved text', () => {
  it('abstains with no_matching_evidence when retrieval returned nothing', () => {
    const result = generateExtractiveAnswer(QUERY, [])
    expect(result.answer.status).toBe('abstained')
    expect(result.answer.status === 'abstained' && result.answer.abstention.code).toBe('no_matching_evidence')
    expect(result.usedChunkIds).toEqual([])
  })

  it('abstains with below_relevance_threshold when retrieved chunks do not contain the claim pattern', () => {
    const irrelevant = chunk({ evidenceId: 'ev-x', text: 'The weather in March was mild and dry.' })
    const result = generateExtractiveAnswer(QUERY, [irrelevant])
    expect(result.answer.status).toBe('abstained')
    expect(result.answer.status === 'abstained' && result.answer.abstention.code).toBe('below_relevance_threshold')
    expect(result.usedChunkIds).toEqual([])
  })

  it('produces a grounded, single-citation answer when exactly one chunk carries the claim', () => {
    const a = chunk({ evidenceId: 'ev-a', text: 'The project planted 1,240 native tree saplings in Q1.' })
    const result = generateExtractiveAnswer(QUERY, [a])
    expect(result.answer.status).toBe('grounded')
    if (result.answer.status !== 'grounded') throw new Error('unreachable')
    expect(result.answer.assertions).toHaveLength(1)
    const [assertion] = result.answer.assertions
    if (assertion.kind !== 'evidence') throw new Error('expected an evidence assertion')
    expect(assertion.statement).toMatch(/1,240/)
    expect(assertion.citations[0].chunkId).toBe(a.chunkId)
    // The citation's quotedTextHash MUST equal the chunk's own persisted
    // content hash — never a hash of a paraphrase the generator invented.
    expect(assertion.citations[0].quotedTextHash).toBe(a.contentHash)
    expect(result.usedChunkIds).toEqual([a.chunkId])

    const issues = validateAnswerCitations(result.answer, asCitable([a]))
    expect(issues).toEqual([])
  })

  it('does NOT report a contradiction when two sources agree on the same number', () => {
    const a = chunk({ evidenceId: 'ev-a', text: 'Field crews planted 1,240 native tree saplings this quarter.' })
    const b = chunk({ evidenceId: 'ev-b', text: 'Verifier confirms 1,240 native tree saplings were planted.' })
    const result = generateExtractiveAnswer(QUERY, [a, b])
    expect(result.answer.status).toBe('grounded')
    expect(result.answer.contradictions).toEqual([])
  })

  it('attributes a contradiction, with both sides independently citable, when two sources disagree', () => {
    const a = chunk({ evidenceId: 'ev-a', text: 'The team planted 1,240 native tree saplings across the eastern parcel.' })
    const b = chunk({ evidenceId: 'ev-b', text: 'Site visit records count 1,180 native tree saplings planted in the same period.' })
    const result = generateExtractiveAnswer(QUERY, [a, b])

    expect(result.answer.status).toBe('partially_grounded')
    expect(result.answer.contradictions).toHaveLength(1)
    const [marker] = result.answer.contradictions
    expect(marker.resolution).toBe('requires_human_resolution')
    expect(marker.sideA[0].chunkId).toBe(a.chunkId)
    expect(marker.sideB[0].chunkId).toBe(b.chunkId)
    // Each side's attribution names WHICH claim said it (assertionHash), not
    // merely which chunk — the claim text is hashed, never stored raw.
    expect(marker.sideAClaim?.assertionHash).toBe(hashContent('1,240 native tree saplings'))
    expect(marker.sideBClaim?.assertionHash).toBe(hashContent('1,180 native tree saplings'))
    expect(result.usedChunkIds).toEqual([a.chunkId, b.chunkId])

    // The real validator — not a stand-in — sees a citable set and a
    // fabricated set differently.
    expect(validateAnswerCitations(result.answer, asCitable([a, b]))).toEqual([])
    const brokenIssues = validateAnswerCitations(result.answer, asCitable([a]))
    expect(brokenIssues.length).toBeGreaterThan(0)
    expect(brokenIssues.some((issue) => issue.code === 'citation_without_source')).toBe(true)
  })
})
