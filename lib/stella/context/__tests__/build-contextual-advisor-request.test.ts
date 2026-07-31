import { describe, expect, it } from 'vitest'
import { UnsupportedAdvisorPipelineStepError } from '../../advisor/steps'
import { buildContextualAdvisorRequest } from '../build-contextual-advisor-request'
import type { ContextualAdvisorContext } from '../types'

function context(): ContextualAdvisorContext {
  return {
    projectId: 'project-1', organizationId: 'organization-1', narrativeSummary: 'Original', outcomesSnapshot: [{ id: 'outcome-1', name: 'Outcome', description: '', stakeholderGroups: [] }],
    indicatorsSnapshot: [], stakeholderCount: 0, stakeholdersSnapshot: [], activitiesSummary: [], evidenceMetadata: [], evidenceTotal: 0,
    proxySummary: [], filterSetsSummary: [], calculationSnapshot: null, calculationReadiness: { ready: false, blockingReasons: [], warnings: [] },
    reportSections: [], projectCreatedAt: '', lastUpdatedAt: '',
  }
}

describe('buildContextualAdvisorRequest', () => {
  it('builds prompt, schema, serialized context, and canonical paths from one stable snapshot', () => {
    const input = context()
    const request = buildContextualAdvisorRequest('outcomes', input)

    expect(request.step).toBe('outcomes')
    expect(request.contextualData.context).toBe(request.serializedContext)
    expect(request.canonicalSourceFieldPaths).toContain('outcomesSnapshot[0].id')
    expect(request.systemPrompt).toContain('sourceFields')
    expect(request.internalResponseSchema.safeParse).toBeTypeOf('function')
  })

  it('isolates the request from later input and nested-array mutations without mutating input', () => {
    const input = context()
    const before = structuredClone(input)
    const request = buildContextualAdvisorRequest('outcomes', input)
    const mutableInput = input as unknown as { narrativeSummary: string; outcomesSnapshot: Array<{ id: string; name: string; description: string; stakeholderGroups: string[] }> }

    mutableInput.narrativeSummary = 'Changed'
    mutableInput.outcomesSnapshot[0].name = 'Changed outcome'
    mutableInput.outcomesSnapshot.push({ id: 'outcome-2', name: 'Second', description: '', stakeholderGroups: [] })

    expect(before.narrativeSummary).toBe('Original')
    expect(request.serializedContext.narrativeSummary).toBe('Original')
    expect(request.serializedContext.outcomesSnapshot?.[0]?.name).toBe('Outcome')
    expect(request.canonicalSourceFieldPaths).not.toContain('outcomesSnapshot[1].id')
  })

  it('does not let one request contaminate another and validates only its own paths', () => {
    const first = buildContextualAdvisorRequest('narrative', { ...context(), narrativeSummary: 'First' })
    const second = buildContextualAdvisorRequest('narrative', { ...context(), outcomesSnapshot: [] })

    expect(first.canonicalSourceFieldPaths).toContain('outcomesSnapshot[0].id')
    expect(second.canonicalSourceFieldPaths).not.toContain('outcomesSnapshot[0].id')
    expect(() => second.validateSourceFields({ findings: [{ sourceFields: ['outcomesSnapshot[0].id'] }], suggestions: [] })).toThrow()
  })

  it('rejects an unknown step before creating a partial request', () => {
    expect(() => buildContextualAdvisorRequest('unknown', context())).toThrow(UnsupportedAdvisorPipelineStepError)
  })
})
