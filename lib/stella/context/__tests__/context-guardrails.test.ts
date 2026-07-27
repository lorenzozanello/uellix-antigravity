// lib/stella/context/__tests__/context-guardrails.test.ts
// Etapa A1 (STL-A1-007) — this is the deterministic control described in
// STELLA_THREAT_MODEL.md's threat T3/I3: it must fail CLOSED on a tampered
// context, and pass silently on a normal one, without depending on the model.
//
// Etapa A2.3.1 (STL-A231-013): assertContextHasNoForbiddenData is now async
// (an aggregate-mention case may need a DB read, scoped to the exact
// entity, to resolve a verified declaration). Etapa A2.3.2 (STL-A232-008)
// batches that read via findValidSensitiveAggregationDeclarations (plural) —
// mocked here; canonicalDeclarationKey is kept real (pure, no DB) via
// importOriginal. This file only exercises the deterministic classification
// and wiring, not the real DB lookup (that is covered by the RLS/integration
// suite and by lib/stella/aggregation's own unit tests).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StellaContextGuardrailError } from '../../errors'
import type { StellaProjectContext } from '../types'

const mockFindValidDeclarations = vi.fn()
vi.mock('../../aggregation/declaration-query', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../aggregation/declaration-query')>()
  return {
    ...original,
    findValidSensitiveAggregationDeclarations: (...args: unknown[]) => mockFindValidDeclarations(...args),
  }
})

import { assertContextHasNoForbiddenData } from '../context-guardrails'

