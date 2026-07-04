// app/actions/marketing/__tests__/demo-request.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EmailProvider, EmailMessage } from '@/lib/email/provider'

const headersMock = vi.hoisted(() => vi.fn())
vi.mock('next/headers', () => ({
  headers: headersMock,
}))

import { submitDemoRequest, type DemoRequestInput } from '../demo-request'
import { resetDemoRequestRateLimitForTests } from '@/lib/marketing/demo-request-rate-limit'

function fakeHeaders(ip: string) {
  return {
    get: (key: string) => (key === 'x-forwarded-for' ? ip : null),
  }
}

function makeInput(overrides: Partial<DemoRequestInput> = {}): DemoRequestInput {
  return {
    name: 'Ana Pérez',
    organization: 'Fundación Ejemplo',
    email: 'ana@fundacion.org',
    message: 'Queremos medir un programa de empleabilidad.',
    website: '',
    ...overrides,
  }
}

describe('submitDemoRequest', () => {
  let sendMock: ReturnType<typeof vi.fn>
  let mockProvider: EmailProvider

  beforeEach(() => {
    resetDemoRequestRateLimitForTests()
    headersMock.mockReturnValue(Promise.resolve(fakeHeaders('203.0.113.10')))
    sendMock = vi.fn().mockResolvedValue({ id: 'email-1' })
    mockProvider = { send: sendMock as unknown as (m: EmailMessage) => Promise<{ id: string } | null> }
  })

  it('sends an email to hola@uellix.com with reply-to set to the lead email', async () => {
    const result = await submitDemoRequest(makeInput(), mockProvider)

    expect(result).toEqual({ ok: true })
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'hola@uellix.com',
        replyTo: 'ana@fundacion.org',
        subject: expect.stringContaining('Fundación Ejemplo'),
      })
    )
  })

  it('escapes HTML in user-provided fields before building the email body', async () => {
    await submitDemoRequest(
      makeInput({ name: '<script>alert(1)</script>', message: 'a & b' }),
      mockProvider
    )

    const call = sendMock.mock.calls[0][0]
    expect(call.html).not.toContain('<script>')
    expect(call.html).toContain('&lt;script&gt;')
    expect(call.html).toContain('a &amp; b')
  })

  it('rejects an invalid email without sending', async () => {
    const result = await submitDemoRequest(makeInput({ email: 'not-an-email' }), mockProvider)

    expect(result.ok).toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('rejects a missing name without sending', async () => {
    const result = await submitDemoRequest(makeInput({ name: '' }), mockProvider)

    expect(result.ok).toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('silently reports success without sending when the honeypot field is filled', async () => {
    const result = await submitDemoRequest(makeInput({ website: 'https://spam.example' }), mockProvider)

    expect(result).toEqual({ ok: true })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('reports failure gracefully when email delivery throws', async () => {
    sendMock.mockRejectedValue(new Error('network down'))

    const result = await submitDemoRequest(makeInput(), mockProvider)

    expect(result.ok).toBe(false)
  })

  it('blocks a client after exceeding the per-IP hourly limit', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await submitDemoRequest(makeInput(), mockProvider)
      expect(result.ok).toBe(true)
    }

    const blocked = await submitDemoRequest(makeInput(), mockProvider)
    expect(blocked.ok).toBe(false)
    expect(sendMock).toHaveBeenCalledTimes(5)
  })

  it('does not share rate-limit buckets across different IPs', async () => {
    for (let i = 0; i < 5; i++) {
      await submitDemoRequest(makeInput(), mockProvider)
    }
    headersMock.mockReturnValue(Promise.resolve(fakeHeaders('198.51.100.20')))

    const result = await submitDemoRequest(makeInput(), mockProvider)
    expect(result.ok).toBe(true)
  })
})
