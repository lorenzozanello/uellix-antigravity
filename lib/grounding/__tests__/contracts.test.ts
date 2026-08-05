// lib/grounding/__tests__/contracts.test.ts
// GROUNDING line — the grounding/provenance contracts.
//
// Several of these are TYPE tests: the @ts-expect-error blocks fail the
// focused typecheck if the contract ever loosens enough to admit an
// uncited evidence claim or a cited abstention. They are as much a part of
// the suite as the runtime assertions, and they only pay off when the
// typecheck runs — see docs/ops/workstreams/GROUNDING.md.

import { describe, it, expect } from 'vitest'
import {
  CHUNKER_VERSION,
  EXTRACTOR_VERSION,
  INJECTION_SCANNER_VERSION,
  NORMALIZATION_VERSION,
  PIPELINE_VERSIONS,
  GroundingScopeViolationError,
  assertSameScope,
  assertValidScope,
  deriveChunkId,
  deriveVersionId,
  hashBytes,
  hashContent,
  highestSeverity,
  isSameScope,
  lineRangeForSpan,
  mustQuarantine,
  parseContentHash,
  renderSignalExcerpt,
  requireNonEmpty,
  scopeContains,
  textSpan,
  validateAnswerCitations,
  type AbstentionReason,
  type ChunkLocation,
  type CitableChunkRecord,
  type CitationReference,
  type ContentHash,
  type DocumentVersion,
  type GroundedAnswerState,
  type GroundingAnswerState,
  type GroundingAssertion,
  type GroundingScope,
  type PromptInjectionSignal,
} from '../contracts'
import { buildRetrievalQuery } from '../contracts'

const ORG_A = 'org-aaaa'
const ORG_B = 'org-bbbb'
const PROJECT_1 = 'proj-1111'

const scopeA: GroundingScope = { organizationId: ORG_A, projectId: PROJECT_1 }

describe('content hashing', () => {
  it('is deterministic and lowercase hex of fixed width', () => {
    const a = hashContent('línea base 2024')
    const b = hashContent('línea base 2024')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates content that differs by a single character', () => {
    expect(hashContent('beneficiarios: 120')).not.toBe(hashContent('beneficiarios: 121'))
  })

  it('hashes bytes and the equivalent UTF-8 string identically', () => {
    expect(hashBytes(Buffer.from('agua seguraáé', 'utf8'))).toBe(hashContent('agua seguraáé'))
  })

  it('rejects anything that is not a lowercase-hex sha256 on re-entry', () => {
    expect(() => parseContentHash('nope')).toThrow(/sha-?256/i)
    expect(() => parseContentHash(hashContent('x').toUpperCase())).toThrow(/sha-?256/i)
    expect(parseContentHash(hashContent('x'))).toBe(hashContent('x'))
  })
})

describe('scope isolation', () => {
  it('treats different organizations as different scopes', () => {
    expect(isSameScope(scopeA, { organizationId: ORG_B, projectId: PROJECT_1 })).toBe(false)
  })

  it('lets an org-wide reader see project-scoped records but not the reverse', () => {
    const orgWide: GroundingScope = { organizationId: ORG_A, projectId: null }
    expect(scopeContains(orgWide, scopeA)).toBe(true)
    expect(scopeContains(scopeA, orgWide)).toBe(false)
    expect(scopeContains(scopeA, { organizationId: ORG_A, projectId: 'proj-other' })).toBe(false)
  })

  it('never lets a scope reach across organizations', () => {
    expect(scopeContains({ organizationId: ORG_A, projectId: null }, { organizationId: ORG_B, projectId: null })).toBe(
      false,
    )
  })

  it('throws on a boundary crossing instead of filtering it away', () => {
    expect(() => assertSameScope(scopeA, { organizationId: ORG_B, projectId: PROJECT_1 }, 'chunk')).toThrow(
      GroundingScopeViolationError,
    )
  })

  it('rejects a malformed scope', () => {
    expect(() => assertValidScope({ organizationId: '', projectId: null })).toThrow(/organizationId/)
    expect(() => assertValidScope({ organizationId: ORG_A, projectId: '' })).toThrow(/projectId/)
  })
})

