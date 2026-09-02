// lib/stella/__tests__/capability-readiness.test.ts
// G-03 — readiness is a property of a CAPABILITY, not of the process.
//
// The defect this pins: `stellaState.canUseStella` is
// `isEnabled && geminiApiKey.length > 0`, and `grounded_query` gated on it.
// That capability answers from evidence chunks with a LOCAL extractive
// generator and never opens a socket to a provider, so a missing provider key
// was disabling a feature that does not use it.
//
// The fix must not travel in the other direction either: a capability that DOES
// call Gemini must still be refused without the key. Both halves are asserted
// here against the same API, because one table is harder to get half-right than
// two scattered conditionals.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockStellaConfig = {
  geminiApiKey: 'test-key',
  isEnabled: true,
  isAdvisorEnabled: true,
  isValidatorEnabled: true,
  isComposerEnabled: true,
  isProxyReviewerEnabled: true,
  isEvidenceReviewerEnabled: true,
  isAuditAssistantEnabled: true,
  isDecisionsPersistenceEnabled: true,
  isGroundedQueryEnabled: true,
}

vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() {
    return mockStellaConfig
  },
}))

import {
  GEMINI_BACKED_STELLA_CAPABILITIES,
  STELLA_CAPABILITIES,
  isStellaCapabilityReady,
  stellaCapabilityBlocker,
} from '@/lib/stella/capability-readiness'

beforeEach(() => {
  mockStellaConfig.geminiApiKey = 'test-key'
  mockStellaConfig.isEnabled = true
  mockStellaConfig.isAdvisorEnabled = true
  mockStellaConfig.isValidatorEnabled = true
  mockStellaConfig.isComposerEnabled = true
  mockStellaConfig.isProxyReviewerEnabled = true
  mockStellaConfig.isEvidenceReviewerEnabled = true
  mockStellaConfig.isAuditAssistantEnabled = true
  mockStellaConfig.isDecisionsPersistenceEnabled = true
  mockStellaConfig.isGroundedQueryEnabled = true
})

describe('1. master Stella off', () => {
  it('makes grounded_query unavailable even with its own flag on', () => {
    mockStellaConfig.isEnabled = false

    expect(isStellaCapabilityReady('grounded_query')).toBe(false)
    expect(stellaCapabilityBlocker('grounded_query')).toBe('master_disabled')
  })

  it('makes every capability unavailable', () => {
    mockStellaConfig.isEnabled = false

    for (const capability of STELLA_CAPABILITIES) {
      expect(isStellaCapabilityReady(capability)).toBe(false)
    }
  })
})

describe('2. capability flag off', () => {
  it('makes grounded_query unavailable while the master flag is on', () => {
    mockStellaConfig.isGroundedQueryEnabled = false

    expect(isStellaCapabilityReady('grounded_query')).toBe(false)
    expect(stellaCapabilityBlocker('grounded_query')).toBe('capability_disabled')
  })

  it('does not leak across capabilities — advisor off leaves grounded_query ready', () => {
    mockStellaConfig.isAdvisorEnabled = false

    expect(isStellaCapabilityReady('advisor')).toBe(false)
    expect(isStellaCapabilityReady('grounded_query')).toBe(true)
  })
})

describe('3. grounded_query does not depend on the provider key', () => {
  it('is READY with master + its own flag on and NO Gemini key', () => {
    mockStellaConfig.geminiApiKey = ''

    expect(isStellaCapabilityReady('grounded_query')).toBe(true)
    expect(stellaCapabilityBlocker('grounded_query')).toBeNull()
  })

  it('is not listed as Gemini-backed', () => {
    expect(GEMINI_BACKED_STELLA_CAPABILITIES.has('grounded_query')).toBe(false)
  })
})

describe('4. Gemini-backed capabilities still require the key', () => {
  it('refuses every Gemini-backed capability when the key is absent', () => {
    mockStellaConfig.geminiApiKey = ''

    for (const capability of GEMINI_BACKED_STELLA_CAPABILITIES) {
      expect(isStellaCapabilityReady(capability)).toBe(false)
      expect(stellaCapabilityBlocker(capability)).toBe('provider_key_missing')
    }
  })

  it('treats a whitespace-only key as absent', () => {
    mockStellaConfig.geminiApiKey = '   '

    expect(isStellaCapabilityReady('advisor')).toBe(false)
    expect(stellaCapabilityBlocker('advisor')).toBe('provider_key_missing')
  })

  it('names the five Gemini-backed capabilities explicitly', () => {
    // A capability added to STELLA_CAPABILITIES without a decision about the
    // provider must be a visible change here, not a silent default.
    expect([...GEMINI_BACKED_STELLA_CAPABILITIES].sort()).toEqual([
      'advisor',
      'audit_assistant',
      'composer',
      'evidence_reviewer',
      'proxy_reviewer',
      'validator',
    ])
  })
})

describe('5. Gemini-backed capabilities with the key present', () => {
  it('are ready, preserving existing behaviour', () => {
    for (const capability of GEMINI_BACKED_STELLA_CAPABILITIES) {
      expect(isStellaCapabilityReady(capability)).toBe(true)
      expect(stellaCapabilityBlocker(capability)).toBeNull()
    }
  })

  it('still respects the master flag ahead of the key', () => {
    mockStellaConfig.isEnabled = false

    expect(stellaCapabilityBlocker('advisor')).toBe('master_disabled')
  })
})

describe('ordering of blockers', () => {
  it('reports the master flag before the capability flag', () => {
    mockStellaConfig.isEnabled = false
    mockStellaConfig.isAdvisorEnabled = false

    expect(stellaCapabilityBlocker('advisor')).toBe('master_disabled')
  })

  it('reports the capability flag before the missing key', () => {
    mockStellaConfig.isAdvisorEnabled = false
    mockStellaConfig.geminiApiKey = ''

    expect(stellaCapabilityBlocker('advisor')).toBe('capability_disabled')
  })
})
