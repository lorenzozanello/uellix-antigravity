// components/stella/__tests__/grounded-fixtures.ts
// PRODUCT TRAIN 2 — shared fixtures for the grounded-presentation components.
//
// The views are built by running the REAL adapter over real contract values
// (hashes produced by `hashContent`, spans by `textSpan`), never by hand-
// writing a GroundedCitationView. A hand-written view would let a component
// test pass against a shape the adapter cannot actually produce.
//
// Not a test file: vitest only collects `*.test.*` / `*.spec.*`.

import { hashContent, textSpan } from '@/lib/grounding/contracts'
import type {
  ChunkLocation,
  CitationReference,
  ContentHash,
  GroundedAnswerState,
  GroundingChunk,
  RetrievalCandidate,
  RetrievalQuery,
} from '@/lib/grounding/contracts'
import { adaptCitation, adaptGroundedAnswer } from '../grounding-adapter'
import type { GroundedAnswerView, GroundedCitationView } from '../grounding-adapter'

const ORGANIZATION_ID = 'org-1'
const COORDINATE_SPACE = hashContent('texto normalizado del informe')

export const REPORT_TEXT = 'El informe registra 1.240 beneficiarios directos en 2025.'
export const ANNEX_TEXT = 'El anexo registra 890 beneficiarios directos en 2025.'

