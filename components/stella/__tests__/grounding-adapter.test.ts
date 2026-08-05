// components/stella/__tests__/grounding-adapter.test.ts
// PRODUCT TRAIN 2 — the pure GROUNDING → presentation adapter (INTEGRATION-001).
//
// These tests exist to hold seven rules that no type can hold on its own, and
// one of them (§7) was explicitly assigned to this train by the train-1
// adversarial review (A-F3): `contradictory_evidence` must be unreachable
// without a real ContradictionMarker. The last two tests in this file are the
// ones that make that a checked invariant instead of a documented convention.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { hashContent, textSpan } from '@/lib/grounding/contracts'
import type {
  ChunkLocation,
  CitationReference,
  ContentHash,
  ContradictionMarker,
  GroundedAnswerState,
  GroundingChunk,
  RetrievalCandidate,
  RetrievalQuery,
  AbstainedAnswerState,
  AbstentionReason,
} from '@/lib/grounding/contracts'
import {
  CITATION_EXCERPT_MAX_LENGTH,
  RELEVANCE_HIGH_MIN_SCORE,
  RELEVANCE_MEDIUM_MIN_SCORE,
  RELEVANCE_THRESHOLDS_VERSION,
  GroundedCitationError,
  adaptCitation,
  adaptGroundedAnswer,
  formatChunkLocation,
  relevanceBucket,
} from '../grounding-adapter'

// ---------------------------------------------------------------------------
// Fixtures — built from the real contract helpers, never from cast strings, so
// a hash in a fixture is a hash of the text the fixture claims it is.
// ---------------------------------------------------------------------------

const ORGANIZATION_ID = 'org-1'
const NORMALIZED_TEXT = 'Línea uno.\nLínea dos.\nLínea tres del informe de impacto.\n'
const COORDINATE_SPACE = hashContent(NORMALIZED_TEXT)

function makeLocation(overrides: Partial<ChunkLocation> = {}): ChunkLocation {
  return {
    span: textSpan(12, 48),
    coordinateSpace: COORDINATE_SPACE,
    page: 4,
    sectionIndex: 2,
    sectionLabel: 'Metodología',
    lineStart: 12,
    lineEnd: 18,
    ...overrides,
  }
}

function makeChunk(
  text: string,
  overrides: Partial<Omit<GroundingChunk, 'contentHash'>> = {},
): GroundingChunk {
  const contentHash = hashContent(text)
  const versionId = (overrides.versionId ?? hashContent('version-1')) as ContentHash
  const chunkId = (overrides.chunkId ?? hashContent(`chunk-of:${text}`)) as ContentHash
  return {
    chunkId,
    scope: { organizationId: ORGANIZATION_ID, projectId: 'proj-1' },
    evidenceId: 'ev-1',
    versionId,
    chunkIndex: 3,
    text,
    contentHash,
    location: makeLocation(),
    provenance: {
      evidenceId: 'ev-1',
      scope: { organizationId: ORGANIZATION_ID, projectId: 'proj-1' },
      versionId,
      rawContentHash: hashContent('raw bytes'),
      normalizedContentHash: COORDINATE_SPACE,
      normalizationVersion: 'norm-1',
      chunkerVersion: 'chunk-1',
      injectionScannerVersion: 'inj-1',
      sourceLabel: 'informe-2025.pdf',
      mimeType: 'application/pdf',
    },
    signals: [],
    ...overrides,
  }
}

function citationFor(chunk: GroundingChunk): CitationReference {
  return {
    chunkId: chunk.chunkId,
    evidenceId: chunk.evidenceId,
    versionId: chunk.versionId,
    location: chunk.location,
    quotedTextHash: chunk.contentHash,
  }
}

function candidateFor(chunk: GroundingChunk, score: number, rank = 0): RetrievalCandidate {
  return { chunk, score, rank, strategy: 'hybrid', untrusted: true }
}

function inputFor(
  chunks: readonly GroundingChunk[],
  candidates: readonly RetrievalCandidate[] = [],
) {
  return {
    chunks: new Map(chunks.map((c) => [c.chunkId as string, c])),
    candidates: new Map(candidates.map((c) => [c.chunk.chunkId as string, c])),
  }
}

