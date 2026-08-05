// lib/grounding/__tests__/extractive-generator.test.ts
// GROUNDING line — the local extractive generator (grounding train 4).
//
// Every case runs the generator over chunks a REAL ingestion produced from a
// REAL document (see ./corpus.ts). None of them hands it a pre-built retrieval
// result, because the property under test — that the answer is a slice of the
// evidence — is only meaningful when the evidence came from somewhere.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ContentHash } from '../contracts'
import {
  EXTRACTIVE_GENERATOR_ID,
  EXTRACTIVE_GENERATOR_VERSION,
  EXTRACTIVE_QUOTE_CLOSE,
  EXTRACTIVE_QUOTE_OPEN,
  InMemoryChunkRepository,
  buildGroundedAnswer,
  createExtractiveAnswerProvider,
  draftExtractiveAnswer,
  retrieveGroundedChunks,
  unwrapExtractiveStatement,
  type ScopedRetrievalResult,
} from '../retrieve'
import { citationsOf } from '../contracts'
import { ANNUAL_REPORT, AUDIT_NOTE, MUNICIPALITY_CSV, REGIONAL_SUMMARY, UNRELATED_MEMO, chunksOf } from './corpus'
import { scopeA1 } from './fixtures'

// ---------------------------------------------------------------------------
// Harness — retrieval is run for real, then the generator is run for real
// ---------------------------------------------------------------------------