export function makeChunk(
  text: string,
  overrides: Partial<Omit<GroundingChunk, 'contentHash'>> = {},
): GroundingChunk {
  const versionId = (overrides.versionId ?? hashContent('version-1')) as ContentHash
  const location: ChunkLocation = {
    span: textSpan(12, 48),
    coordinateSpace: COORDINATE_SPACE,
    page: 4,
    sectionIndex: 2,
    sectionLabel: 'Metodología',
    lineStart: 12,
    lineEnd: 18,
    ...overrides.location,
  }
  return {
    chunkId: (overrides.chunkId ?? hashContent(`chunk-of:${text}`)) as ContentHash,
    scope: { organizationId: ORGANIZATION_ID, projectId: 'proj-1' },
    evidenceId: overrides.evidenceId ?? 'ev-1',
    versionId,
    chunkIndex: 3,
    text,
    contentHash: hashContent(text),
    location,
    provenance: {
      evidenceId: overrides.evidenceId ?? 'ev-1',
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

export function citationFor(chunk: GroundingChunk): CitationReference {
  return {
    chunkId: chunk.chunkId,
    evidenceId: chunk.evidenceId,
    versionId: chunk.versionId,
    location: chunk.location,
    quotedTextHash: chunk.contentHash,
  }
}

export function candidateFor(chunk: GroundingChunk, score: number, rank = 0): RetrievalCandidate {
  return { chunk, score, rank, strategy: 'hybrid', untrusted: true }
}

export function inputFor(
  chunks: readonly GroundingChunk[],
  candidates: readonly RetrievalCandidate[] = [],
) {
  return {
    chunks: new Map(chunks.map((c) => [c.chunkId as string, c])),
    candidates: new Map(candidates.map((c) => [c.chunk.chunkId as string, c])),
  }
}

export const QUERY: RetrievalQuery = {
  scope: { organizationId: ORGANIZATION_ID, projectId: 'proj-1' },
  text: '¿Cuántos beneficiarios reporta el informe?',
  topK: 8,
  minScore: 0.15,
  evidenceIds: [],
  quarantineAtOrAbove: 'critical',
}

/** One loaded citation with a retrieval score. */
export function loadedCitationView(text = REPORT_TEXT, score = 0.82): GroundedCitationView {
  const chunk = makeChunk(text)
  return adaptCitation(citationFor(chunk), inputFor([chunk], [candidateFor(chunk, score)]))
}

/** One citation whose passage was never handed to presentation. */
export function unavailableCitationView(text = REPORT_TEXT): GroundedCitationView {
  const chunk = makeChunk(text)
  return adaptCitation(citationFor(chunk), inputFor([]))
}

/** A fully grounded, single-claim answer. */
export function groundedAnswerView(): GroundedAnswerView {
  const chunk = makeChunk(REPORT_TEXT)
  const state: GroundedAnswerState = {
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
  }
  return adaptGroundedAnswer(state, inputFor([chunk], [candidateFor(chunk, 0.82)]))
}

/** A partially grounded answer: one grounded claim plus a stated abstention. */
export function partiallyGroundedAnswerView(): GroundedAnswerView {
  const chunk = makeChunk(REPORT_TEXT)
  const state: GroundedAnswerState = {
    status: 'partially_grounded',
    query: QUERY,
    assertions: [
      {
        kind: 'evidence',
        statement: 'El proyecto reporta 1.240 beneficiarios directos.',
        citations: [citationFor(chunk)],
      },
      {
        kind: 'absence',
        statement: 'La evidencia no indica el costo por beneficiario.',
        abstention: {
          code: 'below_relevance_threshold',
          explanation: 'Los pasajes recuperados no abordan el costo por beneficiario.',
          query: QUERY,
          inspected: { total: 6, belowThreshold: 6, quarantined: 0 },
        },
      },
    ],
    abstention: {
      code: 'below_relevance_threshold',
      explanation: 'Los pasajes recuperados no abordan el costo por beneficiario.',
      query: QUERY,
      inspected: { total: 6, belowThreshold: 6, quarantined: 0 },
    },
    contradictions: [],
    signals: [],
    requiresHumanReview: true,
  }
  return adaptGroundedAnswer(state, inputFor([chunk], [candidateFor(chunk, 0.82)]))
}

/** An answer that abstained entirely. */
export function abstainedAnswerView(): GroundedAnswerView {
  return adaptGroundedAnswer(
    {
      status: 'abstained',
      query: QUERY,
      abstention: {
        code: 'no_matching_evidence',
        explanation: 'No hay evidencia cargada que responda a esta pregunta.',
        query: QUERY,
        inspected: { total: 0, belowThreshold: 0, quarantined: 0 },
      },
      contradictions: [],
      signals: [],
      requiresHumanReview: true,
    },
    inputFor([]),
  )
}

/** Two claims a real ContradictionMarker names as conflicting. */
export function contradictedAnswerView(): GroundedAnswerView {
  const report = makeChunk(REPORT_TEXT)
  const annex = makeChunk(ANNEX_TEXT, { evidenceId: 'ev-2' })
  const state: GroundedAnswerState = {
    status: 'grounded',
    query: QUERY,
    assertions: [
      { kind: 'evidence', statement: '1.240 beneficiarios.', citations: [citationFor(report)] },
      { kind: 'evidence', statement: '890 beneficiarios.', citations: [citationFor(annex)] },
    ],
    abstention: null,
    contradictions: [
      {
        id: 'contra-1',
        summary: 'El informe y el anexo declaran cifras distintas de beneficiarios.',
        sideA: [citationFor(report)] as [CitationReference],
        sideB: [citationFor(annex)] as [CitationReference],
        resolution: 'requires_human_resolution',
        severity: 'warning',
      },
    ],
    signals: [],
    requiresHumanReview: true,
  }
  return adaptGroundedAnswer(state, inputFor([report, annex]))
}

/**
 * TRAIN 3 — one answer carrying all four assertion kinds at once.
 *
 * The four are not decoration: evidence quotes a document, inference states
 * its own reasoning step, recommendation proposes an action and may cite
 * nothing, and absence is structurally uncitable. A reader who cannot tell
 * them apart cannot tell what the system *knows* from what it *suggests*.
 */
export function allClaimKindsAnswerView(): GroundedAnswerView {
  const chunk = makeChunk(REPORT_TEXT)
  const state: GroundedAnswerState = {
    status: 'partially_grounded',
    query: QUERY,
    assertions: [
      {
        kind: 'evidence',
        statement: 'El informe registra 1.240 beneficiarios directos en 2025.',
        citations: [citationFor(chunk)],
      },
      {
        kind: 'inference',
        statement: 'La cobertura creció respecto del año anterior.',
        derivedFrom: [citationFor(chunk)],
        inferenceBasis: 'Se compara la cifra de 2025 con la de 2024 del mismo informe.',
      },
      {
        kind: 'recommendation',
        statement: 'Conviene adjuntar el padrón desagregado antes de la revisión.',
        supportedBy: [],
        requiresHumanReview: true,
      },
      {
        kind: 'absence',
        statement: 'La evidencia no indica el costo por beneficiario.',
        abstention: {
          code: 'below_relevance_threshold',
          explanation: 'Los pasajes recuperados no abordan el costo por beneficiario.',
          query: QUERY,
          inspected: { total: 6, belowThreshold: 6, quarantined: 0 },
        },
      },
    ],
    abstention: null,
    contradictions: [],
    signals: [],
    requiresHumanReview: true,
  }
  return adaptGroundedAnswer(state, inputFor([chunk], [candidateFor(chunk, 0.82)]))
}

/** A grounded claim whose passage was withheld upstream. */
export function unresolvedAnswerView(): GroundedAnswerView {
  const chunk = makeChunk(REPORT_TEXT)
  const state: GroundedAnswerState = {
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
  }
  return adaptGroundedAnswer(state, inputFor([]))
}

/**
 * TRAIN 3 — a contradiction where BOTH sides cite the SAME chunk, and the
 * marker attributes each side to a distinct claim.
 *
 * The hard case for finding A-M: identical citations, so nothing derivable
 * from `sideA`/`sideB` can tell the two claims apart. Only the attribution
 * can, which is what the panel must render.
 */
export function sameChunkContradictionAnswerView(): GroundedAnswerView {
  const report = makeChunk(REPORT_TEXT)
  const state: GroundedAnswerState = {
    status: 'grounded',
    query: QUERY,
    assertions: [
      { kind: 'evidence', statement: '1.240 beneficiarios.', citations: [citationFor(report)] },
      { kind: 'evidence', statement: '890 beneficiarios.', citations: [citationFor(report)] },
    ],
    abstention: null,
    contradictions: [
      {
        id: 'contra-shared',
        summary: 'Dos afirmaciones leen el mismo pasaje de forma incompatible.',
        sideA: [citationFor(report)] as [CitationReference],
        sideB: [citationFor(report)] as [CitationReference],
        sideAClaim: { claimId: 'claim-a', assertionHash: hashContent('1.240 beneficiarios.') },
        sideBClaim: { claimId: 'claim-b', assertionHash: hashContent('890 beneficiarios.') },
        resolution: 'requires_human_resolution',
        severity: 'warning',
      },
    ],
    signals: [],
    requiresHumanReview: true,
  }
  return adaptGroundedAnswer(state, inputFor([report]))
}