const QUERY: RetrievalQuery = {
  scope: { organizationId: ORGANIZATION_ID, projectId: 'proj-1' },
  text: '¿Cuántos beneficiarios reporta el informe?',
  topK: 8,
  minScore: 0.15,
  evidenceIds: [],
  quarantineAtOrAbove: 'critical',
}

function abstention(overrides: Partial<AbstentionReason> = {}): AbstentionReason {
  return {
    code: 'no_matching_evidence',
    explanation: 'No hay evidencia cargada que responda a esta pregunta.',
    query: QUERY,
    inspected: { total: 0, belowThreshold: 0, quarantined: 0 },
    ...overrides,
  }
}

function groundedAnswer(overrides: Partial<GroundedAnswerState> = {}): GroundedAnswerState {
  const chunk = makeChunk('El informe registra 1.240 beneficiarios directos en 2025.')
  return {
    status: 'grounded',
    query: QUERY,
    assertions: [
      {
        kind: 'evidence',
        statement: 'El proyecto reporta 1.240 beneficiarios directos.',
        citations: [citationFor(chunk)],
      },
    ],
    abstention: null,
    contradictions: [],
    signals: [],
    requiresHumanReview: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Rule 3 — the adapter is pure
// ---------------------------------------------------------------------------

/**
 * One whole `import … from '@/lib/grounding…'` statement, multi-line allowed.
 * The negative lookahead stops the match from swallowing the imports that
 * precede it — without it the expression reports the FIRST import in the file
 * as the offender, whatever it happens to be.
 */
const GROUNDING_IMPORT_RE = /^import\b(?:(?!^import\b)[\s\S])*?from '@\/lib\/grounding[^']*'/gm

describe('grounding-adapter — purity (INTEGRATION-001 §3)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'components/stella/grounding-adapter.ts'),
    'utf8',
  )

  it('imports the canonical contracts as TYPES only, so nothing from lib/grounding reaches the client bundle', () => {
    const groundingImports = source.match(GROUNDING_IMPORT_RE) ?? []
    expect(groundingImports.length).toBeGreaterThan(0)
    for (const statement of groundingImports) {
      expect(statement.startsWith('import type')).toBe(true)
    }
  })

  it('never reaches into the grounding implementation, only the published barrel', () => {
    expect(source).not.toMatch(/from '@\/lib\/grounding\/ingest/)
    expect(source).not.toMatch(/from '@\/lib\/grounding\/contracts\//)
  })

  it('does no I/O: no fetch, no database, no server action', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/@\/db\//)
    expect(source).not.toMatch(/'use server'/)
  })

  it('holds for EVERY Stella component, not just this module', () => {
    // The adapter being type-only is worth nothing if a panel next to it
    // imports the barrel as a value: `lib/grounding/contracts/core.ts` calls
    // `node:crypto` at module scope, so one runtime import puts Node crypto in
    // the client bundle of every page that mounts a Stella panel. This scan is
    // what makes that a build-breaking mistake instead of a runtime surprise.
    const dir = path.join(process.cwd(), 'components/stella')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    expect(files.length).toBeGreaterThan(5)

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8')
      for (const statement of text.match(GROUNDING_IMPORT_RE) ?? []) {
        if (!statement.startsWith('import type')) offenders.push(`${file}: ${statement}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Rules 4 & 5 — excerpt and location
// ---------------------------------------------------------------------------

describe('adaptCitation — full adaptation', () => {
  it('carries every verifiable identifier through unchanged', () => {
    const chunk = makeChunk('El informe registra 1.240 beneficiarios directos en 2025.')
    const view = adaptCitation(citationFor(chunk), inputFor([chunk]))

    expect(view.chunkId).toBe(chunk.chunkId)
    expect(view.evidenceId).toBe('ev-1')
    expect(view.versionId).toBe(chunk.versionId)
    expect(view.quotedTextHash).toBe(chunk.contentHash)
    expect(view.availability).toBe('passage_loaded')
    expect(view.sourceLabel).toBe('informe-2025.pdf')
  })

  it('derives the excerpt from GroundingChunk.text (rule 4), not from the citation', () => {
    const text = 'El informe registra 1.240 beneficiarios directos en 2025.'
    const chunk = makeChunk(text)
    const view = adaptCitation(citationFor(chunk), inputFor([chunk]))

    expect(view.excerpt).not.toBeNull()
    expect(view.excerpt?.text).toBe(text)
    expect(view.excerpt?.truncated).toBe(false)
    expect(view.excerpt?.fullLength).toBe(text.length)
  })

  it('truncates a long excerpt for display WITHOUT changing the hash it is verified against', () => {
    const text = 'a'.repeat(CITATION_EXCERPT_MAX_LENGTH + 50)
    const chunk = makeChunk(text)
    const view = adaptCitation(citationFor(chunk), inputFor([chunk]))

    expect(view.excerpt?.truncated).toBe(true)
    expect(view.excerpt?.text.length).toBeLessThanOrEqual(CITATION_EXCERPT_MAX_LENGTH + 1)
    expect(view.excerpt?.fullLength).toBe(text.length)
    // The hash is still the hash of the FULL chunk text — truncation is a UI
    // decision and must not become a second answer to "what does the doc say".
    expect(view.quotedTextHash).toBe(hashContent(text))
  })

  it('keeps the structured location (rule 5): the human string never replaces span or coordinateSpace', () => {
    const chunk = makeChunk('Texto citado.')
    const view = adaptCitation(citationFor(chunk), inputFor([chunk]))

    expect(view.location.span).toEqual(textSpan(12, 48))
    expect(view.location.coordinateSpace).toBe(COORDINATE_SPACE)
    expect(view.location.page).toBe(4)
    expect(view.location.sectionIndex).toBe(2)
    expect(view.location.sectionLabel).toBe('Metodología')
    expect(view.location.lineStart).toBe(12)
    expect(view.location.lineEnd).toBe(18)
    expect(view.location.label).toContain('p. 4')
  })
})

describe('formatChunkLocation', () => {
  it('renders page, section and line range for humans', () => {
    expect(formatChunkLocation(makeLocation())).toBe('p. 4 · Metodología · líneas 12–18')
  })

  it('falls back to a 1-based section number when the section has no label', () => {
    expect(formatChunkLocation(makeLocation({ sectionLabel: null }))).toBe(
      'p. 4 · sección 3 · líneas 12–18',
    )
  })

  it('omits pagination for sources that do not paginate', () => {
    expect(
      formatChunkLocation(makeLocation({ page: null, sectionIndex: null, sectionLabel: null })),
    ).toBe('líneas 12–18')
  })

  it('renders a single line as a singular', () => {
    expect(
      formatChunkLocation(
        makeLocation({ page: null, sectionIndex: null, sectionLabel: null, lineStart: 7, lineEnd: 7 }),
      ),
    ).toBe('línea 7')
  })
})

// ---------------------------------------------------------------------------
// Rule 6 — relevance buckets derived from the score, never replacing it
// ---------------------------------------------------------------------------

describe('relevance (INTEGRATION-001 §6)', () => {
  it('keeps the numeric score, the strategy, the rank and the thresholds version alongside the bucket', () => {
    const chunk = makeChunk('Texto citado.')
    const view = adaptCitation(citationFor(chunk), inputFor([chunk], [candidateFor(chunk, 0.42, 2)]))

    expect(view.relevance).not.toBeNull()
    expect(view.relevance?.score).toBe(0.42)
    expect(view.relevance?.strategy).toBe('hybrid')
    expect(view.relevance?.rank).toBe(2)
    expect(view.relevance?.bucket).toBe('medium')
    expect(view.relevance?.thresholdsVersion).toBe(RELEVANCE_THRESHOLDS_VERSION)
  })

  it('reports no relevance at all when there is no candidate, rather than guessing one', () => {
    const chunk = makeChunk('Texto citado.')
    const view = adaptCitation(citationFor(chunk), inputFor([chunk]))
    expect(view.relevance).toBeNull()
  })

  it('buckets scores by the named thresholds', () => {
    expect(relevanceBucket(0.95)).toBe('high')
    expect(relevanceBucket(0.5)).toBe('medium')
    expect(relevanceBucket(0.2)).toBe('low')
  })

  it('places the exact threshold values in the HIGHER bucket (boundary is inclusive)', () => {
    expect(relevanceBucket(RELEVANCE_HIGH_MIN_SCORE)).toBe('high')
    expect(relevanceBucket(RELEVANCE_MEDIUM_MIN_SCORE)).toBe('medium')
  })

  it('drops to the lower bucket just below each threshold', () => {
    expect(relevanceBucket(RELEVANCE_HIGH_MIN_SCORE - Number.EPSILON)).toBe('medium')
    expect(relevanceBucket(RELEVANCE_MEDIUM_MIN_SCORE - Number.EPSILON)).toBe('low')
  })

  it('never invents a bucket for a non-finite score', () => {
    expect(() => relevanceBucket(Number.NaN)).toThrow(/finito/i)
  })
})

// ---------------------------------------------------------------------------
// Rule 4 corollary + invalid citations
// ---------------------------------------------------------------------------

describe('adaptCitation — missing and invalid sources', () => {
  it('represents a citation whose chunk was not loaded as verifiable-without-passage, never as invented text', () => {
    const chunk = makeChunk('Texto que nunca se cargó.')
    const view = adaptCitation(citationFor(chunk), inputFor([]))

    expect(view.availability).toBe('source_unavailable')
    expect(view.excerpt).toBeNull()
    expect(view.sourceLabel).toBeNull()
    // Still verifiable: the hashes and the structured location survive.
    expect(view.quotedTextHash).toBe(chunk.contentHash)
    expect(view.location.coordinateSpace).toBe(COORDINATE_SPACE)
  })

  it('refuses a citation whose quotedTextHash does not match the chunk it points at', () => {
    const chunk = makeChunk('El informe registra 1.240 beneficiarios.')
    const drifted: CitationReference = {
      ...citationFor(chunk),
      quotedTextHash: hashContent('El informe registra 2.480 beneficiarios.'),
    }

    expect(() => adaptCitation(drifted, inputFor([chunk]))).toThrow(GroundedCitationError)
    try {
      adaptCitation(drifted, inputFor([chunk]))
    } catch (error) {
      expect((error as GroundedCitationError).code).toBe('citation_hash_mismatch')
    }
  })

  it('refuses a lookup whose key does not match the chunk it returns', () => {
    const chunk = makeChunk('Texto citado.')
    const other = makeChunk('Otro texto.')
    const misKeyed = { chunks: new Map([[chunk.chunkId as string, other]]), candidates: new Map() }

    expect(() => adaptCitation(citationFor(chunk), misKeyed)).toThrow(GroundedCitationError)
  })

  it('degrades a cross-project citation rejected upstream to source_unavailable — the adapter is not the scope gate', () => {
    // Scope enforcement belongs upstream (validateAnswerCitations / retrieval
    // scoping). What PRODUCT guarantees is narrower and checkable here: a
    // citation upstream refused to hand a chunk for can never gain an excerpt,
    // a source label, or a relevance score in presentation.
    const foreign = makeChunk('Dato de otro proyecto de la misma organización.', {
      scope: { organizationId: ORGANIZATION_ID, projectId: 'proj-2' },
    })
    const view = adaptCitation(citationFor(foreign), inputFor([]))

    expect(view.availability).toBe('source_unavailable')
    expect(view.excerpt).toBeNull()
    expect(view.sourceLabel).toBeNull()
    expect(view.relevance).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Answer-level adaptation
// ---------------------------------------------------------------------------

describe('adaptGroundedAnswer', () => {
  it('adapts a fully grounded answer into grounded claims requiring human approval', () => {
    const chunk = makeChunk('El informe registra 1.240 beneficiarios directos en 2025.')
    const view = adaptGroundedAnswer(groundedAnswer(), inputFor([chunk]))

    expect(view.status).toBe('grounded')
    expect(view.answerSupport).toBe('grounded')
    expect(view.claims).toHaveLength(1)
    expect(view.claims[0].support).toBe('grounded')
    expect(view.claims[0].citations[0].excerpt?.text).toContain('1.240 beneficiarios')
    expect(view.requiresHumanReview).toBe(true)
    expect(view.decisionStatus).toBe('user_approval_required')
    expect(view.unresolvedCitationCount).toBe(0)
  })

  it('surfaces partial evidence as partially_grounded together with what was not answered', () => {
    const chunk = makeChunk('El informe registra 1.240 beneficiarios directos en 2025.')
    const view = adaptGroundedAnswer(
      groundedAnswer({
        status: 'partially_grounded',
        abstention: abstention({
          code: 'below_relevance_threshold',
          explanation: 'La evidencia cargada no aborda el costo por beneficiario.',
        }),
      }),
      inputFor([chunk]),
    )

    expect(view.answerSupport).toBe('partially_grounded')
    expect(view.abstention?.code).toBe('below_relevance_threshold')
    expect(view.abstention?.title).toBeTruthy()
    expect(view.claims[0].support).toBe('grounded')
  })

  it('adapts an abstention into an explicit, uncited absence', () => {
    const abstained: AbstainedAnswerState = {
      status: 'abstained',
      query: QUERY,
      abstention: abstention({ code: 'no_matching_evidence' }),
      contradictions: [],
      signals: [],
      requiresHumanReview: true,
    }
    const view = adaptGroundedAnswer(abstained, inputFor([]))

    expect(view.status).toBe('abstained')
    expect(view.answerSupport).toBe('insufficient_evidence')
    expect(view.claims).toHaveLength(0)
    expect(view.abstention?.code).toBe('no_matching_evidence')
    expect(view.abstention?.inspected.total).toBe(0)
  })

  it('marks an absence assertion as insufficient evidence and carries its abstention', () => {
    const view = adaptGroundedAnswer(
      groundedAnswer({
        status: 'partially_grounded',
        assertions: [
          {
            kind: 'absence',
            statement: 'La evidencia no indica el costo por beneficiario.',
            abstention: abstention({ code: 'below_relevance_threshold' }),
          },
        ],
        abstention: abstention({ code: 'below_relevance_threshold' }),
      }),
      inputFor([]),
    )

    expect(view.claims[0].support).toBe('insufficient_evidence')
    expect(view.claims[0].citations).toHaveLength(0)
    expect(view.claims[0].abstention?.code).toBe('below_relevance_threshold')
  })

  it('treats a recommendation with no supporting citation as insufficient evidence, never as grounded', () => {
    const view = adaptGroundedAnswer(
      groundedAnswer({
        assertions: [
          {
            kind: 'recommendation',
            statement: 'Conviene documentar la fuente del proxy.',
            supportedBy: [],
            requiresHumanReview: true,
          },
        ],
      }),
      inputFor([]),
    )

    expect(view.claims[0].support).toBe('insufficient_evidence')
  })

  it('states the reasoning step of an inference instead of presenting it as a finding', () => {
    const chunk = makeChunk('El informe registra 1.240 beneficiarios directos en 2025.')
    const view = adaptGroundedAnswer(
      groundedAnswer({
        assertions: [
          {
            kind: 'inference',
            statement: 'La cobertura creció respecto de 2024.',
            derivedFrom: [citationFor(chunk)],
            inferenceBasis: 'Se compara la cifra de 2025 con la de 2024 del mismo informe.',
          },
        ],
      }),
      inputFor([chunk]),
    )

    expect(view.claims[0].kind).toBe('inference')
    expect(view.claims[0].inferenceBasis).toBe(
      'Se compara la cifra de 2025 con la de 2024 del mismo informe.',
    )
  })

  it('counts citations whose passage could not be loaded so the UI can say so', () => {
    const chunk = makeChunk('El informe registra 1.240 beneficiarios directos en 2025.')
    const view = adaptGroundedAnswer(groundedAnswer(), inputFor([]))

    expect(view.unresolvedCitationCount).toBe(1)
    expect(view.claims[0].citations[0].availability).toBe('source_unavailable')
    expect(chunk.text).toBeTruthy() // fixture sanity: the chunk exists, it was just not handed over
  })
})

// ---------------------------------------------------------------------------
// Rule 7 — contradiction has exactly one producer. (Train-1 finding A-F3.)
// ---------------------------------------------------------------------------

describe('contradiction (INTEGRATION-001 §7)', () => {
  const chunkA = makeChunk('El informe registra 1.240 beneficiarios directos en 2025.')
  const chunkB = makeChunk('El anexo registra 890 beneficiarios directos en 2025.')

  function markerAB(): ContradictionMarker {
    return {
      id: 'contra-1',
      summary: 'El informe y el anexo declaran cifras distintas de beneficiarios.',
      sideA: [citationFor(chunkA)] as [CitationReference],
      sideB: [citationFor(chunkB)] as [CitationReference],
      resolution: 'requires_human_resolution',
      severity: 'warning',
    }
  }

  it('produces contradictory_evidence when — and only when — a ContradictionMarker is present', () => {
    const view = adaptGroundedAnswer(
      groundedAnswer({
        assertions: [
          { kind: 'evidence', statement: '1.240 beneficiarios.', citations: [citationFor(chunkA)] },
          { kind: 'evidence', statement: '890 beneficiarios.', citations: [citationFor(chunkB)] },
        ],
        contradictions: [markerAB()],
      }),
      inputFor([chunkA, chunkB]),
    )

    expect(view.answerSupport).toBe('contradictory_evidence')
    expect(view.claims[0].support).toBe('contradictory_evidence')
    expect(view.claims[1].support).toBe('contradictory_evidence')
    expect(view.contradictions).toHaveLength(1)
    expect(view.contradictions[0].resolution).toBe('requires_human_resolution')
    expect(view.contradictions[0].severity).toBe('warning')
    expect(view.contradictions[0].sideA[0].chunkId).toBe(chunkA.chunkId)
    expect(view.contradictions[0].sideB[0].chunkId).toBe(chunkB.chunkId)
  })

  it('never infers a contradiction from opposing statements, opposing sources or diverging scores', () => {
    // Everything a UI-side heuristic would latch onto is present here — two
    // flatly incompatible numbers, two different evidence items, two very
    // different scores — and `contradictions` is empty. Nothing may go red.
    const view = adaptGroundedAnswer(
      groundedAnswer({
        assertions: [
          { kind: 'evidence', statement: '1.240 beneficiarios.', citations: [citationFor(chunkA)] },
          { kind: 'evidence', statement: '890 beneficiarios.', citations: [citationFor(chunkB)] },
        ],
        contradictions: [],
      }),
      inputFor([chunkA, chunkB], [candidateFor(chunkA, 0.95, 0), candidateFor(chunkB, 0.16, 7)]),
    )

    expect(view.answerSupport).not.toBe('contradictory_evidence')
    for (const claim of view.claims) {
      expect(claim.support).not.toBe('contradictory_evidence')
    }
    expect(view.contradictions).toHaveLength(0)
  })

  it('does not turn an abstention CODED contradictory_evidence into a contradictory support level', () => {
    // AbstentionReasonCode and EvidenceSupportLevel share a spelling but not a
    // meaning: the code says retrieval saw conflicting matches, the support
    // level asserts a resolved ContradictionMarker exists. Only the marker
    // may produce the badge.
    const abstained: AbstainedAnswerState = {
      status: 'abstained',
      query: QUERY,
      abstention: abstention({ code: 'contradictory_evidence' }),
      contradictions: [],
      signals: [],
      requiresHumanReview: true,
    }
    const view = adaptGroundedAnswer(abstained, inputFor([]))

    expect(view.abstention?.code).toBe('contradictory_evidence')
    expect(view.answerSupport).toBe('insufficient_evidence')
  })
})
