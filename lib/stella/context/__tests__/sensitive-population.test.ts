// lib/stella/context/__tests__/sensitive-population.test.ts
// Etapa A2.3 (STL-A23-011, DR-002/DR-003 aprobados 2026-07-26)

import { describe, it, expect } from 'vitest'
import {
  assessSensitiveData,
  isValidAggregateDeclaration,
  MINIMUM_SENSITIVE_GROUP_SIZE,
  QUASI_IDENTIFIER_CATEGORIES,
  type AggregateDataDeclaration,
} from '../sensitive-population'

function validDeclaration(overrides: Partial<AggregateDataDeclaration> = {}): AggregateDataDeclaration {
  return {
    sensitiveCategory: 'minors',
    aggregationLevel: 'aggregate',
    groupSize: 25,
    dimensions: [],
    sourceEntityType: 'stakeholder_group',
    sourceEntityId: 'sg-1',
    ...overrides,
  }
}

describe('MINIMUM_SENSITIVE_GROUP_SIZE', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(MINIMUM_SENSITIVE_GROUP_SIZE)).toBe(true)
    expect(MINIMUM_SENSITIVE_GROUP_SIZE).toBeGreaterThan(0)
  })

  it('is exactly 10 per the approved decision', () => {
    expect(MINIMUM_SENSITIVE_GROUP_SIZE).toBe(10)
  })
})

describe('assessSensitiveData — no sensitive population detected', () => {
  it('allows ordinary SROI thematic language about youth', () => {
    const result = assessSensitiveData('This program improves educational outcomes for young people in the region.')
    expect(result.category).toBe('none')
    expect(result.allowed).toBe(true)
  })

  it('allows ordinary SROI thematic language about health', () => {
    const result = assessSensitiveData('This project increases access to malaria treatment in the community.')
    expect(result.category).toBe('none')
    expect(result.allowed).toBe(true)
  })

  it('allows an outcome name mentioning youth/health themes with no numeric population statement', () => {
    const result = assessSensitiveData('Mejora en salud mental de jóvenes')
    expect(result.category).toBe('none')
    expect(result.allowed).toBe(true)
  })
})

describe('assessSensitiveData — individual-level signals always block', () => {
  it('blocks a minor-identifiable combination regardless of any declaration', () => {
    const result = assessSensitiveData('The student, 12 años old, described her experience.', validDeclaration())
    expect(result.aggregationStatus).toBe('individual')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('SENSITIVE_INDIVIDUAL_DATA_BLOCKED')
  })

  it('blocks individual health framing regardless of any declaration', () => {
    const result = assessSensitiveData('Maria fue diagnosticada con diabetes last year.', validDeclaration({ sensitiveCategory: 'health' }))
    expect(result.aggregationStatus).toBe('individual')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('SENSITIVE_INDIVIDUAL_DATA_BLOCKED')
  })

  it('never leaks the matched text into the assessment result', () => {
    const result = assessSensitiveData('The student, 12 años old, described her experience with a rare condition.')
    expect(JSON.stringify(result)).not.toContain('12 años')
  })
})

describe('assessSensitiveData — aggregate mention without a declaration', () => {
  it('blocks a digit-based aggregate mention of minors with no declaration', () => {
    const result = assessSensitiveData('The program served 50 niños in the last quarter.')
    expect(result.category).toBe('minors')
    expect(result.aggregationStatus).toBe('aggregate_unknown_size')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('SENSITIVE_GROUP_SIZE_REQUIRED')
  })

  it('blocks a word-number aggregate mention (evasion via spelled-out numbers)', () => {
    const result = assessSensitiveData('The clinic treated cincuenta pacientes this month.')
    expect(result.category).toBe('health')
    expect(result.aggregationStatus).toBe('aggregate_unknown_size')
    expect(result.allowed).toBe(false)
  })

  it('blocks even when a declaration is present but for the wrong entity/category', () => {
    const result = assessSensitiveData('The clinic treated 30 patients this month.', validDeclaration({ sensitiveCategory: 'minors' }))
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('SENSITIVE_GROUP_SIZE_REQUIRED')
  })
})

