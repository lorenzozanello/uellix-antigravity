// lib/grounding/__tests__/fixtures.ts
// GROUNDING line — hand-built chunks for retrieval and isolation tests.
//
// These are constructed rather than produced by ingestDocument on purpose. A
// retrieval test needs to place a specific passage in a specific scope, in a
// specific document version, and a real ingestion would decide chunk
// boundaries for itself. The ingestion pipeline has its own suite; here the
// chunks are the fixture, not the subject.

import {
  CHUNKER_VERSION,
  INJECTION_SCANNER_VERSION,
  NORMALIZATION_VERSION,
  deriveChunkId,
  deriveVersionId,
  hashContent,
  textSpan,
  type ContentHash,
  type GroundingChunk,
  type GroundingScope,
  type PromptInjectionSignal,
} from '../contracts'

export const ORG_A = 'org-aaaa'
export const ORG_B = 'org-bbbb'
export const PROJECT_1 = 'proj-1111'
export const PROJECT_2 = 'proj-2222'

export const scopeA1: GroundingScope = { organizationId: ORG_A, projectId: PROJECT_1 }
export const scopeA2: GroundingScope = { organizationId: ORG_A, projectId: PROJECT_2 }
export const scopeAOrgWide: GroundingScope = { organizationId: ORG_A, projectId: null }
export const scopeB1: GroundingScope = { organizationId: ORG_B, projectId: PROJECT_1 }

export interface ChunkFixtureOptions {
  readonly scope?: GroundingScope
  readonly evidenceId?: string
  /** Distinguishes two versions of the same evidence item. */
  readonly rawContent?: string
  readonly chunkIndex?: number
  readonly page?: number | null
  readonly signals?: readonly PromptInjectionSignal[]
}

/**
 * Build one chunk whose provenance chain is internally consistent: the version
 * id derives from (evidenceId, rawContentHash), the chunk id from
 * (versionId, chunkIndex, contentHash), and the span covers the text exactly.
 * A fixture with an inconsistent chain would make validation tests pass for
 * the wrong reason.
 */
export function chunkFixture(text: string, options: ChunkFixtureOptions = {}): GroundingChunk {
  const scope = options.scope ?? scopeA1
  const evidenceId = options.evidenceId ?? 'ev-1'
  const chunkIndex = options.chunkIndex ?? 0
  const rawContentHash = hashContent(options.rawContent ?? `${evidenceId}:bytes`)
  const versionId = deriveVersionId(evidenceId, rawContentHash)
  const contentHash = hashContent(text)
  const normalizedContentHash = hashContent(`${evidenceId}:normalized`)

  return {
    chunkId: deriveChunkId(versionId, chunkIndex, contentHash),
    scope,
    evidenceId,
    versionId,
    chunkIndex,
    text,
    contentHash,
    location: {
      span: textSpan(0, text.length),
      coordinateSpace: normalizedContentHash,
      page: options.page ?? null,
      sectionIndex: null,
      sectionLabel: null,
      lineStart: 1,
      lineEnd: 1,
    },
    provenance: {
      evidenceId,
      scope,
      versionId,
      rawContentHash,
      normalizedContentHash,
      normalizationVersion: NORMALIZATION_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      injectionScannerVersion: INJECTION_SCANNER_VERSION,
      sourceLabel: `${evidenceId}.txt`,
      mimeType: 'text/plain',
    },
    signals: options.signals ?? [],
  }
}

/** A critical injection signal, for quarantine tests. */
export function criticalSignal(span: readonly [number, number]): PromptInjectionSignal {
  return {
    kind: 'envelope_breakout',
    severity: 'critical',
    stage: 'normalized',
    span: textSpan(span[0], span[1]),
    ruleId: 'test-envelope-breakout',
    excerpt: '[redacted]',
    scannerVersion: INJECTION_SCANNER_VERSION,
  }
}

export function warningSignal(span: readonly [number, number]): PromptInjectionSignal {
  return {
    kind: 'capability_claim',
    severity: 'warning',
    stage: 'normalized',
    span: textSpan(span[0], span[1]),
    ruleId: 'test-capability-claim',
    excerpt: '[redacted]',
    scannerVersion: INJECTION_SCANNER_VERSION,
  }
}

export function versionIdOf(evidenceId: string, rawContent: string): ContentHash {
  return deriveVersionId(evidenceId, hashContent(rawContent))
}
