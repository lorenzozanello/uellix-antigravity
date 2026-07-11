// lib/pipeline/methodology-review.test.ts
import { describe, it, expect } from 'vitest'
import {
  computeReadinessScore,
  getReviewChecklistTemplate,
  PIPELINE_REVIEW_STEPS,
} from './methodology-review'

describe('computeReadinessScore', () => {
  it('returns 100 when every applicable item passes', () => {
    const score = computeReadinessScore([
      { status: 'pass', severity: 'low' },
      { status: 'pass', severity: 'high' },
    ])
    expect(score).toBe(100)
  })

  it('returns 0 when every applicable item fails', () => {
    const score = computeReadinessScore([
      { status: 'fail', severity: 'low' },
      { status: 'fail', severity: 'high' },
    ])
    expect(score).toBe(0)
  })

  it('gives half credit for a warning', () => {
    const score = computeReadinessScore([{ status: 'warning', severity: 'medium' }])
    expect(score).toBe(50)
  })

  it('weights higher-severity items more heavily', () => {
    // low-severity pass (weight 1, credit 1) + high-severity fail (weight 3, credit 0)
    // = 1 earned / 4 possible = 25
    const score = computeReadinessScore([
      { status: 'pass', severity: 'low' },
      { status: 'fail', severity: 'high' },
    ])
    expect(score).toBe(25)
  })

  it('excludes not_applicable items from the calculation', () => {
    // Only the passing item counts; the NA item is removed from the denominator.
    const score = computeReadinessScore([
      { status: 'pass', severity: 'medium' },
      { status: 'not_applicable', severity: 'high' },
    ])
    expect(score).toBe(100)
  })

  it('returns null when there are no items to assess', () => {
    expect(computeReadinessScore([])).toBeNull()
  })

  it('returns null when every item is not_applicable', () => {
    const score = computeReadinessScore([
      { status: 'not_applicable', severity: 'low' },
      { status: 'not_applicable', severity: 'high' },
    ])
    expect(score).toBeNull()
  })

  it('rounds to the nearest integer', () => {
    // two medium items: one pass (2), one fail (0) = 2/4 = 50; add a low warning
    // (weight 1, credit 0.5 = 0.5) → earned 2.5 / possible 5 = 50
    const score = computeReadinessScore([
      { status: 'pass', severity: 'medium' },
      { status: 'fail', severity: 'medium' },
      { status: 'warning', severity: 'low' },
    ])
    expect(score).toBe(50)
  })
})

describe('getReviewChecklistTemplate', () => {
  it('returns a non-empty checklist for a known pipeline step', () => {
    const template = getReviewChecklistTemplate('evidence')
    expect(template.length).toBeGreaterThan(0)
    expect(template[0]).toHaveProperty('itemKey')
    expect(template[0]).toHaveProperty('label')
    expect(template[0]).toHaveProperty('defaultSeverity')
  })

  it('every declared pipeline step has a non-empty template with unique itemKeys', () => {
    for (const step of PIPELINE_REVIEW_STEPS) {
      const template = getReviewChecklistTemplate(step)
      expect(template.length, `step ${step} must have items`).toBeGreaterThan(0)
      const keys = template.map((item) => item.itemKey)
      expect(new Set(keys).size, `step ${step} has duplicate itemKeys`).toBe(keys.length)
    }
  })
})
