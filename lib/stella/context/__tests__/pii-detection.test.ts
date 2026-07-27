// lib/stella/context/__tests__/pii-detection.test.ts
// Etapa A2 (STL-A2-007)

import { describe, it, expect } from 'vitest'
import { detectCommonPii, detectHighRiskPii, redactCommonPii } from '../pii-detection'

describe('detectCommonPii', () => {
  it('detects an email address', () => {
    const matches = detectCommonPii('Contact me at jane.doe@example.com for details.')
    expect(matches.some((m) => m.category === 'email')).toBe(true)
  })

  it('detects a phone number', () => {
    const matches = detectCommonPii('Call +1 555-123-4567 for support.')
    expect(matches.some((m) => m.category === 'phone')).toBe(true)
  })

  it('detects a precise address', () => {
    const matches = detectCommonPii('The office is at Calle Principal #123 in the city center.')
    expect(matches.some((m) => m.category === 'preciseAddress')).toBe(true)
  })

  it('detects a bare 6-12 digit ID number', () => {
    const matches = detectCommonPii('Reference number 8823910 was assigned to the case.')
    expect(matches.some((m) => m.category === 'genericId')).toBe(true)
  })

  it('does not flag ordinary narrative text with no PII', () => {
    const matches = detectCommonPii('This project improves employment outcomes for youth in the region.')
    expect(matches).toHaveLength(0)
  })

  it('does not double-count a 13+ digit sequence as genericId', () => {
    const matches = detectCommonPii('Card ending in 4111111111111111 was declined.')
    expect(matches.some((m) => m.category === 'genericId')).toBe(false)
  })
})

describe('detectHighRiskPii', () => {
  it('detects a government ID keyword', () => {
    const matches = detectHighRiskPii('Please provide your DNI number for verification.')
    expect(matches.some((m) => m.category === 'governmentId')).toBe(true)
  })

  it('detects a credit-card-like financial account number', () => {
    const matches = detectHighRiskPii('The card number is 4111 1111 1111 1111.')
    expect(matches.some((m) => m.category === 'financialAccount')).toBe(true)
  })

  it('detects an IBAN-like financial account number', () => {
    const matches = detectHighRiskPii('Transfer to GB29NWBK60161331926819 please.')
    expect(matches.some((m) => m.category === 'financialAccount')).toBe(true)
  })

  it('detects a credential/secret pattern via the existing sanitize check', () => {
    const matches = detectHighRiskPii('Here is the GEMINI_API_KEY for testing.')
    expect(matches.some((m) => m.category === 'credential')).toBe(true)
  })

  it('never includes the actual secret value in a credential match', () => {
    const matches = detectHighRiskPii('The SUPABASE_SERVICE_ROLE_KEY value is abc123secret')
    const credentialMatch = matches.find((m) => m.category === 'credential')
    expect(credentialMatch?.match).not.toContain('abc123secret')
  })

  it('detects a minor-identifiable combination (age + minor context)', () => {
    const matches = detectHighRiskPii('The student, 12 años old, described her experience in the program.')
    expect(matches.some((m) => m.category === 'minorIdentifiable')).toBe(true)
  })

  it('does not flag an age mention without minor context', () => {
    const matches = detectHighRiskPii('The program has been running for 12 años in this region.')
    expect(matches.some((m) => m.category === 'minorIdentifiable')).toBe(false)
  })

  it('detects individual health framing', () => {
    const matches = detectHighRiskPii('Maria fue diagnosticada con diabetes last year.')
    expect(matches.some((m) => m.category === 'individualHealth')).toBe(true)
  })

  it('does not flag an aggregate health-topic mention', () => {
    const matches = detectHighRiskPii('The project increases access to malaria treatment in the community.')
    expect(matches.some((m) => m.category === 'individualHealth')).toBe(false)
  })

  it('does not flag ordinary narrative text with no high-risk PII', () => {
    const matches = detectHighRiskPii('This project improves employment outcomes for youth in the region.')
    expect(matches).toHaveLength(0)
  })
})

describe('redactCommonPii', () => {
  it('replaces an email with a redaction marker', () => {
    const result = redactCommonPii('Contact jane.doe@example.com now.')
    expect(result).not.toContain('jane.doe@example.com')
    expect(result).toContain('[EMAIL_REDACTED]')
  })

  it('replaces a phone number with a redaction marker', () => {
    const result = redactCommonPii('Call +1 555-123-4567 now.')
    expect(result).not.toContain('555-123-4567')
    expect(result).toContain('[PHONE_REDACTED]')
  })

  it('leaves ordinary text unchanged', () => {
    const text = 'This project improves employment outcomes.'
    expect(redactCommonPii(text)).toBe(text)
  })

  it('handles empty string without throwing', () => {
    expect(redactCommonPii('')).toBe('')
  })
})
