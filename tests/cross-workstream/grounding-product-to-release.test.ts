// tests/cross-workstream/grounding-product-to-release.test.ts
// INTEGRATION (Stella parallel train 2) — the GROUNDING/PRODUCT → RELEASE seam.
//
// This is the seam that actually broke during this integration, so it gets the
// most specific tests. RELEASE built its `availableChunks` map by hand against
// the pre-merge signature `{ contentHash, organizationId }`; GROUNDING replaced
// it with `CitableChunkRecord`, which carries the FULL scope. The harness
// compiled fine in RELEASE's worktree and threw at the first merged run.
//
// The lesson these tests encode is narrow and worth stating: an eval harness
// that RE-DECLARES the shape it is judging cannot detect that the shape moved.
// It has to consume the producing line's own projection.
//
// What these tests do NOT do is treat fixtures as a substitute for a runtime
// that does not exist. There is no retrieval service and no provider call in
// this tree; these assert the harness measures the CONTRACT correctly, and the
// harness itself already declares which of its metrics are unmeasurable offline
// and why.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  PIPELINE_VERSIONS,
  deriveChunkId,
  hashContent,
  toCitableChunkRecord,
  validateAnswerCitations,
} from '@/lib/grounding/contracts'
import {
  ALPHA_PROJECT_ONE_CHUNK,
  ALPHA_PROJECT_TWO_CHUNK,
  BETA_PROJECT_ONE_CHUNK,
  GROUNDED_ANSWER,
} from '@/tests/eval/stella-release/fixtures'
import {
  evaluateProjectScopeEnforcement,
  evaluateCanonicalProvenance,
  runReleaseEvalHarness,
} from '@/tests/eval/stella-release/harness'
import { RELEASE_EVAL_MATRIX } from '@/tests/eval/stella-release/matrix'
import type { ReleaseEvalMetric } from '@/tests/eval/stella-release/matrix'

const HARNESS_SOURCE = readFileSync(
  path.join(process.cwd(), 'tests/eval/stella-release/harness.ts'),
  'utf8',
)
const FIXTURES_SOURCE = readFileSync(
  path.join(process.cwd(), 'tests/eval/stella-release/fixtures.ts'),
  'utf8',
)

// ---------------------------------------------------------------------------
// 1. RELEASE fixtures are built from the canonical contracts
// ---------------------------------------------------------------------------

