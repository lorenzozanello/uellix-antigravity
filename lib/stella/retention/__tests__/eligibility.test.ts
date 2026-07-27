// lib/stella/retention/__tests__/eligibility.test.ts
// Etapa A2.4 (DR-004) — pure eligibility function, no DB, injectable clock.

import { describe, it, expect } from 'vitest'
import { evaluateRetentionEligibility } from '../eligibility'
import { isValidResponseRetentionMonths, CURRENT_STELLA_RETENTION_POLICY, type StellaRetentionPolicy } from '../policy'

const NOW = new Date('2026-07-26T00:00:00.000Z')

function monthsAgo(months: number, from: Date = NOW): Date {
  const d = new Date(from.getTime())
  d.setUTCMonth(d.getUTCMonth() - months)
  return d
}

describe('evaluateRetentionEligibility', () => {
  describe('boundary at the default (24 months)', () => {
    it('23 months old is not_expired', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(23),
        purgedAt: null,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result).toEqual({ eligible: false, reason: 'not_expired', expiresAt: expect.any(Date) })
    })

    it('exactly 24 months old is expired/eligible (boundary counts as expired)', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(24),
        purgedAt: null,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result.eligible).toBe(true)
      expect(result.reason).toBe('expired')
    })

    it('25 months old is expired/eligible', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(25),
        purgedAt: null,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result.eligible).toBe(true)
      expect(result.reason).toBe('expired')
    })
  })

  describe('holds', () => {
    it('an active hold blocks an otherwise-expired interaction', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(30),
        purgedAt: null,
        holdStatus: 'active',
        now: NOW,
      })
      expect(result).toEqual({ eligible: false, reason: 'active_hold', expiresAt: expect.any(Date) })
    })

    it('a resolved (expired or released) hold — caller passes holdStatus "none" — does not block', () => {
      // The caller is responsible for reducing a hold's own lifecycle
      // (active/expired/released) to a boolean-ish holdStatus before calling
      // this pure function — this function only ever sees the final verdict.
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(30),
        purgedAt: null,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result.eligible).toBe(true)
    })
  })

  it('already purged is never eligible again', () => {
    const result = evaluateRetentionEligibility({
      category: 'interaction_response_content',
      createdAt: monthsAgo(30),
      purgedAt: monthsAgo(1),
      holdStatus: 'none',
      now: NOW,
    })
    expect(result).toEqual({ eligible: false, reason: 'already_purged' })
  })

  describe('invalid input — fail closed', () => {
    it('an invalid createdAt is never eligible', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: new Date('not-a-date'),
        purgedAt: null,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result).toEqual({ eligible: false, reason: 'invalid_timestamp' })
    })

    it('an invalid purgedAt is never eligible', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(30),
        purgedAt: new Date('not-a-date'),
        holdStatus: 'none',
        now: NOW,
      })
      expect(result).toEqual({ eligible: false, reason: 'invalid_timestamp' })
    })

    it('a missing/invalid policy (organizationRetentionMonths out of bounds) is never eligible', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(30),
        purgedAt: null,
        organizationRetentionMonths: 0,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result).toEqual({ eligible: false, reason: 'missing_policy' })
    })

    it('an unsupported category never becomes eligible under this function', () => {
      const result = evaluateRetentionEligibility({
        category: 'audit_logs',
        createdAt: monthsAgo(100),
        purgedAt: null,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result).toEqual({ eligible: false, reason: 'unsupported_category' })
    })
  })

  describe('organization override', () => {
    it('an organization with no override uses the policy default (24 months)', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(24),
        purgedAt: null,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result.eligible).toBe(true)
    })

    it('a valid organization override changes the threshold (12 months, 13 months old → eligible)', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(13),
        purgedAt: null,
        organizationRetentionMonths: 12,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result.eligible).toBe(true)
    })

    it('a valid organization override changes the threshold (36 months, 30 months old → not yet eligible)', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(30),
        purgedAt: null,
        organizationRetentionMonths: 36,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result.eligible).toBe(false)
      expect(result.reason).toBe('not_expired')
    })

    it('an organization override outside the policy bounds (61 months) fails closed as missing_policy', () => {
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(100),
        purgedAt: null,
        organizationRetentionMonths: 61,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result).toEqual({ eligible: false, reason: 'missing_policy' })
    })
  })

  describe('policy injection — never mutates the production constant', () => {
    it('a fixture policy with a narrower bound rejects a value the real policy would accept', () => {
      const narrowPolicy: StellaRetentionPolicy = { policyVersion: 'v2-test', defaultResponseRetentionMonths: 24, minResponseRetentionMonths: 1, maxResponseRetentionMonths: 12 }
      const result = evaluateRetentionEligibility({
        category: 'interaction_response_content',
        createdAt: monthsAgo(30),
        purgedAt: null,
        organizationRetentionMonths: 24,
        currentPolicy: narrowPolicy,
        holdStatus: 'none',
        now: NOW,
      })
      expect(result).toEqual({ eligible: false, reason: 'missing_policy' })
      expect(isValidResponseRetentionMonths(24)).toBe(true) // still valid under the REAL policy
      expect(CURRENT_STELLA_RETENTION_POLICY.maxResponseRetentionMonths).toBe(60) // untouched
    })
  })
})
