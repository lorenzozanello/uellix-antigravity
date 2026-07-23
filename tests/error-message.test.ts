import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '@/lib/errors/get-error-message'

describe('getErrorMessage', () => {
  it('returns the message from an Error instance', () => {
    expect(getErrorMessage(new Error('specific failure'), 'fallback')).toBe(
      'specific failure'
    )
  })

  it('returns a non-empty thrown string', () => {
    expect(getErrorMessage('specific failure', 'fallback')).toBe(
      'specific failure'
    )
  })

  it('uses the fallback for opaque or empty values', () => {
    expect(getErrorMessage({ reason: 'private' }, 'fallback')).toBe('fallback')
    expect(getErrorMessage('', 'fallback')).toBe('fallback')
    expect(getErrorMessage(null, 'fallback')).toBe('fallback')
  })
})
