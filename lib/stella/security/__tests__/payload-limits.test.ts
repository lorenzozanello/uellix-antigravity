// lib/stella/security/__tests__/payload-limits.test.ts
// WS3 (Fable Moonshot): unit tests for the prompt-size cap, including the
// audit-required pin that StellaPayloadTooLargeError NEVER carries prompt
// content — only sizes.

import { describe, it, expect } from 'vitest'
import {
  StellaPayloadTooLargeError,
  measurePromptChars,
  assertPromptWithinLimit,
} from '../payload-limits'

describe('measurePromptChars', () => {
  it('measures system prompt + user message together', () => {
    expect(measurePromptChars({ systemPrompt: 'abc', userMessage: 'defg' })).toBe(7)
  })

  it('handles empty messages', () => {
    expect(measurePromptChars({ systemPrompt: '', userMessage: '' })).toBe(0)
  })
})

describe('assertPromptWithinLimit', () => {
  it('does not throw at or under the limit', () => {
    expect(() => assertPromptWithinLimit({ systemPrompt: 'abc', userMessage: 'defg' }, 7)).not.toThrow()
    expect(() => assertPromptWithinLimit({ systemPrompt: 'a', userMessage: 'b' }, 100)).not.toThrow()
  })

  it('throws StellaPayloadTooLargeError above the limit', () => {
    expect(() => assertPromptWithinLimit({ systemPrompt: 'abc', userMessage: 'defg' }, 6)).toThrow(
      StellaPayloadTooLargeError
    )
  })
})

describe('StellaPayloadTooLargeError hygiene (audit)', () => {
  const SECRET_SYSTEM = 'SYSTEM_CANARY_9f1: cédula 1.234.567.890 y GEMINI details'
  const SECRET_USER = 'USER_CANARY_7c2: maria.lopez@ong.org narrativa confidencial'

  function capture(): StellaPayloadTooLargeError {
    try {
      assertPromptWithinLimit({ systemPrompt: SECRET_SYSTEM, userMessage: SECRET_USER }, 10)
    } catch (error) {
      return error as StellaPayloadTooLargeError
    }
    throw new Error('expected assertPromptWithinLimit to throw')
  }

  it('the error message carries sizes only — never prompt content', () => {
    const error = capture()
    expect(error.message).toContain(String(SECRET_SYSTEM.length + SECRET_USER.length))
    expect(error.message).toContain('10')
    expect(error.message).not.toContain('CANARY')
    expect(error.message).not.toContain('maria.lopez@ong.org')
    expect(error.message).not.toContain('1.234.567.890')
    expect(error.message).not.toContain(SECRET_SYSTEM)
    expect(error.message).not.toContain(SECRET_USER)
  })

  it('the error object exposes only numeric metadata (no prompt fields)', () => {
    const error = capture()
    expect(error.promptChars).toBe(SECRET_SYSTEM.length + SECRET_USER.length)
    expect(error.maxPromptChars).toBe(10)
    // Serializing every own property must not leak prompt content either.
    const serialized = JSON.stringify({ ...error, message: error.message, stack: undefined })
    expect(serialized).not.toContain('CANARY')
    expect(serialized).not.toContain('maria.lopez@ong.org')
  })
})