describe('document version identity', () => {
  const rawHash = hashContent('Informe de línea base\nBeneficiarios: 120\n')

  it('is stable for the same evidence and the same bytes', () => {
    expect(deriveVersionId('ev-1', rawHash)).toBe(deriveVersionId('ev-1', rawHash))
  })

  it('changes when the bytes change by one character', () => {
    const edited = hashContent('Informe de línea base\nBeneficiarios: 121\n')
    expect(deriveVersionId('ev-1', edited)).not.toBe(deriveVersionId('ev-1', rawHash))
  })

  it('keeps two evidence items with identical bytes distinct', () => {
    // A shared boilerplate annex uploaded twice must not collapse into one
    // version, or provenance would name the wrong upload.
    expect(deriveVersionId('ev-1', rawHash)).not.toBe(deriveVersionId('ev-2', rawHash))
  })
})

describe('pipeline versions — GR-CAP-002 (EXTRACTOR_VERSION)', () => {
  it('EXTRACTOR_VERSION is a stable literal, unchanged across reads', () => {
    expect(EXTRACTOR_VERSION).toBe('extract-1')
    expect(EXTRACTOR_VERSION).toBe(EXTRACTOR_VERSION)
  })

  it('participates in PIPELINE_VERSIONS alongside the other three pipeline stages', () => {
    expect(PIPELINE_VERSIONS.extractor).toBe(EXTRACTOR_VERSION)
    expect(PIPELINE_VERSIONS).toEqual({
      normalization: NORMALIZATION_VERSION,
      chunker: CHUNKER_VERSION,
      injectionScanner: INJECTION_SCANNER_VERSION,
      extractor: EXTRACTOR_VERSION,
    })
  })

  it('a change in extractor version changes pipeline identity: two DocumentVersion stamps that agree on every other field but extractorVersion are not the same pipeline state', () => {
    const base: Omit<DocumentVersion, 'extractorVersion'> = {
      versionId: deriveVersionId('ev-1', hashContent('bytes')),
      evidenceId: 'ev-1',
      scope: { organizationId: ORG_A, projectId: PROJECT_1 },
      rawContentHash: hashContent('bytes'),
      normalizedContentHash: hashContent('normalized'),
      normalizationVersion: NORMALIZATION_VERSION,
      ordinal: null,
      supersedes: null,
    }
    const underCurrentExtractor: DocumentVersion = { ...base, extractorVersion: EXTRACTOR_VERSION }
    const underAHypotheticalNextExtractor: DocumentVersion = { ...base, extractorVersion: 'extract-2' }

    // versionId (content identity) is unchanged — GR-CAP-002's point is exactly
    // that this stays true even though the two stamps must not be confused.
    expect(underAHypotheticalNextExtractor.versionId).toBe(underCurrentExtractor.versionId)
    expect(underAHypotheticalNextExtractor).not.toEqual(underCurrentExtractor)
    expect(underAHypotheticalNextExtractor.extractorVersion).not.toBe(underCurrentExtractor.extractorVersion)
  })
})

describe('chunk identity', () => {
  it('distinguishes identical text appearing at different positions', () => {
    const version = deriveVersionId('ev-1', hashContent('doc'))
    const repeated = hashContent('Anexo confidencial — página')
    expect(deriveChunkId(version, 0, repeated)).not.toBe(deriveChunkId(version, 4, repeated))
  })
})

describe('spans and line ranges', () => {
  it('rejects inverted or fractional spans', () => {
    expect(() => textSpan(5, 2)).toThrow()
    expect(() => textSpan(-1, 2)).toThrow()
    expect(() => textSpan(0.5, 2)).toThrow()
  })

  it('reports 1-based line ranges without claiming the line after a trailing newline', () => {
    const text = 'uno\ndos\ntres\ncuatro'
    expect(lineRangeForSpan(text, textSpan(0, 3))).toEqual({ lineStart: 1, lineEnd: 1 })
    expect(lineRangeForSpan(text, textSpan(0, 4))).toEqual({ lineStart: 1, lineEnd: 1 })
    expect(lineRangeForSpan(text, textSpan(4, 12))).toEqual({ lineStart: 2, lineEnd: 3 })
  })
})

