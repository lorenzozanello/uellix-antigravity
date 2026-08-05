// lib/grounding/__tests__/isolation.test.ts
// GROUNDING line — attack tests for A-F1 (project isolation in citations).
//
// These are ADVERSARIAL tests, not happy-path coverage. Each one constructs an
// answer that a naive validator accepts and that a correct validator must
// reject with a NAMED violation. The distinction matters: a citation that is
// silently dropped and a citation that is reported as out of scope produce the
// same rendered answer but very different audit trails, and the second is the
// only one a reviewer can act on.

import { describe, it, expect } from 'vitest'
import {
  buildRetrievalQuery,
  deriveVersionId,
  hashContent,
  requireNonEmpty,
  textSpan,
  validateAnswerCitations,
  type ChunkLocation,
  type CitationReference,
  type ContentHash,
  type GroundedAnswerState,
  type GroundingAssertion,
  type GroundingScope,
} from '../contracts'

const ORG_A = 'org-aaaa'
const ORG_B = 'org-bbbb'
const PROJECT_CONFIDENTIAL = 'proj-confidencial'
const PROJECT_PUBLIC = 'proj-publico'

const confidentialScope: GroundingScope = {
  organizationId: ORG_A,
  projectId: PROJECT_CONFIDENTIAL,
}
const publicScope: GroundingScope = { organizationId: ORG_A, projectId: PROJECT_PUBLIC }

const EVIDENCE_ID = 'ev-publico-1'
const VERSION_ID = deriveVersionId(EVIDENCE_ID, hashContent('doc bytes'))
const CHUNK_TEXT = 'El informe registra 120 beneficiarios.'
const CHUNK_HASH = hashContent(CHUNK_TEXT)
const CHUNK_ID = hashContent('chunk-publico-1')

const location: ChunkLocation = {
  span: textSpan(0, CHUNK_TEXT.length),
  coordinateSpace: hashContent('normalized'),
  page: 3,
  sectionIndex: 2,
  sectionLabel: 'Resultados',
  lineStart: 1,
  lineEnd: 1,
}

const citation = (overrides: Partial<CitationReference> = {}): CitationReference => ({
  chunkId: CHUNK_ID,
  evidenceId: EVIDENCE_ID,
  versionId: VERSION_ID,
  location,
  quotedTextHash: CHUNK_HASH,
  ...overrides,
})

/**
 * The chunk as it truly is: same organization as the query, but it belongs to
 * the PUBLIC project while the query is scoped to the CONFIDENTIAL one.
 *
 * `organizationId` is deliberately correct. A-F1 is not "the validator misses
 * an obviously foreign chunk" — it is "the validator's only scope check passes,
 * and the check that would have caught this one does not exist".
 */
const crossProjectChunk = {
  chunkId: CHUNK_ID,
  contentHash: CHUNK_HASH,
  organizationId: ORG_A,
  scope: publicScope,
  evidenceId: EVIDENCE_ID,
  versionId: VERSION_ID,
  location,
}

const groundedAnswer = (
  assertions: GroundingAssertion[],
  scope: GroundingScope = confidentialScope,
): GroundedAnswerState => ({
  status: 'grounded',
  query: buildRetrievalQuery(scope, 'beneficiarios'),
  assertions: requireNonEmpty(assertions, 'assertions'),
  abstention: null,
  contradictions: [],
  signals: [],
  requiresHumanReview: true,
})

const codesFor = (
  state: GroundedAnswerState,
  chunks: ReadonlyMap<ContentHash, typeof crossProjectChunk>,
): readonly string[] => validateAnswerCitations(state, chunks).map((issue) => issue.code)

/** The same chunk, correctly scoped to the project the query asks about. */
const inScopeChunk = { ...crossProjectChunk, scope: confidentialScope }

