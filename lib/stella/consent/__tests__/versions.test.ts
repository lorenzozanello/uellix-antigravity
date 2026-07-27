// lib/stella/consent/__tests__/versions.test.ts
// Etapa A2.1 (STL-A21-002)

import { describe, it, expect } from 'vitest'
import { STELLA_AI_TERMS_VERSION, STELLA_DATA_POLICY_VERSION, STELLA_CONSENT_SCOPE_ALL } from '../versions'

describe('Stella consent versions', () => {
  it('STELLA_AI_TERMS_VERSION is a non-empty, version-like string', () => {
    expect(STELLA_AI_TERMS_VERSION).toBeTruthy()
    expect(typeof STELLA_AI_TERMS_VERSION).toBe('string')
    expect(STELLA_AI_TERMS_VERSION.trim().length).toBeGreaterThan(0)
    expect(STELLA_AI_TERMS_VERSION).toMatch(/^v\d+$/)
  })

  it('STELLA_DATA_POLICY_VERSION is a non-empty, version-like string', () => {
    expect(STELLA_DATA_POLICY_VERSION).toBeTruthy()
    expect(typeof STELLA_DATA_POLICY_VERSION).toBe('string')
    expect(STELLA_DATA_POLICY_VERSION.trim().length).toBeGreaterThan(0)
    expect(STELLA_DATA_POLICY_VERSION).toMatch(/^v\d+$/)
  })

  it('neither version looks like an ISO date (no automatic date-based versioning)', () => {
    const isoDatePattern = /\d{4}-\d{2}-\d{2}/
    expect(STELLA_AI_TERMS_VERSION).not.toMatch(isoDatePattern)
    expect(STELLA_DATA_POLICY_VERSION).not.toMatch(isoDatePattern)
  })

  it('STELLA_CONSENT_SCOPE_ALL is a non-empty array of strings', () => {
    expect(Array.isArray(STELLA_CONSENT_SCOPE_ALL)).toBe(true)
    expect(STELLA_CONSENT_SCOPE_ALL.length).toBeGreaterThan(0)
    expect(STELLA_CONSENT_SCOPE_ALL.every((s) => typeof s === 'string' && s.length > 0)).toBe(true)
  })
})
