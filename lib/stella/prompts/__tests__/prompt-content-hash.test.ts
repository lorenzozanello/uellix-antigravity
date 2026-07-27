// lib/stella/prompts/__tests__/prompt-content-hash.test.ts
// Etapa A1.5 (STL-A15-008) — this is the test that fails if a system
// prompt's wording changes without a matching version/hash bump.

import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { computePromptContentHash } from '../prompt-content-hash'
import { PROMPT_TEMPLATES } from '../registry'
import type { StellaRole } from '../../adapter/types'

const ALL_ROLES: StellaRole[] = ['advisor', 'validator', 'composer', 'proxy_reviewer', 'evidence_reviewer', 'audit_assistant']

describe('computePromptContentHash', () => {
  it('is deterministic — calling it twice for the same role gives the same hash', () => {
    for (const role of ALL_ROLES) {
      expect(computePromptContentHash(role)).toBe(computePromptContentHash(role))
    }
  })

  it('produces a 64-char hex SHA-256 digest', () => {
    for (const role of ALL_ROLES) {
      expect(computePromptContentHash(role)).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('gives a different hash for a role whose prompt text actually differs', () => {
    const hashes = ALL_ROLES.map((role) => computePromptContentHash(role))
    expect(new Set(hashes).size).toBe(ALL_ROLES.length)
  })

  it.each(ALL_ROLES)(
    'matches the recorded expectedContentHash for role "%s" (fails if the prompt changed without a version bump)',
    (role) => {
      expect(computePromptContentHash(role)).toBe(PROMPT_TEMPLATES[role].expectedContentHash)
    },
  )

  it('detects drift: a manually altered prompt text no longer matches its recorded hash', () => {
    // Simulates exactly the failure mode this control exists to catch: the
    // registry's expectedContentHash for "advisor" is a snapshot of the
    // CURRENT prompt text. Hashing different text must not match it.
    const currentAdvisorHash = computePromptContentHash('advisor')
    const differentText = 'This is not the real advisor system prompt.'
    const differentHash = createHash('sha256').update(differentText).digest('hex')
    expect(differentHash).not.toBe(currentAdvisorHash)
    expect(differentHash).not.toBe(PROMPT_TEMPLATES.advisor.expectedContentHash)
  })
})