async function retrieve(
  documents: Parameters<typeof chunksOf>[0],
  question: string,
): Promise<ScopedRetrievalResult> {
  const repository = new InMemoryChunkRepository(chunksOf(documents, scopeA1))
  return retrieveGroundedChunks(repository, scopeA1, question)
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Identity
// ---------------------------------------------------------------------------

describe('identity', () => {
  it('publishes a name and a version, and the id carries both', () => {
    expect(EXTRACTIVE_GENERATOR_ID).toBe(`grounding-local-extractive/${EXTRACTIVE_GENERATOR_VERSION}`)
    expect(createExtractiveAnswerProvider().id).toBe(EXTRACTIVE_GENERATOR_ID)
  })
})

// ---------------------------------------------------------------------------
// 2. The invariant — every statement is a verbatim slice of a cited chunk
// ---------------------------------------------------------------------------

describe('the extraction invariant', () => {
  it('answers a single-source question by quoting it verbatim', async () => {
    const retrieval = await retrieve([ANNUAL_REPORT], 'cuantos beneficiarios atendio el programa')
    const draft = draftExtractiveAnswer({ scope: scopeA1, text: 'cuantos beneficiarios atendio el programa', retrieval })

    expect(draft.claims.length).toBeGreaterThan(0)
    expect(draft.claims.every((claim) => claim.kind === 'evidence')).toBe(true)

    const outcome = buildGroundedAnswer(retrieval, draft)
    expect(outcome.kind === 'sufficient_evidence' || outcome.kind === 'partial_evidence').toBe(true)
    expect(outcome.answer.status).not.toBe('abstained')
    expect(outcome.issues).toEqual([])

    const quoted = outcome.answer.assertions!.map((a) => unwrapExtractiveStatement(a.statement))
    expect(quoted.join(' ')).toContain('1.240 beneficiarios')
  })

  it('every statement, unquoted, is an exact substring of a chunk it cites', async () => {
    const question = 'tasa de retencion escolar de los beneficiarios'
    const retrieval = await retrieve([ANNUAL_REPORT, AUDIT_NOTE, MUNICIPALITY_CSV], question)
    const draft = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval })
    const outcome = buildGroundedAnswer(retrieval, draft)

    const byId = new Map(retrieval.candidates.map((c) => [c.chunk.chunkId, c.chunk]))
    const assertions = outcome.answer.status === 'abstained' ? [] : outcome.answer.assertions
    expect(assertions.length).toBeGreaterThan(0)

    for (const assertion of assertions) {
      const passage = unwrapExtractiveStatement(assertion.statement)
      // Wrapped, so a reader is never shown extracted text as Stella's prose.
      expect(assertion.statement.startsWith(EXTRACTIVE_QUOTE_OPEN)).toBe(true)
      expect(assertion.statement.endsWith(EXTRACTIVE_QUOTE_CLOSE)).toBe(true)
      // And verbatim: this is what makes invented causality, arithmetic and
      // certification structurally unreachable — there is nowhere to write them.
      const cited = citationsOf(assertion).map((citation) => byId.get(citation.chunkId)!)
      expect(cited.length).toBeGreaterThan(0)
      expect(cited.some((chunk) => chunk.text.includes(passage))).toBe(true)
    }
  })

  it('quotes a CSV row, where the line and not a full stop is the sentence', async () => {
    const question = 'beneficiarios en Medellin'
    const retrieval = await retrieve([MUNICIPALITY_CSV], question)
    const draft = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval })

    const statements = draft.claims.map((claim) => unwrapExtractiveStatement(claim.statement))
    expect(statements.some((statement) => statement.includes('Medellin,380,0.76'))).toBe(true)
    // The whole file was not dumped as one quotation.
    expect(statements.every((statement) => !statement.includes('Bogota,540'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Several sources
// ---------------------------------------------------------------------------

describe('several sources', () => {
  it('collapses two sources stating the same sentence into one corroborated claim', async () => {
    const question = 'tasa de retencion escolar de los beneficiarios'
    const retrieval = await retrieve([ANNUAL_REPORT, AUDIT_NOTE], question)
    const draft = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval })
    const outcome = buildGroundedAnswer(retrieval, draft)

    const assertions = outcome.answer.status === 'abstained' ? [] : outcome.answer.assertions
    const corroborated = assertions.filter((assertion) => citationsOf(assertion).length > 1)
    expect(corroborated.length).toBeGreaterThan(0)

    // Corroboration means DISTINCT evidence items, not the same document twice.
    const sources = new Set(corroborated.flatMap((a) => citationsOf(a).map((c) => c.evidenceId)))
    expect(sources.size).toBeGreaterThan(1)
  })

  it('keeps two sources that say different things as separate claims', async () => {
    const question = 'tasa de retencion escolar'
    const retrieval = await retrieve([ANNUAL_REPORT, REGIONAL_SUMMARY], question)
    const draft = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval })

    const statements = draft.claims.map((claim) => unwrapExtractiveStatement(claim.statement))
    expect(statements.some((s) => s.includes('78 por ciento'))).toBe(true)
    expect(statements.some((s) => s.includes('62 por ciento'))).toBe(true)
    // And it says nothing about the two figures disagreeing — that judgement is
    // not this generator's to make.
    expect(draft.contradictions ?? []).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Contradictions come only from markers
// ---------------------------------------------------------------------------

describe('contradictions', () => {
  it('never infers one from two passages stating different figures', async () => {
    const question = 'tasa de retencion escolar'
    const retrieval = await retrieve([ANNUAL_REPORT, REGIONAL_SUMMARY], question)
    const outcome = buildGroundedAnswer(retrieval, draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval }))

    expect(outcome.answer.contradictions).toEqual([])
    expect(outcome.kind).not.toBe('contradictory_evidence')
  })

  it('carries a declared marker through, attributed to the claims that quoted each side', async () => {
    const question = 'tasa de retencion escolar'
    const retrieval = await retrieve([ANNUAL_REPORT, REGIONAL_SUMMARY], question)

    const sideA = retrieval.candidates.find((c) => c.chunk.evidenceId === ANNUAL_REPORT.evidenceId)!
    const sideB = retrieval.candidates.find((c) => c.chunk.evidenceId === REGIONAL_SUMMARY.evidenceId)!

    const draft = draftExtractiveAnswer(
      { scope: scopeA1, text: question, retrieval },
      {
        contradictions: [
          {
            summary: 'Dos fuentes reportan tasas de retencion distintas para el mismo periodo.',
            sideAChunkId: sideA.chunk.chunkId,
            sideBChunkId: sideB.chunk.chunkId,
          },
        ],
      },
    )
    const outcome = buildGroundedAnswer(retrieval, draft)

    expect(outcome.kind).toBe('contradictory_evidence')
    const marker = outcome.answer.contradictions[0]
    expect(marker.resolution).toBe('requires_human_resolution')
    expect(marker.sideAClaim?.claimId).toBeDefined()
    expect(marker.sideBClaim?.claimId).toBeDefined()
    expect(marker.sideAClaim!.claimId).not.toBe(marker.sideBClaim!.claimId)
    // The fingerprint is derived inside buildGroundedAnswer, never transported.
    expect(marker.sideAClaim!.assertionHash).not.toBe(marker.sideBClaim!.assertionHash)
    expect(marker.sideAClaim!.assertionHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a marker naming a chunk that was not retrieved is rejected, not half-emitted', async () => {
    const question = 'tasa de retencion escolar'
    const retrieval = await retrieve([ANNUAL_REPORT], question)
    const present = retrieval.candidates[0].chunk.chunkId
    const absent = 'f'.repeat(64) as ContentHash

    const draft = draftExtractiveAnswer(
      { scope: scopeA1, text: question, retrieval },
      { contradictions: [{ summary: 'Conflicto declarado', sideAChunkId: present, sideBChunkId: absent }] },
    )
    const outcome = buildGroundedAnswer(retrieval, draft)

    expect(outcome.answer.contradictions).toEqual([])
    expect(outcome.rejectedContradictions).toHaveLength(1)
    expect(outcome.rejectedContradictions[0].detail).toContain(absent)
  })
})

// ---------------------------------------------------------------------------
// 5. Abstention — an evidence gap is not a provider failure
// ---------------------------------------------------------------------------

describe('abstention', () => {
  it('returns zero claims rather than throwing when nothing states the question', async () => {
    const question = 'cual fue el retorno social de la inversion en salud materna'
    const retrieval = await retrieve([UNRELATED_MEMO], question)

    const draft = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval })
    expect(draft.claims).toEqual([])

    const outcome = buildGroundedAnswer(retrieval, draft)
    expect(outcome.kind).toBe('insufficient_evidence')
    expect(outcome.answer.status).toBe('abstained')
    // The memo shares only stopword-ish tokens, so retrieval itself rejects
    // every passage before the generator sees one. That is the more precise of
    // the two evidence-gap codes and it must not be flattened into the other.
    expect(outcome.answer.abstention!.code).toBe('below_relevance_threshold')
    // Never `retrieval_unavailable`: the system worked and the corpus was
    // silent, and those two facts lead to different conversations.
    expect(outcome.answer.abstention!.code).not.toBe('retrieval_unavailable')
    expect(outcome.retrieval).not.toBeNull()
  })

  it('distinguishes "passages were retrieved and none got grounded" inside R6', async () => {
    // Retrieval DOES return passages here; the generator's own term floor is
    // what rejects them. That is the second situation `no_matching_evidence`
    // covers, and `inspected.total > 0` is what tells the two apart without
    // widening a union other workstreams consume.
    const question = 'tasa de retencion escolar de los beneficiarios'
    const retrieval = await retrieve([ANNUAL_REPORT], question)
    expect(retrieval.candidates.length).toBeGreaterThan(0)

    const draft = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval }, { minTermMatches: 99 })
    expect(draft.claims).toEqual([])

    const outcome = buildGroundedAnswer(retrieval, draft)
    expect(outcome.answer.abstention!.code).toBe('no_matching_evidence')
    expect(outcome.answer.abstention!.inspected.total).toBeGreaterThan(0)
    expect(outcome.answer.abstention!.explanation).toContain('passage(s) were retrieved')
  })

  it('never computes a figure the documents do not state', async () => {
    const question = 'cual es el promedio de retencion entre los municipios'
    const retrieval = await retrieve([MUNICIPALITY_CSV], question)
    const draft = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval })

    const statements = draft.claims.map((claim) => unwrapExtractiveStatement(claim.statement))
    // 0.77 is the average of 0.81, 0.76 and 0.74. It appears in no document,
    // so it cannot appear in an answer whose every word is a slice of one.
    expect(statements.join(' ')).not.toContain('0.77')
    const chunkText = chunksOf([MUNICIPALITY_CSV], scopeA1).map((c) => c.text).join('\n')
    for (const statement of statements) expect(chunkText).toContain(statement)
  })

  it('states what it left out only when something really was left out', async () => {
    const focused = await retrieve([ANNUAL_REPORT], 'beneficiarios')
    const focusedDraft = draftExtractiveAnswer({ scope: scopeA1, text: 'beneficiarios', retrieval: focused })
    const unquotable = focused.candidates.length - focusedDraft.claims.reduce((n, c) => n + c.chunkIds.length, 0)
    expect(focusedDraft.unanswered === null).toBe(unquotable === 0)
  })
})