describe('injection signal policy', () => {
  const signal = (severity: PromptInjectionSignal['severity']): PromptInjectionSignal => ({
    kind: 'instruction_override',
    severity,
    stage: 'normalized',
    span: textSpan(0, 4),
    ruleId: 'test',
    excerpt: 'x',
    scannerVersion: 'inj-1',
  })

  it('quarantines only critical signals', () => {
    expect(mustQuarantine(signal('critical'))).toBe(true)
    expect(mustQuarantine(signal('warning'))).toBe(false)
    expect(mustQuarantine(signal('info'))).toBe(false)
  })

  it('reports the worst severity present', () => {
    expect(highestSeverity([])).toBeNull()
    expect(highestSeverity([signal('info'), signal('warning')])).toBe('warning')
    expect(highestSeverity([signal('info'), signal('critical'), signal('warning')])).toBe('critical')
  })

  it('escapes invisible characters in excerpts so a log viewer cannot be attacked by them', () => {
    const rendered = renderSignalExcerpt('apro​bar‮esto')
    expect(rendered).toContain('\\u{200b}')
    expect(rendered).toContain('\\u{202e}')
    expect(rendered).not.toContain('​')
  })
})

// ---------------------------------------------------------------------------
// The separation the whole contract exists for
// ---------------------------------------------------------------------------

const location: ChunkLocation = {
  span: textSpan(0, 20),
  coordinateSpace: hashContent('normalized'),
  page: 3,
  sectionIndex: 2,
  sectionLabel: 'Resultados',
  lineStart: 1,
  lineEnd: 2,
}

const citation = (chunkId: ContentHash, quotedTextHash: ContentHash): CitationReference => ({
  chunkId,
  evidenceId: 'ev-1',
  versionId: deriveVersionId('ev-1', hashContent('doc')),
  location,
  quotedTextHash,
})

const abstention: AbstentionReason = {
  code: 'no_matching_evidence',
  explanation: 'No indexed passage within scope addresses the question.',
  query: null,
  inspected: { total: 0, belowThreshold: 0, quarantined: 0 },
}

describe('assertion kinds keep evidence, inference, recommendation and absence apart', () => {
  it('accepts each well-formed kind', () => {
    const chunkHash = hashContent('passage')
    const assertions: GroundingAssertion[] = [
      { kind: 'evidence', statement: 'El informe registra 120 beneficiarios.', citations: [citation(hashContent('c1'), chunkHash)] },
      {
        kind: 'inference',
        statement: 'La cobertura creció respecto de la línea base.',
        derivedFrom: [citation(hashContent('c1'), chunkHash)],
        inferenceBasis: '120 en el informe final frente a 90 en la línea base citada.',
      },
      { kind: 'recommendation', statement: 'Documentar el método de conteo.', supportedBy: [], requiresHumanReview: true },
      { kind: 'absence', statement: 'La evidencia no reporta costo por beneficiario.', abstention },
    ]
    expect(assertions.map((a) => a.kind)).toEqual(['evidence', 'inference', 'recommendation', 'absence'])
  })

  it('forbids an evidence claim with no citations at the type level', () => {
    // @ts-expect-error an evidence assertion requires at least one citation
    const bad: GroundingAssertion = { kind: 'evidence', statement: 'Sin fuente.', citations: [] }
    expect(bad.kind).toBe('evidence')
  })

  it('forbids an absence that carries citations at the type level', () => {
    const bad: GroundingAssertion = {
      kind: 'absence',
      statement: 'No hay evidencia.',
      abstention,
      // @ts-expect-error an absence is structurally uncitable
      citations: [citation(hashContent('c1'), hashContent('passage'))],
    }
    expect(bad.kind).toBe('absence')
  })

  it('forbids a recommendation that opts out of human review at the type level', () => {
    const bad: GroundingAssertion = {
      kind: 'recommendation',
      statement: 'Aprobar el proyecto.',
      supportedBy: [],
      // @ts-expect-error requiresHumanReview is a literal true
      requiresHumanReview: false,
    }
    expect(bad.kind).toBe('recommendation')
  })
})