describe('GROUNDING/PRODUCT → RELEASE: fixtures use the canonical contracts', () => {
  it('every release chunk fixture closes its own verification chain', () => {
    for (const chunk of [ALPHA_PROJECT_ONE_CHUNK, ALPHA_PROJECT_TWO_CHUNK, BETA_PROJECT_ONE_CHUNK]) {
      expect(evaluateCanonicalProvenance(chunk)).toEqual([])
      // Re-derived here with GROUNDING's own primitives, not with the harness's
      // — so a fixture that only satisfies the harness's idea of a chunk fails.
      expect(chunk.contentHash).toBe(hashContent(chunk.text))
      expect(chunk.chunkId).toBe(
        deriveChunkId(chunk.versionId, chunk.chunkIndex, chunk.contentHash),
      )
    }
  })

  it('fixtures carry the CURRENT pipeline versions, so a pipeline bump invalidates them loudly', () => {
    for (const chunk of [ALPHA_PROJECT_ONE_CHUNK, ALPHA_PROJECT_TWO_CHUNK, BETA_PROJECT_ONE_CHUNK]) {
      expect(chunk.provenance.normalizationVersion).toBe(PIPELINE_VERSIONS.normalization)
      expect(chunk.provenance.chunkerVersion).toBe(PIPELINE_VERSIONS.chunker)
    }
  })

  it('builds fixtures through the published helpers rather than casting literals into shape', () => {
    expect(FIXTURES_SOURCE).toMatch(/from '@\/lib\/grounding\/contracts'/)
    expect(FIXTURES_SOURCE).toMatch(/hashContent\(/)
    expect(FIXTURES_SOURCE).toMatch(/deriveChunkId\(/)
  })
})

// ---------------------------------------------------------------------------
// 2. RELEASE does not reimplement provenance
// ---------------------------------------------------------------------------

describe('GROUNDING/PRODUCT → RELEASE: no second implementation of provenance', () => {
  it('projects citable records through GROUNDING’s helper instead of assembling them by hand', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. A hand-built map compiles, and omits
    // exactly the field (`scope`) whose omission was finding A-F1.
    expect(HARNESS_SOURCE).toMatch(/toCitableChunkRecord\(/)
    expect(HARNESS_SOURCE).not.toMatch(
      /\{\s*contentHash:\s*c\.contentHash,\s*organizationId:/,
    )
  })

  it('does not define its own hashing, chunk-id derivation or scope containment', () => {
    const code = HARNESS_SOURCE.split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
    expect(code).not.toMatch(/function\s+(hashContent|deriveChunkId|scopeContains)\b/)
    expect(code).not.toMatch(/createHash\(/)
    // It must IMPORT them instead.
    expect(code).toMatch(/import \{[\s\S]*?scopeContains[\s\S]*?\} from '@\/lib\/grounding\/contracts'/)
  })

  it('does not restate the relevance thresholds it would then be judging', () => {
    const code = HARNESS_SOURCE.split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
    expect(code).not.toMatch(/product-relevance|RELEVANCE_HIGH_MIN_SCORE|RELEVANCE_MEDIUM_MIN_SCORE/)
  })
})

// ---------------------------------------------------------------------------
// 3. The isolation check fails on a cross-project citation
// ---------------------------------------------------------------------------

describe('GROUNDING/PRODUCT → RELEASE: isolation', () => {
  const readerScope = ALPHA_PROJECT_ONE_CHUNK.scope

  it('reports a sibling-project chunk as crossing the reader scope', () => {
    const answer = {
      ...GROUNDED_ANSWER,
      assertions: [
        {
          kind: 'evidence' as const,
          statement: 'Afirmación con una cita del proyecto vecino.',
          citations: [
            {
              chunkId: ALPHA_PROJECT_TWO_CHUNK.chunkId,
              evidenceId: ALPHA_PROJECT_TWO_CHUNK.evidenceId,
              versionId: ALPHA_PROJECT_TWO_CHUNK.versionId,
              quotedTextHash: ALPHA_PROJECT_TWO_CHUNK.contentHash,
              location: ALPHA_PROJECT_TWO_CHUNK.location,
            },
          ],
        },
      ],
    }
    const chunks = new Map([[ALPHA_PROJECT_TWO_CHUNK.chunkId, ALPHA_PROJECT_TWO_CHUNK]])

    const violations = evaluateProjectScopeEnforcement(answer as never, chunks, readerScope)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/crosses the reader scope/)
  })

  it('and GROUNDING’s own validator now reports it too — the two agree (A-F1 closed)', () => {
    const answer = {
      ...GROUNDED_ANSWER,
      assertions: [
        {
          kind: 'evidence' as const,
          statement: 'Afirmación con una cita de otra organización.',
          citations: [
            {
              chunkId: BETA_PROJECT_ONE_CHUNK.chunkId,
              evidenceId: BETA_PROJECT_ONE_CHUNK.evidenceId,
              versionId: BETA_PROJECT_ONE_CHUNK.versionId,
              quotedTextHash: BETA_PROJECT_ONE_CHUNK.contentHash,
              location: BETA_PROJECT_ONE_CHUNK.location,
            },
          ],
        },
      ],
    }
    const available = new Map([
      [BETA_PROJECT_ONE_CHUNK.chunkId, toCitableChunkRecord(BETA_PROJECT_ONE_CHUNK)],
    ])
    const issues = validateAnswerCitations(answer as never, available)
    expect(issues.map((i) => i.code)).toContain('citation_out_of_scope')
  })

  it('a clean, in-scope answer produces no violations — the check discriminates', () => {
    const chunks = new Map([[ALPHA_PROJECT_ONE_CHUNK.chunkId, ALPHA_PROJECT_ONE_CHUNK]])
    expect(evaluateProjectScopeEnforcement(GROUNDED_ANSWER, chunks, readerScope)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Citation metrics recognise the integrated shape
// ---------------------------------------------------------------------------

describe('GROUNDING/PRODUCT → RELEASE: metrics over the integrated shape', () => {
  const run = runReleaseEvalHarness()
  const report = run.summary
  const results = run.results

  it('runs every matrix check against the merged tree with zero failures', () => {
    expect(results).toHaveLength(RELEASE_EVAL_MATRIX.length)
    expect(report.failed).toBe(0)
    expect(report.isolationViolations).toBe(0)
    expect(report.systemErrors).toBe(0)
  })

  it('emits citation-precision and citation-coverage as real numbers, not nulls', () => {
    const byName = new Map(report.metrics.map((m) => [m.metric, m]))
    const required: readonly ReleaseEvalMetric[] = ['citation-precision', 'citation-coverage']
    for (const name of required) {
      const metric = byName.get(name)
      expect(metric, `${name} was not emitted`).toBeTruthy()
      expect(metric!.measurable).toBe(true)
      expect(typeof metric!.value).toBe('number')
    }
  })

  it('keeps every provider-dependent metric null WITH a structured reason — no fabricated baseline', () => {
    const byName = new Map(report.metrics.map((m) => [m.metric, m]))
    const providerDependent: readonly ReleaseEvalMetric[] = [
      'latency',
      'token-usage',
      'estimated-provider-cost',
    ]
    for (const name of providerDependent) {
      const metric = byName.get(name)!
      expect(metric.value).toBeNull()
      expect(metric.nullReason?.code).toBeTruthy()
    }
    expect(report.providerCalls).toBe(0)
  })

  it('detects every negative control, and there is at least one per grounding check', () => {
    expect(report.negativeControlsUndetected).toBe(0)
    const groundingChecks = results.filter((r) => r.checkId.startsWith('grounding-'))
    expect(groundingChecks.length).toBeGreaterThan(0)
    for (const check of groundingChecks) {
      expect(check.negativeControls.length, `${check.checkId} has no negative control`).toBeGreaterThan(0)
    }
  })

  it('declares no tautological check', () => {
    expect(report.tautologicalChecks).toEqual([])
  })
})