describe('A-F1 — same organization, different project', () => {
  it('rejects a citation whose chunk belongs to another project of the same organization', () => {
    const available = new Map([[CHUNK_ID, crossProjectChunk]])
    const state = groundedAnswer([
      { kind: 'evidence', statement: '120 beneficiarios.', citations: [citation()] },
    ])

    expect(codesFor(state, available)).toEqual(['citation_out_of_scope'])
  })

  it('does not degrade a cross-project citation into an unscoped but accepted one', () => {
    const available = new Map([[CHUNK_ID, crossProjectChunk]])
    const state = groundedAnswer([
      { kind: 'evidence', statement: '120 beneficiarios.', citations: [citation()] },
    ])

    // The failure mode this pins down: returning [] (accepted) or returning
    // 'citation_without_source' (accepted-but-anonymous) are both wrong. The
    // violation must name the boundary that was crossed.
    const issues = validateAnswerCitations(state, available)
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('citation_out_of_scope')
    expect(issues[0].detail).toContain(PROJECT_PUBLIC)
  })

  it('still accepts a citation whose chunk sits in the queried project', () => {
    const available = new Map([[CHUNK_ID, inScopeChunk]])
    const state = groundedAnswer([
      { kind: 'evidence', statement: '120 beneficiarios.', citations: [citation()] },
    ])

    expect(codesFor(state, available)).toEqual([])
  })

  it('lets an organization-wide query read a project-scoped chunk', () => {
    const available = new Map([[CHUNK_ID, crossProjectChunk]])
    const state = groundedAnswer(
      [{ kind: 'evidence', statement: '120 beneficiarios.', citations: [citation()] }],
      { organizationId: ORG_A, projectId: null },
    )

    expect(codesFor(state, available)).toEqual([])
  })
})

describe('A-F1 — cross-organization isolation stays enforced', () => {
  it('rejects a citation whose chunk belongs to another organization entirely', () => {
    const foreign = {
      ...crossProjectChunk,
      organizationId: ORG_B,
      scope: { organizationId: ORG_B, projectId: PROJECT_CONFIDENTIAL },
    }
    const available = new Map([[CHUNK_ID, foreign]])
    const state = groundedAnswer([
      { kind: 'evidence', statement: 'Cruzada.', citations: [citation()] },
    ])

    expect(codesFor(state, available)).toEqual(['citation_out_of_scope'])
  })

  it('rejects a foreign-organization chunk even when the project id happens to match', () => {
    // A project id is only unique within its organization. Matching on project
    // alone would let a colliding id bridge two tenants.
    const collidingProject = {
      ...crossProjectChunk,
      organizationId: ORG_B,
      scope: { organizationId: ORG_B, projectId: PROJECT_CONFIDENTIAL },
    }
    const available = new Map([[CHUNK_ID, collidingProject]])
    const state = groundedAnswer([
      { kind: 'evidence', statement: 'Colisión.', citations: [citation()] },
    ])

    expect(codesFor(state, available)).toEqual(['citation_out_of_scope'])
  })
})

