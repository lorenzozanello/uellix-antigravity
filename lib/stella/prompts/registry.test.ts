// lib/stella/prompts/registry.test.ts
// Etapa A1 (STL-A1-002)

import { describe, it, expect } from 'vitest'
import { PROMPT_TEMPLATES, getPromptTemplate } from './registry'
import type { StellaRole } from '../adapter/types'

const ALL_ROLES: StellaRole[] = [
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
]

describe('PROMPT_TEMPLATES registry', () => {
  it.each(ALL_ROLES)('has a registered template for role "%s"', (role) => {
    const template = getPromptTemplate(role)
    expect(template.templateId).toBeTruthy()
    expect(Number.isInteger(template.version)).toBe(true)
    expect(template.version).toBeGreaterThan(0)
    // Etapa A1.5 (STL-A15-008): every template must carry a content-hash
    // snapshot; prompt-content-hash.test.ts verifies it actually matches the
    // live prompt text.
    expect(template.expectedContentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('assigns a unique templateId per role', () => {
    const ids = ALL_ROLES.map((role) => PROMPT_TEMPLATES[role].templateId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('throws for an unregistered role instead of returning undefined', () => {
    expect(() => getPromptTemplate('not_a_real_role' as StellaRole)).toThrow(
      /No prompt template registered/,
    )
  })
})