// ---------------------------------------------------------------------------
// 6. Determinism, and no provider
// ---------------------------------------------------------------------------

describe('determinism and isolation', () => {
  it('produces byte-identical drafts across runs', async () => {
    const question = 'tasa de retencion escolar de los beneficiarios'
    const first = await retrieve([ANNUAL_REPORT, AUDIT_NOTE, REGIONAL_SUMMARY], question)
    const second = await retrieve([ANNUAL_REPORT, AUDIT_NOTE, REGIONAL_SUMMARY], question)

    const a = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval: first })
    const b = draftExtractiveAnswer({ scope: scopeA1, text: question, retrieval: second })
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('calls no network provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const question = 'beneficiarios atendidos'
    const retrieval = await retrieve([ANNUAL_REPORT, AUDIT_NOTE], question)
    await createExtractiveAnswerProvider().draftAnswer({ scope: scopeA1, text: question, retrieval })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reaches no provider, no database and no fixture from its source', () => {
    const source = readFileSync(path.join(__dirname, '..', 'retrieve', 'extractive-generator.ts'), 'utf8')
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/from\s+['"]@\/db/)
    expect(source).not.toMatch(/gemini|openai|anthropic/i)
    // A runtime module importing a test fixture would be simulated data.
    expect(source).not.toMatch(/__tests__/)
    expect(source).not.toMatch(/\bDate\.now\b|\bMath\.random\b/)
  })
})

// ---------------------------------------------------------------------------
// 7. Scope
// ---------------------------------------------------------------------------

describe('scope', () => {
  it('throws when the retrieval it is handed was run under a different scope', async () => {
    const retrieval = await retrieve([ANNUAL_REPORT], 'beneficiarios')
    expect(() =>
      draftExtractiveAnswer({
        scope: { organizationId: 'org-other', projectId: 'proj-1111' },
        text: 'beneficiarios',
        retrieval,
      }),
    ).toThrow(/Grounding scope violation/)
  })
})