function baseContext(overrides: Partial<StellaProjectContext> = {}): StellaProjectContext {
  return {
    projectId: 'proj-1',
    organizationId: 'org-1',
    narrativeSummary: 'A short, normal narrative.',
    outcomesSnapshot: [{ id: 'o-1', name: 'Outcome', description: 'desc', stakeholderGroups: [] }],
    indicatorsSnapshot: [],
    stakeholderCount: 0,
    evidenceMetadata: [
      { id: 'e-1', title: 'Evidence', type: 'file', status: 'approved', contentHashTruncated: 'abcd1234', createdAt: '2026-01-01T00:00:00Z' },
    ],
    evidenceTotal: 1,
    proxySummary: [{ id: 'p-1', name: 'Proxy', source: 'Source', value: '', currency: '' }],
    filterSetsSummary: [],
    calculationSnapshot: null,
    reportSections: [],
    projectCreatedAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('assertContextHasNoForbiddenData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no declaration exists for any entity — matches production
    // reality until a real declaration is created via the aggregation actions.
    mockFindValidDeclarations.mockResolvedValue(new Map())
  })

  it('passes silently for a normal, well-formed context', async () => {
    await expect(assertContextHasNoForbiddenData(baseContext())).resolves.toBeUndefined()
  })

  it('throws if a proxy carries a non-empty financial value', async () => {
    const context = baseContext({
      proxySummary: [{ id: 'p-1', name: 'Proxy', source: 'Source', value: '12.50', currency: '' }],
    })
    await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
  })

  it('throws if a proxy carries a non-empty currency', async () => {
    const context = baseContext({
      proxySummary: [{ id: 'p-1', name: 'Proxy', source: 'Source', value: '', currency: 'USD' }],
    })
    await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
  })

  it('throws if narrativeSummary exceeds the sanitization ceiling', async () => {
    const context = baseContext({ narrativeSummary: 'x'.repeat(3000) })
    await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
  })

  it('throws if an evidence hash is longer than the truncation ceiling', async () => {
    const context = baseContext({
      evidenceMetadata: [
        {
          id: 'e-1',
          title: 'Evidence',
          type: 'file',
          status: 'approved',
          // 64-char full SHA-256 instead of an 8-char truncation.
          contentHashTruncated: 'a'.repeat(64),
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    })
    await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
  })

  it('throws if a forbidden pattern slipped through per-field sanitization', async () => {
    const context = baseContext({
      outcomesSnapshot: [{ id: 'o-1', name: 'Contains GEMINI_API_KEY reference', description: '', stakeholderGroups: [] }],
    })
    await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
  })

  it('does not throw on an 8-char truncated hash (the expected, correct case)', async () => {
    const context = baseContext({
      evidenceMetadata: [
        { id: 'e-1', title: 'Evidence', type: 'file', status: 'approved', contentHashTruncated: '12345678', createdAt: '2026-01-01T00:00:00Z' },
      ],
    })
    await expect(assertContextHasNoForbiddenData(context)).resolves.toBeUndefined()
  })

  it('scans report section titles too (STL-A231-013: previously unscanned field)', async () => {
    const context = baseContext({
      reportSections: [{ id: 's-1', sectionType: 'executive_summary', title: 'Contains GEMINI_API_KEY reference', contentLength: 0, status: 'draft' }],
    })
    await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
  })

  // Etapa A2 (STL-A2-008, DR-001 approved 2026-07-25): high-risk PII blocks
  // fail-closed. The narrative is the field most likely to carry free text.
  describe('high-risk PII (DR-001) — fails closed', () => {
    it('throws when the narrative contains a government ID keyword', async () => {
      const context = baseContext({ narrativeSummary: 'Please provide your DNI number for verification.' })
      await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
    })

    it('throws when an outcome name contains a minor-identifiable combination', async () => {
      const context = baseContext({
        outcomesSnapshot: [{ id: 'o-1', name: 'The student, 12 años old, improved test scores', description: '', stakeholderGroups: [] }],
      })
      await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
    })

    it('throws when the narrative contains individual health framing', async () => {
      const context = baseContext({ narrativeSummary: 'Maria fue diagnosticada con diabetes last year.' })
      await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
    })

    it('never includes the matched PII value in the thrown error message', async () => {
      const context = baseContext({ narrativeSummary: 'Please provide your DNI number for verification.' })
      try {
        await assertContextHasNoForbiddenData(context)
        expect.fail('expected assertContextHasNoForbiddenData to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(StellaContextGuardrailError)
        expect((e as Error).message).not.toContain('DNI number for verification')
        expect((e as Error).message).toContain('governmentId')
      }
    })

    it('does not throw on ordinary narrative text with no PII', async () => {
      const context = baseContext({ narrativeSummary: 'This project improves employment outcomes for youth in the region.' })
      await expect(assertContextHasNoForbiddenData(context)).resolves.toBeUndefined()
    })
  })

  describe('common PII (DR-001) — does not block by itself', () => {
    it('does not throw when the narrative contains only a common-tier email/phone', async () => {
      const context = baseContext({ narrativeSummary: 'Contact jane.doe@example.com or +1 555-123-4567 for details.' })
      await expect(assertContextHasNoForbiddenData(context)).resolves.toBeUndefined()
    })
  })

  // Etapa A2.3.1 (STL-A231-013/014, DR-002/DR-003): a verified aggregation
  // declaration, scoped to the exact entity, unblocks an aggregate mention.
  describe('sensitive-population aggregation (Etapa A2.3.1) — declaration integration', () => {
    it('blocks an aggregate mention with no declaration (unchanged fail-closed behavior)', async () => {
      const context = baseContext({ narrativeSummary: 'The program served 50 niños in the last quarter.' })
      await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
      expect(mockFindValidDeclarations).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          projectId: 'proj-1',
          refs: [expect.objectContaining({ entityType: 'project', entityId: 'proj-1', sensitiveCategory: 'minors' })],
        }),
      )
    })

    it('allows an aggregate mention when a valid declaration is found for the SAME entity', async () => {
      mockFindValidDeclarations.mockResolvedValue(
        new Map([
          [
            'project:proj-1:minors',
            { sensitiveCategory: 'minors', aggregationLevel: 'aggregate', groupSize: 50, dimensions: [], sourceEntityType: 'project', sourceEntityId: 'proj-1' },
          ],
        ]),
      )
      const context = baseContext({ narrativeSummary: 'The program served 50 niños in the last quarter.' })
      await expect(assertContextHasNoForbiddenData(context)).resolves.toBeUndefined()
    })

    it('still blocks a minor-identifiable individual mention even when a declaration lookup would return valid (never consulted)', async () => {
      const context = baseContext({ narrativeSummary: 'The student, 12 años old, described her experience.' })
      await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
      expect(mockFindValidDeclarations).not.toHaveBeenCalled()
    })

    it('scopes the declaration lookup to the specific outcome entity, not the whole project', async () => {
      const context = baseContext({
        outcomesSnapshot: [{ id: 'outcome-42', name: 'Served 50 niños this year', description: '', stakeholderGroups: [] }],
      })
      await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
      expect(mockFindValidDeclarations).toHaveBeenCalledWith(
        expect.objectContaining({
          refs: [expect.objectContaining({ entityType: 'outcome', entityId: 'outcome-42' })],
        }),
      )
    })

    it('never includes a financial-proxy ref in the batch (not an allowed entity type) — still blocks', async () => {
      const context = baseContext({
        proxySummary: [{ id: 'proxy-1', name: 'Cost proxy for 50 niños cohort', source: 'HACT', value: '', currency: '' }],
      })
      await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
      // The batch call still happens (there IS a pending aggregate mention —
      // the proxy one — even though it can never resolve to a declaration),
      // but its `refs` array excludes the proxy entity type entirely.
      expect(mockFindValidDeclarations).toHaveBeenCalledWith(expect.objectContaining({ refs: [] }))
    })

    it('batches multiple aggregate mentions into a SINGLE call to findValidSensitiveAggregationDeclarations', async () => {
      const context = baseContext({
        narrativeSummary: 'The program served 50 niños in the last quarter.',
        outcomesSnapshot: [
          { id: 'outcome-1', name: 'Served 30 niños this year', description: '', stakeholderGroups: [] },
          { id: 'outcome-2', name: 'Treated 40 pacientes this year', description: '', stakeholderGroups: [] },
        ],
      })
      await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)
      expect(mockFindValidDeclarations).toHaveBeenCalledTimes(1)
      const call = mockFindValidDeclarations.mock.calls[0][0]
      expect(call.refs.length).toBeGreaterThanOrEqual(3)
    })
  })
})