describe('A-F1 — forged evidence, version, chunk and location', () => {
  const available = new Map([[CHUNK_ID, inScopeChunk]])

  it('rejects a citation naming an evidence item the chunk does not come from', () => {
    const state = groundedAnswer([
      {
        kind: 'evidence',
        statement: 'Atribuida al documento equivocado.',
        citations: [citation({ evidenceId: 'ev-inventado-9' })],
      },
    ])

    expect(codesFor(state, available)).toEqual(['citation_evidence_mismatch'])
  })

  it("rejects a citation carrying another version's id for the same evidence item", () => {
    const state = groundedAnswer([
      {
        kind: 'evidence',
        statement: 'Versión ajena.',
        citations: [citation({ versionId: deriveVersionId(EVIDENCE_ID, hashContent('otros bytes')) })],
      },
    ])

    expect(codesFor(state, available)).toEqual(['citation_version_mismatch'])
  })

  it('rejects a citation whose quoted-text hash drifted off the chunk', () => {
    const state = groundedAnswer([
      {
        kind: 'evidence',
        statement: 'Reencuadrada.',
        citations: [citation({ quotedTextHash: hashContent('otro pasaje') })],
      },
    ])

    expect(codesFor(state, available)).toEqual(['citation_hash_mismatch'])
  })

  it('rejects a citation to a chunk that was never retrieved', () => {
    const state = groundedAnswer([
      {
        kind: 'evidence',
        statement: 'Inventada.',
        citations: [citation({ chunkId: hashContent('chunk-fantasma') })],
      },
    ])

    expect(codesFor(state, available)).toEqual(['citation_without_source'])
  })

  it('rejects a citation whose span was moved off the chunk it names', () => {
    const state = groundedAnswer([
      {
        kind: 'evidence',
        statement: 'Ubicación movida.',
        citations: [citation({ location: { ...location, span: textSpan(400, 460) } })],
      },
    ])

    expect(codesFor(state, available)).toEqual(['citation_location_mismatch'])
  })

  it('rejects a citation resolved against a different normalized coordinate space', () => {
    // Offsets stay in range and the page number still looks right; only the
    // hash of the normalized text they index differs. This is the silent
    // failure `coordinateSpace` exists to make loud.
    const state = groundedAnswer([
      {
        kind: 'evidence',
        statement: 'Espacio de coordenadas ajeno.',
        citations: [
          citation({ location: { ...location, coordinateSpace: hashContent('normalized-v2') } }),
        ],
      },
    ])

    expect(codesFor(state, available)).toEqual(['citation_location_mismatch'])
  })

  it('rejects the same citation repeated within one assertion', () => {
    // Repetition inflates how much evidence a claim appears to rest on.
    const state = groundedAnswer([
      {
        kind: 'evidence',
        statement: 'Doblemente respaldada, en apariencia.',
        citations: [citation(), citation()],
      },
    ])

    expect(codesFor(state, available)).toEqual(['citation_duplicated'])
  })

  it('accepts the same chunk cited by two different assertions', () => {
    // Two claims resting on one passage is normal; the duplicate rule is about
    // one claim double-counting a single source.
    const state = groundedAnswer([
      { kind: 'evidence', statement: 'Primera lectura.', citations: [citation()] },
      { kind: 'evidence', statement: 'Segunda lectura.', citations: [citation()] },
    ])

    expect(codesFor(state, available)).toEqual([])
  })

  it('reports every violation a single forged citation commits, not just the first', () => {
    const state = groundedAnswer([
      {
        kind: 'evidence',
        statement: 'Falsificación completa.',
        citations: [
          citation({
            evidenceId: 'ev-inventado-9',
            versionId: deriveVersionId('ev-inventado-9', hashContent('bytes')),
            quotedTextHash: hashContent('texto inventado'),
          }),
        ],
      },
    ])

    expect([...codesFor(state, available)].sort()).toEqual([
      'citation_evidence_mismatch',
      'citation_hash_mismatch',
      'citation_version_mismatch',
    ])
  })
})

describe('A-F1 — contradiction markers are validated on both sides', () => {
  it('rejects a contradiction whose opposing side cites another project', () => {
    const otherChunkId = hashContent('chunk-publico-2')
    const available = new Map([
      [CHUNK_ID, inScopeChunk],
      [otherChunkId, { ...crossProjectChunk, chunkId: otherChunkId }],
    ])
    const state: GroundedAnswerState = {
      ...groundedAnswer([
        { kind: 'evidence', statement: '120 beneficiarios.', citations: [citation()] },
      ]),
      contradictions: [
        {
          id: 'contra-1',
          summary: 'Dos cifras de beneficiarios',
          sideA: [citation()],
          sideB: [citation({ chunkId: otherChunkId })],
          resolution: 'requires_human_resolution',
          severity: 'warning',
        },
      ],
    }

    expect(codesFor(state, available)).toEqual(['citation_out_of_scope'])
  })
})
