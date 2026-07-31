// lib/stella/__tests__/observability.test.ts
// WS3b U3: reportStellaFailure — Sentry capture with tags/fingerprint and a
// structured console.error that never leaks prompt/context text.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockCaptureException = vi.fn()
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import { reportStellaFailure } from '../observability'

const PROMPT_FIXTURE =
  'SYSTEM_PROMPT_CANARY: Eres Stella. Contexto del proyecto: cédula 1.234.567.890, narrativa confidencial.'

describe('reportStellaFailure', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('captures a sanitized clone with stella_role and error_code tags', () => {
    const error = new Error('boom')
    reportStellaFailure('advisor', 'GEMINI_ERROR', error)

    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    const [captured, options] = mockCaptureException.mock.calls[0] as [Error, Record<string, unknown>]
    // NOT the original object — a clone so a poisoned message never travels verbatim
    expect(captured).not.toBe(error)
    expect(captured).toBeInstanceOf(Error)
    expect(captured.name).toBe('Error')
    expect(captured.message).toBe('boom') // short messages pass through intact
    expect(options.tags).toEqual({ stella_role: 'advisor', error_code: 'GEMINI_ERROR' })
  })

  it('uses a stable fingerprint per (role, error_code)', () => {
    reportStellaFailure('validator', 'TIMEOUT', new Error('t'))
    const [, options] = mockCaptureException.mock.calls[0] as [Error, Record<string, unknown>]
    expect(options.fingerprint).toEqual(['stella', 'validator', 'TIMEOUT'])
  })

  it('forwards scalar meta as extra plus the original message length', () => {
    reportStellaFailure('composer', 'AUDIT_ERROR', new Error('x'), { projectId: 'p-1', reportId: 'r-1' })
    const [, options] = mockCaptureException.mock.calls[0] as [Error, Record<string, unknown>]
    expect(options.extra).toEqual({ projectId: 'p-1', reportId: 'r-1', originalMessageLength: 1 })
  })

  it('truncates a poisoned long message to 200 chars before Sentry (stack header included)', () => {
    // Worst case: the provider error echoes the whole request body. The canary
    // sits beyond the truncation limit and must never reach Sentry.
    const poisoned = new Error('GEMINI 400: request rejected. Body echo follows: ' + 'x'.repeat(300) + ' TAIL_CANARY_' + PROMPT_FIXTURE)
    reportStellaFailure('advisor', 'GEMINI_ERROR', poisoned)

    const [captured, options] = mockCaptureException.mock.calls[0] as [Error, Record<string, unknown>]
    expect(captured.message.length).toBeLessThanOrEqual(200)
    expect(captured.message).not.toContain('TAIL_CANARY_')
    expect(captured.message).not.toContain('SYSTEM_PROMPT_CANARY')
    // V8 stacks embed the full message in the header line — the sanitized
    // clone must rebuild it from the truncated message.
    expect(captured.stack ?? '').not.toContain('TAIL_CANARY_')
    expect(captured.stack ?? '').not.toContain('SYSTEM_PROMPT_CANARY')
    // frames are preserved for grouping/debugging
    expect(captured.stack ?? '').toMatch(/\n\s+at /)
    // diagnostics: the original length survives as a scalar
    const extra = options.extra as Record<string, unknown>
    expect(extra.originalMessageLength).toBe(poisoned.message.length)
  })

  it('wraps non-Error values without serializing them (no payload leak)', () => {
    reportStellaFailure('advisor', 'UNKNOWN_ERROR', { prompt: PROMPT_FIXTURE })
    const [captured] = mockCaptureException.mock.calls[0] as [Error]
    expect(captured).toBeInstanceOf(Error)
    expect(captured.message).not.toContain('SYSTEM_PROMPT_CANARY')
    expect(captured.message).not.toContain('1.234.567.890')
  })

  it('logs a structured [stella] console.error with role, code and error NAME only', () => {
    const error = new Error(PROMPT_FIXTURE) // worst case: message echoes the prompt
    reportStellaFailure('advisor', 'GEMINI_ERROR', error, { projectId: 'p-1', promptChars: 120 })

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const [prefix, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(prefix).toBe('[stella] failure')
    expect(payload).toEqual({
      role: 'advisor',
      errorCode: 'GEMINI_ERROR',
      errorName: 'Error',
      projectId: 'p-1',
      promptChars: 120,
    })
  })

  it('console output never contains the prompt fixture text, even when the error message does', () => {
    reportStellaFailure('advisor', 'PARSE_ERROR', new Error(PROMPT_FIXTURE))

    const serialized = JSON.stringify(errorSpy.mock.calls)
    expect(serialized).not.toContain('SYSTEM_PROMPT_CANARY')
    expect(serialized).not.toContain('narrativa confidencial')
    expect(serialized).not.toContain('1.234.567.890')
  })

  it('never throws when Sentry capture itself fails', () => {
    mockCaptureException.mockImplementation(() => {
      throw new Error('sentry down')
    })

    expect(() => reportStellaFailure('advisor', 'GEMINI_ERROR', new Error('x'))).not.toThrow()
    // the console log still happens
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})
