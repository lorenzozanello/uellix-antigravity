// lib/stella/aggregation/__tests__/policy.test.ts
// Etapa A2.3.1 (STL-A231-017)

import { describe, it, expect } from 'vitest'
import {
  SENSITIVE_AGGREGATION_POLICY_VERSION,
  MINIMUM_SENSITIVE_GROUP_SIZE,
  MINIMUM_GROUP_SIZE_BY_POLICY_VERSION,
  ALLOWED_SENSITIVE_ENTITY_TYPES,
  isAllowedSensitiveEntityType,
  ALLOWED_AGGREGATION_DIMENSIONS,
  MAX_AGGREGATION_DIMENSIONS,
  isHighRiskDimensionCombination,
  ALLOWED_COUNT_SOURCE_TYPES,
  isAllowedCountSourceType,
  computeGroupSizeBucket,
} from '../policy'

describe('MINIMUM_SENSITIVE_GROUP_SIZE', () => {
  it('is a positive integer equal to 10', () => {
    expect(Number.isInteger(MINIMUM_SENSITIVE_GROUP_SIZE)).toBe(true)
    expect(MINIMUM_SENSITIVE_GROUP_SIZE).toBe(10)
  })

  it('has a historical record for the current policy version', () => {
    expect(MINIMUM_GROUP_SIZE_BY_POLICY_VERSION[SENSITIVE_AGGREGATION_POLICY_VERSION]).toBe(MINIMUM_SENSITIVE_GROUP_SIZE)
  })
})

describe('isAllowedSensitiveEntityType', () => {
  it('accepts every value in ALLOWED_SENSITIVE_ENTITY_TYPES', () => {
    for (const t of ALLOWED_SENSITIVE_ENTITY_TYPES) expect(isAllowedSensitiveEntityType(t)).toBe(true)
  })

  it('rejects an arbitrary string (no free-form entity type)', () => {
    expect(isAllowedSensitiveEntityType('financial_proxy')).toBe(false)
    expect(isAllowedSensitiveEntityType('user')).toBe(false)
    expect(isAllowedSensitiveEntityType('')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isAllowedSensitiveEntityType(null)).toBe(false)
    expect(isAllowedSensitiveEntityType(undefined)).toBe(false)
    expect(isAllowedSensitiveEntityType(123)).toBe(false)
  })
})

describe('isAllowedCountSourceType', () => {
  it('accepts every value in ALLOWED_COUNT_SOURCE_TYPES', () => {
    for (const t of ALLOWED_COUNT_SOURCE_TYPES) expect(isAllowedCountSourceType(t)).toBe(true)
  })

  it('rejects an arbitrary string', () => {
    expect(isAllowedCountSourceType('stella_said_so')).toBe(false)
    expect(isAllowedCountSourceType('extracted_from_narrative')).toBe(false)
  })
})

describe('isHighRiskDimensionCombination', () => {
  it('flags gender + territory_level as high-risk', () => {
    expect(isHighRiskDimensionCombination(['gender', 'territory_level'])).toBe(true)
    expect(isHighRiskDimensionCombination(['territory_level', 'gender'])).toBe(true) // order-independent
  })

  it('flags age_band + condition_category as high-risk', () => {
    expect(isHighRiskDimensionCombination(['age_band', 'condition_category'])).toBe(true)
  })

  it('does not flag a single dimension', () => {
    expect(isHighRiskDimensionCombination(['gender'])).toBe(false)
  })

  it('does not flag an allowed, non-listed pair', () => {
    expect(isHighRiskDimensionCombination(['program_period', 'education_level_band'])).toBe(false)
  })

  it('does not flag an empty dimension list', () => {
    expect(isHighRiskDimensionCombination([])).toBe(false)
  })
})

describe('MAX_AGGREGATION_DIMENSIONS', () => {
  it('is a small, conservative positive integer', () => {
    expect(Number.isInteger(MAX_AGGREGATION_DIMENSIONS)).toBe(true)
    expect(MAX_AGGREGATION_DIMENSIONS).toBeGreaterThan(0)
    expect(MAX_AGGREGATION_DIMENSIONS).toBeLessThanOrEqual(3)
  })
})

describe('computeGroupSizeBucket', () => {
  it('classifies below the minimum as below_10', () => {
    expect(computeGroupSizeBucket(1)).toBe('below_10')
    expect(computeGroupSizeBucket(9)).toBe('below_10')
  })

  it('classifies 10-49 as 10_49', () => {
    expect(computeGroupSizeBucket(10)).toBe('10_49')
    expect(computeGroupSizeBucket(49)).toBe('10_49')
  })

  it('classifies 50-249 as 50_249', () => {
    expect(computeGroupSizeBucket(50)).toBe('50_249')
    expect(computeGroupSizeBucket(249)).toBe('50_249')
  })

  it('classifies 250+ as 250_plus', () => {
    expect(computeGroupSizeBucket(250)).toBe('250_plus')
    expect(computeGroupSizeBucket(100000)).toBe('250_plus')
  })
})

describe('ALLOWED_AGGREGATION_DIMENSIONS', () => {
  it('contains only structural category codes, never a value-shaped string', () => {
    for (const d of ALLOWED_AGGREGATION_DIMENSIONS) {
      // A structural code is a short snake_case identifier — never something
      // that looks like a school name, a number, or a free-text value.
      expect(d).toMatch(/^[a-z_]+$/)
      expect(d.length).toBeLessThan(30)
    }
  })
})
