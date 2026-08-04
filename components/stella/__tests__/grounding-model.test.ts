// components/stella/__tests__/grounding-model.test.ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  classifyFindingSupport,
  classifySuggestionSupport,
  buildEvidenceReferences,
  classifyAvailability,
  decisionStatusFromAction,
} from '../grounding-model'
import type { ContextualFinding, ContextualSuggestion } from '../StellaContextualAdvisorPanel'

function finding(overrides: Partial<ContextualFinding> = {}): ContextualFinding {
  return {
    id: 'f1',
    severity: 'info',
    title: 'Título',
    explanation: 'Explicación',
    sourceFields: [],
    ...overrides,
  }
}

function suggestion(overrides: Partial<ContextualSuggestion> = {}): ContextualSuggestion {
  return {
    id: 's1',
    proposedText: 'Texto propuesto',
    rationale: 'Motivo',
    missingInformation: [],
    sourceFields: [],
    ...overrides,
  }
}

describe('classifyFindingSupport', () => {
  it('is grounded when sourceFields cites real (non-.empty) paths', () => {
    expect(classifyFindingSupport(finding({ sourceFields: ['outcomesSnapshot[0].name'] }))).toBe('grounded')
  })

  it('is insufficient_evidence when sourceFields is empty', () => {
    expect(classifyFindingSupport(finding({ sourceFields: [] }))).toBe('insufficient_evidence')
  })

  it('is insufficient_evidence when every sourceField is an .empty sentinel', () => {
    expect(classifyFindingSupport(finding({ sourceFields: ['outcomesSnapshot.empty'] }))).toBe('insufficient_evidence')
  })

  it('is partially_grounded when sourceFields mixes real paths and .empty sentinels', () => {
    expect(
      classifyFindingSupport(finding({ sourceFields: ['outcomesSnapshot[0].name', 'indicatorsSnapshot.empty'] }))
    ).toBe('partially_grounded')
  })
})

describe('classifySuggestionSupport', () => {
  it('is insufficient_evidence (abstention) when proposedText is null, regardless of other fields', () => {
    expect(
      classifySuggestionSupport(suggestion({ proposedText: null, missingInformation: ['falta narrativa'] }))
    ).toBe('insufficient_evidence')
  })

  it('is grounded when proposedText exists, has real sourceFields, and no missingInformation', () => {
    expect(
      classifySuggestionSupport(suggestion({ sourceFields: ['narrativeSummary'], missingInformation: [] }))
    ).toBe('grounded')
  })

  it('is partially_grounded when proposedText exists with real sourceFields but missingInformation is non-empty', () => {
    expect(
      classifySuggestionSupport(
        suggestion({ sourceFields: ['narrativeSummary'], missingInformation: ['falta un indicador'] })
      )
    ).toBe('partially_grounded')
  })

  it('is partially_grounded (never grounded) when proposedText exists but sourceFields is empty and there are gaps', () => {
    expect(
      classifySuggestionSupport(suggestion({ sourceFields: [], missingInformation: ['falta contexto'] }))
    ).toBe('partially_grounded')
  })

  it('is insufficient_evidence when proposedText exists but sourceFields is empty and there are no gaps either', () => {
    expect(classifySuggestionSupport(suggestion({ sourceFields: [], missingInformation: [] }))).toBe(
      'insufficient_evidence'
    )
  })
})

describe('buildEvidenceReferences', () => {
  it('labels a known canonical path via sourceFieldLabel', () => {
    const refs = buildEvidenceReferences(['outcomesSnapshot[0].name'])
    expect(refs).toEqual([{ sourceField: 'outcomesSnapshot[0].name', label: 'Resultados › n.º 1 › nombre' }])
  })

  it('falls back to the raw path for a malformed / nonexistent citation without throwing', () => {
    const refs = buildEvidenceReferences(['not a canonical path!!'])
    expect(refs).toEqual([{ sourceField: 'not a canonical path!!', label: 'not a canonical path!!' }])
  })

  it('returns an empty array for an empty input', () => {
    expect(buildEvidenceReferences([])).toEqual([])
  })
})

describe('classifyAvailability', () => {
  it('maps DISABLED to unavailable', () => {
    expect(classifyAvailability('DISABLED')).toBe('unavailable')
  })
  it('maps UNAUTHORIZED to permission_denied', () => {
    expect(classifyAvailability('UNAUTHORIZED')).toBe('permission_denied')
  })
  it('maps QUOTA_EXCEEDED to quota_reached', () => {
    expect(classifyAvailability('QUOTA_EXCEEDED')).toBe('quota_reached')
  })
  it.each(['GEMINI_ERROR', 'TIMEOUT', 'PARSE_ERROR'] as const)('maps %s to provider_failure', (code) => {
    expect(classifyAvailability(code)).toBe('provider_failure')
  })
  it.each(['UNSUPPORTED_STEP', 'RATE_LIMITED', 'RATE_LIMIT_UNAVAILABLE', 'PAYLOAD_TOO_LARGE', 'AUDIT_ERROR', 'UNKNOWN_ERROR'] as const)(
    'maps %s to provider_failure (no dedicated bucket -- surfaced via the existing error taxonomy)',
    (code) => {
      expect(classifyAvailability(code)).toBe('provider_failure')
    }
  )
})

describe('decisionStatusFromAction', () => {
  it('defaults to user_approval_required when no action has happened yet', () => {
    expect(decisionStatusFromAction(null)).toBe('user_approval_required')
  })
  it.each(['accepted', 'accepted_edited', 'rejected', 'undone'] as const)('maps %s 1:1', (action) => {
    expect(decisionStatusFromAction(action)).toBe(action)
  })
  it("maps 'copied' back to user_approval_required (clipboard is not a decision)", () => {
    expect(decisionStatusFromAction('copied')).toBe('user_approval_required')
  })
})