describe('assessSensitiveData — aggregate mention with a valid declaration', () => {
  it('allows an aggregate mention when the declared group size meets the minimum', () => {
    const result = assessSensitiveData('The program served 50 niños in the last quarter.', validDeclaration({ groupSize: 50 }))
    expect(result.aggregationStatus).toBe('aggregate_valid')
    expect(result.allowed).toBe(true)
    expect(result.groupSize).toBe(50)
  })

  it('blocks when the declared group size is below the minimum threshold', () => {
    const result = assessSensitiveData('The program served 5 niños in the last quarter.', validDeclaration({ groupSize: 5 }))
    expect(result.aggregationStatus).toBe('aggregate_below_threshold')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('SENSITIVE_GROUP_TOO_SMALL')
  })

  it('blocks when the declared group size equals one below the threshold', () => {
    const result = assessSensitiveData('The clinic treated 9 pacientes.', validDeclaration({ sensitiveCategory: 'health', groupSize: 9 }))
    expect(result.allowed).toBe(false)
  })

  it('allows when the declared group size equals exactly the threshold', () => {
    const result = assessSensitiveData('The clinic treated 10 pacientes.', validDeclaration({ sensitiveCategory: 'health', groupSize: 10 }))
    expect(result.allowed).toBe(true)
  })
})

describe('assessSensitiveData — reidentification risk from quasi-identifier combinations', () => {
  it('blocks when 2+ quasi-identifier dimensions co-occur even with a valid declaration', () => {
    const result = assessSensitiveData(
      'En enero de 2026, 50 estudiantes de la Escuela San Martin que tienen 8 años participaron.',
      validDeclaration({ groupSize: 50 }),
    )
    expect(result.aggregationStatus).toBe('reidentification_risk')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('SENSITIVE_REIDENTIFICATION_RISK')
    expect(result.quasiIdentifierCategories.length).toBeGreaterThanOrEqual(2)
  })

  it('does not block on a single quasi-identifier dimension alone (paired with a valid declaration)', () => {
    const result = assessSensitiveData('The program served 50 niñas in the last quarter.', validDeclaration({ groupSize: 50 }))
    expect(result.quasiIdentifierCategories).toEqual([QUASI_IDENTIFIER_CATEGORIES.genderMention])
    expect(result.allowed).toBe(true)
  })
})

describe('assessSensitiveData — individual narrative text is prohibited', () => {
  it('blocks a first-person quoted narrative naming a sensitive population theme (no exact age/diagnosis needed)', () => {
    const result = assessSensitiveData('Un participante dijo: "Soy un paciente que sobrevivio una enfermedad rara y este programa cambio mi vida."')
    expect(result.aggregationStatus).toBe('free_text_prohibited')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('SENSITIVE_FREE_TEXT_BLOCKED')
  })

  it('does not flag a plain thematic mention of patients with no narrative marker', () => {
    const result = assessSensitiveData('This clinic serves patients from across the region.')
    expect(result.category).toBe('none')
    expect(result.allowed).toBe(true)
  })
})

describe('isValidAggregateDeclaration — strict structural validation', () => {
  it('accepts a well-formed declaration', () => {
    expect(isValidAggregateDeclaration(validDeclaration())).toBe(true)
  })

  it('rejects a missing groupSize', () => {
    const { groupSize: _groupSize, ...rest } = validDeclaration()
    expect(isValidAggregateDeclaration(rest)).toBe(false)
  })

  it('rejects a non-integer groupSize', () => {
    expect(isValidAggregateDeclaration(validDeclaration({ groupSize: 12.5 }))).toBe(false)
  })

  it('rejects a zero or negative groupSize', () => {
    expect(isValidAggregateDeclaration(validDeclaration({ groupSize: 0 }))).toBe(false)
    expect(isValidAggregateDeclaration(validDeclaration({ groupSize: -5 }))).toBe(false)
  })

  it('rejects a missing sourceEntityId (no verifiable source)', () => {
    expect(isValidAggregateDeclaration(validDeclaration({ sourceEntityId: '' }))).toBe(false)
  })

  it('rejects an aggregationLevel that is not "aggregate"', () => {
    expect(isValidAggregateDeclaration({ ...validDeclaration(), aggregationLevel: 'individual' })).toBe(false)
  })

  it('rejects null and non-object values', () => {
    expect(isValidAggregateDeclaration(null)).toBe(false)
    expect(isValidAggregateDeclaration(undefined)).toBe(false)
    expect(isValidAggregateDeclaration('50')).toBe(false)
    expect(isValidAggregateDeclaration(50)).toBe(false)
  })

  it('rejects an invalid sensitiveCategory value', () => {
    expect(isValidAggregateDeclaration({ ...validDeclaration(), sensitiveCategory: 'other' })).toBe(false)
  })
})
