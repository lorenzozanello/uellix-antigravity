// lib/stella/advisor/run-contextual-advisor.test.ts
// Trusted-step contract: runContextualAdvisor must canonicalize the
// provider's step against the requested step, never the reverse. This is
// the pure pipeline — no authorization involved, adapter is always injected.

import { describe, it, expect, vi } from 'vitest'
import { runContextualAdvisor } from './run-contextual-advisor'
import { buildContextualAdvisorRequest } from '../context/build-contextual-advisor-request'
import type { ContextualAdvisorContext } from '../context/types'
import type { StellaGeminiAdapter } from '../adapter/gemini-client'

function context(): ContextualAdvisorContext {
  return {
    projectId: 'project-1',
    organizationId: 'organization-1',
    narrativeSummary: 'Original',
    outcomesSnapshot: [{ id: 'outcome-1', name: 'Outcome', description: '', stakeholderGroups: [] }],
    indicatorsSnapshot: [],
    stakeholderCount: 0,
    stakeholdersSnapshot: [],
    activitiesSummary: [],
    evidenceMetadata: [],
    evidenceTotal: 0,
    proxySummary: [],
    filterSetsSummary: [],
    calculationSnapshot: null,
    calculationReadiness: { ready: false, blockingReasons: [], warnings: [] },
    reportSections: [],
    projectCreatedAt: '',
    lastUpdatedAt: '',
  }
}

function providerOutput(step: string, sourceRefIndexes: unknown[]) {
  return {
    step,
    responseType: 'review',
    summary: 'Resumen',
    findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'Texto', sourceRefIndexes }],
    suggestions: [{ id: 's', proposedText: null, rationale: 'Razón', missingInformation: [], sourceRefIndexes }],
    clarifyingQuestions: [],
    limitations: [],
    requiresHumanReview: true,
  }
}

function mockAdapter(rawOutput: unknown): { adapter: StellaGeminiAdapter; generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn().mockResolvedValue({
    role: 'advisor',
    rawOutput: JSON.stringify(rawOutput),
    parsedOutput: null,
    modelUsed: 'mock-model',
    timestamp: new Date(),
  })
  return { adapter: { generate, parseResponse: vi.fn(), isReady: vi.fn().mockReturnValue(true) } as unknown as StellaGeminiAdapter, generate }
}

describe('runContextualAdvisor — trusted step contract', () => {
  it('canonicalizes a provider-translated step against the requested step', async () => {
    const { adapter, generate } = mockAdapter(providerOutput('narrativa', [0]))

    const result = await runContextualAdvisor('narrative', context(), adapter)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.step).toBe('narrative')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('does not mutate the raw provider response while canonicalizing the step', async () => {
    const raw = providerOutput('narrativa', [0])
    const before = structuredClone(raw)
    const { adapter } = mockAdapter(raw)

    await runContextualAdvisor('narrative', context(), adapter)

    expect(raw).toEqual(before)
    expect(raw.step).toBe('narrativa')
  })

  it('decodes valid source references into internal sourceFields', async () => {
    const canonicalPaths = buildContextualAdvisorRequest('narrative', context()).canonicalSourceFieldPaths
    const narrativeIndex = canonicalPaths.indexOf('narrativeSummary')
    expect(narrativeIndex).toBeGreaterThanOrEqual(0)
    const { adapter } = mockAdapter(providerOutput('narrative', [narrativeIndex]))

    const result = await runContextualAdvisor('narrative', context(), adapter)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.findings[0].sourceFields).toEqual(['narrativeSummary'])
      expect(result.data.findings[0]).not.toHaveProperty('sourceRefIndexes')
    }
  })

  it('fails closed on an out-of-range source reference index regardless of step canonicalization', async () => {
    const { adapter, generate } = mockAdapter(providerOutput('narrative', [99]))

    const result = await runContextualAdvisor('narrative', context(), adapter)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('PARSE_ERROR')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('never calls a real provider — only the injected adapter mock', async () => {
    const { adapter, generate } = mockAdapter(providerOutput('narrative', []))

    await runContextualAdvisor('narrative', context(), adapter)

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0]).toMatchObject({ role: 'advisor' })
  })

  it('returns modelUsed and tokensUsed from the provider response for the audit trail', async () => {
    const generate = vi.fn().mockResolvedValue({
      role: 'advisor',
      rawOutput: JSON.stringify(providerOutput('narrative', [])),
      parsedOutput: null,
      modelUsed: 'gemini-2.5-flash',
      tokensUsed: 42,
      timestamp: new Date(),
    })
    const adapter = { generate, parseResponse: vi.fn(), isReady: vi.fn().mockReturnValue(true) } as unknown as StellaGeminiAdapter

    const result = await runContextualAdvisor('narrative', context(), adapter)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.modelUsed).toBe('gemini-2.5-flash')
      expect(result.tokensUsed).toBe(42)
    }
  })
})