describe('validateAnswerCitations — the runtime half of "no citation without a source"', () => {
  const chunkId = hashContent('chunk-1')
  const chunkHash = hashContent('El informe registra 120 beneficiarios.')
  const record = (overrides: Partial<CitableChunkRecord> = {}): CitableChunkRecord => ({
    chunkId,
    contentHash: chunkHash,
    scope: scopeA,
    evidenceId: 'ev-1',
    versionId: deriveVersionId('ev-1', hashContent('doc')),
    location,
    ...overrides,
  })
  const available = new Map([[chunkId, record()]])
  const query = buildRetrievalQuery(scopeA, 'beneficiarios')

  const grounded = (assertions: GroundingAssertion[]): GroundedAnswerState => ({
    status: 'grounded',
    query,
    assertions: requireNonEmpty(assertions, 'assertions'),
    abstention: null,
    contradictions: [],
    signals: [],
    requiresHumanReview: true,
  })

  it('passes a citation that resolves to a chunk actually placed in context', () => {
    const state = grounded([
      { kind: 'evidence', statement: '120 beneficiarios.', citations: [citation(chunkId, chunkHash)] },
    ])
    expect(validateAnswerCitations(state, available)).toEqual([])
  })

  it('flags a citation to a chunk that was never retrieved', () => {
    const state = grounded([
      { kind: 'evidence', statement: 'Inventado.', citations: [citation(hashContent('ghost'), chunkHash)] },
    ])
    expect(validateAnswerCitations(state, available).map((i) => i.code)).toEqual(['citation_without_source'])
  })

  it('flags a citation whose quoted text has drifted off the chunk', () => {
    const state = grounded([
      { kind: 'evidence', statement: 'Reencuadrado.', citations: [citation(chunkId, hashContent('otro pasaje'))] },
    ])
    expect(validateAnswerCitations(state, available).map((i) => i.code)).toEqual(['citation_hash_mismatch'])
  })

  it('flags a citation that resolves into another organization', () => {
    const foreign = new Map([
      [chunkId, record({ scope: { organizationId: ORG_B, projectId: PROJECT_1 } })],
    ])
    const state = grounded([
      { kind: 'evidence', statement: 'Cruzada.', citations: [citation(chunkId, chunkHash)] },
    ])
    expect(validateAnswerCitations(state, foreign).map((i) => i.code)).toEqual(['citation_out_of_scope'])
  })

  it('validates citations carried by contradiction markers too', () => {
    const state: GroundedAnswerState = {
      ...grounded([{ kind: 'evidence', statement: '120.', citations: [citation(chunkId, chunkHash)] }]),
      contradictions: [
        {
          id: 'contra-1',
          summary: 'Dos cifras de beneficiarios',
          sideA: [citation(chunkId, chunkHash)],
          sideB: [citation(hashContent('ghost'), chunkHash)],
          resolution: 'requires_human_resolution',
          severity: 'warning',
        },
      ],
    }
    expect(validateAnswerCitations(state, available).map((i) => i.code)).toEqual(['citation_without_source'])
  })

  it('requires a partially grounded answer to say what it could not answer', () => {
    const state: GroundedAnswerState = {
      ...grounded([{ kind: 'evidence', statement: '120.', citations: [citation(chunkId, chunkHash)] }]),
      status: 'partially_grounded',
    }
    expect(validateAnswerCitations(state, available).map((i) => i.code)).toEqual(['partial_without_abstention'])
  })

  it('accepts an abstained answer with no assertions at all', () => {
    const state: GroundingAnswerState = {
      status: 'abstained',
      query,
      abstention,
      contradictions: [],
      signals: [],
      requiresHumanReview: true,
    }
    expect(validateAnswerCitations(state, available)).toEqual([])
  })
})
